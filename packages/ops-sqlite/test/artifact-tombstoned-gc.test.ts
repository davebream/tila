import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteTombstonedPointers,
  tombstonePointer,
  upsertPointer,
} from "../src/artifact-ops";
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
  opts?: { tombstoned?: number; tombstoned_at?: number | null },
): void {
  const tombstoned = opts?.tombstoned ?? 0;
  const tombstoned_at =
    opts?.tombstoned_at !== undefined ? opts.tombstoned_at : null;
  db.rawDb
    .prepare(
      `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned, tombstoned_at)
       VALUES(?, NULL, 'output', 'deadbeef', 100, NULL, 'text/plain', ${Date.now()}, 'test-actor', NULL, ?, ?)`,
    )
    .run(r2Key, tombstoned, tombstoned_at);
}

describe("deleteTombstonedPointers", () => {
  it("deletes rows where tombstoned=1 AND tombstoned_at < cutoff", () => {
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const cutoff = now - sevenDaysMs;

    // tombstoned past grace (should be deleted)
    insertPointer(testDb, "produced/a/old.bin", {
      tombstoned: 1,
      tombstoned_at: cutoff - 1000,
    });
    // tombstoned within grace (should NOT be deleted)
    insertPointer(testDb, "produced/b/fresh.bin", {
      tombstoned: 1,
      tombstoned_at: cutoff + 1000,
    });
    // tombstoned but tombstoned_at IS NULL (should NOT be deleted)
    insertPointer(testDb, "produced/c/null-ts.bin", {
      tombstoned: 1,
      tombstoned_at: null,
    });
    // live pointer (should NOT be deleted)
    insertPointer(testDb, "produced/d/live.bin", {
      tombstoned: 0,
      tombstoned_at: null,
    });

    const deleted = deleteTombstonedPointers(testDb.db, cutoff);
    expect(deleted).toBe(1);

    const remaining = testDb.rawDb
      .prepare("SELECT r2_key FROM artifact_pointers ORDER BY r2_key")
      .all() as { r2_key: string }[];
    const keys = remaining.map((r) => r.r2_key);
    expect(keys).not.toContain("produced/a/old.bin");
    expect(keys).toContain("produced/b/fresh.bin");
    expect(keys).toContain("produced/c/null-ts.bin");
    expect(keys).toContain("produced/d/live.bin");
  });

  it("returns 0 when no rows match the cutoff", () => {
    const now = Date.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    // Row within grace
    insertPointer(testDb, "produced/e/new.bin", {
      tombstoned: 1,
      tombstoned_at: cutoff + 5000,
    });
    const deleted = deleteTombstonedPointers(testDb.db, cutoff);
    expect(deleted).toBe(0);
  });

  it("returns 0 when table is empty", () => {
    const deleted = deleteTombstonedPointers(testDb.db, Date.now());
    expect(deleted).toBe(0);
  });
});

describe("tombstonePointer stamps tombstoned_at", () => {
  it("sets tombstoned_at when tombstoning a pointer", () => {
    const before = Date.now();
    // Insert via upsertPointer (no tombstoned_at yet)
    upsertPointer(
      testDb.db,
      {
        r2_key: "produced/f/test.bin",
        resource: null,
        kind: "output",
        sha256: "sha-f",
        bytes: 100,
        fence: null,
        mime_type: "application/octet-stream",
        produced_at: before,
        produced_by: "test",
        expires_at: null,
      },
      { actor: "test" },
    );

    const tsBefore = testDb.rawDb
      .prepare(
        "SELECT tombstoned_at FROM artifact_pointers WHERE r2_key = 'produced/f/test.bin'",
      )
      .get() as { tombstoned_at: number | null };
    expect(tsBefore.tombstoned_at).toBeNull();

    tombstonePointer(testDb.db, "produced/f/test.bin", { actor: "sweep-cron" });
    const after = Date.now();

    const row = testDb.rawDb
      .prepare(
        "SELECT tombstoned, tombstoned_at FROM artifact_pointers WHERE r2_key = 'produced/f/test.bin'",
      )
      .get() as { tombstoned: number; tombstoned_at: number | null };

    expect(row.tombstoned).toBe(1);
    expect(row.tombstoned_at).not.toBeNull();
    expect(row.tombstoned_at).toBeGreaterThanOrEqual(before);
    expect(row.tombstoned_at).toBeLessThanOrEqual(after);
  });
});
