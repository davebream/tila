import { SearchQueryError, recordOps } from "@tila/ops-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

let testDb: TestDb;
let rawDb: TestDb["sqlite"];
let db: TestDb["db"];

beforeEach(() => {
  testDb = createTestDb({ foreignKeys: "on" });
  rawDb = testDb.sqlite;
  db = testDb.db;
});

afterEach(() => {
  testDb.sqlite.close();
});

// ---------------------------------------------------------------------------
// extractSearchText helper
// ---------------------------------------------------------------------------

describe("extractSearchText", () => {
  it("collects string values from a flat object", () => {
    const text = recordOps.extractSearchText({
      title: "Hello world",
      count: 42,
      active: true,
    });
    expect(text).toContain("Hello world");
    expect(text).not.toContain("42");
  });

  it("recursively collects strings from nested objects", () => {
    const text = recordOps.extractSearchText({
      outer: { inner: "nested value" },
    });
    expect(text).toContain("nested value");
  });

  it("collects strings from arrays", () => {
    const text = recordOps.extractSearchText({
      tags: ["alpha", "beta", "gamma"],
    });
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("gamma");
  });

  it("returns empty string for an object with no string values", () => {
    const text = recordOps.extractSearchText({ count: 5, ratio: 3.14 });
    expect(text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Record FTS5 indexing via createRecord
// ---------------------------------------------------------------------------

describe("createRecord — FTS5 indexing", () => {
  it("inserts a search doc on create", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { description: "production configuration" },
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
    );

    const row = rawDb
      .prepare(
        "SELECT body_text, tombstoned FROM record_search_docs WHERE record_type = ? AND record_key = ?",
      )
      .get("config", "main") as
      | { body_text: string; tombstoned: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.body_text).toContain("production configuration");
    expect(row?.tombstoned).toBe(0);
  });

  it("FTS5 trigger fires — record is discoverable via MATCH", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "note",
        key: "n1",
        value: { content: "unique_token_xyzabc123 here" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const results = rawDb
      .prepare(
        "SELECT * FROM record_search_docs_fts WHERE record_search_docs_fts MATCH ?",
      )
      .all("unique_token_xyzabc123") as Array<{ body_text: string }>;
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// setRecord — FTS5 indexing
// ---------------------------------------------------------------------------

describe("setRecord — FTS5 indexing", () => {
  it("updates search doc on set", async () => {
    // Create first
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "alpha",
        value: { description: "initial content" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    // Get fence
    const fence =
      (
        rawDb
          .prepare("SELECT current_fence FROM fences WHERE resource = ?")
          .get("config:alpha") as { current_fence: number } | undefined
      )?.current_fence ?? 1;

    // Set with new content
    await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "alpha",
        value: { description: "updated content xyzset456" },
        fence,
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const row = rawDb
      .prepare(
        "SELECT body_text FROM record_search_docs WHERE record_type = ? AND record_key = ?",
      )
      .get("config", "alpha") as { body_text: string } | undefined;
    expect(row?.body_text).toContain("updated content xyzset456");
    expect(row?.body_text).not.toContain("initial content");
  });

  it("skips re-indexing when sha256 is unchanged", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "beta",
        value: { description: "stable content" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const before = rawDb
      .prepare(
        "SELECT indexed_at FROM record_search_docs WHERE record_type = ? AND record_key = ?",
      )
      .get("config", "beta") as { indexed_at: number } | undefined;

    // Wait a tick to ensure timestamp would differ if re-indexed
    await new Promise((r) => setTimeout(r, 5));

    const fence =
      (
        rawDb
          .prepare("SELECT current_fence FROM fences WHERE resource = ?")
          .get("config:beta") as { current_fence: number } | undefined
      )?.current_fence ?? 1;

    // Set with same value — sha256 guard should prevent re-index
    await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "beta",
        value: { description: "stable content" },
        fence,
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const after = rawDb
      .prepare(
        "SELECT indexed_at FROM record_search_docs WHERE record_type = ? AND record_key = ?",
      )
      .get("config", "beta") as { indexed_at: number } | undefined;
    expect(after?.indexed_at).toBe(before?.indexed_at);
  });
});

// ---------------------------------------------------------------------------
// patchRecord — FTS5 indexing
// ---------------------------------------------------------------------------

describe("patchRecord — FTS5 indexing", () => {
  it("updates search doc on patch", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "note",
        key: "p1",
        value: { content: "original text" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const fence =
      (
        rawDb
          .prepare("SELECT current_fence FROM fences WHERE resource = ?")
          .get("note:p1") as { current_fence: number } | undefined
      )?.current_fence ?? 1;

    await recordOps.patchRecord(
      db,
      {
        type: "note",
        key: "p1",
        patch: { content: "patched text xyzpatch789" },
        fence,
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const row = rawDb
      .prepare(
        "SELECT body_text FROM record_search_docs WHERE record_type = ? AND record_key = ?",
      )
      .get("note", "p1") as { body_text: string } | undefined;
    expect(row?.body_text).toContain("patched text xyzpatch789");
  });
});

// ---------------------------------------------------------------------------
// archiveRecord / unarchiveRecord — tombstone propagation
// ---------------------------------------------------------------------------

describe("archiveRecord — FTS5 tombstone", () => {
  it("sets tombstoned=1 on archive", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "note",
        key: "arch1",
        value: { content: "archivable content" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const fence =
      (
        rawDb
          .prepare("SELECT current_fence FROM fences WHERE resource = ?")
          .get("note:arch1") as { current_fence: number } | undefined
      )?.current_fence ?? 1;

    recordOps.archiveRecord(
      db,
      {
        type: "note",
        key: "arch1",
        fence,
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const row = rawDb
      .prepare(
        "SELECT tombstoned FROM record_search_docs WHERE record_type = ? AND record_key = ?",
      )
      .get("note", "arch1") as { tombstoned: number } | undefined;
    expect(row?.tombstoned).toBe(1);
  });

  it("sets tombstoned=0 on unarchive", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "note",
        key: "unarch1",
        value: { content: "unarchivable content" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    // Read fence after create (fence=1)
    const fence1 =
      (
        rawDb
          .prepare("SELECT current_fence FROM fences WHERE resource = ?")
          .get("note:unarch1") as { current_fence: number } | undefined
      )?.current_fence ?? 1;

    recordOps.archiveRecord(
      db,
      {
        type: "note",
        key: "unarch1",
        fence: fence1,
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    // Archive increments fence — re-read current fence for unarchive
    const fence2 =
      (
        rawDb
          .prepare("SELECT current_fence FROM fences WHERE resource = ?")
          .get("note:unarch1") as { current_fence: number } | undefined
      )?.current_fence ?? 2;

    recordOps.unarchiveRecord(
      db,
      {
        type: "note",
        key: "unarch1",
        fence: fence2,
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const row = rawDb
      .prepare(
        "SELECT tombstoned FROM record_search_docs WHERE record_type = ? AND record_key = ?",
      )
      .get("note", "unarch1") as { tombstoned: number } | undefined;
    expect(row?.tombstoned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// searchRecords
// ---------------------------------------------------------------------------

describe("searchRecords", () => {
  it("returns matching records by term", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "doc",
        key: "d1",
        value: { body: "elasticsearch query performance" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );
    await recordOps.createRecord(
      db,
      {
        type: "doc",
        key: "d2",
        value: { body: "unrelated content" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const results = recordOps.searchRecords(db, { q: "elasticsearch" });
    expect(results).toHaveLength(1);
    expect(results[0].record_type).toBe("doc");
    expect(results[0].record_key).toBe("d1");
    expect(results[0].indexed_at).toBeGreaterThan(0);
  });

  it("returns a snippet", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "doc",
        key: "snip1",
        value: {
          body: "This is a long text with a findable_term_unique_xyz inside",
        },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const results = recordOps.searchRecords(db, {
      q: "findable_term_unique_xyz",
    });
    expect(results).toHaveLength(1);
    expect(results[0].snippet).not.toBeNull();
  });

  it("excludes tombstoned (archived) records", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "doc",
        key: "tomb1",
        value: { body: "tombstone_unique_xyz_term" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const fence =
      (
        rawDb
          .prepare("SELECT current_fence FROM fences WHERE resource = ?")
          .get("doc:tomb1") as { current_fence: number } | undefined
      )?.current_fence ?? 1;

    recordOps.archiveRecord(
      db,
      {
        type: "doc",
        key: "tomb1",
        fence,
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const results = recordOps.searchRecords(db, {
      q: "tombstone_unique_xyz_term",
    });
    expect(results).toHaveLength(0);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await recordOps.createRecord(
        db,
        {
          type: "note",
          key: `limit${i}`,
          value: { body: `limitterm_xyz content number ${i}` },
          schema_version: 1,
          actor: "agent",
        },
        { actor: "agent" },
      );
    }

    const results = recordOps.searchRecords(db, {
      q: "limitterm_xyz",
      limit: 2,
    });
    expect(results).toHaveLength(2);
  });

  it("throws SearchQueryError for invalid FTS5 query", async () => {
    expect(() => recordOps.searchRecords(db, { q: "x".repeat(201) })).toThrow(
      SearchQueryError,
    );
  });

  it("supports prefix queries", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "doc",
        key: "prefix1",
        value: { body: "prefixableterm content" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const results = recordOps.searchRecords(db, { q: "pre*" });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty array when no matches", async () => {
    const results = recordOps.searchRecords(db, { q: "nonexistent_xyz_term" });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// searchRecords — tagFilter (post-MATCH EXISTS)
// ---------------------------------------------------------------------------

describe("searchRecords — tagFilter", () => {
  it("returns only records carrying all tagFilter tags (AND)", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "doc",
        key: "rtag-1",
        value: { body: "recordtagfilterterm content" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );
    await recordOps.createRecord(
      db,
      {
        type: "doc",
        key: "rtag-2",
        value: { body: "recordtagfilterterm content" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );
    await recordOps.createRecord(
      db,
      {
        type: "doc",
        key: "rtag-3",
        value: { body: "recordtagfilterterm content" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    // rtag-1 has both tags, rtag-2 has only repo:a, rtag-3 has neither
    rawDb
      .prepare("INSERT INTO record_tags(type, key, tag) VALUES(?, ?, ?)")
      .run("doc", "rtag-1", "repo:a");
    rawDb
      .prepare("INSERT INTO record_tags(type, key, tag) VALUES(?, ?, ?)")
      .run("doc", "rtag-1", "team:x");
    rawDb
      .prepare("INSERT INTO record_tags(type, key, tag) VALUES(?, ?, ?)")
      .run("doc", "rtag-2", "repo:a");

    const results = recordOps.searchRecords(db, {
      q: "recordtagfilterterm",
      tagFilter: ["repo:a", "team:x"],
    });
    expect(results).toHaveLength(1);
    expect(results[0].record_key).toBe("rtag-1");
  });

  it("bm25 ordering preserved among tag-filtered record survivors", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "note",
        key: "rbm-high",
        value: {
          body: "recordbm25term recordbm25term recordbm25term recordbm25term recordbm25term",
        },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );
    await recordOps.createRecord(
      db,
      {
        type: "note",
        key: "rbm-low",
        value: { body: "recordbm25term other words here" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    rawDb
      .prepare("INSERT INTO record_tags(type, key, tag) VALUES(?, ?, ?)")
      .run("note", "rbm-high", "scope:keep");
    rawDb
      .prepare("INSERT INTO record_tags(type, key, tag) VALUES(?, ?, ?)")
      .run("note", "rbm-low", "scope:keep");

    const results = recordOps.searchRecords(db, {
      q: "recordbm25term",
      tagFilter: ["scope:keep"],
    });
    expect(results).toHaveLength(2);
    expect(results[0].record_key).toBe("rbm-high");
  });
});
