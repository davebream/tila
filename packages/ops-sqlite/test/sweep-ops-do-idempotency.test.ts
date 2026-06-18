/**
 * Tests for sweep-ops _do_idempotency TTL prune and integration with sweep().
 *
 * The sweep function now:
 *   1. Deletes _do_idempotency rows with created_at < (now - DO_IDEMPOTENCY_TTL_MS)
 *      inside the main transaction (strict less-than — the at-cutoff row is retained).
 *   2. Returns doIdempotencyDeleted in the SweepResult.
 *
 * The prune uses the same readChanges(tx) count pattern as other sweep deletes.
 * The exactly-at-cutoff row is retained (exclusive boundary), mirroring the
 * deleteTombstonedPointers age-cutoff precedent in sweep-ops-tombstone.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DO_IDEMPOTENCY_TTL_MS, sweep } from "../src/sweep-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

function insertDoIdempotencyRow(
  db: TestDb,
  key: string,
  createdAt: number,
): void {
  db.rawDb
    .prepare(
      "INSERT INTO _do_idempotency(key, request_hash, status_code, response_json, created_at) VALUES(?, NULL, 200, '{}', ?)",
    )
    .run(key, createdAt);
}

describe("DO_IDEMPOTENCY_TTL_MS constant", () => {
  it("is 7 days in milliseconds (604800000)", () => {
    expect(DO_IDEMPOTENCY_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("sweep doIdempotencyDeleted field", () => {
  it("deletes stale rows, retains fresh rows, and reports count = 2", () => {
    const now = 1_700_000_000_000;
    const cutoff = now - DO_IDEMPOTENCY_TTL_MS;

    // Two stale rows (older than TTL)
    insertDoIdempotencyRow(testDb, "stale-1", cutoff - 1);
    insertDoIdempotencyRow(testDb, "stale-2", cutoff - 2);
    // One fresh row (within TTL)
    insertDoIdempotencyRow(testDb, "fresh-1", now - 1_000);

    const result = sweep(testDb.db, now);
    expect(result.doIdempotencyDeleted).toBe(2);

    // Fresh row must remain
    const remaining = testDb.rawDb
      .prepare("SELECT key FROM _do_idempotency ORDER BY key")
      .all() as { key: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].key).toBe("fresh-1");
  });

  it("retains a row at exactly the cutoff (strict less-than, exclusive boundary)", () => {
    const now = 1_700_000_000_000;
    const cutoff = now - DO_IDEMPOTENCY_TTL_MS;

    // Row exactly at the cutoff — must NOT be deleted
    insertDoIdempotencyRow(testDb, "boundary", cutoff);

    const result = sweep(testDb.db, now);
    // created_at = cutoff is NOT < cutoff, so it must be retained
    expect(result.doIdempotencyDeleted).toBe(0);

    const remaining = testDb.rawDb
      .prepare("SELECT key FROM _do_idempotency")
      .all() as { key: string }[];
    expect(remaining).toHaveLength(1);
  });

  it("returns doIdempotencyDeleted = 0 when only fresh rows exist (no-op)", () => {
    const now = 1_700_000_000_000;

    // Only within-TTL rows — nothing to prune; both must survive.
    insertDoIdempotencyRow(testDb, "fresh-a", now - 1_000);
    insertDoIdempotencyRow(testDb, "fresh-b", now - 2_000);

    const result = sweep(testDb.db, now);
    expect(result.doIdempotencyDeleted).toBe(0);

    const remaining = testDb.rawDb
      .prepare("SELECT key FROM _do_idempotency")
      .all() as { key: string }[];
    expect(remaining).toHaveLength(2);
  });

  it("reports doIdempotencyDeleted independently of other in-transaction deletes", () => {
    // Guards the readChanges() cross-table attribution invariant: with an
    // expired claim ALSO swept in the same transaction (its own delete +
    // readChanges runs before the idempotency prune), doIdempotencyDeleted must
    // reflect ONLY the _do_idempotency rows, not the claim delete's count.
    const now = 1_700_000_000_000;
    const cutoff = now - DO_IDEMPOTENCY_TTL_MS;

    // One expired claim (claims.expires_at <= now → swept), count 1.
    testDb.rawDb
      .prepare(
        `INSERT INTO claims(resource, holder, machine, user, mode, fence, acquired_at, expires_at, metadata)
         VALUES('task:gc', 'm1/u1', 'm1', 'u1', 'exclusive', 1, ?, ?, '{}')`,
      )
      .run(now - 2_000, now - 1_000);
    // Two stale idempotency rows (count 2) + one fresh (retained).
    insertDoIdempotencyRow(testDb, "stale-x", cutoff - 1);
    insertDoIdempotencyRow(testDb, "stale-y", cutoff - 2);
    insertDoIdempotencyRow(testDb, "fresh-z", now - 1_000);

    const result = sweep(testDb.db, now);

    // Each count is attributed to its own DELETE, uncontaminated by the others.
    expect(result.claimsDeleted).toBe(1);
    expect(result.doIdempotencyDeleted).toBe(2);

    const remaining = testDb.rawDb
      .prepare("SELECT key FROM _do_idempotency ORDER BY key")
      .all() as { key: string }[];
    expect(remaining.map((r) => r.key)).toEqual(["fresh-z"]);
  });
});
