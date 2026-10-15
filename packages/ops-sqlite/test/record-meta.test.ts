import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "../src/migrations-sql";
import {
  archiveRecord,
  createRecord,
  getRecord,
  getRecordMeta,
  patchRecord,
  putRecord,
  setRecord,
  unarchiveRecord,
} from "../src/record-ops";
import * as schema from "../src/schema";
import { type TestDb, createTestDb, runMigration, testOrigin } from "./helpers";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

function create(
  db: Db,
  key: string,
  value: Record<string, unknown>,
  type = "config",
) {
  return createRecord(
    db,
    {
      type,
      key,
      value,
      tags: ["t-secret"],
      schema_version: 3,
      actor: "writer",
    },
    testOrigin("writer"),
  );
}

describe("getRecordMeta", () => {
  it("returns exactly the metadata of one revision and nothing of the value", async () => {
    const created = await create(testDb.db, "main", { note: "VALUE-SECRET" });

    const meta = getRecordMeta(testDb.db, "config", "main");

    expect(meta).toEqual({
      type: "config",
      key: "main",
      revision: 1,
      fence: 1,
      value_sha256: created.value_sha256,
      updated_at: created.updated_at,
      archived: 0,
    });
    expect(Object.keys(meta ?? {}).sort()).toEqual([
      "archived",
      "fence",
      "key",
      "revision",
      "type",
      "updated_at",
      "value_sha256",
    ]);
    expect(JSON.stringify(meta)).not.toContain("VALUE-SECRET");
    expect(JSON.stringify(meta)).not.toContain("t-secret");
  });

  it("agrees with getRecord on every shared field after each kind of write", async () => {
    const check = (step: string) => {
      const full = getRecord(testDb.db, "config", "main");
      const meta = getRecordMeta(testDb.db, "config", "main");
      expect(full, step).not.toBeNull();
      expect(meta, step).toEqual({
        type: full?.type,
        key: full?.key,
        revision: full?.revision,
        fence: full?.fence,
        value_sha256: full?.value_sha256,
        updated_at: full?.updated_at,
        archived: full?.archived,
      });
      return meta;
    };

    const created = await create(testDb.db, "main", { v: 1 });
    const m1 = check("create");
    expect(m1?.revision).toBe(1);

    await setRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        value: { v: 2 },
        fence: created.fence,
        schema_version: 3,
        actor: "writer",
      },
      testOrigin("writer"),
    );
    const m2 = check("set");
    expect(m2?.revision).toBe(2);
    expect(m2?.value_sha256).not.toBe(m1?.value_sha256);

    await patchRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        patch: { w: 1 },
        fence: m2?.fence ?? -1,
        schema_version: 3,
        actor: "writer",
      },
      testOrigin("writer"),
    );
    const m3 = check("patch");
    expect(m3?.revision).toBe(3);

    await putRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        value: { v: 4 },
        schema_version: 3,
        actor: "writer",
      },
      testOrigin("writer"),
    );
    const m4 = check("put");
    expect(m4?.revision).toBe(4);
    // Every write bumped the revision and the fence together.
    expect([m1, m2, m3, m4].map((m) => m?.fence)).toEqual([1, 2, 3, 4]);
  });

  it("reports the fence a fenced write needs and the one a stale write lacks", async () => {
    await create(testDb.db, "main", { v: 1 });
    const before = getRecordMeta(testDb.db, "config", "main");

    await setRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        value: { v: 2 },
        fence: before?.fence ?? -1,
        schema_version: 3,
        actor: "writer",
      },
      testOrigin("writer"),
    );
    const after = getRecordMeta(testDb.db, "config", "main");

    expect(after?.fence).toBe((before?.fence ?? 0) + 1);
    await expect(
      setRecord(
        testDb.db,
        {
          type: "config",
          key: "main",
          value: { v: 3 },
          fence: before?.fence ?? -1,
          schema_version: 3,
          actor: "writer",
        },
        testOrigin("writer"),
      ),
    ).rejects.toThrow();
    // The accepted write used exactly the fence the earlier read returned.
    await setRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        value: { v: 3 },
        fence: after?.fence ?? -1,
        schema_version: 3,
        actor: "writer",
      },
      testOrigin("writer"),
    );
    expect(getRecordMeta(testDb.db, "config", "main")?.revision).toBe(3);
  });

  it("reflects archive and unarchive with the revision and fence they produce", async () => {
    const created = await create(testDb.db, "main", { v: 1 });

    const archived = archiveRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        fence: created.fence,
        schema_version: 3,
        actor: "writer",
      },
      testOrigin("writer"),
    );
    const afterArchive = getRecordMeta(testDb.db, "config", "main");
    expect(afterArchive).toMatchObject({
      archived: 1,
      revision: archived.revision,
      fence: archived.fence,
      value_sha256: created.value_sha256,
    });
    expect(afterArchive?.revision).toBe(2);

    const restored = unarchiveRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        fence: afterArchive?.fence ?? -1,
        schema_version: 3,
        actor: "writer",
      },
      testOrigin("writer"),
    );
    const afterUnarchive = getRecordMeta(testDb.db, "config", "main");
    expect(afterUnarchive).toMatchObject({
      archived: 0,
      revision: restored.revision,
      fence: restored.fence,
    });
    expect(afterUnarchive?.revision).toBe(3);
    expect(afterUnarchive?.fence).toBe(3);
  });

  it("returns null for a record that does not exist, in any type or key", async () => {
    await create(testDb.db, "main", { v: 1 });

    expect(getRecordMeta(testDb.db, "config", "absent")).toBeNull();
    expect(getRecordMeta(testDb.db, "other", "main")).toBeNull();
    // A fence row alone does not make a record: a prefix of a real key is absent.
    expect(getRecordMeta(testDb.db, "config", "mai")).toBeNull();
  });

  it("keeps slash keys and prefix-sharing keys apart", async () => {
    await create(testDb.db, "a", { v: 1 });
    const nested = await create(testDb.db, "a/b/c", { v: 1 });
    await setRecord(
      testDb.db,
      {
        type: "config",
        key: "a/b/c",
        value: { v: 2 },
        fence: nested.fence,
        schema_version: 3,
        actor: "writer",
      },
      testOrigin("writer"),
    );

    expect(getRecordMeta(testDb.db, "config", "a")).toMatchObject({
      key: "a",
      revision: 1,
      fence: 1,
    });
    expect(getRecordMeta(testDb.db, "config", "a/b/c")).toMatchObject({
      key: "a/b/c",
      revision: 2,
      fence: 2,
    });
    expect(getRecordMeta(testDb.db, "config", "a/b")).toBeNull();
  });

  it("answers fence 0 when the fence row is missing, as getRecord does", async () => {
    await create(testDb.db, "main", { v: 1 });
    testDb.rawDb
      .prepare("DELETE FROM fences WHERE resource = ?")
      .run("record:config/main");

    expect(getRecord(testDb.db, "config", "main")?.fence).toBe(0);
    expect(getRecordMeta(testDb.db, "config", "main")?.fence).toBe(0);
  });

  it("neither loads nor parses the stored value", async () => {
    await create(testDb.db, "main", { v: 1 });
    // A stored value no JSON parser accepts: the full read cannot return it,
    // the metadata read never touches it.
    testDb.rawDb
      .prepare("UPDATE records SET value_json = ? WHERE type = ? AND key = ?")
      .run("{not json", "config", "main");

    expect(() => getRecord(testDb.db, "config", "main")).toThrow(SyntaxError);
    expect(getRecordMeta(testDb.db, "config", "main")).toMatchObject({
      key: "main",
      revision: 1,
    });
  });
});

