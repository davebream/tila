/**
 * C7 — Fence-resource convention unification tests.
 *
 * Canonical entity claim+fence resource is `<type>:<id>`. These tests verify:
 *   a) Migration 17 backfills `<type>:<id>` fence row = MAX(typed, bare)
 *   b) `assertResourceFence` canonicalizes bare entity ids → `<type>:<id>` via
 *      entity-existence lookup (before exact-match shortcut)
 *   c) `record:type/key` resources are NOT canonicalized (exact-match only)
 *   d) `compactEntity` claim lookup still resolves (no regression)
 *   e) A stale bare-row fence is rejected after migration
 */
import { FenceError } from "@tila/core";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
  FenceNotFoundError,
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type MigrationStorage,
  coordinationOps,
  entityOps,
  fenceOps,
  schema,
} from "../../ops-sqlite/src";

const { assertResourceFence } = fenceOps;
const {
  compactEntity,
  create: createEntity,
  update,
  getCompactEntityStats,
} = entityOps;
const { acquire } = coordinationOps;

// Cloudflare's SQLite fork supports COALESCE in PRIMARY KEY; standard SQLite does not.
function patchMigration(sql: string): string {
  return sql.replace(
    "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
    "PRIMARY KEY (from_key, type)",
  );
}

function createStorage(
  rawDb: InstanceType<typeof Database>,
): MigrationStorage & { transactionSync<T>(callback: () => T): T } {
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
    transactionSync<T>(callback: () => T): T {
      return rawDb.transaction(callback)();
    },
  };
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

function insertEntity(
  rawDb: InstanceType<typeof Database>,
  id: string,
  type: string,
): void {
  const now = Date.now();
  rawDb
    .prepare(
      "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, 1, '{}', 0, ?, ?, 'test')",
    )
    .run(id, type, now, now);
}

function insertFence(
  rawDb: InstanceType<typeof Database>,
  resource: string,
  currentFence: number,
): void {
  rawDb
    .prepare("INSERT INTO fences (resource, current_fence) VALUES (?, ?)")
    .run(resource, currentFence);
}

// ---------------------------------------------------------------------------
// Migration 17 backfill tests
// ---------------------------------------------------------------------------

