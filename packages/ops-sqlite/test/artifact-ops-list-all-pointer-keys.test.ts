import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAllPointerKeys } from "../src/artifact-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

function insertPointer(db: TestDb, r2_key: string, tombstoned: number): void {
  testDb.rawDb
    .prepare(
      `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned)
       VALUES(?, NULL, 'output', 'deadbeef', 100, NULL, 'text/plain', ${Date.now()}, 'test-actor', NULL, ?)`,
    )
    .run(r2_key, tombstoned);
}

describe("listAllPointerKeys", () => {
  it("returns all r2_keys including tombstoned ones (no opts = unbounded)", () => {
    insertPointer(testDb, "produced/T-1/aaa.md", 0);
    insertPointer(testDb, "produced/T-2/bbb.md", 0);
    insertPointer(testDb, "sources/ccc.bin", 1); // tombstoned

    const result = listAllPointerKeys(testDb.db);

    expect(result.keys).toHaveLength(3);
    expect(result.keys).toContain("produced/T-1/aaa.md");
    expect(result.keys).toContain("produced/T-2/bbb.md");
    expect(result.keys).toContain("sources/ccc.bin");
    expect(result.nextCursor).toBeNull();
  });

  it("returns empty keys and null nextCursor when no pointers exist", () => {
    const result = listAllPointerKeys(testDb.db);
    expect(result.keys).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns keys in stable alphabetical order", () => {
    insertPointer(testDb, "sources/zzz.bin", 0);
    insertPointer(testDb, "produced/T-1/aaa.md", 0);
    insertPointer(testDb, "produced/T-2/bbb.md", 1);

    const result = listAllPointerKeys(testDb.db);

    expect(result.keys).toEqual([
      "produced/T-1/aaa.md",
      "produced/T-2/bbb.md",
      "sources/zzz.bin",
    ]);
    expect(result.nextCursor).toBeNull();
  });

  // ── Pagination tests (Task 8 — TDD RED → GREEN) ─────────────────────────

  it("paginates: returns first page and a non-null nextCursor when limit < total", () => {
    insertPointer(testDb, "produced/T-1/aaa.md", 0);
    insertPointer(testDb, "produced/T-2/bbb.md", 0);
    insertPointer(testDb, "sources/ccc.bin", 0);

    const result = listAllPointerKeys(testDb.db, { limit: 2 });

    expect(result.keys).toHaveLength(2);
    expect(result.keys).toEqual(["produced/T-1/aaa.md", "produced/T-2/bbb.md"]);
    expect(result.nextCursor).not.toBeNull();
  });

  it("paginates: cursor-based second page returns remaining keys with null nextCursor", () => {
    insertPointer(testDb, "produced/T-1/aaa.md", 0);
    insertPointer(testDb, "produced/T-2/bbb.md", 0);
    insertPointer(testDb, "sources/ccc.bin", 0);

    const page1 = listAllPointerKeys(testDb.db, { limit: 2 });
    expect(page1.nextCursor).not.toBeNull();
    const cursor = page1.nextCursor;
    if (!cursor) throw new Error("expected nextCursor to be non-null");

    const page2 = listAllPointerKeys(testDb.db, { limit: 2, cursor });

    expect(page2.keys).toHaveLength(1);
    expect(page2.keys).toEqual(["sources/ccc.bin"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("paginates: full drain across pages yields every key exactly once", () => {
    for (let i = 0; i < 7; i++) {
      insertPointer(testDb, `produced/T-${i}/blob.bin`, 0);
    }

    const allKeys: string[] = [];
    let cursor: string | null = null;
    do {
      const result = listAllPointerKeys(testDb.db, {
        limit: 3,
        cursor: cursor ?? undefined,
      });
      allKeys.push(...result.keys);
      cursor = result.nextCursor;
    } while (cursor !== null);

    expect(allKeys).toHaveLength(7);
    // All distinct
    expect(new Set(allKeys).size).toBe(7);
  });

  it("paginates: returns null nextCursor when limit equals total", () => {
    insertPointer(testDb, "produced/T-1/aaa.md", 0);
    insertPointer(testDb, "produced/T-2/bbb.md", 0);

    const result = listAllPointerKeys(testDb.db, { limit: 2 });

    expect(result.keys).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("paginates: includes tombstoned records in pages", () => {
    insertPointer(testDb, "produced/T-1/live.md", 0);
    insertPointer(testDb, "produced/T-2/dead.md", 1); // tombstoned
    insertPointer(testDb, "sources/also-live.bin", 0);

    const page1 = listAllPointerKeys(testDb.db, { limit: 2 });
    const cursor = page1.nextCursor;
    if (!cursor) throw new Error("expected nextCursor to be non-null");
    const page2 = listAllPointerKeys(testDb.db, { limit: 2, cursor });

    const allKeys = [...page1.keys, ...page2.keys];
    expect(allKeys).toContain("produced/T-2/dead.md"); // tombstoned included
    expect(allKeys).toHaveLength(3);
  });
});
