import { describe, expect, it } from "vitest";
import { createEntity, createTestDb } from "./helpers";

describe("helpers", () => {
  it("createTestDb returns a working db with all migrations applied", () => {
    const { db, rawDb } = createTestDb();
    expect(db).toBeDefined();
    expect(rawDb).toBeDefined();
    // Verify key tables from migrations were created
    const tables = rawDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("entities");
    expect(tableNames).toContain("records");
  });

  it("createEntity inserts an entity into the db", () => {
    const { db } = createTestDb();
    const entity = createEntity(db, { id: "test-ent-1", type: "task" });
    expect(entity.id).toBe("test-ent-1");
    expect(entity.type).toBe("task");
  });
});
