import { describe, expect, it } from "vitest";
import {
  SchemaParseException,
  parseSchemaToml,
  parseTilaSchemaToml,
} from "../src/schema-parser";

// Reference schema from docs/02-ARCHITECTURE.md §6.1
const REFERENCE_SCHEMA = `
schema_version = 1

[work_units.task]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "description", required = false, type = "text" },
  { name = "status", required = true, type = "enum", values = ["open", "in_progress", "blocked", "done", "cancelled"] },
  { name = "spec", required = false, type = "text" },
]
parents = ["issue"]
required_parent = false
references = [
  { name = "research_sources", multiple = true, kinds = ["research", "interview", "spec"] },
  { name = "prior_lessons", multiple = true, kinds = ["lesson"] },
]

[work_units.issue]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "description", required = false, type = "text" },
  { name = "status", required = true, type = "enum", values = ["open", "in_progress", "done"] },
  { name = "labels", required = false, type = "list<string>" },
]
parents = ["epic"]
required_parent = false

[work_units.epic]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "description", required = false, type = "text" },
  { name = "owner", required = false, type = "string" },
  { name = "status", required = true, type = "enum", values = ["proposed", "active", "done", "cancelled"] },
]
parents = []

[hierarchy]
levels = ["epic", "issue", "task"]
max_depth = 3

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 30

[artifacts.design]
mime_types = ["text/markdown"]
retention_days = 90

[artifacts.review]
mime_types = ["text/markdown"]
retention_days = 30
requires_reference_to = ["design"]

[artifact_relationships]
types = ["references", "supersedes", "derived-from", "extends", "rebuts", "index-of", "entry-of"]
`;

const MINIMAL_SCHEMA = `
schema_version = 1

[work_units.task]
fields = [
  { name = "title", required = true, type = "string" },
]
parents = []
`;

// Bundled default schema template — inline fixture for round-trip validation.
// Must be kept in sync with generateDefaultSchemaToml() in packages/cli/src/lib/provisioning.ts.
const BUNDLED_DEFAULT_SCHEMA_TOML = `
schema_version = 1

[work_units.task]
fields = [
  { name = "title",       required = true,  type = "string" },
  { name = "description", required = false, type = "text" },
  { name = "status",      required = true,  type = "enum",
    values = ["open", "in_progress", "blocked", "done", "cancelled"] },
]
parents = []

[artifacts.lesson]
mime_types = ["text/markdown"]
retention_days = 0
searchable = true
search_mode = "full_text"

[artifacts.adr]
mime_types = ["text/markdown"]
retention_days = 0
searchable = true
search_mode = "full_text"

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 30
searchable = true
search_mode = "full_text"

[artifacts.design]
mime_types = ["text/markdown"]
retention_days = 90
searchable = true
search_mode = "full_text"

[artifacts.review]
mime_types = ["text/markdown"]
retention_days = 30
requires_reference_to = ["design"]
searchable = true
search_mode = "full_text"

[artifacts.research]
mime_types = ["text/markdown", "text/plain", "application/pdf"]
retention_days = 0
searchable = true
search_mode = "full_text"

[artifacts.index]
mime_types = ["text/markdown"]
retention_days = 0
searchable = true
search_mode = "full_text"

[artifacts.patch]
mime_types = ["text/x-patch", "application/x-patch"]
retention_days = 7
searchable = false

[artifact_relationships]
types = [
  "references",
  "supersedes",
  "derived-from",
  "extends",
  "rebuts",
  "index-of",
  "entry-of",
]
`;

