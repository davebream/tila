import { artifactOps, type schema } from "@tila/ops-sqlite";
import type Database from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/create-test-db";

type SearchRebuildCandidate = artifactOps.SearchRebuildCandidate;
const { rebuildSearchDocs } = artifactOps;

function insertPointer(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  key: string,
  opts: {
    kind?: string;
    sha256?: string;
    tombstoned?: number;
    mime_type?: string;
    resource?: string | null;
  } = {},
) {
  const sqlite = (db as unknown as { session: { client: Database.Database } })
    .session.client;
  sqlite.exec(`
    INSERT INTO artifact_pointers (r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned)
    VALUES ('${key}', ${opts.resource === undefined ? "NULL" : `'${opts.resource}'`}, '${opts.kind ?? "lesson"}', '${opts.sha256 ?? "abc123"}', 100, NULL, '${opts.mime_type ?? "text/markdown"}', ${Date.now()}, 'test', NULL, ${opts.tombstoned ?? 0})
  `);
}

function insertSearchDoc(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  key: string,
  opts: {
    source_sha256?: string;
    tombstoned?: number;
    kind?: string;
  } = {},
) {
  const sqlite = (db as unknown as { session: { client: Database.Database } })
    .session.client;
  sqlite.exec(`
    INSERT INTO artifact_search_docs (artifact_key, kind, mime_type, resource, title, body_text, indexed_at, source_sha256, tombstoned)
    VALUES ('${key}', '${opts.kind ?? "lesson"}', 'text/markdown', NULL, 'Test', 'body', ${Date.now()}, '${opts.source_sha256 ?? "abc123"}', ${opts.tombstoned ?? 0})
  `);
}

function getSearchDoc(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  key: string,
) {
  const sqlite = (db as unknown as { session: { client: Database.Database } })
    .session.client;
  return sqlite
    .prepare("SELECT * FROM artifact_search_docs WHERE artifact_key = ?")
    .get(key) as Record<string, unknown> | undefined;
}

