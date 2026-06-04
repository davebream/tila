import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOMAIN_TABLE_NAMES, countStoreRows } from "../src/store-counts-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

// The canonical set of domain tables that must be zero after a destroy + reconstruction.
const EXPECTED_DOMAIN_TABLES = [
  "entities",
  "entity_relationships",
  "artifact_pointers",
  "entity_artifact_references",
  "artifact_relationships",
  "journal",
  "_journal_archive_watermark",
  "claims",
  "fences",
  "presence",
  "gates",
  "signals",
  "records",
  "record_tags",
  "record_revisions",
  "artifact_search_docs",
  "entity_search_docs",
  "record_search_docs",
];

describe("countStoreRows", () => {
  it("returns all-zero domain counts on empty DB", () => {
    const result = countStoreRows(testDb.db);

    for (const table of EXPECTED_DOMAIN_TABLES) {
      expect(result.domain[table], `expected ${table} in domain counts`).toBe(
        0,
      );
    }
  });

  it("domain key set matches exactly the enumerated table list (drift guard)", () => {
    const result = countStoreRows(testDb.db);

    const actualKeys = Object.keys(result.domain).sort();
    const expectedKeys = [...EXPECTED_DOMAIN_TABLES].sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  it("increments count when a row is inserted", () => {
    testDb.rawDb
      .prepare(
        `INSERT INTO entities(id, type, schema_version, data, archived, created_at, updated_at, created_by)
         VALUES('e-1', 'task', 1, '{}', 0, ${Date.now()}, ${Date.now()}, 'test-actor')`,
      )
      .run();

    testDb.rawDb
      .prepare(
        `INSERT INTO fences(resource, current_fence) VALUES('task:T-1', 2)`,
      )
      .run();

    const result = countStoreRows(testDb.db);

    expect(result.domain.entities).toBe(1);
    expect(result.domain.fences).toBe(1);
    // All others still 0
    for (const table of EXPECTED_DOMAIN_TABLES) {
      if (table !== "entities" && table !== "fences") {
        expect(result.domain[table]).toBe(0);
      }
    }
  });

  it("returns schemaHistory count separately (diagnostic, not in domain)", () => {
    const result = countStoreRows(testDb.db);

    // schemaHistory is returned separately
    expect(typeof result.schemaHistory).toBe("number");
    // Must not appear in domain keys
    expect("_schema_history" in result.domain).toBe(false);
  });

  it("re-exports DOMAIN_TABLE_NAMES as the canonical list", () => {
    expect([...DOMAIN_TABLE_NAMES].sort()).toEqual(
      [...EXPECTED_DOMAIN_TABLES].sort(),
    );
  });
});
