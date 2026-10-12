import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "../src/migrations-sql";
import type * as schema from "../src/schema";
import { searchPage } from "../src/search-page-ops";
import { runMigration } from "./helpers";

describe("MIGRATION_0035 task paging and id search", () => {
  it("makes documents indexed before the migration findable by id", () => {
    const raw = new Database(":memory:");
    raw.exec(MIGRATION_BOOTSTRAP);
    for (const migration of MIGRATIONS.filter((m) => m.version <= 34))
      runMigration(raw, migration);

    raw
      .prepare(
        "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, 'task', 1, '{}', 0, 1, 1, 'seed')",
      )
      .run("legacy-777");
    raw
      .prepare(
        "INSERT INTO entity_search_docs (entity_id, entity_type, name, indexed_at) VALUES (?, 'task', 'Old title', 1)",
      )
      .run("legacy-777");

    const migration35 = MIGRATIONS.find((m) => m.version === 35);
    if (!migration35) throw new Error("migration 35 missing");
    runMigration(raw, migration35);

    const db = drizzle(raw) as unknown as BaseSQLiteDatabase<
      "sync",
      unknown,
      typeof schema
    >;
    const find = (q: string) =>
      searchPage(db, {
        q,
        syntax: "literal",
        kinds: ["task"],
        limit: 5,
      }).results.map((r) => (r.type === "entity" ? r.entity_id : ""));
    expect(find("777")).toEqual(["legacy-777"]);
    expect(find("old title")).toEqual(["legacy-777"]);

    // Triggers keep both columns in sync after the rebuild.
    raw
      .prepare(
        "UPDATE entity_search_docs SET name = 'New title' WHERE entity_id = ?",
      )
      .run("legacy-777");
    expect(find("old")).toEqual([]);
    expect(find("new")).toEqual(["legacy-777"]);
    raw
      .prepare("DELETE FROM entity_search_docs WHERE entity_id = ?")
      .run("legacy-777");
    expect(find("777")).toEqual([]);

    const indexes = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entities'",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_entities_created_id",
        "idx_entities_updated_id",
        "idx_entities_type_id",
      ]),
    );
    raw.close();
  });
});
