import { MIGRATION_0001, MIGRATION_0003, schema } from "@tila/ops-sqlite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

// Cloudflare's SQLite fork supports COALESCE in PRIMARY KEY; standard SQLite does not.
const MIGRATION_0001_TEST = MIGRATION_0001.replace(
  "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
  "PRIMARY KEY (from_key, type)",
);

interface TestDb {
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
  sqlite: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_0001_TEST);
  sqlite.exec(MIGRATION_0003);
  const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, sqlite };
}

function insertSearchDoc(
  sqlite: InstanceType<typeof Database>,
  overrides: {
    artifact_key: string;
    kind?: string;
    mime_type?: string;
    resource?: string | null;
    title?: string | null;
    body_text?: string | null;
    indexed_at?: number;
    source_sha256?: string;
    tombstoned?: number;
  },
) {
  const row = {
    kind: "lesson",
    mime_type: "text/markdown",
    resource: null,
    title: "Test Title",
    body_text: "Test body text content",
    indexed_at: Date.now(),
    source_sha256: "abc123",
    tombstoned: 0,
    ...overrides,
  };
  // Use raw SQL to insert so triggers fire (Drizzle insert also fires triggers,
  // but raw SQL makes the test independent of Drizzle insert behavior)
  sqlite
    .prepare(
      "INSERT INTO artifact_search_docs (artifact_key, kind, mime_type, resource, title, body_text, indexed_at, source_sha256, tombstoned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.artifact_key,
      row.kind,
      row.mime_type,
      row.resource,
      row.title,
      row.body_text,
      row.indexed_at,
      row.source_sha256,
      row.tombstoned,
    );
}

function ftsQuery(
  sqlite: InstanceType<typeof Database>,
  term: string,
): Array<{ title: string; body_text: string }> {
  return sqlite
    .prepare(
      "SELECT title, body_text FROM artifact_search_docs_fts WHERE artifact_search_docs_fts MATCH ?",
    )
    .all(term) as Array<{ title: string; body_text: string }>;
}

describe("artifact_search_docs schema", () => {
  it("migration applies without errors", () => {
    expect(() => createTestDb()).not.toThrow();
  });

  it("insert a search doc row succeeds", () => {
    const { sqlite } = createTestDb();
    expect(() =>
      insertSearchDoc(sqlite, { artifact_key: "proj/1/abc.md" }),
    ).not.toThrow();
  });
});

describe("FTS5 trigger chain", () => {
  it("insert triggers FTS index -- MATCH query returns the row", () => {
    const { sqlite } = createTestDb();
    insertSearchDoc(sqlite, {
      artifact_key: "proj/1/abc.md",
      title: "Architecture Decision",
      body_text: "We chose SQLite for persistence because of its simplicity",
    });

    const results = ftsQuery(sqlite, "SQLite");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Architecture Decision");
  });

  it("update triggers FTS re-index -- old content gone, new content found", () => {
    const { sqlite } = createTestDb();
    insertSearchDoc(sqlite, {
      artifact_key: "proj/2/def.md",
      title: "Original Title",
      body_text: "Original body with termAlpha xyzuniqA",
    });

    // Verify original is findable
    expect(ftsQuery(sqlite, "termAlpha")).toHaveLength(1);

    // Update body_text via raw SQL (triggers fire)
    sqlite
      .prepare(
        "UPDATE artifact_search_docs SET body_text = ? WHERE artifact_key = ?",
      )
      .run("Updated body with termBeta xyzuniqB", "proj/2/def.md");

    // Old term should NOT match
    expect(ftsQuery(sqlite, "termAlpha")).toHaveLength(0);
    // New term should match
    expect(ftsQuery(sqlite, "termBeta")).toHaveLength(1);
  });

  it("delete triggers FTS removal -- MATCH no longer returns the row", () => {
    const { sqlite } = createTestDb();
    insertSearchDoc(sqlite, {
      artifact_key: "proj/3/ghi.md",
      title: "Deletable",
      body_text: "Content with termGamma for deletion test",
    });

    // Verify findable before delete
    expect(ftsQuery(sqlite, "termGamma")).toHaveLength(1);

    // Delete the row
    sqlite
      .prepare("DELETE FROM artifact_search_docs WHERE artifact_key = ?")
      .run("proj/3/ghi.md");

    // Should no longer match
    expect(ftsQuery(sqlite, "termGamma")).toHaveLength(0);
  });
});

describe("metadata filtering (normal table, no FTS)", () => {
  it("filter by kind returns only matching rows", () => {
    const { sqlite } = createTestDb();
    insertSearchDoc(sqlite, { artifact_key: "proj/a/1.md", kind: "lesson" });
    insertSearchDoc(sqlite, { artifact_key: "proj/b/2.md", kind: "adr" });
    insertSearchDoc(sqlite, { artifact_key: "proj/c/3.md", kind: "lesson" });

    const results = sqlite
      .prepare("SELECT artifact_key FROM artifact_search_docs WHERE kind = ?")
      .all("lesson") as Array<{ artifact_key: string }>;

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.artifact_key).sort()).toEqual([
      "proj/a/1.md",
      "proj/c/3.md",
    ]);
  });

  it("tombstoned rows excluded by WHERE tombstoned = 0", () => {
    const { sqlite } = createTestDb();
    insertSearchDoc(sqlite, {
      artifact_key: "proj/d/4.md",
      tombstoned: 0,
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/e/5.md",
      tombstoned: 1,
    });

    const results = sqlite
      .prepare(
        "SELECT artifact_key FROM artifact_search_docs WHERE tombstoned = 0",
      )
      .all() as Array<{ artifact_key: string }>;

    expect(results).toHaveLength(1);
    expect(results[0].artifact_key).toBe("proj/d/4.md");
  });
});
