import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create } from "../src/entity-ops";
import { createRecord } from "../src/record-ops";
import {
  SchemaParseException,
  applySchema,
  previewSchema,
} from "../src/schema-ops";
import { type TestDb, createTestDb, testOrigin } from "./helpers";

let testDb: TestDb;

const INITIAL_SCHEMA_TOML = `
schema_version = 1

[work_units.task]
[work_units.task.fields.title]
type = "string"
required = true

[work_units.task.fields.status]
type = "string"

[work_units.bug]
[work_units.bug.fields.title]
type = "string"
required = true

[work_units.bug.fields.severity]
type = "string"
`;

const SCHEMA_WITHOUT_BUG_TOML = `
schema_version = 1

[work_units.task]
[work_units.task.fields.title]
type = "string"
required = true

[work_units.task.fields.status]
type = "string"
`;

const SCHEMA_WITHOUT_STATUS_FIELD_TOML = `
schema_version = 1

[work_units.task]
[work_units.task.fields.title]
type = "string"
required = true

[work_units.bug]
[work_units.bug.fields.title]
type = "string"
required = true

[work_units.bug.fields.severity]
type = "string"
`;

const SCHEMA_WITH_RECORDS_TOML = `
schema_version = 1

[work_units.task]
[work_units.task.fields.title]
type = "string"
required = true

[records.config]
[records.config.fields.env]
type = "string"

[records.settings]
[records.settings.fields.theme]
type = "string"
`;

const SCHEMA_WITHOUT_CONFIG_RECORDS_TOML = `
schema_version = 1

[work_units.task]
[work_units.task.fields.title]
type = "string"
required = true

[records.settings]
[records.settings.fields.theme]
type = "string"
`;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

function applyInitialSchema(toml: string) {
  applySchema(testDb.db, toml, "test-actor");
}