describe("rebuildSearchDocs", () => {
  it("returns all zeros for empty candidates list", () => {
    const { db } = createTestDb();
    const result = rebuildSearchDocs(db, [], { actor: "test-actor" }, false);
    expect(result.candidates_found).toBe(0);
    expect(result.written).toBe(0);
    expect(result.tombstoned).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.unrecoverable).toBe(0);
    expect(result.details).toHaveLength(0);
  });

  it("reports skipped in dry-run when pointer has no search doc", () => {
    const { db } = createTestDb();
    insertPointer(db, "produced/res1/abc123.md");
    const candidates: SearchRebuildCandidate[] = [
      {
        artifact_key: "produced/res1/abc123.md",
        kind: "lesson",
        resource: "res1",
        sha256: "abc123",
        mime_type: "text/markdown",
        produced_at: Date.now(),
        pointer_tombstoned: 0,
        title: "Test Title",
        body_text: "Test body content",
        source_sha256: "abc123",
      },
    ];
    const result = rebuildSearchDocs(
      db,
      candidates,
      { actor: "test-actor" },
      false,
    );
    expect(result.candidates_found).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.details[0].status).toBe("skipped");
    // Verify no row was written
    expect(getSearchDoc(db, "produced/res1/abc123.md")).toBeUndefined();
  });

  it("writes search doc on apply when pointer has no search doc", () => {
    const { db } = createTestDb();
    insertPointer(db, "produced/res1/abc123.md");
    const candidates: SearchRebuildCandidate[] = [
      {
        artifact_key: "produced/res1/abc123.md",
        kind: "lesson",
        resource: "res1",
        sha256: "abc123",
        mime_type: "text/markdown",
        produced_at: Date.now(),
        pointer_tombstoned: 0,
        title: "Rebuilt Title",
        body_text: "Rebuilt body",
        source_sha256: "abc123",
      },
    ];
    const result = rebuildSearchDocs(
      db,
      candidates,
      { actor: "test-actor" },
      true,
    );
    expect(result.written).toBe(1);
    expect(result.details[0].status).toBe("written");
    const doc = getSearchDoc(db, "produced/res1/abc123.md");
    expect(doc).toBeDefined();
    expect(doc?.title).toBe("Rebuilt Title");
    expect(doc?.body_text).toBe("Rebuilt body");
    expect(doc?.source_sha256).toBe("abc123");
  });

  it("skips tombstoned pointer with no search doc (never resurrect)", () => {
    const { db } = createTestDb();
    insertPointer(db, "produced/res1/abc123.md", { tombstoned: 1 });
    const candidates: SearchRebuildCandidate[] = [
      {
        artifact_key: "produced/res1/abc123.md",
        kind: "lesson",
        resource: "res1",
        sha256: "abc123",
        mime_type: "text/markdown",
        produced_at: Date.now(),
        pointer_tombstoned: 1,
        title: null,
        body_text: null,
        source_sha256: null,
      },
    ];
    const result = rebuildSearchDocs(
      db,
      candidates,
      { actor: "test-actor" },
      true,
    );
    expect(result.skipped).toBe(1);
    expect(result.details[0].status).toBe("skipped");
    expect(getSearchDoc(db, "produced/res1/abc123.md")).toBeUndefined();
  });

  it("tombstones leaked search doc when pointer is tombstoned", () => {
    const { db } = createTestDb();
    insertPointer(db, "produced/res1/abc123.md", { tombstoned: 1 });
    insertSearchDoc(db, "produced/res1/abc123.md", { tombstoned: 0 });
    const candidates: SearchRebuildCandidate[] = [
      {
        artifact_key: "produced/res1/abc123.md",
        kind: "lesson",
        resource: "res1",
        sha256: "abc123",
        mime_type: "text/markdown",
        produced_at: Date.now(),
        pointer_tombstoned: 1,
        title: null,
        body_text: null,
        source_sha256: null,
      },
    ];
    const result = rebuildSearchDocs(
      db,
      candidates,
      { actor: "test-actor" },
      true,
    );
    expect(result.tombstoned).toBe(1);
    expect(result.details[0].status).toBe("tombstoned");
    const doc = getSearchDoc(db, "produced/res1/abc123.md");
    expect(doc).toBeDefined();
    expect(doc?.tombstoned).toBe(1);
  });

  it("skips already-current search doc (matching sha256)", () => {
    const { db } = createTestDb();
    insertPointer(db, "produced/res1/abc123.md");
    insertSearchDoc(db, "produced/res1/abc123.md", {
      source_sha256: "abc123",
    });
    const candidates: SearchRebuildCandidate[] = [
      {
        artifact_key: "produced/res1/abc123.md",
        kind: "lesson",
        resource: "res1",
        sha256: "abc123",
        mime_type: "text/markdown",
        produced_at: Date.now(),
        pointer_tombstoned: 0,
        title: "Test",
        body_text: "body",
        source_sha256: "abc123",
      },
    ];
    const result = rebuildSearchDocs(
      db,
      candidates,
      { actor: "test-actor" },
      true,
    );
    expect(result.skipped).toBe(1);
    expect(result.details[0].status).toBe("skipped");
  });

  it("updates stale search doc when sha256 differs", () => {
    const { db } = createTestDb();
    insertPointer(db, "produced/res1/def456.md", { sha256: "def456" });
    insertSearchDoc(db, "produced/res1/def456.md", {
      source_sha256: "abc123",
    });
    const candidates: SearchRebuildCandidate[] = [
      {
        artifact_key: "produced/res1/def456.md",
        kind: "lesson",
        resource: "res1",
        sha256: "def456",
        mime_type: "text/markdown",
        produced_at: Date.now(),
        pointer_tombstoned: 0,
        title: "Updated Title",
        body_text: "Updated body",
        source_sha256: "def456",
      },
    ];
    const result = rebuildSearchDocs(
      db,
      candidates,
      { actor: "test-actor" },
      true,
    );
    expect(result.written).toBe(1);
    expect(result.details[0].status).toBe("written");
    const doc = getSearchDoc(db, "produced/res1/def456.md");
    expect(doc?.title).toBe("Updated Title");
    expect(doc?.source_sha256).toBe("def456");
  });

  it("marks candidate unrecoverable when body_text is null", () => {
    const { db } = createTestDb();
    insertPointer(db, "produced/res1/abc123.md");
    const candidates: SearchRebuildCandidate[] = [
      {
        artifact_key: "produced/res1/abc123.md",
        kind: "lesson",
        resource: "res1",
        sha256: "abc123",
        mime_type: "text/markdown",
        produced_at: Date.now(),
        pointer_tombstoned: 0,
        title: null,
        body_text: null,
        source_sha256: null,
      },
    ];
    const result = rebuildSearchDocs(
      db,
      candidates,
      { actor: "test-actor" },
      true,
    );
    expect(result.unrecoverable).toBe(1);
    expect(result.details[0].status).toBe("unrecoverable");
    expect(result.details[0].reason).toContain("body_text");
  });

  it("skips already-tombstoned search doc for tombstoned pointer", () => {
    const { db } = createTestDb();
    insertPointer(db, "produced/res1/abc123.md", { tombstoned: 1 });
    insertSearchDoc(db, "produced/res1/abc123.md", { tombstoned: 1 });
    const candidates: SearchRebuildCandidate[] = [
      {
        artifact_key: "produced/res1/abc123.md",
        kind: "lesson",
        resource: "res1",
        sha256: "abc123",
        mime_type: "text/markdown",
        produced_at: Date.now(),
        pointer_tombstoned: 1,
        title: null,
        body_text: null,
        source_sha256: null,
      },
    ];
    const result = rebuildSearchDocs(
      db,
      candidates,
      { actor: "test-actor" },
      true,
    );
    expect(result.skipped).toBe(1);
    expect(result.details[0].status).toBe("skipped");
  });
});