describe("getRecordMeta snapshot", () => {
  let dir: string;
  let reader: InstanceType<typeof Database>;
  let writer: InstanceType<typeof Database>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tila-record-meta-"));
    const path = join(dir, "project.db");
    reader = new Database(path);
    writer = new Database(path);
    reader.pragma("foreign_keys = ON");
    reader.exec(MIGRATION_BOOTSTRAP);
    for (const migration of MIGRATIONS) runMigration(reader, migration);
  });

  afterEach(() => {
    reader.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("issues one value-free statement, so a writer between reads cannot split revision from fence", async () => {
    const statements: string[] = [];
    let armed = false;
    // A second connection commits a revision bump the moment a second
    // statement is about to run: the instant at which a two-query read would
    // pair the old revision with the new fence.
    const db = drizzle(reader, {
      schema,
      logger: {
        logQuery(query: string) {
          if (!armed) return;
          statements.push(query);
          if (statements.length === 2) {
            writer.exec(`
              BEGIN;
              UPDATE records SET revision = revision + 1, value_sha256 = '${"f".repeat(64)}'
                WHERE type = 'config' AND key = 'main';
              UPDATE fences SET current_fence = current_fence + 1
                WHERE resource = 'record:config/main';
              COMMIT;
            `);
          }
        },
      },
    }) as unknown as Db;

    await create(db, "main", { v: 1 });
    armed = true;

    const meta = getRecordMeta(db, "config", "main");

    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain("value_json");
    expect(meta).not.toBeNull();
    // Writes in this project bump revision and fence in lockstep, so a
    // consistent snapshot is one where they are equal.
    expect(meta?.fence).toBe(meta?.revision);
    // The interleaved write did commit, and a read after it sees all of it.
    const after = getRecordMeta(db, "config", "main");
    expect(after).toMatchObject({ revision: 2, fence: 2 });
    expect(after?.value_sha256).toBe("f".repeat(64));
  });
});