describe("migration 17 — fence backfill", () => {
  it("backfills typed fence row = MAX(typed, bare) when both exist", () => {
    const { rawDb } = createTestDb();

    insertEntity(rawDb, "ent-backfill-1", "task");
    // bare-id row with higher fence (simulates old acquire convention)
    insertFence(rawDb, "ent-backfill-1", 10);
    // typed row with lower fence
    insertFence(rawDb, "task:ent-backfill-1", 5);

    // Manually re-run migration 17 (it was already run by createTestDb, so
    // we need to test its backfill logic independently by inserting AFTER migration)
    // Simulate re-run by deleting _migrations record and re-running
    rawDb.prepare("DELETE FROM _migrations WHERE version = 17").run();
    const storage = createStorage(rawDb);
    const m17 = MIGRATIONS.find((m) => m.version === 17);
    if (!m17 || !("run" in m17))
      throw new Error("Migration 17 not found or not a run migration");
    m17.run(storage);

    const typedRow = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("task:ent-backfill-1") as { current_fence: number } | undefined;
    expect(typedRow?.current_fence).toBe(10); // MAX(5, 10) = 10
  });

  it("creates typed fence row from bare row when typed row is absent", () => {
    const { rawDb } = createTestDb();

    insertEntity(rawDb, "ent-backfill-2", "task");
    insertFence(rawDb, "ent-backfill-2", 7);
    // no typed row yet

    rawDb.prepare("DELETE FROM _migrations WHERE version = 17").run();
    const storage = createStorage(rawDb);
    const m17 = MIGRATIONS.find((m) => m.version === 17);
    if (!m17 || !("run" in m17))
      throw new Error("Migration 17 not found or not a run migration");
    m17.run(storage);

    const typedRow = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("task:ent-backfill-2") as { current_fence: number } | undefined;
    expect(typedRow?.current_fence).toBe(7);
  });

  it("does not decrease typed fence when typed row is higher", () => {
    const { rawDb } = createTestDb();

    insertEntity(rawDb, "ent-backfill-3", "task");
    insertFence(rawDb, "ent-backfill-3", 3); // bare row: 3
    insertFence(rawDb, "task:ent-backfill-3", 8); // typed row: 8 (higher)

    rawDb.prepare("DELETE FROM _migrations WHERE version = 17").run();
    const storage = createStorage(rawDb);
    const m17 = MIGRATIONS.find((m) => m.version === 17);
    if (!m17 || !("run" in m17))
      throw new Error("Migration 17 not found or not a run migration");
    m17.run(storage);

    const typedRow = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("task:ent-backfill-3") as { current_fence: number } | undefined;
    expect(typedRow?.current_fence).toBe(8); // MAX(8, 3) = 8 — not decreased
  });

  it("is idempotent (safe to run multiple times)", () => {
    const { rawDb } = createTestDb();

    insertEntity(rawDb, "ent-backfill-4", "task");
    insertFence(rawDb, "ent-backfill-4", 5);
    insertFence(rawDb, "task:ent-backfill-4", 3);

    const storage = createStorage(rawDb);
    const m17 = MIGRATIONS.find((m) => m.version === 17);
    if (!m17 || !("run" in m17))
      throw new Error("Migration 17 not found or not a run migration");

    // Run twice
    rawDb.prepare("DELETE FROM _migrations WHERE version = 17").run();
    m17.run(storage);
    rawDb.prepare("DELETE FROM _migrations WHERE version = 17").run();
    m17.run(storage);

    const typedRow = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("task:ent-backfill-4") as { current_fence: number } | undefined;
    expect(typedRow?.current_fence).toBe(5);
  });

  it("does not touch fence rows for non-entity resources (record:type/key)", () => {
    const { rawDb } = createTestDb();

    insertFence(rawDb, "record:deploy-config/prod", 4);

    rawDb.prepare("DELETE FROM _migrations WHERE version = 17").run();
    const storage = createStorage(rawDb);
    const m17 = MIGRATIONS.find((m) => m.version === 17);
    if (!m17 || !("run" in m17))
      throw new Error("Migration 17 not found or not a run migration");
    m17.run(storage);

    const row = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("record:deploy-config/prod") as
      | { current_fence: number }
      | undefined;
    expect(row?.current_fence).toBe(4); // unchanged
  });
});

// ---------------------------------------------------------------------------
// assertResourceFence canonicalization tests
// ---------------------------------------------------------------------------