describe("previewSchema", () => {
  describe("work-unit-removed with entity counts", () => {
    it("returns entityCount=3 when 3 bug entities exist and bug type is removed", () => {
      applyInitialSchema(INITIAL_SCHEMA_TOML);

      // Create 5 task entities and 3 bug entities
      for (let i = 0; i < 5; i++) {
        create(
          testDb.db,
          {
            id: `task-${i}`,
            type: "task",
            data: { title: `Task ${i}`, status: "open" },
            created_by: "test-actor",
          },
          1,
          testOrigin("test-actor"),
        );
      }
      for (let i = 0; i < 3; i++) {
        create(
          testDb.db,
          {
            id: `bug-${i}`,
            type: "bug",
            data: { title: `Bug ${i}`, severity: "high" },
            created_by: "test-actor",
          },
          1,
          testOrigin("test-actor"),
        );
      }

      const result = previewSchema(testDb.db, SCHEMA_WITHOUT_BUG_TOML);

      expect(result.changes).toHaveLength(1);
      const removedChange = result.changes.find(
        (c) => c.kind === "work-unit-removed",
      );
      expect(removedChange).toBeDefined();
      expect(removedChange?.kind).toBe("work-unit-removed");
      if (removedChange?.kind === "work-unit-removed") {
        expect(removedChange.unitType).toBe("bug");
        expect(removedChange.entityCount).toBe(3);
      }
      expect(result.autoApplicable).toBe(false);
    });

    it("returns entityCount=0 when no entities of removed type exist", () => {
      applyInitialSchema(INITIAL_SCHEMA_TOML);

      // Only create task entities, no bugs
      for (let i = 0; i < 2; i++) {
        create(
          testDb.db,
          {
            id: `task-${i}`,
            type: "task",
            data: { title: `Task ${i}`, status: "open" },
            created_by: "test-actor",
          },
          1,
          testOrigin("test-actor"),
        );
      }

      const result = previewSchema(testDb.db, SCHEMA_WITHOUT_BUG_TOML);

      const removedChange = result.changes.find(
        (c) => c.kind === "work-unit-removed",
      );
      if (removedChange?.kind === "work-unit-removed") {
        expect(removedChange.entityCount).toBe(0);
      }
    });

    it("does not count archived entities", () => {
      applyInitialSchema(INITIAL_SCHEMA_TOML);

      for (let i = 0; i < 3; i++) {
        create(
          testDb.db,
          {
            id: `bug-${i}`,
            type: "bug",
            data: { title: `Bug ${i}` },
            created_by: "test-actor",
          },
          1,
          testOrigin("test-actor"),
        );
      }

      // Archive one bug by directly updating archived column
      testDb.rawDb
        .prepare("UPDATE entities SET archived = 1 WHERE id = 'bug-0'")
        .run();

      const result = previewSchema(testDb.db, SCHEMA_WITHOUT_BUG_TOML);

      const removedChange = result.changes.find(
        (c) => c.kind === "work-unit-removed",
      );
      if (removedChange?.kind === "work-unit-removed") {
        // Only 2 non-archived bugs
        expect(removedChange.entityCount).toBe(2);
      }
    });
  });

  describe("field-removed with entity counts", () => {
    it("returns count of entities that have the removed field in their data", () => {
      applyInitialSchema(INITIAL_SCHEMA_TOML);

      // Create tasks with status field
      for (let i = 0; i < 4; i++) {
        create(
          testDb.db,
          {
            id: `task-${i}`,
            type: "task",
            data: { title: `Task ${i}`, status: "open" },
            created_by: "test-actor",
          },
          1,
          testOrigin("test-actor"),
        );
      }
      // Create a task without status field
      create(
        testDb.db,
        {
          id: "task-no-status",
          type: "task",
          data: { title: "No status task" },
          created_by: "test-actor",
        },
        1,
        testOrigin("test-actor"),
      );

      const result = previewSchema(testDb.db, SCHEMA_WITHOUT_STATUS_FIELD_TOML);

      const fieldRemovedChange = result.changes.find(
        (c) =>
          c.kind === "field-removed" &&
          c.unitType === "task" &&
          c.fieldName === "status",
      );
      expect(fieldRemovedChange).toBeDefined();
      if (fieldRemovedChange?.kind === "field-removed") {
        // 4 tasks have 'status' field
        expect(fieldRemovedChange.entityCount).toBe(4);
      }
    });
  });

  describe("record-type-removed with record counts", () => {
    it("returns recordCount for removed record type", async () => {
      applyInitialSchema(SCHEMA_WITH_RECORDS_TOML);

      // Create 2 config records and 1 settings record
      for (let i = 0; i < 2; i++) {
        await createRecord(
          testDb.db,
          {
            type: "config",
            key: `key-${i}`,
            value: { env: `env-${i}` },
            schema_version: 1,
            actor: "test-actor",
          },
          testOrigin("test-actor"),
        );
      }
      await createRecord(
        testDb.db,
        {
          type: "settings",
          key: "main",
          value: { theme: "dark" },
          schema_version: 1,
          actor: "test-actor",
        },
        testOrigin("test-actor"),
      );

      const result = previewSchema(
        testDb.db,
        SCHEMA_WITHOUT_CONFIG_RECORDS_TOML,
      );

      const removedRecordChange = result.changes.find(
        (c) => c.kind === "record-type-removed" && c.typeName === "config",
      );
      expect(removedRecordChange).toBeDefined();
      if (removedRecordChange?.kind === "record-type-removed") {
        expect(removedRecordChange.recordCount).toBe(2);
      }
    });

    it("does not count archived records", async () => {
      applyInitialSchema(SCHEMA_WITH_RECORDS_TOML);

      for (let i = 0; i < 3; i++) {
        await createRecord(
          testDb.db,
          {
            type: "config",
            key: `key-${i}`,
            value: { env: `env-${i}` },
            schema_version: 1,
            actor: "test-actor",
          },
          testOrigin("test-actor"),
        );
      }

      // Archive one record
      testDb.rawDb
        .prepare(
          "UPDATE records SET archived = 1 WHERE type = 'config' AND key = 'key-0'",
        )
        .run();

      const result = previewSchema(
        testDb.db,
        SCHEMA_WITHOUT_CONFIG_RECORDS_TOML,
      );

      const removedRecordChange = result.changes.find(
        (c) => c.kind === "record-type-removed" && c.typeName === "config",
      );
      if (removedRecordChange?.kind === "record-type-removed") {
        expect(removedRecordChange.recordCount).toBe(2);
      }
    });
  });

  describe("no-change scenario", () => {
    it("returns empty changes array when schema is identical", () => {
      applyInitialSchema(INITIAL_SCHEMA_TOML);

      const result = previewSchema(testDb.db, INITIAL_SCHEMA_TOML);

      expect(result.changes).toHaveLength(0);
      expect(result.autoApplicable).toBe(true);
    });

    it("returns additive changes as autoApplicable=true", () => {
      applyInitialSchema(INITIAL_SCHEMA_TOML);

      const schemaWithNewType = `
${INITIAL_SCHEMA_TOML}
[work_units.feature]
[work_units.feature.fields.title]
type = "string"
`;

      const result = previewSchema(testDb.db, schemaWithNewType);

      expect(result.changes.some((c) => c.kind === "work-unit-added")).toBe(
        true,
      );
      expect(result.autoApplicable).toBe(true);
    });
  });

  describe("no current schema", () => {
    it("returns empty changes when no schema exists yet", () => {
      // No schema applied yet
      const result = previewSchema(testDb.db, INITIAL_SCHEMA_TOML);
      expect(result.changes).toHaveLength(0);
      expect(result.autoApplicable).toBe(true);
    });
  });

  describe("invalid TOML error handling", () => {
    it("throws SchemaParseException on invalid TOML", () => {
      expect(() => previewSchema(testDb.db, "not valid toml !!!")).toThrow(
        SchemaParseException,
      );
    });

    it("throws SchemaParseException on empty string", () => {
      expect(() => previewSchema(testDb.db, "")).toThrow(SchemaParseException);
    });
  });
});

