import { describe, expect, it } from "vitest";

/**
 * Schema apply integration tests.
 *
 * These tests require @cloudflare/vitest-pool-workers to be configured
 * with a DO binding (ProjectDO). The test worker must have MIGRATION_0001
 * and MIGRATION_0002 applied, and a valid project token.
 *
 * Until the pool-workers vitest config is set up, these tests document
 * the expected behavior and can be run once the infrastructure exists.
 *
 * Routes under test:
 * - POST /projects/:projectId/schema -> DO POST /schema/apply
 * - GET  /projects/:projectId/schema -> DO GET /schema/current
 */

describe("Schema apply lifecycle", () => {
  // Request: POST /projects/:pid/schema
  // Body: { definition: '<valid tila.schema.toml content>' }
  // Expected: 200, body.ok === true, body.version === 1,
  //           body.changes contains "Initial schema applied",
  //           journal contains schema.applied event with data.version === 1
  it.todo("POST /schema with valid TOML on empty project creates version 1");

  // Pre-condition: project at schema version 1 (from previous test or setup)
  // Request: POST /projects/:pid/schema
  // Body: { definition: '<TOML with new optional field added>' }
  // Expected: 200, body.ok === true, body.version === 2,
  //           body.changes contains "Added field 'priority' to task",
  //           no --strategy needed (autoApplicable: true)
  it.todo("POST /schema adding optional field auto-applies without strategy");

  // Pre-condition: project at schema version N with work-unit type "task" defined
  // Request: POST /projects/:pid/schema
  // Body: { definition: '<TOML with task type removed>' }
  // Expected: 422, body.ok === false,
  //           body.error.code === "schema-destructive",
  //           body.error.changes contains "Removed work-unit type: task",
  //           body.error.message contains "--strategy" hint
  it.todo("POST /schema removing work-unit type returns 422 without strategy");

  // Pre-condition: project at schema version N with destructive change pending
  // Request: POST /projects/:pid/schema
  // Body: { definition: '<TOML with removed type>', strategy: "force" }
  // Expected: 200, body.ok === true, body.version === N+1,
  //           body.changes contains the destructive change descriptions
  it.todo("POST /schema with strategy=force applies destructive change");

  // Pre-condition: project has at least one applied schema
  // Request: GET /projects/:pid/schema
  // Expected: 200, body.ok === true, body.version === <latest>,
  //           body.schema contains the full schema history row
  it.todo("GET /schema returns current version and schema");

  // Pre-condition: project at schema version N
  // Request: POST /projects/:pid/schema
  // Body: { definition: '<exact same TOML as version N>' }
  // Expected: 200, body.ok === true, body.version === null,
  //           body.changes === [], body.noChange === true,
  //           no new _schema_history row inserted
  it.todo("POST /schema with identical TOML returns noChange");

  // Request: POST /projects/:pid/schema
  // Body: { definition: 'not valid toml {{{}}}' }
  // Expected: 400, body.ok === false,
  //           body.error.code === "schema-parse-error"
  it.todo("POST /schema with invalid TOML returns 400");

  // Request: POST /projects/:pid/schema
  // Body: { definition: '<valid TOML>', strategy: "migrate" }
  // Expected: 400, body.ok === false,
  //           body.error.code === "validation-error",
  //           body.error.message mentions valid strategies
  it.todo("POST /schema with invalid strategy returns 400");
});