describe("assertResourceFence — entity canonicalization", () => {
  it("bare id resolves to typed fence row after migration backfill", () => {
    const { db, rawDb } = createTestDb();

    insertEntity(rawDb, "ent-canon-1", "task");
    insertFence(rawDb, "task:ent-canon-1", 5);

    // Bare-id lookup should resolve via entity-existence → typed row
    expect(() => assertResourceFence(db, "ent-canon-1", 5)).not.toThrow();
  });

  it("typed resource is resolved directly (exact match)", () => {
    const { db, rawDb } = createTestDb();

    insertEntity(rawDb, "ent-canon-2", "task");
    insertFence(rawDb, "task:ent-canon-2", 3);

    expect(() => assertResourceFence(db, "task:ent-canon-2", 3)).not.toThrow();
  });

  it("bare id and type:id resolve to the SAME fence row and reject the same stale fence", () => {
    const { db, rawDb } = createTestDb();

    insertEntity(rawDb, "ent-same-1", "task");
    insertFence(rawDb, "task:ent-same-1", 6);

    // Both bare and typed reject stale fence 5 (current is 6)
    expect(() => assertResourceFence(db, "ent-same-1", 5)).toThrow(FenceError);
    expect(() => assertResourceFence(db, "task:ent-same-1", 5)).toThrow(
      FenceError,
    );

    // Both accept current fence 6
    expect(() => assertResourceFence(db, "ent-same-1", 6)).not.toThrow();
    expect(() => assertResourceFence(db, "task:ent-same-1", 6)).not.toThrow();
  });

  it("stale bare-row fence is rejected post-migration (bare row is inert, typed row wins)", () => {
    // Simulates a holder that acquired with a bare-id before deploy
    // After migration, typed row has MAX fence (= bare fence pre-migration).
    // A re-acquire (post-migration, using type:id) increments the typed row.
    // The pre-migration bare-fence is now stale.
    const { db, rawDb } = createTestDb();

    insertEntity(rawDb, "ent-stale-1", "task");
    // Pre-migration: bare-id acquire at fence=3
    insertFence(rawDb, "ent-stale-1", 3);
    // Migration 17 would have created task:ent-stale-1 with fence=3
    insertFence(rawDb, "task:ent-stale-1", 3);
    // Post-migration: a new acquire uses type:id, bumping typed fence to 4
    rawDb
      .prepare("UPDATE fences SET current_fence = 4 WHERE resource = ?")
      .run("task:ent-stale-1");

    // The old fence=3 (bare-id holder) should now be rejected
    expect(() => assertResourceFence(db, "ent-stale-1", 3)).toThrow(FenceError);
    // New fence=4 should be accepted
    expect(() => assertResourceFence(db, "ent-stale-1", 4)).not.toThrow();
  });

  it("record:type/key resource is NOT canonicalized — uses exact match only", () => {
    const { db, rawDb } = createTestDb();

    // record resources contain a colon but are not entity ids
    insertFence(rawDb, "record:deploy-config/prod", 2);

    expect(() =>
      assertResourceFence(db, "record:deploy-config/prod", 2),
    ).not.toThrow();

    // A bare "record" lookup (not entity resource) should fail with FenceNotFoundError
    expect(() => assertResourceFence(db, "record", 2)).toThrow(
      FenceNotFoundError,
    );
  });

  it("throws FenceNotFoundError when resource does not exist at all", () => {
    const { db } = createTestDb();

    expect(() => assertResourceFence(db, "nonexistent-id", 1)).toThrow(
      FenceNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// compactEntity regression test (claim lookup must still resolve)
// ---------------------------------------------------------------------------

describe("compactEntity — claim lookup no regression", () => {
  it("resolves claimed_by when claim is stored under type:id (canonical form)", () => {
    const { db, rawDb } = createTestDb();

    // Create entity
    const entity = createEntity(
      db,
      {
        id: "ent-compact-1",
        type: "task",
        data: { name: "Compact entity", status: "open" },
        created_by: "test",
      },
      1,
      { actor: "test" },
    );

    // Acquire under type:id (canonical form — what compactEntity matches)
    const result = acquire(
      db,
      "task:ent-compact-1",
      "machine-a",
      "user-a",
      "exclusive",
      60_000,
    );
    expect(result.acquired).toBe(true);

    // List all active claims (simulates what compactEntity's caller does)
    const allClaims = rawDb
      .prepare(
        "SELECT resource, machine, user FROM claims WHERE expires_at > ?",
      )
      .all(Date.now() - 1_000) as {
      resource: string;
      machine: string;
      user: string;
    }[];

    const stats = getCompactEntityStats(db, [entity.id]);
    const compact = compactEntity(db, entity, allClaims, stats);
    expect(compact.claimed_by).toBe("machine-a/user-a");
  });

  it("claimed_by is null when no active claim exists", () => {
    const { db } = createTestDb();

    const entity = createEntity(
      db,
      {
        id: "ent-compact-2",
        type: "task",
        data: { name: "Unclaimed", status: "open" },
        created_by: "test",
      },
      1,
      { actor: "test" },
    );

    const stats = getCompactEntityStats(db, [entity.id]);
    const compact = compactEntity(db, entity, [], stats);
    expect(compact.claimed_by).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// entity-ops update/archive — fence validation via canonicalization
// ---------------------------------------------------------------------------

describe("entity-ops update/archive with bare-id acquire", () => {
  it("update() accepts fence acquired via bare id (canonicalization bridges the gap)", () => {
    const { db } = createTestDb();

    createEntity(
      db,
      {
        id: "ent-update-bare",
        type: "task",
        data: { name: "Old", status: "open" },
        created_by: "test",
      },
      1,
      { actor: "test" },
    );

    // CLI-style: acquire with bare id
    const result = acquire(
      db,
      "ent-update-bare",
      "m",
      "u",
      "exclusive",
      60_000,
    );
    expect(result.acquired).toBe(true);

    // update() calls assertResourceFence(tx, id, fence) with bare id
    // Canonicalization should route to the typed row created by acquire
    expect(() =>
      update(db, "ent-update-bare", { name: "New" }, result.fence, {
        actor: "test",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Migration 17 is in the version list
// ---------------------------------------------------------------------------

describe("migration runner — version 17 present", () => {
  it("applies migration 17 on a fresh database", () => {
    const rawDb = new Database(":memory:");
    runAllMigrations(rawDb);

    const versions = (
      rawDb
        .prepare("SELECT version FROM _migrations ORDER BY version")
        .all() as { version: number }[]
    ).map((r) => r.version);

    expect(versions).toContain(17);
  });
});

// ---------------------------------------------------------------------------
// acquire write-path canonicalization tests (fix-cycle-1 gap)
// ---------------------------------------------------------------------------

describe("acquire — entity resource write-path canonicalization", () => {
  it("bare-id acquire stores canonical type:id fence row and claim row", () => {
    const { db, rawDb } = createTestDb();

    createEntity(
      db,
      { id: "ent-wr-1", type: "task", data: {}, created_by: "test" },
      1,
      { actor: "test" },
    );

    // Bare-id acquire (CLI / legacy style)
    const result = acquire(db, "ent-wr-1", "m", "u", "exclusive", 60_000);
    expect(result.acquired).toBe(true);

    // Fence row should be stored under canonical key, not bare id
    const typedFence = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("task:ent-wr-1") as { current_fence: number } | undefined;
    expect(typedFence).toBeDefined();
    expect(typedFence?.current_fence).toBe(result.fence);

    // No bare-id fence row should exist
    const bareFence = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("ent-wr-1") as { current_fence: number } | undefined;
    expect(bareFence).toBeUndefined();

    // Claim row should be stored under canonical key
    const typedClaim = rawDb
      .prepare("SELECT resource FROM claims WHERE resource = ?")
      .get("task:ent-wr-1") as { resource: string } | undefined;
    expect(typedClaim).toBeDefined();

    const bareClaim = rawDb
      .prepare("SELECT resource FROM claims WHERE resource = ?")
      .get("ent-wr-1") as { resource: string } | undefined;
    expect(bareClaim).toBeUndefined();
  });

  it("bare-id acquire + typed-resource update produces ONE fence row (no divergence)", () => {
    const { db, rawDb } = createTestDb();

    createEntity(
      db,
      {
        id: "ent-nodiv",
        type: "task",
        data: { name: "x", status: "open" },
        created_by: "test",
      },
      1,
      { actor: "test" },
    );

    // Bare-id acquire
    const result = acquire(db, "ent-nodiv", "m", "u", "exclusive", 60_000);
    expect(result.acquired).toBe(true);

    // update() uses bare id → assertResourceFence → canonical typed row
    expect(() =>
      update(db, "ent-nodiv", { name: "y" }, result.fence, { actor: "test" }),
    ).not.toThrow();

    // After the whole round-trip exactly ONE fence row must exist
    const fenceRows = rawDb
      .prepare(
        "SELECT resource FROM fences WHERE resource IN ('ent-nodiv', 'task:ent-nodiv')",
      )
      .all() as { resource: string }[];
    expect(fenceRows).toHaveLength(1);
    expect(fenceRows[0].resource).toBe("task:ent-nodiv");
  });

  it("bare-id acquire — compactEntity resolves claimed_by (no null regression)", () => {
    const { db, rawDb } = createTestDb();

    const entity = createEntity(
      db,
      { id: "ent-cbr", type: "task", data: {}, created_by: "test" },
      1,
      { actor: "test" },
    );

    // Bare-id acquire (what CLI remote.ts does)
    const result = acquire(
      db,
      "ent-cbr",
      "machine-x",
      "user-x",
      "exclusive",
      60_000,
    );
    expect(result.acquired).toBe(true);

    // compactEntity matches claims by `${type}:${id}` — must find the canonical claim
    const allClaims = rawDb
      .prepare(
        "SELECT resource, machine, user FROM claims WHERE expires_at > ?",
      )
      .all(Date.now() - 1_000) as {
      resource: string;
      machine: string;
      user: string;
    }[];

    const stats = getCompactEntityStats(db, [entity.id]);
    const compact = compactEntity(db, entity, allClaims, stats);
    expect(compact.claimed_by).toBe("machine-x/user-x");
  });

  it("record resource acquire is NOT canonicalized", () => {
    const { db, rawDb } = createTestDb();

    const result = acquire(
      db,
      "record:deploy-config/prod",
      "m",
      "u",
      "exclusive",
      60_000,
    );
    expect(result.acquired).toBe(true);

    // Fence row must be under the original key (exact match)
    const fenceRow = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("record:deploy-config/prod") as
      | { current_fence: number }
      | undefined;
    expect(fenceRow).toBeDefined();
    expect(fenceRow?.current_fence).toBe(result.fence);
  });

  it("arbitrary non-entity resource acquire is NOT canonicalized", () => {
    const { db, rawDb } = createTestDb();

    const result = acquire(
      db,
      "pipeline:build-42",
      "m",
      "u",
      "exclusive",
      60_000,
    );
    expect(result.acquired).toBe(true);

    const fenceRow = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("pipeline:build-42") as { current_fence: number } | undefined;
    expect(fenceRow).toBeDefined();
    expect(fenceRow?.current_fence).toBe(result.fence);
  });
});

// ---------------------------------------------------------------------------
// Migration 17 backfill boundary cases
// ---------------------------------------------------------------------------

describe("migration 17 — backfill boundary cases", () => {
  it("MAX(n, n) equal values — typed row keeps the same value (no spurious increment)", () => {
    const { rawDb } = createTestDb();

    insertEntity(rawDb, "ent-equal", "task");
    insertFence(rawDb, "ent-equal", 5);
    insertFence(rawDb, "task:ent-equal", 5); // both same

    rawDb.prepare("DELETE FROM _migrations WHERE version = 17").run();
    const storage = createStorage(rawDb);
    const m17 = MIGRATIONS.find((m) => m.version === 17);
    if (!m17 || !("run" in m17)) throw new Error("Migration 17 not found");
    m17.run(storage);

    const typedRow = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("task:ent-equal") as { current_fence: number } | undefined;
    expect(typedRow?.current_fence).toBe(5); // unchanged
  });

  it("entity with NO fence rows — migration is a no-op (no row created)", () => {
    const { rawDb } = createTestDb();

    insertEntity(rawDb, "ent-nofence", "task");
    // No fence rows at all

    rawDb.prepare("DELETE FROM _migrations WHERE version = 17").run();
    const storage = createStorage(rawDb);
    const m17 = MIGRATIONS.find((m) => m.version === 17);
    if (!m17 || !("run" in m17)) throw new Error("Migration 17 not found");
    m17.run(storage);

    const typedRow = rawDb
      .prepare("SELECT current_fence FROM fences WHERE resource = ?")
      .get("task:ent-nofence") as { current_fence: number } | undefined;
    expect(typedRow).toBeUndefined(); // still no row — migration only backfills bare-id rows
  });
});
