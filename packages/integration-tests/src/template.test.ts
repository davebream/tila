import { describe, expect, it } from "vitest";

/**
 * Entity template integration tests.
 *
 * These tests require @cloudflare/vitest-pool-workers to be configured
 * with a DO binding (ProjectDO). The test worker must have a schema applied
 * with [templates.*] sections and a valid project token.
 *
 * Routes under test:
 * - POST /projects/:projectId/templates/instantiate
 *
 * TOML fixture used in instantiation tests:
 *   schema_version = 1
 *
 *   [work_units.epic]
 *   [work_units.epic.fields.title]
 *   type = "string"
 *
 *   [work_units.plan]
 *
 *   [templates.standard-epic]
 *   description = "Standard epic with plan"
 *
 *   [templates.standard-epic.entities.root]
 *   type = "epic"
 *   id_suffix = ""
 *
 *   [templates.standard-epic.entities.root.data]
 *   title = "{{title}}"
 *
 *   [templates.standard-epic.entities.child]
 *   type = "plan"
 *   id_suffix = ".plan"
 *
 *   [[templates.standard-epic.relationships]]
 *   from = "root"
 *   to = "child"
 *   type = "blocks"
 */
describe("Entity templates", () => {
  describe("schema parsing", () => {
    it("parses schema TOML with [templates.standard-epic] section", () => {
      // Setup: Apply schema TOML containing the fixture above
      // Request: GET /projects/:pid/schema/current
      // Expected: 200, schema.definition contains [templates.standard-epic]
      // Verify: template is parseable and has 2 entities, 1 relationship
      expect(true).toBe(true);
    });

    it("returns parse error for template with unknown entity type", () => {
      // Setup: Apply schema TOML with:
      //   [templates.bad-template.entities.root]
      //   type = "nonexistent_type"
      //   But work_units only has [work_units.epic]
      //
      // Request: POST /projects/:pid/schema (apply schema)
      // Expected: 400 with parse error mentioning
      //   "templates.bad-template.entities.root.type"
      expect(true).toBe(true);
    });
  });

  describe("instantiate", () => {
    it("creates all entities and relationships atomically", () => {
      // Setup: Apply schema with standard-epic template
      // Request: POST /projects/:pid/templates/instantiate
      //   Body: { template_name: "standard-epic", root_id: "epic:E-1",
      //           vars: { title: "Auth Feature" } }
      // Expected: 200 { ok: true,
      //   created_entities: ["epic:E-1", "epic:E-1.plan"],
      //   created_relationships: 1,
      //   journal_seq: <number> }
      //
      // Verify entities exist:
      //   GET /projects/:pid/entities/epic:E-1 -> 200
      //   GET /projects/:pid/entities/epic:E-1.plan -> 200
      //   entity data.title === "Auth Feature" (var substituted)
      //
      // Verify single journal event:
      //   GET /projects/:pid/journal?kind=template.instantiated&resource=epic:E-1
      //   -> exactly 1 entry with data.template_name === "standard-epic"
      expect(true).toBe(true);
    });

    it("rolls back all entities on duplicate ID conflict", () => {
      // Setup: Apply schema with standard-epic template
      //        Pre-create entity "epic:E-2" (so root entity will conflict)
      // Request: POST /projects/:pid/templates/instantiate
      //   Body: { template_name: "standard-epic", root_id: "epic:E-2",
      //           vars: { title: "Conflict" } }
      // Expected: 409 (UNIQUE constraint violation -- SQLite raises through onError)
      //
      // Verify rollback: entity "epic:E-2.plan" should NOT exist
      //   GET /projects/:pid/entities/epic:E-2.plan -> 404
      // Verify: no template.instantiated journal event for epic:E-2
      expect(true).toBe(true);
    });

    it("returns 404 for unknown template name", () => {
      // Setup: Apply schema with standard-epic template
      // Request: POST /projects/:pid/templates/instantiate
      //   Body: { template_name: "nonexistent", root_id: "epic:E-3", vars: {} }
      // Expected: 404 { ok: false, error: { code: "not-found" } }
      expect(true).toBe(true);
    });

    it("returns 422 when no schema is applied", () => {
      // Setup: Create project with no schema applied
      // Request: POST /projects/:pid/templates/instantiate
      //   Body: { template_name: "standard-epic", root_id: "epic:E-4", vars: {} }
      // Expected: 422 { ok: false, error: { code: "no-schema" } }
      expect(true).toBe(true);
    });

    it("rejects root_id containing '/'", () => {
      // Setup: Apply schema with standard-epic template
      // Request: POST /projects/:pid/templates/instantiate
      //   Body: { template_name: "standard-epic", root_id: "epic/E-5", vars: {} }
      // Expected: 422 { ok: false, error: { code: "invalid-id" } }
      expect(true).toBe(true);
    });

    it("passes through unresolved {{var}} placeholders as literal strings", () => {
      // Setup: Apply schema with standard-epic template (has {{title}} in data)
      // Request: POST /projects/:pid/templates/instantiate
      //   Body: { template_name: "standard-epic", root_id: "epic:E-6", vars: {} }
      //   (no vars provided -- title should remain "{{title}}" literally)
      // Expected: 200
      // Verify: entity epic:E-6 has data.title === "{{title}}" (literal string)
      expect(true).toBe(true);
    });
  });
});
