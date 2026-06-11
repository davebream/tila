import { TilaSchemaTomlSchema } from "@tila/schemas";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/schema-ops";
import {
  TemplateInstantiateError,
  instantiateTemplate,
  validateTemplateInstantiation,
} from "../src/template-ops";
import { type TestDb, createTestDb } from "./helpers";

// A schema declaring `task`/`subtask` work-units plus a `sprint` template
// (root + child + a parent-child relationship), with `{{name}}` placeholders.
const SCHEMA_WITH_TEMPLATE = `
schema_version = 1

[work_units.task]
label = "Task"

[work_units.subtask]
label = "Subtask"

[templates.sprint]
description = "A task with one subtask"

[templates.sprint.entities.root]
type = "task"
id_suffix = ""
[templates.sprint.entities.root.data]
title = "Sprint {{name}}"

[templates.sprint.entities.child]
type = "subtask"
id_suffix = "-child"
[templates.sprint.entities.child.data]
title = "Child of {{name}}"

[[templates.sprint.relationships]]
from = "root"
to = "child"
type = "parent-child"
`;

const ORIGIN = {
  actor: "test-actor",
  tokenId: null,
  source: null,
  sourceVersion: null,
};

let testDb: TestDb;

function countEntities(db: TestDb): number {
  return (
    db.rawDb.prepare("SELECT COUNT(*) AS n FROM entities").get() as {
      n: number;
    }
  ).n;
}
function countRelationships(db: TestDb): number {
  return (
    db.rawDb
      .prepare("SELECT COUNT(*) AS n FROM entity_relationships")
      .get() as { n: number }
  ).n;
}
function countTemplateJournal(db: TestDb): number {
  return (
    db.rawDb
      .prepare(
        "SELECT COUNT(*) AS n FROM journal WHERE kind = 'template.instantiated'",
      )
      .get() as { n: number }
  ).n;
}

beforeEach(() => {
  testDb = createTestDb();
});

describe("templateOps.instantiateTemplate — happy path", () => {
  it("creates entities + relationships, substitutes {{var}}, appends journal", () => {
    applySchema(testDb.db, SCHEMA_WITH_TEMPLATE, "test-actor");

    const result = instantiateTemplate(testDb.db, {
      templateName: "sprint",
      rootId: "sprint-1",
      vars: { name: "Alpha" },
      origin: ORIGIN,
    });

    expect(result.created_entities).toEqual(["sprint-1", "sprint-1-child"]);
    expect(result.created_relationships).toBe(1);
    expect(result.journal_seq).toBeGreaterThan(0);

    // Entities persisted with {{name}} substituted on BOTH root and child.
    const root = testDb.rawDb
      .prepare("SELECT type, data, created_by FROM entities WHERE id = ?")
      .get("sprint-1") as { type: string; data: string; created_by: string };
    expect(root.type).toBe("task");
    expect(JSON.parse(root.data).title).toBe("Sprint Alpha");
    expect(root.created_by).toBe("test-actor");

    const child = testDb.rawDb
      .prepare("SELECT type, data FROM entities WHERE id = ?")
      .get("sprint-1-child") as { type: string; data: string };
    expect(child.type).toBe("subtask");
    expect(JSON.parse(child.data).title).toBe("Child of Alpha");

    // parent-child relationship.
    const rel = testDb.rawDb
      .prepare(
        "SELECT from_id, to_id, type FROM entity_relationships WHERE from_id = ?",
      )
      .get("sprint-1") as { from_id: string; to_id: string; type: string };
    expect(rel).toEqual({
      from_id: "sprint-1",
      to_id: "sprint-1-child",
      type: "parent-child",
    });

    // journal event with the right payload.
    const journal = testDb.rawDb
      .prepare(
        "SELECT resource, actor, data FROM journal WHERE kind = 'template.instantiated'",
      )
      .get() as { resource: string; actor: string; data: string };
    expect(journal.resource).toBe("sprint-1");
    expect(journal.actor).toBe("test-actor");
    const jdata = JSON.parse(journal.data);
    expect(jdata.template_name).toBe("sprint");
    expect(jdata.created_entity_ids).toEqual(["sprint-1", "sprint-1-child"]);
    expect(jdata.vars_used).toEqual(["name"]);
  });

  it("leaves unknown {{placeholders}} intact when no matching var supplied", () => {
    applySchema(testDb.db, SCHEMA_WITH_TEMPLATE, "test-actor");
    instantiateTemplate(testDb.db, {
      templateName: "sprint",
      rootId: "sprint-2",
      vars: {},
      origin: ORIGIN,
    });
    const root = testDb.rawDb
      .prepare("SELECT data FROM entities WHERE id = ?")
      .get("sprint-2") as { data: string };
    expect(JSON.parse(root.data).title).toBe("Sprint {{name}}");
  });
});

