import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "../src/migrations-sql";
import * as transfer from "../src/project-transfer-ops";
import * as recordOps from "../src/record-ops";
import * as schema from "../src/schema";
import { runMigration, testOrigin } from "./helpers";

type Raw = InstanceType<typeof Database>;
type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

function database(version = Number.POSITIVE_INFINITY): Raw {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  raw.exec(MIGRATION_BOOTSTRAP);
  for (const migration of MIGRATIONS.filter((m) => m.version <= version))
    runMigration(raw, migration);
  return raw;
}

function orm(raw: Raw): Db {
  return drizzle(raw, { schema }) as unknown as Db;
}

function storage(raw: Raw): transfer.ProjectSqlStorage {
  return {
    exec(statement: string, ...bindings: unknown[]) {
      if (/^\s*(SELECT|PRAGMA)/i.test(statement))
        return {
          toArray: () =>
            raw.prepare(statement).all(...bindings) as Record<
              string,
              unknown
            >[],
        };
      if (bindings.length > 0) raw.prepare(statement).run(...bindings);
      else raw.exec(statement);
      return { toArray: () => [] };
    },
  };
}

function migrate43(raw: Raw): void {
  const migration = MIGRATIONS.find((m) => m.version === 43);
  if (!migration) throw new Error("Missing migration 43");
  runMigration(raw, migration);
}

/** A level-42 project holding two revisions authored before principal tracking. */
function legacyProject(): Raw {
  const raw = database(42);
  raw.exec(`
    INSERT INTO records (type, key, schema_version, value_json, value_sha256, revision, archived, created_at, updated_at, updated_by)
      VALUES ('config', 'main', 1, '{"n":2}', 'sha-2', 2, 0, 1000, 2000, 'alice');
    INSERT INTO record_revisions (type, key, revision, operation, schema_version, value_json, value_sha256, actor, created_at, token_id)
      VALUES ('config', 'main', 1, 'created', 1, '{"n":1}', 'sha-1', 'alice', 1000, 'tok-old'),
             ('config', 'main', 2, 'set', 1, '{"n":2}', 'sha-2', 'alice', 2000, NULL);
    INSERT INTO fences (resource, current_fence) VALUES ('record:config/main', 2);
    -- The journal names a principal at exactly the revision timestamps. It is
    -- tempting evidence, and it must not become a backfilled author.
    INSERT INTO journal (t, kind, resource, actor, principal_id, participant_id, environment, token_id, data)
      VALUES (1000, 'record.created', 'record:config/main', '', 'journal-principal', 'p', '{}', 'tok-old', '{}'),
             (2000, 'record.updated', 'record:config/main', '', 'journal-principal', 'p', '{}', NULL, '{}');
  `);
  return raw;
}

function history(raw: Raw, type = "config", key = "main") {
  return recordOps.listRecordHistory(orm(raw), type, key).items;
}

describe("record revision principal migration", () => {
  it("adds one nullable column, idempotently, and leaves earlier revisions NULL", () => {
    const raw = legacyProject();
    try {
      const columns = (name: string) =>
        (
          raw.prepare("PRAGMA table_info(record_revisions)").all() as {
            name: string;
            notnull: number;
            dflt_value: string | null;
          }[]
        ).filter((c) => c.name === name);
      expect(columns("principal_id")).toEqual([]);
      const before = raw.prepare("SELECT * FROM record_revisions").all();

      migrate43(raw);
      migrate43(raw);

      expect(columns("principal_id")).toHaveLength(1);
      expect(columns("principal_id")[0]).toMatchObject({ notnull: 0 });
      // Existing data is untouched apart from the new NULL column.
      const after = raw.prepare("SELECT * FROM record_revisions").all();
      expect(after).toEqual(
        before.map((row) => ({ ...(row as object), principal_id: null })),
      );
    } finally {
      raw.close();
    }
  });

  it("never infers an author for an earlier revision from the journal", () => {
    const raw = legacyProject();
    try {
      migrate43(raw);
      expect(history(raw)).toMatchObject([
        { revision: 2, principal_id: null, token_id: null, actor: "alice" },
        {
          revision: 1,
          principal_id: null,
          // The credential recorded at write time is returned as stored.
          token_id: "tok-old",
          actor: "alice",
        },
      ]);
    } finally {
      raw.close();
    }
  });

  it("keeps new revisions attributed beside earlier NULL ones after an upgrade", async () => {
    const raw = legacyProject();
    try {
      migrate43(raw);
      const db = orm(raw);
      const current = recordOps.getRecord(db, "config", "main");
      if (!current) throw new Error("fixture record is missing");
      await recordOps.setRecord(
        db,
        {
          type: "config",
          key: "main",
          value: { n: 3 },
          fence: current.fence,
          schema_version: 1,
          actor: "alice",
        },
        {
          ...testOrigin("laptop", "user:alice"),
          actor: "alice",
          tokenId: "tok-new",
        },
      );
      expect(
        history(raw).map(({ revision, principal_id, token_id }) => ({
          revision,
          principal_id,
          token_id,
        })),
      ).toEqual([
        { revision: 3, principal_id: "user:alice", token_id: "tok-new" },
        { revision: 2, principal_id: null, token_id: null },
        { revision: 1, principal_id: null, token_id: "tok-old" },
      ]);
    } finally {
      raw.close();
    }
  });
});

