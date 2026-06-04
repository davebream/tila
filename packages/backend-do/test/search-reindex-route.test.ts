/**
 * Tests for POST /search/reindex DO route body parsing (issue #412).
 *
 * The DO handler must:
 * - Return 400 validation-error for an empty/missing body
 * - NOT throw / 500 when no JSON body is provided
 *
 * The valid-body 2xx path is tested in the integration suite
 * (packages/integration-tests/src/search.test.ts) because the DO handler
 * calls ctx.storage.put/setAlarm which throws on the {ctx: {} as DurableObjectState}
 * harness stub — the 400 path returns before touching storage, so it is runnable here.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATION_0001,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0011,
  MIGRATION_0016,
  runMigration0016,
  schema,
} from "../../ops-sqlite/src";
import { createArtifactRoutes } from "../src/routes/artifact-routes";
import type { RouterDeps } from "../src/routes/types";

const MIGRATION_0001_TEST = MIGRATION_0001.replace(
  "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
  "PRIMARY KEY (from_key, type)",
).replace(",\n  FOREIGN KEY (resource) REFERENCES entities(id)", "");

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_0001_TEST);
  sqlite.exec(MIGRATION_0003);
  sqlite.exec(MIGRATION_0004);
  sqlite.exec(MIGRATION_0011);
  sqlite.exec(
    "ALTER TABLE journal ADD COLUMN source TEXT DEFAULT NULL; ALTER TABLE journal ADD COLUMN source_version TEXT DEFAULT NULL;",
  );
  runMigration0016({
    sql: {
      exec<T>(statement: string) {
        if (/^\s*(SELECT|PRAGMA)\b/i.test(statement)) {
          return { toArray: () => sqlite.prepare(statement).all() as T[] };
        }
        sqlite.exec(statement);
        return { toArray: () => [] as T[] };
      },
    },
  });
  const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, sqlite };
}

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: vi.fn() as RouterDeps["enrichOpts"],
  };
}

let sqlite: InstanceType<typeof Database>;
let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;

beforeEach(() => {
  const testDb = createTestDb();
  sqlite = testDb.sqlite;
  db = testDb.db;
});

afterEach(() => {
  sqlite.close();
});

describe("POST /search/reindex -- body validation (issue #412)", () => {
  it("returns 400 (not 500) for /search/reindex with empty body", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/search/reindex", { method: "POST" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("validation-error");
  });

  it("returns 400 for /search/reindex with invalid JSON body", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/search/reindex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("validation-error");
  });

  it("returns 400 for /search/reindex with missing kind field", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/search/reindex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "unknown" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("validation-error");
  });
});
