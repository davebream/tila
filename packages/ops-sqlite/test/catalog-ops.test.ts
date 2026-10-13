import { type TilaSchemaToml, TilaSchemaTomlSchema } from "@tila/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRecordCatalog,
  buildWorkCatalog,
  permitsRecordType,
} from "../src/catalog-ops";
import { countByType } from "../src/entity-ops";
import { countRecordTypes } from "../src/record-ops";
import * as schema from "../src/schema";
import { type TestDb, createEntity, createTestDb } from "./helpers";

const SCHEMA: TilaSchemaToml = TilaSchemaTomlSchema.parse({
  schema_version: 1,
  work_units: {
    epic: { fields: { title: { type: "string" } } },
    story: {
      fields: {
        headline: { type: "string" },
        state: { type: "enum", values: ["queued", "shipped"] },
      },
      lifecycle: {
        field: "state",
        dispatchable: ["queued"],
        terminal: ["shipped"],
        dependency_satisfied: ["shipped"],
      },
      presentation: { title: "headline" },
    },
    empty: { fields: {} },
  },
  records: {
    deploy: {
      fields: { service: { type: "string" } },
      presentation: { title: "service", kind: "configuration" },
    },
    runbook: { fields: {} },
  },
});

let testDb: TestDb;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.rawDb.close();
});

function insertRecord(type: string, key: string, archived = 0) {
  testDb.db
    .insert(schema.records)
    .values({
      type,
      key,
      schema_version: 1,
      value_json: "{}",
      value_sha256: "0".repeat(64),
      revision: 1,
      archived,
      created_at: 1,
      updated_at: 1,
      updated_by: "test",
    })
    .run();
}

describe("countByType", () => {
  it("counts archived and active tasks per type", () => {
    createEntity(testDb.db, { id: "s1", type: "story" });
    createEntity(testDb.db, { id: "s2", type: "story" });
    createEntity(testDb.db, { id: "legacy-1", type: "bug" });
    testDb.db
      .update(schema.entities)
      .set({ archived: 1 })
      .where(eq(schema.entities.id, "s2"))
      .run();

    expect(countByType(testDb.db)).toEqual([
      { type: "bug", count: 1, archived_count: 0 },
      { type: "story", count: 1, archived_count: 1 },
    ]);
  });

  it("excludes forbidden types and children of forbidden parents", () => {
    createEntity(testDb.db, { id: "e1", type: "epic" });
    createEntity(testDb.db, { id: "s1", type: "story" });
    createEntity(testDb.db, {
      id: "s2",
      type: "story",
      data: { parent_id: "e1" },
    });

    expect(countByType(testDb.db, { task_types: ["story"] })).toEqual([
      { type: "story", count: 1, archived_count: 0 },
    ]);
  });
});

describe("countRecordTypes", () => {
  it("counts records within key-prefix restrictions", () => {
    insertRecord("deploy", "prod/api");
    insertRecord("deploy", "staging/api");
    insertRecord("deploy", "prod/web", 1);
    insertRecord("legacy", "one");

    expect(countRecordTypes(testDb.db)).toEqual([
      { type: "deploy", count: 2, archived_count: 1 },
      { type: "legacy", count: 1, archived_count: 0 },
    ]);
    expect(
      countRecordTypes(testDb.db, {
        records: [{ type: "deploy", key_prefixes: ["prod"] }],
      }),
    ).toEqual([{ type: "deploy", count: 1, archived_count: 1 }]);
  });
});