describe("revision principal on new writes", () => {
  const origin = (
    principalId: string,
    tokenId: string | null | undefined,
    actor = "deploy-bot",
  ) => ({ ...testOrigin("host", principalId), actor, tokenId });

  async function write(
    db: Db,
    operation: "create" | "set" | "patch" | "archive" | "unarchive",
    value: Record<string, unknown>,
    who: ReturnType<typeof origin>,
    fence = 0,
  ): Promise<number> {
    const base = {
      type: "config",
      key: "main",
      schema_version: 1,
      actor: who.actor,
    };
    switch (operation) {
      case "create":
        return (await recordOps.createRecord(db, { ...base, value }, who))
          .fence;
      case "set":
        return (await recordOps.setRecord(db, { ...base, value, fence }, who))
          .fence;
      case "patch":
        return (
          await recordOps.patchRecord(db, { ...base, patch: value, fence }, who)
        ).fence;
      case "archive":
        return recordOps.archiveRecord(db, { ...base, fence }, who).fence;
      case "unarchive":
        return recordOps.unarchiveRecord(db, { ...base, fence }, who).fence;
    }
  }

  it("stores the authenticated origin principal for every revision-writing operation", async () => {
    const raw = database();
    try {
      const db = orm(raw);
      let fence = await write(db, "create", { n: 1 }, origin("svc:a", "tok-a"));
      fence = await write(db, "set", { n: 2 }, origin("svc:b", "tok-b"), fence);
      fence = await write(
        db,
        "patch",
        { n: 3 },
        origin("svc:c", "tok-c"),
        fence,
      );
      fence = await write(db, "archive", {}, origin("svc:d", "tok-d"), fence);
      await write(db, "unarchive", {}, origin("svc:e", "tok-e"), fence);

      expect(
        history(raw)
          .reverse()
          .map((r) => [r.operation, r.principal_id, r.token_id]),
      ).toEqual([
        ["created", "svc:a", "tok-a"],
        ["set", "svc:b", "tok-b"],
        ["patch", "svc:c", "tok-c"],
        ["archived", "svc:d", "tok-d"],
        ["unarchived", "svc:e", "tok-e"],
      ]);
    } finally {
      raw.close();
    }
  });

  it("keeps the principal across credential rotation and tells same-named tokens apart", async () => {
    const raw = database();
    try {
      const db = orm(raw);
      // One service account, its credential rotated from token-1 to token-2,
      // all under the same display name. A second account shares that name.
      let fence = await write(
        db,
        "create",
        { n: 1 },
        origin("service:deploy", "token-1"),
      );
      fence = await write(
        db,
        "set",
        { n: 2 },
        origin("service:deploy", "token-2"),
        fence,
      );
      await write(
        db,
        "set",
        { n: 3 },
        origin("service:impostor", "token-3"),
        fence,
      );

      const rows = history(raw).reverse();
      expect(rows.map((r) => r.actor)).toEqual([
        "deploy-bot",
        "deploy-bot",
        "deploy-bot",
      ]);
      expect(rows.map((r) => r.principal_id)).toEqual([
        "service:deploy",
        "service:deploy",
        "service:impostor",
      ]);
      expect(rows.map((r) => r.token_id)).toEqual([
        "token-1",
        "token-2",
        "token-3",
      ]);
    } finally {
      raw.close();
    }
  });

  it.each([null, undefined])(
    "records a session write (%s token) with its principal and no token",
    async (tokenId) => {
      const raw = database();
      try {
        await write(
          orm(raw),
          "create",
          { n: 1 },
          origin("github:github.com:42", tokenId, "octocat"),
        );
        expect(history(raw)).toMatchObject([
          {
            principal_id: "github:github.com:42",
            token_id: null,
            actor: "octocat",
          },
        ]);
      } finally {
        raw.close();
      }
    },
  );
});

