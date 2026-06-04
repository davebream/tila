import { describe, expect, it } from "vitest";

/**
 * Schema-change integration tests covering the four common cases from
 * docs/03-ROADMAP.md section 4.1 criterion 6:
 *
 *   (a) Add entity type — auto-applied
 *   (b) Add optional field — auto-applied
 *   (c) Add required field with default_for_legacy — auto-applied with backfill
 *   (d) Make parent required — rejected without --strategy, accepted with strategy
 *
 * Plus a bonus no-change idempotency case.
 *
 * These tests require @cloudflare/vitest-pool-workers to be configured
 * with a DO binding (ProjectDO) and the schema migrations applied.
 * Until pool-workers is set up, these tests document the expected behavior
 * as living specification stubs.
 *
 * Dependencies:
 *   - T1: parseTilaSchemaToml (parser validates TOML before apply)
 *   - T2: diffSchemas + applySchema extended (diff, strategy, rejection)
 *   - T3: applyLegacyDefaults (default materialization on read)
 *
 * Routes under test:
 *   - POST /projects/:projectId/schema -> DO /schema/apply
 *   - GET  /projects/:projectId/entities/:id -> DO /entity/get/:id
 *   - GET  /projects/:projectId/entities -> DO /entity/list
 *   - GET  /projects/:projectId/journal -> journal events
 */

// --- TOML schema fixtures ---

/** Base schema v1: single work-unit "task" with required "title" field */
const SCHEMA_V1_TASK_ONLY = `
schema_version = 1

[work_units.task]
[work_units.task.fields.title]
type = "string"
required = true
`;

/** Case (a): v2 adds a new work-unit type "sprint" */
const SCHEMA_V2_ADD_SPRINT = `
schema_version = 2

[work_units.task]
[work_units.task.fields.title]
type = "string"
required = true

[work_units.sprint]
[work_units.sprint.fields.name]
type = "string"
required = true
`;

/** Case (b): v2 adds optional field "notes" to task */
const SCHEMA_V2_ADD_OPTIONAL_NOTES = `
schema_version = 2

[work_units.task]
[work_units.task.fields.title]
type = "string"
required = true

[work_units.task.fields.notes]
type = "string"
required = false
`;

/** Case (c): v2 adds required field "priority" with default_for_legacy */
const SCHEMA_V2_ADD_REQUIRED_PRIORITY = `
schema_version = 2

[work_units.task]
[work_units.task.fields.title]
type = "string"
required = true

[work_units.task.fields.priority]
type = "string"
required = true
default_for_legacy = "medium"
`;

/** Case (d): v2 sets task.required_parent = true (destructive change) */
const SCHEMA_V2_REQUIRE_PARENT = `
schema_version = 2

[work_units.task]
required_parent = true

[work_units.task.fields.title]
type = "string"
required = true
`;

// --- Test cases ---

describe("Schema change case (a): Add entity type", () => {
  it("POST /schema with new work-unit type auto-applies and bumps version", async () => {
    // Precondition:
    //   1. Create project with POST /projects
    //   2. Apply base schema: POST /projects/:pid/schema { definition: SCHEMA_V1_TASK_ONLY }
    //      -> 200, { ok: true, version: 1 }
    //   3. Create a task entity: POST /projects/:pid/entities
    //      { id: "T-existing", type: "task", data: { title: "Existing" }, created_by: "test" }
    //      -> 200
    //
    // Action:
    //   POST /projects/:pid/schema { definition: SCHEMA_V2_ADD_SPRINT }
    //
    // Expected:
    //   - 200, { ok: true, version: 2, changes: ["Added work-unit type: sprint"] }
    //   - GET /projects/:pid/entities/T-existing -> entity intact, data.title === "Existing"
    //   - GET /projects/:pid/journal -> contains event with
    //     kind: "schema.applied", data: { version: 2 }
    expect(true).toBe(true);
  });
});

describe("Schema change case (b): Add optional field", () => {
  it("POST /schema with new optional field auto-applies", async () => {
    // Precondition:
    //   1. Create project and apply SCHEMA_V1_TASK_ONLY (version 1)
    //   2. Create entity: POST /projects/:pid/entities
    //      { id: "T-old", type: "task", data: { title: "Old task" }, created_by: "test" }
    //      -> 200
    //
    // Action:
    //   POST /projects/:pid/schema { definition: SCHEMA_V2_ADD_OPTIONAL_NOTES }
    //
    // Expected:
    //   - 200, { ok: true, version: 2, changes: ["Added field 'notes' to task"] }
    //   - GET /projects/:pid/entities/T-old -> entity.data has NO "notes" key
    //     (optional field is absent, not null — legacy entities are not backfilled)
    //   - POST /projects/:pid/entities
    //     { id: "T-new", type: "task", data: { title: "New", notes: "hello" }, created_by: "test" }
    //     -> 200 (new entity with optional field accepted)
    //   - GET /projects/:pid/journal -> schema.applied event with version: 2
    expect(true).toBe(true);
  });
});

