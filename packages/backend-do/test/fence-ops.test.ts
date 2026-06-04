import { FenceError } from "@tila/core";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
  FenceNotFoundError,
  MIGRATION_0001,
  fenceOps,
  schema,
} from "../../ops-sqlite/src";

const { assertResourceFence } = fenceOps;

// Cloudflare's SQLite fork supports COALESCE in PRIMARY KEY; standard SQLite does not.
const MIGRATION_0001_TEST = MIGRATION_0001.replace(
  "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
  "PRIMARY KEY (from_key, type)",
);

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(MIGRATION_0001_TEST);
  const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, sqlite };
}

function insertEntity(
  sqlite: InstanceType<typeof Database>,
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
