/**
 * Tests for listSearchablePointers (C6) — read-only helper for reconcile.
 * No Cloudflare types — this is a pure SQLite read.
 */
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSearchablePointers } from "../src/artifact-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

/** Insert a minimal artifact_pointers row. */
function insertPointer(
  db: TestDb,
  r2Key: string,
  opts?: { tombstoned?: number; kind?: string; resource?: string | null },
): void {
  const tombstoned = opts?.tombstoned ?? 0;
  const kind = opts?.kind ?? "output";
  const resource = opts?.resource ?? null;
  db.rawDb
    .prepare(
      `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned)
       VALUES(?, ?, ?, 'sha-abc', 100, NULL, 'text/markdown', ${Date.now()}, 'test-actor', NULL, ?)`,
    )
    .run(r2Key, resource, kind, tombstoned);
}

/** Insert a minimal artifact_search_docs row. */
function insertSearchDoc(
  db: TestDb,
  artifactKey: string,
  opts?: { tombstoned?: number },
): void {
  const tombstoned = opts?.tombstoned ?? 0;
  db.db.run(
    sql`INSERT INTO artifact_search_docs(artifact_key, kind, mime_type, resource, title, body_text, indexed_at, source_sha256, tombstoned)
        VALUES(${artifactKey}, ${"output"}, ${"text/markdown"}, ${null}, ${"Title"}, ${"Body text"}, ${Date.now()}, ${"sha-abc"}, ${tombstoned})`,
  );
}

describe("listSearchablePointers", () => {
  it("returns rows with r2_key, resource, kind, sha256 for non-tombstoned searchable pointers", () => {
    insertPointer(testDb, "produced/a/doc.md", { kind: "report" });
    insertSearchDoc(testDb, "produced/a/doc.md");

    const rows = listSearchablePointers(testDb.db, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].r2_key).toBe("produced/a/doc.md");
    expect(rows[0].kind).toBe("report");
    expect(rows[0].sha256).toBe("sha-abc");
    expect(rows[0].resource).toBeNull();
  });

  it("excludes tombstoned artifact pointers", () => {
    insertPointer(testDb, "produced/b/dead.md", { tombstoned: 1 });
    insertSearchDoc(testDb, "produced/b/dead.md");

    const rows = listSearchablePointers(testDb.db, 100);
    expect(rows).toHaveLength(0);
  });

  it("excludes pointers with tombstoned search docs", () => {
    insertPointer(testDb, "produced/c/doc.md");
    insertSearchDoc(testDb, "produced/c/doc.md", { tombstoned: 1 });

    const rows = listSearchablePointers(testDb.db, 100);
    expect(rows).toHaveLength(0);
  });

  it("excludes pointers with no search doc (not searchable)", () => {
    insertPointer(testDb, "produced/d/binary.bin", { kind: "binary" });
    // No search doc inserted

    const rows = listSearchablePointers(testDb.db, 100);
    expect(rows).toHaveLength(0);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      insertPointer(testDb, `produced/${i}/doc.md`);
      insertSearchDoc(testDb, `produced/${i}/doc.md`);
    }

    const rows = listSearchablePointers(testDb.db, 3);
    expect(rows).toHaveLength(3);
  });

  it("returns empty array when no pointers exist", () => {
    const rows = listSearchablePointers(testDb.db, 100);
    expect(rows).toHaveLength(0);
  });
});