describe("buildWorkCatalog", () => {
  it("lists declared empty types, declared types with rows, and undeclared in-use types", () => {
    const catalog = buildWorkCatalog({
      schema: { state: "ok", schema: SCHEMA },
      counts: [
        { type: "bug", count: 4, archived_count: 0 },
        { type: "story", count: 2, archived_count: 1 },
      ],
    });

    expect(catalog.types.map((t) => [t.type, t.declaration, t.count])).toEqual([
      ["bug", "undeclared", 4],
      ["empty", "declared", 0],
      ["epic", "declared", 0],
      ["story", "declared", 2],
    ]);
    expect(catalog.scope).toEqual({ restricted: false });
    expect(catalog.incomplete).toBeUndefined();

    const story = catalog.types.find((t) => t.type === "story");
    expect(story?.definition?.fields).toEqual([
      { name: "headline", type: "string", required: false },
      {
        name: "state",
        type: "enum",
        required: false,
        values: ["queued", "shipped"],
      },
    ]);
    expect(story?.definition?.lifecycle?.field).toBe("state");
    expect(story?.definition?.presentation).toEqual({ title: "headline" });
    expect(
      catalog.types.find((t) => t.type === "bug")?.definition,
    ).toBeUndefined();
  });

  it("treats a project without a schema as complete with nothing declared", () => {
    const catalog = buildWorkCatalog({
      schema: { state: "none" },
      counts: [{ type: "task", count: 1, archived_count: 0 }],
    });
    expect(catalog.types).toEqual([
      { type: "task", declaration: "undeclared", count: 1, archived_count: 0 },
    ]);
    expect(catalog.incomplete).toBeUndefined();
  });

  it("marks declaration unknown and reports incomplete when the schema is invalid", () => {
    const catalog = buildWorkCatalog({
      schema: { state: "invalid" },
      counts: [{ type: "task", count: 1, archived_count: 0 }],
    });
    expect(catalog.types[0].declaration).toBe("unknown");
    expect(catalog.incomplete).toEqual({ declared_types: "invalid" });
  });

  it("reports unavailable counts without dropping declared types", () => {
    const catalog = buildWorkCatalog({
      schema: { state: "ok", schema: SCHEMA },
      counts: null,
    });
    expect(catalog.types.map((t) => t.type)).toEqual([
      "empty",
      "epic",
      "story",
    ]);
    expect(catalog.incomplete).toEqual({ in_use_types: "unavailable" });
  });

  it("never shows a restricted caller forbidden declared types or schema state", () => {
    const catalog = buildWorkCatalog({
      schema: { state: "unavailable" },
      counts: [{ type: "story", count: 1, archived_count: 0 }],
      restrictions: { task_types: ["story"] },
    });
    expect(catalog.types).toEqual([
      { type: "story", declaration: "undeclared", count: 1, archived_count: 0 },
    ]);
    expect(catalog.scope).toEqual({ restricted: true });
    expect(catalog.incomplete).toBeUndefined();
    // An invalid schema looks the same as an unavailable one to this caller.
    expect(
      buildWorkCatalog({
        schema: { state: "invalid" },
        counts: [{ type: "story", count: 1, archived_count: 0 }],
        restrictions: { task_types: ["story"] },
      }),
    ).toEqual(catalog);

    const declared = buildWorkCatalog({
      schema: { state: "ok", schema: SCHEMA },
      counts: [],
      restrictions: { task_types: ["story"] },
    });
    expect(declared.types.map((t) => t.type)).toEqual(["story"]);
  });

  it("ignores count rows for types outside the restriction", () => {
    const catalog = buildWorkCatalog({
      schema: { state: "none" },
      counts: [{ type: "epic", count: 1, archived_count: 0 }],
      restrictions: { task_types: ["story"] },
    });
    expect(catalog.types).toEqual([]);
  });
});

describe("buildRecordCatalog", () => {
  it("carries the declared classification and never infers one from names", () => {
    const catalog = buildRecordCatalog({
      schema: { state: "ok", schema: SCHEMA },
      counts: [{ type: "config", count: 2, archived_count: 0 }],
    });
    const byType = Object.fromEntries(catalog.types.map((t) => [t.type, t]));
    expect(byType.deploy.definition?.presentation?.kind).toBe("configuration");
    expect(byType.runbook.declaration).toBe("declared");
    expect(byType.runbook.count).toBe(0);
    expect(byType.runbook.definition?.presentation).toBeUndefined();
    expect(byType.config.declaration).toBe("undeclared");
    expect(byType.config.definition).toBeUndefined();
  });

  it("drops types whose rule allows no key prefixes", () => {
    const restrictions = {
      records: [
        { type: "deploy", key_prefixes: ["prod"] },
        { type: "runbook", key_prefixes: [] },
      ],
    };
    expect(permitsRecordType(restrictions, "deploy")).toBe(true);
    expect(permitsRecordType(restrictions, "runbook")).toBe(false);
    const catalog = buildRecordCatalog({
      schema: { state: "ok", schema: SCHEMA },
      counts: [],
      restrictions,
    });
    expect(catalog.types.map((t) => t.type)).toEqual(["deploy"]);
    expect(catalog.scope.restricted).toBe(true);
  });
});

it("exposes declared field defaults without applying them", () => {
  const withDefault = TilaSchemaTomlSchema.parse({
    schema_version: 1,
    work_units: {
      bug: {
        fields: {
          severity: { type: "enum", values: ["low", "high"], default: "low" },
          title: { type: "string" },
        },
      },
    },
  });
  const catalog = buildWorkCatalog({
    schema: { state: "ok", schema: withDefault },
    counts: [],
  });
  expect(catalog.types[0].definition?.fields).toEqual([
    {
      name: "severity",
      type: "enum",
      required: false,
      values: ["low", "high"],
      default: "low",
    },
    { name: "title", type: "string", required: false },
  ]);
});
