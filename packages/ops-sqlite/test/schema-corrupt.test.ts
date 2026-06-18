import { parseSchemaToml } from "@tila/core";
/**
 * C3: Schema-validation fail-closed tests (RED → GREEN)
 *
 * Asserts that a malformed stored schema row causes `resolveCurrentSchema` and
 * `enrichEntity` to throw `SchemaCorruptError` rather than silently returning
 * `null` / skipping constraint checks.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveCurrentSchema } from "../src/constraint-ops";
import { list as listEntities } from "../src/entity-ops";
import { applySchema } from "../src/schema-ops";
import { type TestDb, createEntity, createTestDb } from "./helpers";

// A valid TOML to bootstrap the schema history, then we corrupt the stored row.
const VALID_SCHEMA_TOML = `
schema_version = 1

[work_units.task]
label = "Task"
`;

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

// ---------------------------------------------------------------------------
// Write/validation path: resolveCurrentSchema throws on corrupt TOML
// ---------------------------------------------------------------------------

describe("resolveCurrentSchema — write/validation path", () => {
  it("returns null when no schema is applied (legitimate no-schema case)", () => {
    // No schema applied — must return null, NOT throw
    const schema = resolveCurrentSchema(testDb.db);
    expect(schema).toBeNull();
  });

  it("returns the parsed schema when TOML is valid", () => {
    applySchema(testDb.db, VALID_SCHEMA_TOML, "test-actor");
    const schema = resolveCurrentSchema(testDb.db);
    expect(schema).not.toBeNull();
    expect(schema?.work_units).toHaveProperty("task");
  });

  it("throws SchemaCorruptError when stored schema TOML is malformed", () => {
    // Apply a valid schema first so the row exists
    applySchema(testDb.db, VALID_SCHEMA_TOML, "test-actor");
    // Directly corrupt the stored definition (bypass the apply validator)
    testDb.rawDb
      .prepare("UPDATE _schema_history SET definition = ?")
      .run("NOT_VALID_TOML [[[ broken");

    // Must throw SchemaCorruptError, NOT return null
    expect(() => resolveCurrentSchema(testDb.db)).toThrow();
    expect(() => resolveCurrentSchema(testDb.db)).toThrowError(
      expect.objectContaining({ name: "SchemaCorruptError" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Read/enrichment path: enrichEntity (via listEntities) throws on corrupt TOML
// ---------------------------------------------------------------------------

describe("enrichEntity (listEntities) — read/enrichment path", () => {
  it("throws SchemaCorruptError when the entity's schema version has malformed TOML", () => {
    // Apply schema and create an entity that references schema_version 1
    applySchema(testDb.db, VALID_SCHEMA_TOML, "test-actor");
    createEntity(testDb.db, { type: "task" });

    // Now corrupt the stored TOML for that schema version
    testDb.rawDb
      .prepare("UPDATE _schema_history SET definition = ? WHERE version = 1")
      .run("NOT_VALID_TOML [[[ broken");

    // Listing entities with enrichOpts calls enrichEntity internally — should throw SchemaCorruptError
    expect(() =>
      listEntities(testDb.db, {}, { db: testDb.db, parseSchemaToml }),
    ).toThrow(expect.objectContaining({ name: "SchemaCorruptError" }));
  });
});