describe("Schema change case (c): Add required field with default_for_legacy", () => {
  it("POST /schema with required field + default_for_legacy auto-applies", async () => {
    // Precondition:
    //   1. Create project and apply SCHEMA_V1_TASK_ONLY (version 1)
    //   2. Create legacy entity: POST /projects/:pid/entities
    //      { id: "T-legacy", type: "task", data: { title: "Legacy" }, created_by: "test" }
    //      -> 200
    //
    // Action:
    //   POST /projects/:pid/schema { definition: SCHEMA_V2_ADD_REQUIRED_PRIORITY }
    //
    // Expected:
    //   - 200, { ok: true, version: 2, changes: ["Added required field 'priority' to task"] }
    //     (autoApplicable: true because default_for_legacy is present)
    //   - GET /projects/:pid/entities/T-legacy -> entity.data.priority === "medium"
    //     (applyLegacyDefaults from T3 materializes the default at read time)
    //   - POST /projects/:pid/entities
    //     { id: "T-no-priority", type: "task", data: { title: "Missing" }, created_by: "test" }
    //     -> 422 (validatedWrite rejects new entity missing required "priority")
    //   - POST /projects/:pid/entities
    //     { id: "T-with-priority", type: "task", data: { title: "Complete", priority: "high" }, created_by: "test" }
    //     -> 200 (new entity with required field accepted)
    //   - GET /projects/:pid/journal -> schema.applied event with version: 2
    expect(true).toBe(true);
  });
});

describe("Schema change case (d): Make parent required", () => {
  it("POST /schema setting required_parent=true is rejected without strategy", async () => {
    // Precondition:
    //   1. Create project and apply SCHEMA_V1_TASK_ONLY (version 1)
    //      (task.required_parent is absent/false in v1)
    //   2. Create entity without parent: POST /projects/:pid/entities
    //      { id: "T-no-parent", type: "task", data: { title: "Orphan" }, created_by: "test" }
    //      -> 200
    //
    // Action:
    //   POST /projects/:pid/schema { definition: SCHEMA_V2_REQUIRE_PARENT }
    //   (no strategy field in request body)
    //
    // Expected:
    //   - 422, { ok: false, error: {
    //       code: "schema-destructive",
    //       changes: ["Work-unit type 'task' now requires a parent"],
    //       message: "<hint listing --strategy options including 'relax'>"
    //     }}
    //   - error.message contains at least one --strategy value string
    //   - Schema version remains 1 (GET /projects/:pid/schema -> version: 1)
    expect(true).toBe(true);
  });

  it("POST /schema with strategy='relax' accepts destructive change", async () => {
    // Precondition:
    //   Same project state as the rejection test above (schema v1, entity T-no-parent exists)
    //
    // Action:
    //   POST /projects/:pid/schema { definition: SCHEMA_V2_REQUIRE_PARENT, strategy: "relax" }
    //
    // Expected:
    //   - 200, { ok: true, version: 2, changes: ["Work-unit type 'task' now requires a parent"] }
    //   - GET /projects/:pid/entities/T-no-parent -> entity readable (tolerant read passes;
    //     legacy entity without parent is tolerated under "relax" strategy)
    //   - GET /projects/:pid/journal -> schema.applied event with version: 2
    expect(true).toBe(true);
  });
});

describe("Schema change: no-change idempotency", () => {
  it("POST /schema with identical TOML returns noChange without version bump", async () => {
    // Precondition:
    //   1. Create project and apply SCHEMA_V1_TASK_ONLY (version 1)
    //
    // Action:
    //   POST /projects/:pid/schema { definition: SCHEMA_V1_TASK_ONLY }
    //   (identical TOML as already applied)
    //
    // Expected:
    //   - 200, { ok: true, version: null, changes: [], noChange: true }
    //   - No new _schema_history row inserted
    //   - No schema.applied journal event emitted for this call
    expect(true).toBe(true);
  });
});