describe("previewSchema impact for settings editors", () => {
  const ARTIFACTS = (retention: number, extra = "") => `
schema_version = 1

[work_units.task]
[work_units.task.fields.title]
type = "string"
required = true

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = ${retention}
${extra}
[artifacts.patch]
mime_types = ["text/x-patch"]
retention_days = 7
`;

  function insertArtifact(key: string, kind: string, tombstoned = 0) {
    testDb.rawDb
      .prepare(
        `INSERT INTO artifact_pointers
           (r2_key, kind, sha256, bytes, mime_type, produced_at, produced_by, tombstoned)
         VALUES (?, ?, 'abc', 1, 'text/markdown', 0, 'test-actor', ?)`,
      )
      .run(`${kind}/${key}/abc.md`, kind, tombstoned);
  }

  function insertPendingRevision(key: string, lineage: string, kind: string) {
    testDb.rawDb
      .prepare(
        "INSERT OR IGNORE INTO artifact_lineages (id, project_id, kind) VALUES (?, 'p', ?)",
      )
      .run(lineage, kind);
    testDb.rawDb
      .prepare(
        "INSERT INTO artifact_revisions (r2_key, lineage_id, revision, metadata, retention_assigned) VALUES (?, ?, 1, '{}', 0)",
      )
      .run(key, lineage);
  }

  it("explains a shortened retention without rewriting existing expiry", () => {
    applyInitialSchema(ARTIFACTS(30));
    insertArtifact("a1", "plan");
    insertArtifact("a2", "plan");
    insertArtifact("a3", "plan", 1);
    insertArtifact("p1", "patch");
    insertPendingRevision("r1", "lin-1", "plan");

    const result = previewSchema(testDb.db, ARTIFACTS(7));
    const change = result.changes.find(
      (c) => c.kind === "definition-changed" && c.path === "artifacts.plan",
    );
    expect(change).toMatchObject({
      destructive: true,
      impact: {
        liveArtifacts: 2,
        searchChanged: false,
        retention: {
          from: 30,
          to: 7,
          pendingBackfill: 1,
          pendingBackfillUsesNewPolicy: true,
        },
      },
    });
    expect(result.autoApplicable).toBe(false);
  });

  it("reports that a policy snapshot already fixes pending retention", () => {
    applyInitialSchema(ARTIFACTS(30));
    testDb.rawDb
      .prepare(
        `INSERT INTO artifact_retention_state (id, policy, complete) VALUES (1, '{"plan":30}', 0)`,
      )
      .run();
    const change = previewSchema(testDb.db, ARTIFACTS(7)).changes.find(
      (c) => c.kind === "definition-changed",
    );
    expect(change).toMatchObject({
      impact: { retention: { pendingBackfillUsesNewPolicy: false } },
    });
  });

  it("flags search changes and omits retention when it is unchanged", () => {
    applyInitialSchema(ARTIFACTS(30));
    const change = previewSchema(
      testDb.db,
      ARTIFACTS(30, 'searchable = true\nsearch_mode = "full_text"\n'),
    ).changes.find((c) => c.kind === "definition-changed");
    expect(change).toMatchObject({ impact: { searchChanged: true } });
    if (change?.kind === "definition-changed") {
      expect(change.impact?.retention).toBeUndefined();
    }
  });

  it("counts live artifacts and lineages for a removed kind", () => {
    applyInitialSchema(ARTIFACTS(30));
    insertArtifact("p1", "patch");
    insertArtifact("p2", "patch", 1);
    insertPendingRevision("r1", "lin-patch", "patch");
    const without = ARTIFACTS(30).replace(/\[artifacts\.patch\][\s\S]*$/, "");
    const change = previewSchema(testDb.db, without).changes.find(
      (c) => c.kind === "artifact-kind-removed",
    );
    expect(change).toMatchObject({
      artifactKind: "patch",
      artifactCount: 1,
      lineageCount: 1,
    });
  });

  it("counts archived tasks of a removed type and lazy legacy defaults", () => {
    applyInitialSchema(INITIAL_SCHEMA_TOML);
    for (const id of ["bug-0", "bug-1"]) {
      create(
        testDb.db,
        { id, type: "bug", data: { title: id }, created_by: "test-actor" },
        1,
        testOrigin("test-actor"),
      );
    }
    testDb.rawDb
      .prepare("UPDATE entities SET archived = 1 WHERE id = 'bug-0'")
      .run();
    create(
      testDb.db,
      {
        id: "task-0",
        type: "task",
        data: { title: "t", status: "open" },
        created_by: "test-actor",
      },
      1,
      testOrigin("test-actor"),
    );

    const removed = previewSchema(testDb.db, SCHEMA_WITHOUT_BUG_TOML).changes;
    expect(removed).toContainEqual(
      expect.objectContaining({
        kind: "work-unit-removed",
        entityCount: 1,
        archivedCount: 1,
      }),
    );

    const withPriority = `${INITIAL_SCHEMA_TOML}
[work_units.task.fields.priority]
type = "string"
required = true
default_for_legacy = "normal"
`;
    const added = previewSchema(testDb.db, withPriority).changes;
    expect(added).toContainEqual(
      expect.objectContaining({
        kind: "field-added",
        fieldName: "priority",
        legacyDefaultCount: 1,
      }),
    );
  });

  it("counts records that hold a removed record field", async () => {
    applyInitialSchema(SCHEMA_WITH_RECORDS_TOML);
    await createRecord(
      testDb.db,
      {
        type: "config",
        key: "a",
        value: { env: "prod" },
        schema_version: 1,
        actor: "test-actor",
      },
      testOrigin("test-actor"),
    );
    await createRecord(
      testDb.db,
      {
        type: "config",
        key: "b",
        value: {},
        schema_version: 1,
        actor: "test-actor",
      },
      testOrigin("test-actor"),
    );
    const without = SCHEMA_WITH_RECORDS_TOML.replace(
      '[records.config.fields.env]\ntype = "string"\n',
      "",
    );
    const change = previewSchema(testDb.db, without).changes.find(
      (c) => c.kind === "record-field-removed",
    );
    expect(change).toMatchObject({ fieldName: "env", recordCount: 1 });
  });
});
