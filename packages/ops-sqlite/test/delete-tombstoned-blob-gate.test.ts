import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteTombstonedPointers } from "../src/artifact-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

function insertPointer(
  db: TestDb,
  r2Key: string,
  opts: { tombstoned_at: number | null; blob_deleted_at: number | null },
): void {
  db.rawDb
    .prepare(
      `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned, tombstoned_at, blob_deleted_at)
       VALUES(?, NULL, 'output', 'deadbeef', 100, NULL, 'text/plain', ${Date.now()}, 'test-actor', NULL, 1, ?, ?)`,
    )
    .run(r2Key, opts.tombstoned_at, opts.blob_deleted_at);
}

// Finding #2: a tombstoned pointer whose R2 blob delete permanently FAILED must
// not be hard-deleted on the time grace alone — doing so strands the orphan
// blob. The hard-delete is now gated on a confirmed blob deletion
// (blob_deleted_at IS NOT NULL).
describe("deleteTombstonedPointers gates on confirmed blob deletion", () => {
  it("retains a past-grace tombstoned pointer whose blob deletion is unconfirmed", () => {
    const now = Date.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;

    // Past grace, but blob delete never confirmed -> must be RETAINED.
    insertPointer(testDb, "produced/a/unconfirmed.bin", {
      tombstoned_at: cutoff - 1000,
      blob_deleted_at: null,
    });

    const deleted = deleteTombstonedPointers(testDb.db, cutoff);
    expect(deleted).toBe(0);

    const remaining = testDb.rawDb
      .prepare("SELECT r2_key FROM artifact_pointers")
      .all() as { r2_key: string }[];
    expect(remaining.map((r) => r.r2_key)).toContain(
      "produced/a/unconfirmed.bin",
    );
  });

  it("deletes a past-grace tombstoned pointer whose blob deletion is confirmed", () => {
    const now = Date.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;

    insertPointer(testDb, "produced/b/confirmed.bin", {
      tombstoned_at: cutoff - 1000,
      blob_deleted_at: cutoff - 1000,
    });

    const deleted = deleteTombstonedPointers(testDb.db, cutoff);
    expect(deleted).toBe(1);

    const remaining = testDb.rawDb
      .prepare("SELECT r2_key FROM artifact_pointers")
      .all() as { r2_key: string }[];
    expect(remaining.map((r) => r.r2_key)).not.toContain(
      "produced/b/confirmed.bin",
    );
  });
});
