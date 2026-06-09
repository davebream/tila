import { FenceError } from "@tila/core";
import { describe, expect, it } from "vitest";
import { FenceNotFoundError, fenceOps } from "../../ops-sqlite/src";
import { createTestDb } from "./helpers/create-test-db";

const { assertResourceFence } = fenceOps;

function insertEntity(
  sqlite: ReturnType<typeof createTestDb>["sqlite"],
  id: string,
  type: string,
) {
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, 1, '{}', 0, ?, ?, 'test')",
    )
    .run(id, type, now, now);
}

describe("assertResourceFence", () => {
  it("validates an exact resource fence", () => {
    const { db, sqlite } = createTestDb();
    sqlite
      .prepare("INSERT INTO fences (resource, current_fence) VALUES (?, ?)")
      .run("task:T-1", 2);

    expect(() => assertResourceFence(db, "task:T-1", 2)).not.toThrow();
  });

  it("validates a bare entity id against its typed claim resource", () => {
    const { db, sqlite } = createTestDb();
    insertEntity(sqlite, "T-1", "task");
    sqlite
      .prepare("INSERT INTO fences (resource, current_fence) VALUES (?, ?)")
      .run("task:T-1", 2);

    expect(() => assertResourceFence(db, "T-1", 2)).not.toThrow();
  });

  it("rejects stale fences through the typed entity fallback", () => {
    const { db, sqlite } = createTestDb();
    insertEntity(sqlite, "T-1", "task");
    sqlite
      .prepare("INSERT INTO fences (resource, current_fence) VALUES (?, ?)")
      .run("task:T-1", 3);

    expect(() => assertResourceFence(db, "T-1", 2)).toThrow(FenceError);
  });

  it("rejects a supplied fence when no matching fence row exists", () => {
    const { db } = createTestDb();

    expect(() => assertResourceFence(db, "T-1", 1)).toThrow(FenceNotFoundError);
  });
});
