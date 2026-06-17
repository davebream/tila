import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { truncateAllDomainTables } from "../src/destroy-ops";
import { DOMAIN_TABLE_NAMES, countStoreRows } from "../src/store-counts-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

// A RawSqlExecutor backed by the test's better-sqlite3 handle — mirrors the DO's
// ctx.storage.sql seam (a single exec(statement) method).
function rawExecutor(rawDb: TestDb["rawDb"]) {
  return {
    exec(statement: string) {
      rawDb.exec(statement);
    },
  };
}

describe("truncateAllDomainTables", () => {
  it("empties every domain table and _schema_history", () => {
    const now = Date.now();
    // Seed a spread of domain tables.
    testDb.rawDb
      .prepare(
        `INSERT INTO entities(id, type, schema_version, data, archived, created_at, updated_at, created_by)
         VALUES('e-1', 'task', 1, '{}', 0, ${now}, ${now}, 'test-actor')`,
      )
      .run();
    testDb.rawDb
      .prepare(
        `INSERT INTO fences(resource, current_fence) VALUES('task:e-1', 2)`,
      )
      .run();
    testDb.rawDb
      .prepare(
        `INSERT INTO claims(resource, holder, machine, user, mode, fence, acquired_at, expires_at, metadata)
         VALUES('task:e-1', 'm/u', 'm', 'u', 'exclusive', 2, ${now}, ${now + 1000}, '{}')`,
      )
      .run();
    testDb.rawDb
      .prepare(
        `INSERT INTO presence(machine, last_seen, info) VALUES('m', ${now}, '{}')`,
      )
      .run();
    // Seed a _schema_history row: destroy must also clear migration bookkeeping.
    testDb.rawDb
      .prepare(
        `INSERT INTO _schema_history(version, definition, applied_at, applied_by)
         VALUES(1, '{}', ${now}, 'test-actor')`,
      )
      .run();
    expect(countStoreRows(testDb.db).schemaHistory).toBeGreaterThan(0);

    truncateAllDomainTables(rawExecutor(testDb.rawDb));

    const result = countStoreRows(testDb.db);
    for (const table of DOMAIN_TABLE_NAMES) {
      expect(result.domain[table], `expected ${table} to be empty`).toBe(0);
    }
    expect(result.schemaHistory).toBe(0);
  });

  it("keeps the schema intact (tables still queryable after truncation)", () => {
    truncateAllDomainTables(rawExecutor(testDb.rawDb));

    // If truncation had dropped tables, countStoreRows would throw on the missing
    // table. A clean all-zero read proves the schema is intact.
    const result = countStoreRows(testDb.db);
    for (const table of DOMAIN_TABLE_NAMES) {
      expect(result.domain[table]).toBe(0);
    }
  });
});
