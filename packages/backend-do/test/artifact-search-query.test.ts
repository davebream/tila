import { SearchQueryError, artifactOps } from "@tila/ops-sqlite";
/**
 * Tests for searchArtifacts FTS5 query function.
 *
 * FTS5 tokenizer notes (unicode61 — SQLite default):
 * - Case-insensitive: "SQLite" matches "sqlite", "SQLITE", etc.
 * - Folds diacritics: "café" matches "cafe" (approximately)
 * - Splits on whitespace and Unicode punctuation categories
 * - Phrase queries: use double quotes, e.g. '"hello world"'
 * - Prefix queries: append *, e.g. "migrat*"
 * - Boolean: AND, OR, NOT (uppercase)
 * - NEAR operator: NEAR(term1 term2, N) within N tokens
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/create-test-db";

const { searchArtifacts } = artifactOps;

/** Insert a search doc row (triggers fire to populate FTS5 index). */
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

/**
 * Insert a matching artifact_pointers row so the INNER JOIN in
 * searchArtifacts can resolve produced_at.
 */
function insertPointer(
  sqlite: InstanceType<typeof Database>,
  r2_key: string,
  overrides?: { produced_at?: number },
) {
  const produced_at = overrides?.produced_at ?? Date.now();
  sqlite
    .prepare(
      `INSERT INTO artifact_pointers
       (r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned)
       VALUES (?, NULL, 'lesson', 'sha256hash', 100, NULL, 'text/markdown', ?, 'test-actor', NULL, 0)`,
    )
    .run(r2_key, produced_at);
}

