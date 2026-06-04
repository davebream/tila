import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_0001,
  MIGRATION_0004,
  MIGRATION_0005,
  MIGRATION_0006,
  MIGRATION_0007,
  MIGRATION_0008,
  MIGRATION_0009,
  MIGRATION_0010,
  coordinationOps,
  entityOps,
  schema,
} from "../../ops-sqlite/src";

const MIGRATION_0001_TEST = MIGRATION_0001.replace(
  "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
  "PRIMARY KEY (from_key, type)",
);

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_0001_TEST);
  sqlite.exec(MIGRATION_0004); // journal.token_id column
  sqlite.exec(MIGRATION_0005); // entity_relationships index
  sqlite.exec(MIGRATION_0006); // gates table
  sqlite.exec(MIGRATION_0007); // signals table
  sqlite.exec(MIGRATION_0008); // records table
  sqlite.exec(MIGRATION_0009); // entity FTS
  sqlite.exec(MIGRATION_0010); // claims: holder → machine + user
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

describe("entity_search_docs transaction coupling", () => {
  it("inserts search doc on entity create", () => {
    const { db, sqlite } = createTestDb();
    entityOps.create(
      db,
      {
        id: "e1",
        type: "task",
        data: { name: "Test entity" },
        created_by: "actor",
      },
      1,
      { actor: "actor" },
    );
    const row = sqlite
      .prepare("SELECT * FROM entity_search_docs WHERE entity_id = ?")
      .get("e1") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.entity_type).toBe("task");
    expect(row.name).toBe("Test entity");
  });

  it("updates search doc on entity update", () => {
    const { db, sqlite } = createTestDb();
    entityOps.create(
      db,
      {
        id: "e2",
        type: "task",
        data: { name: "Original" },
        created_by: "actor",
      },
      1,
      { actor: "actor" },
    );
    const acquired = coordinationOps.acquire(
      db,
      "e2",
      "actor",
      "actor",
      "exclusive",
      60_000,
    );
    entityOps.update(db, "e2", { name: "Updated" }, acquired.fence, {
      actor: "actor",
    });
    const row = sqlite
      .prepare("SELECT * FROM entity_search_docs WHERE entity_id = ?")
      .get("e2") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.name).toBe("Updated");
  });

  it("deletes search doc on entity archive", () => {
    const { db, sqlite } = createTestDb();
    entityOps.create(
      db,
      {
        id: "e3",
        type: "task",
        data: { name: "To archive" },
        created_by: "actor",
      },
      1,
      { actor: "actor" },
    );
    const acquired = coordinationOps.acquire(
      db,
      "e3",
      "actor",
      "actor",
      "exclusive",
      60_000,
    );
    entityOps.archive(db, "e3", acquired.fence, { actor: "actor" });
    const row = sqlite
      .prepare("SELECT * FROM entity_search_docs WHERE entity_id = ?")
      .get("e3");
    expect(row).toBeUndefined();
  });

  it("FTS5 trigger fires on insert -- direct FTS query finds entity", () => {
    const { db, sqlite } = createTestDb();
    entityOps.create(
      db,
      {
        id: "e4",
        type: "task",
        data: { name: "Searchable entity" },
        created_by: "actor",
      },
      1,
      { actor: "actor" },
    );
    const ftsRow = sqlite
      .prepare(
        "SELECT * FROM entity_search_docs_fts WHERE entity_search_docs_fts MATCH ?",
      )
      .get("searchable") as Record<string, unknown> | undefined;
    expect(ftsRow).toBeTruthy();
  });

  it("FTS5 trigger fires on delete -- FTS query returns nothing", () => {
    const { db, sqlite } = createTestDb();
    entityOps.create(
      db,
      {
        id: "e5",
        type: "task",
        data: { name: "Temporary entity" },
        created_by: "actor",
      },
      1,
      { actor: "actor" },
    );
    const acquired = coordinationOps.acquire(
      db,
      "e5",
      "actor",
      "actor",
      "exclusive",
      60_000,
    );
    entityOps.archive(db, "e5", acquired.fence, { actor: "actor" });
    const ftsRows = sqlite
      .prepare(
        "SELECT * FROM entity_search_docs_fts WHERE entity_search_docs_fts MATCH ?",
      )
      .all("temporary");
    expect(ftsRows).toHaveLength(0);
  });
});
