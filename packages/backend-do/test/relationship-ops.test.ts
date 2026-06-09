import { relationshipOps } from "@tila/ops-sqlite";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/create-test-db";

function countRows(
  sqlite: ReturnType<typeof createTestDb>["sqlite"],
  table: string,
): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return row.n;
}

function journalCount(
  sqlite: ReturnType<typeof createTestDb>["sqlite"],
): number {
  return countRows(sqlite, "journal");
}

function relCount(sqlite: ReturnType<typeof createTestDb>["sqlite"]): number {
  return countRows(sqlite, "entity_relationships");
}

// ---------------------------------------------------------------------------
// insertEntityRelationship — idempotent insert
// ---------------------------------------------------------------------------

describe("insertEntityRelationship", () => {
  it("(a) second identical insert returns {created:false} and leaves exactly one row", () => {
    const { db, sqlite } = createTestDb();

    const input = {
      from_id: "task-1",
      to_id: "task-2",
      type: "blocks" as const,
      schema_version: 1,
    };

    const first = relationshipOps.insertEntityRelationship(db, input, "tester");
    expect(first.created).toBe(true);

    const second = relationshipOps.insertEntityRelationship(
      db,
      input,
      "tester",
    );
    expect(second.created).toBe(false);

    expect(relCount(sqlite)).toBe(1);
  });

  it("(b) first insert returns {created:true} and writes exactly one journal row", () => {
    const { db, sqlite } = createTestDb();

    const result = relationshipOps.insertEntityRelationship(
      db,
      { from_id: "task-1", to_id: "task-2", type: "blocks", schema_version: 1 },
      "tester",
    );

    expect(result.created).toBe(true);
    expect(journalCount(sqlite)).toBe(1);
  });

  it("(b2) duplicate insert adds ZERO additional journal rows (no-op must not journal)", () => {
    const { db, sqlite } = createTestDb();

    const input = {
      from_id: "task-1",
      to_id: "task-2",
      type: "blocks" as const,
      schema_version: 1,
    };

    relationshipOps.insertEntityRelationship(db, input, "tester");
    expect(journalCount(sqlite)).toBe(1);

    relationshipOps.insertEntityRelationship(db, input, "tester");
    // Journal count must still be 1 — no new journal row for the duplicate
    expect(journalCount(sqlite)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// listEntityRelationships — type filter
// ---------------------------------------------------------------------------

describe("listEntityRelationships", () => {
  it("(c) returns only relationships matching the given type", () => {
    const { db } = createTestDb();

    // Insert two different types
    relationshipOps.insertEntityRelationship(
      db,
      { from_id: "A", to_id: "B", type: "blocks", schema_version: 1 },
      "tester",
    );
    relationshipOps.insertEntityRelationship(
      db,
      { from_id: "A", to_id: "C", type: "parent-child", schema_version: 1 },
      "tester",
    );

    const result = relationshipOps.listEntityRelationships(db, {
      type: "blocks",
    });

    expect(result).toHaveLength(1);
    expect(result[0].from_id).toBe("A");
    expect(result[0].to_id).toBe("B");
    expect(result[0].type).toBe("blocks");
  });

  it("(c2) {from_id, type} uses AND semantics — returns intersection only", () => {
    const { db } = createTestDb();

    // A→B blocks
    relationshipOps.insertEntityRelationship(
      db,
      { from_id: "A", to_id: "B", type: "blocks", schema_version: 1 },
      "tester",
    );
    // A→C parent-child (same from_id, different type)
    relationshipOps.insertEntityRelationship(
      db,
      { from_id: "A", to_id: "C", type: "parent-child", schema_version: 1 },
      "tester",
    );
    // X→D blocks (different from_id, same type)
    relationshipOps.insertEntityRelationship(
      db,
      { from_id: "X", to_id: "D", type: "blocks", schema_version: 1 },
      "tester",
    );

    const result = relationshipOps.listEntityRelationships(db, {
      from_id: "A",
      type: "blocks",
    });

    // Must only return A→B (intersection of from_id=A AND type=blocks)
    expect(result).toHaveLength(1);
    expect(result[0].from_id).toBe("A");
    expect(result[0].to_id).toBe("B");
    expect(result[0].type).toBe("blocks");
  });
});

// ---------------------------------------------------------------------------
// deleteEntityRelationship — removed flag
// ---------------------------------------------------------------------------

describe("deleteEntityRelationship", () => {
  it("(d) returns {removed:false} when deleting an absent edge", () => {
    const { db } = createTestDb();

    const result = relationshipOps.deleteEntityRelationship(
      db,
      "no-such-from",
      "no-such-to",
      "blocks",
      "tester",
    );

    expect(result.removed).toBe(false);
  });

  it("(d) returns {removed:true} when deleting a present edge", () => {
    const { db, sqlite } = createTestDb();

    relationshipOps.insertEntityRelationship(
      db,
      { from_id: "A", to_id: "B", type: "blocks", schema_version: 1 },
      "tester",
    );
    expect(relCount(sqlite)).toBe(1);

    const result = relationshipOps.deleteEntityRelationship(
      db,
      "A",
      "B",
      "blocks",
      "tester",
    );

    expect(result.removed).toBe(true);
    expect(relCount(sqlite)).toBe(0);
  });
});