describe("revision principal in backups", () => {
  const LEVELS = [30, 34, 36, 38, 39, 40, 41, 42];

  it("digests an archive taken below level 43 exactly as before the migration", async () => {
    const raw = legacyProject();
    try {
      const sql = storage(raw);
      const before = new Map<number, string>();
      for (const level of LEVELS)
        before.set(level, await transfer.semanticDigest(sql, level));
      migrate43(raw);
      for (const level of LEVELS)
        expect(
          await transfer.semanticDigest(sql, level),
          `level ${level}`,
        ).toBe(before.get(level));
      // Level 43 now covers the column, so the digest is a different one.
      expect(await transfer.semanticDigest(sql, 43)).not.toBe(before.get(42));
      expect(await transfer.semanticDigest(sql)).toBe(
        await transfer.semanticDigest(sql, 43),
      );
    } finally {
      raw.close();
    }
  });

  it("detects a changed revision author at level 43", async () => {
    const raw = legacyProject();
    try {
      migrate43(raw);
      raw
        .prepare(
          "UPDATE record_revisions SET principal_id = 'user:alice' WHERE revision = 1",
        )
        .run();
      const sql = storage(raw);
      const attributed = await transfer.semanticDigest(sql, 43);
      raw
        .prepare(
          "UPDATE record_revisions SET principal_id = 'user:mallory' WHERE revision = 1",
        )
        .run();
      expect(await transfer.semanticDigest(sql, 43)).not.toBe(attributed);
    } finally {
      raw.close();
    }
  });

  function snapshot(raw: Raw) {
    const from = storage(raw);
    return Object.fromEntries(
      transfer.PROJECT_BACKUP_TABLES.map((table) => [
        table,
        transfer.readSnapshotPage(from, table, { limit: 1_000 }).rows,
      ]),
    );
  }

  it("restores a level-42 archive into a level-43 project with the digest it was exported with", async () => {
    const source = legacyProject();
    const destination = database();
    try {
      const archived = snapshot(source);
      // The archive predates the column, so its rows cannot carry it.
      for (const row of archived.record_revisions ?? [])
        expect(row).not.toHaveProperty("principal_id");
      const digest = await transfer.semanticDigest(storage(source), 42);

      destination.transaction(() =>
        transfer.replaceSnapshotRows(storage(destination), archived, 1),
      )();

      expect(await transfer.semanticDigest(storage(destination), 42)).toBe(
        digest,
      );
      expect(history(destination).map((r) => r.principal_id)).toEqual([
        null,
        null,
      ]);
    } finally {
      source.close();
      destination.close();
    }
  });

  it("round-trips principals and the level-43 digest through export and restore", async () => {
    const source = database();
    const destination = database();
    try {
      const db = orm(source);
      const first = await recordOps.createRecord(
        db,
        {
          type: "config",
          key: "main",
          value: { n: 1 },
          schema_version: 1,
          actor: "bot",
        },
        {
          ...testOrigin("host", "service:deploy"),
          actor: "bot",
          tokenId: "t1",
        },
      );
      await recordOps.setRecord(
        db,
        {
          type: "config",
          key: "main",
          value: { n: 2 },
          fence: first.fence,
          schema_version: 1,
          actor: "bot",
        },
        { ...testOrigin("host", "user:alice"), actor: "alice", tokenId: null },
      );
      const digest = await transfer.semanticDigest(storage(source), 43);
      const exported = snapshot(source);
      expect(exported.record_revisions?.map((row) => row.principal_id)).toEqual(
        ["service:deploy", "user:alice"],
      );

      destination.transaction(() =>
        transfer.replaceSnapshotRows(storage(destination), exported, 1),
      )();

      expect(await transfer.semanticDigest(storage(destination), 43)).toBe(
        digest,
      );
      expect(
        history(destination).map((r) => [
          r.revision,
          r.principal_id,
          r.token_id,
        ]),
      ).toEqual([
        [2, "user:alice", null],
        [1, "service:deploy", "t1"],
      ]);
    } finally {
      source.close();
      destination.close();
    }
  });
});