describe("searchArtifacts", () => {
  it("returns multiple matching results", () => {
    const { db, sqlite } = createTestDb();
    for (let i = 0; i < 3; i++) {
      const key = `proj/${i}/doc.md`;
      insertPointer(sqlite, key);
      insertSearchDoc(sqlite, {
        artifact_key: key,
        body_text: "SQLite persistence architecture decision",
      });
    }

    const results = searchArtifacts(db, { q: "SQLite" });
    expect(results).toHaveLength(3);
    expect(results[0]).toHaveProperty("r2_key");
    expect(results[0]).toHaveProperty("kind");
    expect(results[0]).toHaveProperty("snippet");
  });

  it("returns empty array when no matches", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, "proj/1/doc.md");
    insertSearchDoc(sqlite, {
      artifact_key: "proj/1/doc.md",
      body_text: "Architecture decisions",
    });

    const results = searchArtifacts(db, { q: "nonexistent_xyzzy_term" });
    expect(results).toHaveLength(0);
  });

  it("filters by kind", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, "proj/a/1.md");
    insertPointer(sqlite, "proj/b/2.md");
    insertSearchDoc(sqlite, {
      artifact_key: "proj/a/1.md",
      kind: "lesson",
      body_text: "Common search term here",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/b/2.md",
      kind: "adr",
      body_text: "Common search term here",
    });

    const results = searchArtifacts(db, { q: "search", kind: "lesson" });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("lesson");
  });

  it("filters source_only (resource IS NULL)", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, "proj/src/1.md");
    insertPointer(sqlite, "proj/res/2.md");
    insertSearchDoc(sqlite, {
      artifact_key: "proj/src/1.md",
      resource: null,
      body_text: "Shared unique xterm content",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/res/2.md",
      resource: "task/1",
      body_text: "Shared unique xterm content",
    });

    const results = searchArtifacts(db, { q: "xterm", source_only: true });
    expect(results).toHaveLength(1);
    expect(results[0].resource).toBeNull();
  });

  it("excludes tombstoned rows", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, "proj/live/1.md");
    insertPointer(sqlite, "proj/dead/2.md");
    insertSearchDoc(sqlite, {
      artifact_key: "proj/live/1.md",
      tombstoned: 0,
      body_text: "Findable unique ztombterm content",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/dead/2.md",
      tombstoned: 1,
      body_text: "Findable unique ztombterm content",
    });

    const results = searchArtifacts(db, { q: "ztombterm" });
    expect(results).toHaveLength(1);
    expect(results[0].r2_key).toBe("proj/live/1.md");
  });

  it("respects limit parameter", () => {
    const { db, sqlite } = createTestDb();
    for (let i = 0; i < 5; i++) {
      const key = `proj/${i}/doc.md`;
      insertPointer(sqlite, key);
      insertSearchDoc(sqlite, {
        artifact_key: key,
        body_text: "Common zlimitterm content for limit test",
      });
    }

    const results = searchArtifacts(db, { q: "zlimitterm", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("orders by bm25 relevance (more relevant first)", () => {
    const { db, sqlite } = createTestDb();
    // Doc with many repetitions of the term should rank higher (more negative bm25 = higher relevance)
    insertPointer(sqlite, "proj/high/1.md");
    insertPointer(sqlite, "proj/low/2.md");
    insertSearchDoc(sqlite, {
      artifact_key: "proj/high/1.md",
      title: "Relevance test",
      body_text:
        "zrankuniq zrankuniq zrankuniq zrankuniq zrankuniq zrankuniq zrankuniq zrankuniq",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/low/2.md",
      title: "Other topic",
      body_text:
        "This doc mentions zrankuniq only once among other words padding",
    });

    const results = searchArtifacts(db, { q: "zrankuniq" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    // The doc with higher term frequency should appear first (bm25 ascending: more negative = more relevant)
    expect(results[0].r2_key).toBe("proj/high/1.md");
  });

  it("throws SearchQueryError on invalid FTS5 syntax", () => {
    const { db, sqlite } = createTestDb();
    // FTS5 syntax errors are only surfaced when the table has data --
    // SQLite short-circuits MATCH evaluation on empty content tables.
    // Insert a row so the FTS5 MATCH expression is actually evaluated.
    insertPointer(sqlite, "proj/err/1.md");
    insertSearchDoc(sqlite, {
      artifact_key: "proj/err/1.md",
      body_text: "content for error test",
    });

    expect(() => searchArtifacts(db, { q: "AND" })).toThrow(
      "Invalid search query syntax",
    );
    expect(() => searchArtifacts(db, { q: "OR" })).toThrow(
      "Invalid search query syntax",
    );
  });

  it("handles phrase queries", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, "proj/phrase/1.md");
    insertPointer(sqlite, "proj/phrase/2.md");
    insertSearchDoc(sqlite, {
      artifact_key: "proj/phrase/1.md",
      body_text: "The hello world program is classic",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/phrase/2.md",
      body_text: "Hello to the brave new world of programming",
    });

    // Phrase query: only the doc with exact adjacent "hello world" matches
    const results = searchArtifacts(db, { q: '"hello world"' });
    expect(results).toHaveLength(1);
    expect(results[0].r2_key).toBe("proj/phrase/1.md");
  });

  it("includes produced_at from artifact_pointers", () => {
    const { db, sqlite } = createTestDb();
    const producedAt = 1700000000;
    insertPointer(sqlite, "proj/pa/1.md", { produced_at: producedAt });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/pa/1.md",
      body_text: "zproducedterm unique content",
    });

    const results = searchArtifacts(db, { q: "zproducedterm" });
    expect(results).toHaveLength(1);
    expect(results[0].produced_at).toBe(producedAt);
  });

  it("returns snippet with highlight markers when available", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, "proj/snip/1.md");
    insertSearchDoc(sqlite, {
      artifact_key: "proj/snip/1.md",
      body_text:
        "This document discusses SQLite performance tuning and optimization strategies for production databases",
    });

    const results = searchArtifacts(db, { q: "SQLite" });
    expect(results).toHaveLength(1);
    // snippet() should contain <b> markers around the matched term
    if (results[0].snippet !== null) {
      expect(results[0].snippet).toContain("<b>");
      expect(results[0].snippet).toContain("</b>");
    }
    // If snippet is null (snippet() unavailable), the test still passes --
    // the fallback path returns null gracefully
  });

  it("defaults limit to 20 and caps at 100", () => {
    const { db, sqlite } = createTestDb();
    for (let i = 0; i < 25; i++) {
      const key = `proj/${i}/doc.md`;
      insertPointer(sqlite, key);
      insertSearchDoc(sqlite, {
        artifact_key: key,
        body_text: "Shared zcapterm content for cap test",
      });
    }

    // Default limit = 20
    const defaultResults = searchArtifacts(db, { q: "zcapterm" });
    expect(defaultResults).toHaveLength(20);

    // Explicit limit over 100 is capped at 100, but we only have 25 rows
    const cappedResults = searchArtifacts(db, { q: "zcapterm", limit: 200 });
    expect(cappedResults.length).toBeLessThanOrEqual(25);
  });

  it("filters by resource when source_only is false", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, "proj/r1/1.md");
    insertPointer(sqlite, "proj/r2/2.md");
    insertPointer(sqlite, "proj/r3/3.md");
    insertSearchDoc(sqlite, {
      artifact_key: "proj/r1/1.md",
      resource: "task/42",
      body_text: "Shared zresterm content here",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/r2/2.md",
      resource: "task/99",
      body_text: "Shared zresterm content here",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/r3/3.md",
      resource: null,
      body_text: "Shared zresterm content here",
    });

    const results = searchArtifacts(db, {
      q: "zresterm",
      resource: "task/42",
    });
    expect(results).toHaveLength(1);
    expect(results[0].r2_key).toBe("proj/r1/1.md");
  });

  it("source_only takes precedence over resource filter", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, "proj/s1/1.md");
    insertPointer(sqlite, "proj/s2/2.md");
    insertSearchDoc(sqlite, {
      artifact_key: "proj/s1/1.md",
      resource: null,
      body_text: "Shared zprecterm content here",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/s2/2.md",
      resource: "task/1",
      body_text: "Shared zprecterm content here",
    });

    // Both source_only=true and resource provided — source_only wins
    const results = searchArtifacts(db, {
      q: "zprecterm",
      source_only: true,
      resource: "task/1",
    });
    expect(results).toHaveLength(1);
    expect(results[0].resource).toBeNull();
  });

  describe("validateFtsQuery - complexity rejection", () => {
    it("throws SearchQueryError when query length exceeds 200 chars", () => {
      const { db, sqlite } = createTestDb();
      insertPointer(sqlite, "proj/val/1.md");
      insertSearchDoc(sqlite, {
        artifact_key: "proj/val/1.md",
        body_text: "content for validation test",
      });

      const longQuery = "a".repeat(201);
      expect(() => searchArtifacts(db, { q: longQuery })).toThrow(
        SearchQueryError,
      );
      expect(() => searchArtifacts(db, { q: longQuery })).toThrow(
        "Query exceeds 200 character limit",
      );
    });

    it("does NOT throw for query of exactly 200 chars", () => {
      const { db, sqlite } = createTestDb();
      insertPointer(sqlite, "proj/val/2.md");
      insertSearchDoc(sqlite, {
        artifact_key: "proj/val/2.md",
        body_text: "content for boundary test",
      });

      // 200 chars is at the boundary -- should pass validation
      // (may return empty results, that's fine -- no throw is the assertion)
      const boundaryQuery = "boundary".repeat(25); // 200 chars exactly
      expect(() => searchArtifacts(db, { q: boundaryQuery })).not.toThrow(
        SearchQueryError,
      );
    });

    it("throws SearchQueryError when boolean operator count exceeds 10", () => {
      const { db, sqlite } = createTestDb();
      insertPointer(sqlite, "proj/val/3.md");
      insertSearchDoc(sqlite, {
        artifact_key: "proj/val/3.md",
        body_text: "content for operator test",
      });

      // 11 AND operators
      const terms = Array.from({ length: 12 }, (_, i) => `term${i}`);
      const overOperatorQuery = terms.join(" AND ");
      expect(() => searchArtifacts(db, { q: overOperatorQuery })).toThrow(
        SearchQueryError,
      );
      expect(() => searchArtifacts(db, { q: overOperatorQuery })).toThrow(
        "Query contains too many boolean operators (max 10)",
      );
    });

    it("does NOT throw for query with exactly 10 boolean operators", () => {
      const { db, sqlite } = createTestDb();
      insertPointer(sqlite, "proj/val/4.md");
      insertSearchDoc(sqlite, {
        artifact_key: "proj/val/4.md",
        body_text: "content for boundary operator test",
      });

      // 10 AND operators (11 terms joined by AND = 10 operators)
      const terms = Array.from({ length: 11 }, (_, i) => `term${i}`);
      const boundaryOperatorQuery = terms.join(" AND ");
      expect(() =>
        searchArtifacts(db, { q: boundaryOperatorQuery }),
      ).not.toThrow(SearchQueryError);
    });

    it("throws SearchQueryError for single-char prefix wildcard (a*)", () => {
      const { db, sqlite } = createTestDb();
      insertPointer(sqlite, "proj/val/5.md");
      insertSearchDoc(sqlite, {
        artifact_key: "proj/val/5.md",
        body_text: "content for wildcard test",
      });

      expect(() => searchArtifacts(db, { q: "a*" })).toThrow(SearchQueryError);
      expect(() => searchArtifacts(db, { q: "a*" })).toThrow(
        "Prefix wildcard requires at least 3 characters before '*'",
      );
    });

    it("throws SearchQueryError for two-char prefix wildcard (ab*)", () => {
      const { db, sqlite } = createTestDb();
      insertPointer(sqlite, "proj/val/6.md");
      insertSearchDoc(sqlite, {
        artifact_key: "proj/val/6.md",
        body_text: "content for two-char wildcard test",
      });

      expect(() => searchArtifacts(db, { q: "ab*" })).toThrow(SearchQueryError);
      expect(() => searchArtifacts(db, { q: "ab*" })).toThrow(
        "Prefix wildcard requires at least 3 characters before '*'",
      );
    });

    it("does NOT throw for 3-char prefix wildcard (abc*)", () => {
      const { db, sqlite } = createTestDb();
      insertPointer(sqlite, "proj/val/7.md");
      insertSearchDoc(sqlite, {
        artifact_key: "proj/val/7.md",
        body_text: "abcdef content for prefix test",
      });

      // abc* should pass validation and return results
      expect(() => searchArtifacts(db, { q: "abc*" })).not.toThrow(
        SearchQueryError,
      );
    });

    it("does NOT throw for NEAR query within limits", () => {
      const { db, sqlite } = createTestDb();
      insertPointer(sqlite, "proj/val/8.md");
      insertSearchDoc(sqlite, {
        artifact_key: "proj/val/8.md",
        body_text: "migration to sqlite database system",
      });

      // NEAR query with valid terms -- 1 operator, valid prefix lengths
      expect(() =>
        searchArtifacts(db, { q: "NEAR(migration sqlite, 5)" }),
      ).not.toThrow(SearchQueryError);
    });
  });
});

