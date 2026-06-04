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
  it("returns all r2_keys including tombstoned ones", () => {
    insertPointer(testDb, "produced/T-1/aaa.md", 0);
    insertPointer(testDb, "produced/T-2/bbb.md", 0);
    insertPointer(testDb, "sources/ccc.bin", 1); // tombstoned

    const keys = listAllPointerKeys(testDb.db);

    expect(keys).toHaveLength(3);
    expect(keys).toContain("produced/T-1/aaa.md");
    expect(keys).toContain("produced/T-2/bbb.md");
    expect(keys).toContain("sources/ccc.bin");
  });

  it("returns empty array when no pointers exist", () => {
    const keys = listAllPointerKeys(testDb.db);
    expect(keys).toEqual([]);
  });

  it("returns keys in stable alphabetical order", () => {
    insertPointer(testDb, "sources/zzz.bin", 0);
    insertPointer(testDb, "produced/T-1/aaa.md", 0);
    insertPointer(testDb, "produced/T-2/bbb.md", 1);

    const keys = listAllPointerKeys(testDb.db);

    expect(keys).toEqual([
      "produced/T-1/aaa.md",
      "produced/T-2/bbb.md",
      "sources/zzz.bin",
    ]);
  });
});
