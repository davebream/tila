import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_0001,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0011,
  artifactOps,
  schema,
} from "../../ops-sqlite/src";

const { upsertPointer } = artifactOps;

// Cloudflare's SQLite fork supports COALESCE in PRIMARY KEY; standard SQLite does not.
const MIGRATION_0001_TEST = MIGRATION_0001.replace(
  "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
  "PRIMARY KEY (from_key, type)",
);

// Drop FK on resource -> entities(id) so we can insert pointers without entities
const MIGRATION_FOR_SEARCH = MIGRATION_0001_TEST.replace(
  ",\n  FOREIGN KEY (resource) REFERENCES entities(id)",
  "",
);

interface TestDb {
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
  sqlite: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_FOR_SEARCH);
  sqlite.exec(MIGRATION_0003);
  sqlite.exec(MIGRATION_0004);
  sqlite.exec(MIGRATION_0011);
  sqlite.exec(
    "ALTER TABLE journal ADD COLUMN source TEXT DEFAULT NULL; ALTER TABLE journal ADD COLUMN source_version TEXT DEFAULT NULL;",
  );
  const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, sqlite };
}

function makePointer(overrides?: Partial<Parameters<typeof upsertPointer>[1]>) {
  return {
    r2_key: "sources/abc123.md",
    resource: null,
    kind: "lesson",
    sha256: "abc123",
    bytes: 100,
    fence: null,
    mime_type: "text/markdown",
    produced_at: Date.now(),
    produced_by: "test-machine",
    expires_at: null,
    ...overrides,
  };
}

describe("upsertPointer with searchText", () => {
  it("inserts search doc when searchText is provided", () => {
    const { db, sqlite } = createTestDb();
    const pointer = makePointer();
    upsertPointer(db, pointer, { actor: "test-actor" }, undefined, {
      title: "My Lesson",
      body_text: "Content about architecture decisions",
    });

    const rows = sqlite
      .prepare("SELECT * FROM artifact_search_docs WHERE artifact_key = ?")
      .all(pointer.r2_key) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("lesson");
    expect(rows[0].mime_type).toBe("text/markdown");
    expect(rows[0].title).toBe("My Lesson");
    expect(rows[0].body_text).toBe("Content about architecture decisions");
    expect(rows[0].source_sha256).toBe("abc123");
    expect(rows[0].tombstoned).toBe(0);
  });

  it("does not insert search doc when searchText is null", () => {
    const { db, sqlite } = createTestDb();
    upsertPointer(db, makePointer(), { actor: "test-actor" }, undefined, null);

    const rows = sqlite
      .prepare("SELECT COUNT(*) as cnt FROM artifact_search_docs")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  it("does not insert search doc when searchText is omitted", () => {
    const { db, sqlite } = createTestDb();
    upsertPointer(db, makePointer(), { actor: "test-actor" });

    const rows = sqlite
      .prepare("SELECT COUNT(*) as cnt FROM artifact_search_docs")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  it("INSERT OR IGNORE deduplicates on re-upload of same content", () => {
    const { db, sqlite } = createTestDb();
    const pointer = makePointer();
    const searchText = { title: "Title", body_text: "Body" };

    upsertPointer(db, pointer, { actor: "test-actor" }, undefined, searchText);
    // Second upload of same r2_key (content-addressed dedup)
    upsertPointer(db, pointer, { actor: "test-actor" }, undefined, searchText);

    const rows = sqlite
      .prepare("SELECT COUNT(*) as cnt FROM artifact_search_docs")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it("FTS5 trigger fires -- content is discoverable via MATCH", () => {
    const { db, sqlite } = createTestDb();
    upsertPointer(db, makePointer(), { actor: "test-actor" }, undefined, {
      title: "Architecture Decision",
      body_text: "We chose SQLite for persistence xyzuniq123",
    });

    const results = sqlite
      .prepare(
        "SELECT title FROM artifact_search_docs_fts WHERE artifact_search_docs_fts MATCH ?",
      )
      .all("xyzuniq123") as Array<{ title: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Architecture Decision");
  });

  it("search doc includes resource for produced artifacts", () => {
    const { db, sqlite } = createTestDb();
    const now = Date.now();
    sqlite
      .prepare(
        "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, 1, '{}', 0, ?, ?, 'test')",
      )
      .run("task-1", "task", now, now);
    sqlite
      .prepare("INSERT INTO fences (resource, current_fence) VALUES (?, ?)")
      .run("task:task-1", 1);
    const pointer = makePointer({
      r2_key: "produced/task-1/def456.md",
      resource: "task-1",
      fence: 1,
    });
    upsertPointer(db, pointer, { actor: "test-actor" }, undefined, {
      title: null,
      body_text: "Produced content",
    });

    const row = sqlite
      .prepare(
        "SELECT resource FROM artifact_search_docs WHERE artifact_key = ?",
      )
      .get(pointer.r2_key) as { resource: string };
    expect(row.resource).toBe("task-1");
  });

  it("search doc title can be null", () => {
    const { db, sqlite } = createTestDb();
    upsertPointer(db, makePointer(), { actor: "test-actor" }, undefined, {
      title: null,
      body_text: "No title content",
    });

    const row = sqlite
      .prepare("SELECT title FROM artifact_search_docs WHERE artifact_key = ?")
      .get("sources/abc123.md") as { title: string | null };
    expect(row.title).toBeNull();
  });
});
