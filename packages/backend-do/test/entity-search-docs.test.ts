import { describe, expect, it } from "vitest";
import { coordinationOps, entityOps } from "../../ops-sqlite/src";
import { createTestDb } from "./helpers/create-test-db";

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