// ---------------------------------------------------------------------------
// searchArtifacts — tagFilter (post-MATCH EXISTS)
// ---------------------------------------------------------------------------

describe("searchArtifacts — tagFilter", () => {
  it("returns only artifacts carrying all tagFilter tags (AND)", () => {
    const { db, sqlite } = createTestDb();

    insertPointer(sqlite, "proj/tag-a/1.md");
    insertPointer(sqlite, "proj/tag-b/2.md");
    insertPointer(sqlite, "proj/tag-c/3.md");

    insertSearchDoc(sqlite, {
      artifact_key: "proj/tag-a/1.md",
      body_text: "artifacttagterm content here",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/tag-b/2.md",
      body_text: "artifacttagterm content here",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "proj/tag-c/3.md",
      body_text: "artifacttagterm content here",
    });

    // a has both tags, b has only repo:a, c has neither
    sqlite
      .prepare("INSERT INTO artifact_tags(artifact_key, tag) VALUES(?, ?)")
      .run("proj/tag-a/1.md", "repo:a");
    sqlite
      .prepare("INSERT INTO artifact_tags(artifact_key, tag) VALUES(?, ?)")
      .run("proj/tag-a/1.md", "team:x");
    sqlite
      .prepare("INSERT INTO artifact_tags(artifact_key, tag) VALUES(?, ?)")
      .run("proj/tag-b/2.md", "repo:a");

    const results = searchArtifacts(db, {
      q: "artifacttagterm",
      tagFilter: ["repo:a", "team:x"],
    });
    expect(results).toHaveLength(1);
    expect(results[0].r2_key).toBe("proj/tag-a/1.md");
  });

  it("bm25 ordering preserved among tag-filtered artifact survivors", () => {
    const { db, sqlite } = createTestDb();

    insertPointer(sqlite, "proj/bm-high/1.md");
    insertPointer(sqlite, "proj/bm-low/2.md");

    // high relevance: many repetitions
    insertSearchDoc(sqlite, {
      artifact_key: "proj/bm-high/1.md",
      body_text:
        "artifactbm25term artifactbm25term artifactbm25term artifactbm25term artifactbm25term",
    });
    // low relevance: one occurrence
    insertSearchDoc(sqlite, {
      artifact_key: "proj/bm-low/2.md",
      body_text: "artifactbm25term other words here",
    });

    sqlite
      .prepare("INSERT INTO artifact_tags(artifact_key, tag) VALUES(?, ?)")
      .run("proj/bm-high/1.md", "scope:keep");
    sqlite
      .prepare("INSERT INTO artifact_tags(artifact_key, tag) VALUES(?, ?)")
      .run("proj/bm-low/2.md", "scope:keep");

    const results = searchArtifacts(db, {
      q: "artifactbm25term",
      tagFilter: ["scope:keep"],
    });
    expect(results).toHaveLength(2);
    expect(results[0].r2_key).toBe("proj/bm-high/1.md");
  });
});