describe("parseSchemaToml", () => {
  describe("valid schemas", () => {
    it("parses the reference schema from docs/02-ARCHITECTURE.md section 6.1", () => {
      const result = parseSchemaToml(REFERENCE_SCHEMA);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.schema.schema_version).toBe(1);
      expect(Object.keys(result.schema.work_units)).toEqual([
        "task",
        "issue",
        "epic",
      ]);
      expect(result.schema.hierarchy?.levels).toEqual([
        "epic",
        "issue",
        "task",
      ]);
      expect(result.schema.hierarchy?.max_depth).toBe(3);
      expect(Object.keys(result.schema.artifacts ?? {})).toContain("plan");
      expect(result.schema.artifact_relationships?.types).toContain(
        "references",
      );
    });

    it("converts fields from array to record keyed by name", () => {
      const result = parseSchemaToml(REFERENCE_SCHEMA);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const taskFields = result.schema.work_units.task.fields;
      expect(taskFields.title).toBeDefined();
      expect(taskFields.title.type).toBe("string");
      expect(taskFields.title.required).toBe(true);
    });

    it("parses minimal schema with work_units only", () => {
      const result = parseSchemaToml(MINIMAL_SCHEMA);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.schema.schema_version).toBe(1);
      expect(Object.keys(result.schema.work_units)).toEqual(["task"]);
      expect(result.schema.hierarchy).toBeUndefined();
      expect(result.schema.artifacts).toBeUndefined();
    });

    it("accepts fields already in record form (passthrough)", () => {
      const toml = `
schema_version = 1

[work_units.task.fields.title]
type = "string"
required = true
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.schema.work_units.task.fields.title.type).toBe("string");
    });
  });

  describe("TOML syntax errors", () => {
    it("returns error with line info for malformed TOML", () => {
      const result = parseSchemaToml("schema_version = [unclosed");
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toBeTruthy();
      // smol-toml provides line/column for syntax errors
    });
  });

  describe("Zod validation errors", () => {
    it("rejects schema without schema_version", () => {
      const toml = `
[work_units.task]
fields = []
parents = []
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors[0].path).toContain("schema_version");
    });
  });

  describe("structural: unknown parent types", () => {
    it("rejects work_unit with parent referencing undeclared type", () => {
      const toml = `
schema_version = 1

[work_units.task]
fields = [{ name = "title", required = true, type = "string" }]
parents = ["nonexistent"]
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors[0].message).toContain("nonexistent");
      expect(result.errors[0].path).toContain("work_units.task.parents");
    });
  });

  describe("structural: hierarchy levels", () => {
    it("rejects hierarchy level referencing undeclared work-unit type", () => {
      const toml = `
schema_version = 1

[work_units.task]
fields = [{ name = "title", required = true, type = "string" }]
parents = []

[hierarchy]
levels = ["task", "ghost"]
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors[0].message).toContain("ghost");
      expect(result.errors[0].path).toContain("hierarchy.levels");
    });

    it("rejects hierarchy where levels count exceeds max_depth", () => {
      const toml = `
schema_version = 1

[work_units.epic]
fields = []
parents = []

[work_units.issue]
fields = []
parents = ["epic"]

[work_units.task]
fields = []
parents = ["issue"]

[hierarchy]
levels = ["epic", "issue", "task"]
max_depth = 2
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors[0].message).toContain("levels count (3)");
      expect(result.errors[0].message).toContain("max_depth (2)");
    });
  });

  describe("structural: circular parent chain", () => {
    it("detects direct circular parent reference (A -> B -> A)", () => {
      const toml = `
schema_version = 1

[work_units.a]
fields = [{ name = "title", required = true, type = "string" }]
parents = ["b"]

[work_units.b]
fields = [{ name = "title", required = true, type = "string" }]
parents = ["a"]
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const cycleError = result.errors.find((e) =>
        e.message.includes("circular"),
      );
      expect(cycleError).toBeDefined();
    });
  });

  describe("structural: field type validation", () => {
    it("rejects unknown field type", () => {
      const toml = `
schema_version = 1

[work_units.task]
fields = [{ name = "count", required = true, type = "integer" }]
parents = []
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors[0].message).toContain("integer");
      expect(result.errors[0].message).toContain(
        "valid: string, text, enum, list<string>",
      );
    });
  });

  describe("multiple errors collected", () => {
    it("collects all structural errors in a single pass", () => {
      const toml = `
schema_version = 1

[work_units.a]
fields = [{ name = "count", required = true, type = "integer" }]
parents = ["missing"]
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      // Should have at least 2 errors: unknown parent + invalid field type
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("bundled default schema template", () => {
    it("parses the bundled template to ok: true", () => {
      const result = parseSchemaToml(BUNDLED_DEFAULT_SCHEMA_TOML);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        console.error("Parse errors:", result.errors);
        return;
      }
    });

    it("marks memory-like kinds as searchable", () => {
      const result = parseSchemaToml(BUNDLED_DEFAULT_SCHEMA_TOML);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const searchableKinds = [
        "lesson",
        "adr",
        "plan",
        "design",
        "review",
        "research",
        "index",
      ];
      for (const kind of searchableKinds) {
        expect(result.schema.artifacts?.[kind]?.searchable).toBe(true);
        expect(result.schema.artifacts?.[kind]?.search_mode).toBe("full_text");
      }
    });

    it("marks patch as non-searchable", () => {
      const result = parseSchemaToml(BUNDLED_DEFAULT_SCHEMA_TOML);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.schema.artifacts?.patch?.searchable).toBe(false);
    });
  });

  describe("search config", () => {
    it("parses searchable=true with default search_mode", () => {
      const toml = `
schema_version = 1

[work_units.task]
fields = [{ name = "title", required = true, type = "string" }]
parents = []

[artifacts.lesson]
mime_types = ["text/markdown"]
searchable = true
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.schema.artifacts?.lesson.searchable).toBe(true);
      expect(result.schema.artifacts?.lesson.search_mode).toBe("none");
    });

    it("defaults searchable to false when omitted", () => {
      const toml = `
schema_version = 1

[work_units.task]
fields = [{ name = "title", required = true, type = "string" }]
parents = []

[artifacts.patch]
mime_types = ["text/x-patch"]
retention_days = 7
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.schema.artifacts?.patch.searchable).toBe(false);
      expect(result.schema.artifacts?.patch.search_mode).toBe("none");
    });

    it("rejects invalid search_mode value", () => {
      const toml = `
schema_version = 1

[work_units.task]
fields = [{ name = "title", required = true, type = "string" }]
parents = []

[artifacts.lesson]
mime_types = ["text/markdown"]
search_mode = "invalid"
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const searchModeError = result.errors.find((e) =>
        e.path?.includes("search_mode"),
      );
      expect(searchModeError).toBeDefined();
    });
  });

  describe("records section", () => {
    it("parses valid record type with all fields", () => {
      const toml = `
schema_version = 1

[work_units.task]
fields = [{ name = "title", required = true, type = "string" }]
parents = []

[records.pipeline_config]
format = "yaml"
history = "snapshot"
key_description = "Pipeline configuration per environment"
writers = ["human", "agent"]
mcp_resource = true
schema_ref = "https://example.com/pipeline.json"

[records.pipeline_config.fields.replicas]
type = "number"
required = true

[records.pipeline_config.fields.debug]
type = "boolean"
required = false

[records.pipeline_config.fields.overrides]
type = "json"
required = false
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const def = result.schema.records.pipeline_config;
      expect(def).toBeDefined();
      expect(def.format).toBe("yaml");
      expect(def.history).toBe("snapshot");
      expect(def.key_description).toBe(
        "Pipeline configuration per environment",
      );
      expect(def.writers).toEqual(["human", "agent"]);
      expect(def.mcp_resource).toBe(true);
      expect(def.schema_ref).toBe("https://example.com/pipeline.json");
      expect(def.fields.replicas.type).toBe("number");
      expect(def.fields.replicas.required).toBe(true);
      expect(def.fields.debug.type).toBe("boolean");
      expect(def.fields.overrides.type).toBe("json");
    });

    it("applies correct defaults when record fields are omitted", () => {
      const toml = `
schema_version = 1

[records.service]
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const def = result.schema.records.service;
      expect(def.format).toBe("json");
      expect(def.history).toBe("revision");
      expect(def.key_description).toBeUndefined();
      expect(def.writers).toBeUndefined();
      expect(def.mcp_resource).toBe(false);
      expect(def.schema_ref).toBeUndefined();
      expect(def.fields).toEqual({});
    });

    it("accepts number field type for record fields", () => {
      const toml = `
schema_version = 1

[records.metrics]

[records.metrics.fields.count]
type = "number"
required = false
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(true);
    });

    it("rejects number field type for work-unit fields", () => {
      const toml = `
schema_version = 1

[work_units.task]
fields = [{ name = "count", required = false, type = "number" }]
parents = []
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors[0].message).toContain("number");
      expect(result.errors[0].message).toContain(
        "valid: string, text, enum, list<string>",
      );
    });

    it("rejects invalid writers value at Zod structural phase", () => {
      const toml = `
schema_version = 1

[records.service]
writers = ["human", "invalid"]
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
    });

    it("defaults records to {} when no [records] section present", () => {
      const toml = `
schema_version = 1

[work_units.task]
fields = [{ name = "title", required = true, type = "string" }]
parents = []
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.schema.records).toEqual({});
    });

    it("rejects record type name with uppercase letters", () => {
      const toml = `
schema_version = 1

[records.Pipeline_Config]
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors[0].message).toContain("Pipeline_Config");
      expect(result.errors[0].path).toBe("records.Pipeline_Config");
    });

    it("rejects invalid record field type", () => {
      const toml = `
schema_version = 1

[records.service]

[records.service.fields.size]
type = "integer"
required = false
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.errors[0].message).toContain("integer");
      expect(result.errors[0].message).toContain("number, boolean, json");
      expect(result.errors[0].path).toBe("records.service.fields.size.type");
    });

    it("accepts empty writers array", () => {
      const toml = `
schema_version = 1

[records.service]
writers = []
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.schema.records.service.writers).toEqual([]);
    });

    it("preserves schema_ref when provided", () => {
      const toml = `
schema_version = 1

[records.config]
schema_ref = "https://json-schema.org/draft/2020-12/schema"
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.schema.records.config.schema_ref).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
    });

    it("existing work-unit tests still pass with records present", () => {
      const toml = `
schema_version = 1

[work_units.task]
fields = [{ name = "title", required = true, type = "string" }]
parents = []

[records.service]
format = "json"
`;
      const result = parseSchemaToml(toml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.schema.work_units.task.fields.title.type).toBe("string");
      expect(result.schema.records.service.format).toBe("json");
    });
  });
});

describe("parseTilaSchemaToml", () => {
  it("returns TilaSchemaToml on valid input", () => {
    const schema = parseTilaSchemaToml(MINIMAL_SCHEMA);
    expect(schema.schema_version).toBe(1);
    expect(schema.work_units.task).toBeDefined();
  });

  it("throws SchemaParseException on invalid input", () => {
    expect(() => parseTilaSchemaToml("invalid toml [[[")).toThrow(
      SchemaParseException,
    );
  });

  it("SchemaParseException contains errors array", () => {
    try {
      parseTilaSchemaToml("invalid toml [[[");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaParseException);
      expect((e as SchemaParseException).errors.length).toBeGreaterThan(0);
    }
  });
});
