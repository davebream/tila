import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_0001,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0005,
  MIGRATION_0006,
  MIGRATION_0007,
  MIGRATION_0008,
  MIGRATION_0009,
  MIGRATION_0010,
  MIGRATION_0011,
  MIGRATION_0012,
  MIGRATION_0018,
  SearchQueryError,
  artifactOps,
  coordinationOps,
  entityOps,
  recordOps,
  schema,
} from "../../ops-sqlite/src";

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
  sqlite.exec(MIGRATION_0003); // artifact FTS (needed for searchAll)
  sqlite.exec(MIGRATION_0004); // journal.token_id column
  sqlite.exec(MIGRATION_0005); // entity_relationships index
  sqlite.exec(MIGRATION_0006); // gates table
  sqlite.exec(MIGRATION_0007); // signals table
  sqlite.exec(MIGRATION_0008); // records table
  sqlite.exec(MIGRATION_0009); // entity FTS
  sqlite.exec(MIGRATION_0010); // claims: holder → machine + user
  sqlite.exec(MIGRATION_0011); // content_inline column
  sqlite.exec(MIGRATION_0012); // record_search_docs FTS5
  sqlite.exec(
    "ALTER TABLE journal ADD COLUMN source TEXT DEFAULT NULL; ALTER TABLE journal ADD COLUMN source_version TEXT DEFAULT NULL;",
  );
  sqlite.exec(
    "ALTER TABLE record_revisions ADD COLUMN token_id TEXT DEFAULT NULL; ALTER TABLE record_revisions ADD COLUMN source TEXT DEFAULT NULL; ALTER TABLE record_revisions ADD COLUMN source_version TEXT DEFAULT NULL;",
  );
  sqlite.exec(MIGRATION_0018); // entity_tags + artifact_tags tables
  const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, sqlite };
}

function createEntity(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  overrides?: { id?: string; type?: string; data?: Record<string, unknown> },
) {
  return entityOps.create(
    db,
    {
      id: overrides?.id ?? `ent-${Date.now()}`,
      type: overrides?.type ?? "task",
      data: overrides?.data ?? { name: "Deploy pipeline", status: "open" },
      created_by: "test-actor",
    },
    1,
    { actor: "test-actor" },
  );
}

function acquireClaim(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  entityId: string,
): number {
  const result = coordinationOps.acquire(
    db,
    entityId,
    "test-actor",
    "test-actor",
    "exclusive",
    60_000,
  );
  return result.fence;
}