describe("templateOps.instantiateTemplate — guards", () => {
  it("invalid-id: root_id containing '/' is rejected before any write", () => {
    applySchema(testDb.db, SCHEMA_WITH_TEMPLATE, "test-actor");
    expect(() =>
      instantiateTemplate(testDb.db, {
        templateName: "sprint",
        rootId: "a/b",
        vars: {},
        origin: ORIGIN,
      }),
    ).toThrow(TemplateInstantiateError);
    try {
      instantiateTemplate(testDb.db, {
        templateName: "sprint",
        rootId: "a/b",
        vars: {},
        origin: ORIGIN,
      });
    } catch (e) {
      expect((e as TemplateInstantiateError).code).toBe("invalid-id");
    }
    expect(countEntities(testDb)).toBe(0);
  });

  it("invalid-id (computed): root_id + id_suffix containing '/' is rejected", () => {
    // A template whose child id_suffix introduces a '/'. The schema parser
    // permits the suffix; the op's computed-id guard catches it.
    applySchema(
      testDb.db,
      `
schema_version = 1
[work_units.task]
label = "Task"
[templates.bad.entities.root]
type = "task"
id_suffix = "/oops"
[templates.bad.entities.root.data]
`,
      "test-actor",
    );
    try {
      instantiateTemplate(testDb.db, {
        templateName: "bad",
        rootId: "x",
        vars: {},
        origin: ORIGIN,
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateInstantiateError);
      expect((e as TemplateInstantiateError).code).toBe("invalid-id");
      expect((e as Error).message).toContain('Computed entity ID "x/oops"');
    }
    expect(countEntities(testDb)).toBe(0);
  });

  it("no-schema: instantiating with no schema applied throws no-schema", () => {
    try {
      instantiateTemplate(testDb.db, {
        templateName: "sprint",
        rootId: "s-1",
        vars: {},
        origin: ORIGIN,
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateInstantiateError);
      expect((e as TemplateInstantiateError).code).toBe("no-schema");
    }
  });

  it("not-found: unknown template name throws not-found", () => {
    applySchema(testDb.db, SCHEMA_WITH_TEMPLATE, "test-actor");
    try {
      instantiateTemplate(testDb.db, {
        templateName: "missing",
        rootId: "s-1",
        vars: {},
        origin: ORIGIN,
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateInstantiateError);
      expect((e as TemplateInstantiateError).code).toBe("not-found");
    }
    expect(countEntities(testDb)).toBe(0);
  });

  // constraint-violation is a DEFENSIVE re-check: the schema parser rejects a
  // template referencing an undeclared work-unit type at apply time, so it can't
  // arrive here via a stored schema. We exercise it directly against the pure
  // `validateTemplateInstantiation` with a hand-built schema whose template
  // references an undeclared type.
  it("constraint-violation: template entity referencing an undeclared type", () => {
    const parsedSchema = TilaSchemaTomlSchema.parse({
      schema_version: 1,
      work_units: { task: { label: "Task" } },
      templates: {
        broken: {
          entities: {
            root: { type: "ghost", id_suffix: "", data: {} },
          },
          relationships: [],
        },
      },
    });
    try {
      validateTemplateInstantiation(parsedSchema, "broken", "x-1");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateInstantiateError);
      expect((e as TemplateInstantiateError).code).toBe("constraint-violation");
      expect((e as Error).message).toContain('Template entity "root"');
      expect((e as Error).message).toContain("ghost");
    }
  });
});

describe("templateOps.instantiateTemplate — atomicity (rollback proof)", () => {
  it("a mid-instantiate failure rolls back ALL entities, relationships, journal", () => {
    applySchema(testDb.db, SCHEMA_WITH_TEMPLATE, "test-actor");

    // Pre-insert a row that COLLIDES with the template's CHILD id. The root
    // inserts first (sprint-x), then the child insert (sprint-x-child) hits a
    // PRIMARY KEY violation mid-transaction.
    testDb.rawDb
      .prepare(
        "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, 1, '{}', 0, 1, 1, 'pre')",
      )
      .run("sprint-x-child", "subtask");

    const entitiesBefore = countEntities(testDb); // 1 (the pre-inserted child)
    const relsBefore = countRelationships(testDb);
    const journalBefore = countTemplateJournal(testDb);

    expect(() =>
      instantiateTemplate(testDb.db, {
        templateName: "sprint",
        rootId: "sprint-x",
        vars: { name: "Boom" },
        origin: ORIGIN,
      }),
    ).toThrow();

    // ROLLBACK PROOF: the root (sprint-x) was NOT persisted, no relationship and
    // no journal row were added — counts are exactly what they were before.
    expect(
      testDb.rawDb
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE id = ?")
        .get("sprint-x") as { n: number },
    ).toEqual({ n: 0 });
    expect(countEntities(testDb)).toBe(entitiesBefore);
    expect(countRelationships(testDb)).toBe(relsBefore);
    expect(countTemplateJournal(testDb)).toBe(journalBefore);
  });
});
