/**
 * Tests for sweep-ops tombstone grace deletion (C1) and integration with sweep().
 *
 * The sweep function now:
 *   1. Calls deleteTombstonedPointers(db, now - TOMBSTONE_GRACE_MS) before the
 *      main transaction (hard-deletes pointers past grace).
 *   2. Returns tombstonedPointersDeleted in the SweepResult.
 *
 * The ordering constraint (tombstone-before-R2-delete) lives in the Worker's
 * runSweep() in packages/worker/src/index.ts and is tested at the integration
 * level in packages/integration-tests/src/sweep.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOMBSTONE_GRACE_MS, sweep } from "../src/sweep-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

function insertTombstonedPointer(
  db: TestDb,
  r2Key: string,
  tombstonedAt: number | null,
): void {
  // blob_deleted_at mirrors tombstoned_at: these rows represent the normal
  // successful-sweep case (blob delete confirmed), which is what makes them
  // eligible for the time-grace hard-delete under test here.
  db.rawDb
    .prepare(
      `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned, tombstoned_at, blob_deleted_at)
       VALUES(?, NULL, 'output', 'deadbeef', 100, NULL, 'text/plain', ${Date.now()}, 'test-actor', NULL, 1, ?, ?)`,
    )
    .run(r2Key, tombstonedAt, tombstonedAt);
}

describe("TOMBSTONE_GRACE_MS constant", () => {
  it("is 7 days in milliseconds (604800000)", () => {
    expect(TOMBSTONE_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("sweep tombstonedPointersDeleted field", () => {
  it("returns tombstonedPointersDeleted = 0 when no rows qualify", () => {
    const result = sweep(testDb.db, Date.now());
    expect(result.tombstonedPointersDeleted).toBe(0);
  });

  it("returns tombstonedPointersDeleted count when rows past grace are deleted", () => {
    const now = Date.now();
    const cutoff = now - TOMBSTONE_GRACE_MS;

    // Two rows past grace
    insertTombstonedPointer(testDb, "produced/a/old.bin", cutoff - 1000);
    insertTombstonedPointer(testDb, "produced/b/older.bin", cutoff - 2000);
    // One row within grace
    insertTombstonedPointer(testDb, "produced/c/fresh.bin", cutoff + 5000);
    // One row with NULL tombstoned_at
    insertTombstonedPointer(testDb, "produced/d/null.bin", null);

    const result = sweep(testDb.db, now);
    expect(result.tombstonedPointersDeleted).toBe(2);

    // Check that fresh and null rows remain
    const remaining = testDb.rawDb
      .prepare("SELECT r2_key FROM artifact_pointers ORDER BY r2_key")
      .all() as { r2_key: string }[];
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.r2_key)).toContain("produced/c/fresh.bin");
    expect(remaining.map((r) => r.r2_key)).toContain("produced/d/null.bin");
  });

  it("tombstoned row whose tombstoned_at is exactly the cutoff is NOT deleted (strict less-than)", () => {
    const now = Date.now();
    const cutoff = now - TOMBSTONE_GRACE_MS;
    insertTombstonedPointer(testDb, "produced/e/boundary.bin", cutoff);

    const result = sweep(testDb.db, now);
    // tombstoned_at = cutoff is NOT < cutoff, so it should not be deleted
    expect(result.tombstonedPointersDeleted).toBe(0);
  });
});