describe("searchEntities", () => {
  it("finds entity by name after create", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "e1", data: { name: "Deploy pipeline" } });
    const results = entityOps.searchEntities(db, { q: "deploy" });
    expect(results).toHaveLength(1);
    expect(results[0].entity_id).toBe("e1");
    expect(results[0].name).toBe("Deploy pipeline");
    expect(results[0].snippet).toBeTruthy();
  });

  it("finds updated name after update", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "e2", data: { name: "Deploy pipeline" } });
    const fence = acquireClaim(db, "e2");
    entityOps.update(db, "e2", { name: "Release pipeline" }, fence, {
      actor: "test-actor",
    });
    const found = entityOps.searchEntities(db, { q: "release" });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("Release pipeline");
    const notFound = entityOps.searchEntities(db, { q: "deploy" });
    expect(notFound).toHaveLength(0);
  });

  it("removes from index after archive", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "e3", data: { name: "Archive test entity" } });
    const fence = acquireClaim(db, "e3");
    entityOps.archive(db, "e3", fence, { actor: "test-actor" });
    const results = entityOps.searchEntities(db, { q: "archive" });
    expect(results).toHaveLength(0);
  });

  it("filters by entity_type", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "e4", type: "task", data: { name: "Task item" } });
    createEntity(db, { id: "e5", type: "epic", data: { name: "Epic item" } });
    const taskOnly = entityOps.searchEntities(db, {
      q: "item",
      entity_type: "task",
    });
    expect(taskOnly).toHaveLength(1);
    expect(taskOnly[0].entity_type).toBe("task");
  });

  it("respects limit", () => {
    const { db } = createTestDb();
    for (let i = 0; i < 5; i++) {
      createEntity(db, {
        id: `e${i + 10}`,
        data: { name: `Searchable item ${i}` },
      });
    }
    const limited = entityOps.searchEntities(db, { q: "searchable", limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it("returns empty array for no matches", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "e20", data: { name: "Something else" } });
    const results = entityOps.searchEntities(db, { q: "nonexistent" });
    expect(results).toHaveLength(0);
  });

  it("throws SearchQueryError for overly long queries", () => {
    const { db } = createTestDb();
    expect(() => entityOps.searchEntities(db, { q: "x".repeat(201) })).toThrow(
      SearchQueryError,
    );
  });

  it("finds entity by data.title term (issue #412)", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "t1", data: { title: "Auth System" } });
    const results = entityOps.searchEntities(db, { q: "auth" });
    expect(results.map((r) => r.entity_id)).toContain("t1");
  });

  it("finds updated data.title after update (issue #412)", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "t2", data: { title: "Auth System" } });
    const fence = acquireClaim(db, "t2");
    entityOps.update(db, "t2", { title: "Billing System" }, fence, {
      actor: "test-actor",
    });
    expect(
      entityOps.searchEntities(db, { q: "billing" }).map((r) => r.entity_id),
    ).toContain("t2");
    expect(entityOps.searchEntities(db, { q: "auth" })).toHaveLength(0);
  });

  it("prefers data.title over data.name when both present (issue #412)", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "t3", data: { title: "Payments", name: "Legacy" } });
    expect(
      entityOps.searchEntities(db, { q: "payments" }).map((r) => r.entity_id),
    ).toContain("t3");
  });
});

describe("searchAll returns interleaved entity and artifact results", () => {
  it("returns entity results with type=entity when only entities exist", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "e30", data: { name: "Deploy service" } });
    // searchAll calls searchArtifacts too -- with no artifacts, only entity results returned
    const results = entityOps.searchAll(db, { q: "deploy" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe("entity");
  });
});

describe("searchAll returns all three result types", () => {
  it("interleaves entities, artifacts, and records in round-robin", async () => {
    const { db, sqlite } = createTestDb();

    // Create an entity
    createEntity(db, {
      id: "unified-e1",
      data: { name: "unifiedterm testrun" },
    });

    // Create an artifact with searchText
    sqlite
      .prepare(
        "INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, tombstoned) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "sources/unifiedterm.md",
        null,
        "lesson",
        "abc123unified",
        100,
        null,
        "text/markdown",
        Date.now(),
        "agent",
        0,
      );
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO artifact_search_docs(artifact_key, kind, mime_type, resource, title, body_text, indexed_at, source_sha256, tombstoned) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "sources/unifiedterm.md",
        "lesson",
        "text/markdown",
        null,
        "Unified Title",
        "unifiedterm content",
        Date.now(),
        "abc123unified",
        0,
      );

    // Create a record
    await recordOps.createRecord(
      db,
      {
        type: "note",
        key: "unified-r1",
        value: { content: "unifiedterm record data" },
        schema_version: 1,
        actor: "agent",
      },
      { actor: "agent" },
    );

    const results = entityOps.searchAll(db, { q: "unifiedterm", limit: 10 });
    const types = results.map((r) => r.type);

    // All three types should be present
    expect(types).toContain("entity");
    expect(types).toContain("artifact");
    expect(types).toContain("record");
  });

  it("round-robin interleaving respects limit", async () => {
    const { db } = createTestDb();
    createEntity(db, { id: "rr-e1", data: { name: "rrterm entity1" } });
    createEntity(db, { id: "rr-e2", data: { name: "rrterm entity2" } });

    const results = entityOps.searchAll(db, { q: "rrterm", limit: 1 });
    expect(results).toHaveLength(1);
  });
});
