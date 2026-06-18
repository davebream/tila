/**
 * Audit B1 — idempotency dedup survives a cross-store crash.
 *
 * The worker idempotency middleware records its D1 dedup row AFTER the DO write
 * commits. A crash between the DO commit and the D1 store leaves no D1 row, so a
 * retry with the same Idempotency-Key re-executes the handler and double-applies
 * a fence-mutating write. The fix records the dedup row INSIDE the same DO SQLite
 * transaction as the write, so a replay returns the prior result without
 * re-executing — even though no D1 row was ever written.
 *
 * These tests simulate exactly that crash: the ops are invoked directly (the D1
 * store is never touched), then the same op is replayed with the same key+hash.
 * The write must execute ONCE.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
  DoIdempotencyConflictError,
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type MigrationStorage,
  coordinationOps,
  entityOps,
  recordOps,
  schema,
} from "../../ops-sqlite/src";

// Cloudflare's SQLite fork supports COALESCE in PRIMARY KEY; standard SQLite does not.
function patchMigration(sql: string): string {
  return sql.replace(
    "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
    "PRIMARY KEY (from_key, type)",
  );
}

function createStorage(rawDb: InstanceType<typeof Database>): MigrationStorage {
  return {
    sql: {
      exec<T>(statement: string, ...bindings: unknown[]) {
        const patched = patchMigration(statement);
        if (/^\s*(SELECT|PRAGMA)\b/i.test(patched)) {
          return {
            toArray: () => rawDb.prepare(patched).all(...bindings) as T[],
          };
        }
        if (bindings.length > 0) {
          rawDb.prepare(patched).run(...bindings);
        } else {
          rawDb.exec(patched);
        }
        return { toArray: () => [] as T[] };
      },
    },
  } as MigrationStorage;
}

function runAllMigrations(rawDb: InstanceType<typeof Database>): void {
  rawDb.exec(MIGRATION_BOOTSTRAP);
  const storage = createStorage(rawDb);
  for (const migration of MIGRATIONS) {
    if ("run" in migration) {
      migration.run(storage);
    } else {
      rawDb.exec(patchMigration(migration.sql));
    }
    rawDb
      .prepare(
        "INSERT OR IGNORE INTO _migrations (version, applied_at) VALUES (?, ?)",
      )
      .run(migration.version, Date.now());
  }
}

function createTestDb(): {
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
  rawDb: InstanceType<typeof Database>;
} {
  const rawDb = new Database(":memory:");
  rawDb.pragma("foreign_keys = ON");
  runAllMigrations(rawDb);
  const db = drizzle(rawDb, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, rawDb };
}

function journalCount(
  rawDb: InstanceType<typeof Database>,
  kind: string,
  resource: string,
): number {
  const row = rawDb
    .prepare(
      "SELECT COUNT(*) AS n FROM journal WHERE kind = ? AND resource = ?",
    )
    .get(kind, resource) as { n: number };
  return row.n;
}

function fenceOf(
  rawDb: InstanceType<typeof Database>,
  resource: string,
): number | undefined {
  const row = rawDb
    .prepare("SELECT current_fence FROM fences WHERE resource = ?")
    .get(resource) as { current_fence: number } | undefined;
  return row?.current_fence;
}

const ORIGIN = {
  actor: "m/u",
  tokenId: null,
  source: null,
  sourceVersion: null,
};

describe("audit B1 — DO idempotency dedup (crash-replay)", () => {
  it("entity.update: replay with the same key executes the write ONCE", () => {
    const { db, rawDb } = createTestDb();
    entityOps.create(
      db,
      { id: "e1", type: "task", data: { n: 0 }, created_by: "test" },
      1,
      { actor: "test" },
    );
    const claim = coordinationOps.acquire(
      db,
      "e1",
      "m",
      "u",
      "exclusive",
      60_000,
    );

    const idem = { key: "dp:p:c:POST:/e1:abc", requestHash: "h1" };

    const first = entityOps.update(
      db,
      "e1",
      { n: 1 },
      claim.fence,
      ORIGIN,
      undefined,
      idem,
    );
    expect(first.data.n).toBe(1);

    // CRASH between DO commit and D1 store: no D1 row written. Replay the same
    // request with the same key+hash. Without the in-tx dedup this re-runs the
    // update (and would re-journal); with it, the stored result is returned.
    const replay = entityOps.update(
      db,
      "e1",
      { n: 1 },
      claim.fence,
      ORIGIN,
      undefined,
      idem,
    );
    expect(replay).toEqual(first); // verbatim stored result

    // Single execution: exactly one entity.updated journal row.
    expect(journalCount(rawDb, "entity.updated", "e1")).toBe(1);
  });

  it("record.set: replay with the same key bumps the fence ONCE", async () => {
    const { db, rawDb } = createTestDb();
    await recordOps.putRecord(
      db,
      {
        type: "cfg",
        key: "main",
        value: { a: 1 },
        schema_version: 0,
        actor: "test",
      },
      ORIGIN,
    );
    const resource = "record:cfg/main";
    const fenceBefore = fenceOf(rawDb, resource) ?? 0;

    const idem = { key: "dp:p:c:POST:/record:set", requestHash: "h-set" };

    const first = await recordOps.setRecord(
      db,
      {
        type: "cfg",
        key: "main",
        value: { a: 2 },
        fence: fenceBefore,
        schema_version: 0,
        actor: "test",
      },
      ORIGIN,
      idem,
    );
    const fenceAfterFirst = fenceOf(rawDb, resource);
    expect(fenceAfterFirst).toBe(first.fence);
    expect(fenceAfterFirst).toBeGreaterThan(fenceBefore);

    // CRASH + replay with the same key+hash (the original request body hash).
    const replay = await recordOps.setRecord(
      db,
      {
        type: "cfg",
        key: "main",
        value: { a: 2 },
        fence: fenceBefore, // the ORIGINAL fence the client held
        schema_version: 0,
        actor: "test",
      },
      ORIGIN,
      idem,
    );
    expect(replay).toEqual(first); // verbatim stored result

    // The fence must NOT have bumped a second time.
    expect(fenceOf(rawDb, resource)).toBe(fenceAfterFirst);
    expect(journalCount(rawDb, "record.updated", resource)).toBe(1);
  });

  it("coord.acquire: replay returns the original fence, no second bump", () => {
    const { db, rawDb } = createTestDb();
    entityOps.create(
      db,
      { id: "e2", type: "task", data: {}, created_by: "test" },
      1,
      { actor: "test" },
    );
    const idem = { key: "dp:p:c:POST:/acquire", requestHash: "h-acq" };

    // First acquire (resource fence goes to 1).
    const first = coordinationOps.acquire(
      db,
      "e2",
      "m",
      "u",
      "exclusive",
      60_000,
      undefined,
      Date.now(),
      undefined,
      idem,
    );
    expect(first.acquired).toBe(true);
    const fenceAfterFirst = fenceOf(rawDb, "task:e2");
    expect(fenceAfterFirst).toBe(first.fence);

    // CRASH + replay: must return the SAME fence, not bump again.
    const replay = coordinationOps.acquire(
      db,
      "e2",
      "m",
      "u",
      "exclusive",
      60_000,
      undefined,
      Date.now(),
      undefined,
      idem,
    );
    expect(replay.fence).toBe(first.fence);
    expect(fenceOf(rawDb, "task:e2")).toBe(fenceAfterFirst);
    expect(journalCount(rawDb, "claim.acquired", "task:e2")).toBe(1);
  });

  it("conflict: same key with a different body hash throws", () => {
    const { db } = createTestDb();
    entityOps.create(
      db,
      { id: "e3", type: "task", data: {}, created_by: "test" },
      1,
      { actor: "test" },
    );
    const claim = coordinationOps.acquire(
      db,
      "e3",
      "m",
      "u",
      "exclusive",
      60_000,
    );

    entityOps.update(db, "e3", { n: 1 }, claim.fence, ORIGIN, undefined, {
      key: "dp:dup",
      requestHash: "hA",
    });
    expect(() =>
      entityOps.update(db, "e3", { n: 2 }, claim.fence, ORIGIN, undefined, {
        key: "dp:dup",
        requestHash: "hB",
      }),
    ).toThrow(DoIdempotencyConflictError);
  });

  it("no idempotency context: behaves exactly as before (no dedup row)", () => {
    const { db, rawDb } = createTestDb();
    entityOps.create(
      db,
      { id: "e4", type: "task", data: { n: 0 }, created_by: "test" },
      1,
      { actor: "test" },
    );
    const claim = coordinationOps.acquire(
      db,
      "e4",
      "m",
      "u",
      "exclusive",
      60_000,
    );

    entityOps.update(db, "e4", { n: 1 }, claim.fence, ORIGIN);
    const rows = rawDb
      .prepare("SELECT COUNT(*) AS n FROM _do_idempotency")
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});
