import type { Entity, TilaSchemaToml } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import {
  applyLegacyDefaults,
  diffSchemas,
  tolerantRead,
  validatedWrite,
} from "../src/schema-evolution";

const testSchema: TilaSchemaToml = {
  schema_version: 1,
  work_units: {
    task: {
      fields: {
        title: { type: "string", required: true },
        owner: { type: "string", required: true },
        priority: { type: "string", required: false },
      },
    },
  },
};

const schemaWithLegacyDefault: TilaSchemaToml = {
  schema_version: 1,
  work_units: {
    task: {
      fields: {
        title: { type: "string", required: true },
        owner: {
          type: "string",
          required: true,
          default_for_legacy: "unassigned",
        },
      },
    },
  },
};

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: "T-1",
    type: "task",
    schema_version: 1,
    data: { title: "Test", owner: "alice" },
    archived: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
    created_by: "alice",
    ...overrides,
  };
}

describe("tolerantRead", () => {
  it("returns ok when all required fields are present", () => {
    const result = tolerantRead(makeEntity(), testSchema, "task");
    expect(result).toEqual({ ok: true });
  });

  it("preserves unknown fields in data (passthrough)", () => {
    const entity = makeEntity({
      data: { title: "Test", owner: "alice", custom_field: 42 },
    });
    const result = tolerantRead(entity, testSchema, "task");
    expect(result).toEqual({ ok: true });
  });

  it("passes legacy entity with missing required field when default_for_legacy exists", () => {
    const entity = makeEntity({
      schema_version: 0,
      data: { title: "Test" },
    });
    const result = tolerantRead(entity, schemaWithLegacyDefault, "task");
    expect(result).toEqual({ ok: true });
  });

  it("returns error for unknown entity type", () => {
    const result = tolerantRead(makeEntity(), testSchema, "epic");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("Unknown entity type");
    }
  });
});

describe("validatedWrite", () => {
  it("returns ok when all required fields are present", () => {
    const result = validatedWrite(
      { title: "Test", owner: "alice" },
      testSchema,
      "task",
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns error when required field is missing", () => {
    const result = validatedWrite({ title: "Test" }, testSchema, "task");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('Required field "owner" is missing');
    }
  });

  it("does not strip unknown fields (merge not replace)", () => {
    const result = validatedWrite(
      { title: "Test", owner: "alice", custom_field: 42 },
      testSchema,
      "task",
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns error for unknown entity type", () => {
    const result = validatedWrite({ title: "Test" }, testSchema, "epic");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("Unknown entity type");
    }
  });
});

describe("applyLegacyDefaults", () => {
  it("injects default_for_legacy value for missing field", () => {
    const entity = makeEntity({
      schema_version: 1,
      data: { title: "Test" },
    });
    const result = applyLegacyDefaults(entity, schemaWithLegacyDefault, "task");
    expect(result.data).toEqual({ title: "Test", owner: "unassigned" });
    // Must return a new object, not mutate the original
    expect(result).not.toBe(entity);
    expect(entity.data).toEqual({ title: "Test" });
  });

  it("does not override field that already has a value", () => {
    const entity = makeEntity({
      data: { title: "Test", owner: "alice" },
    });
    const result = applyLegacyDefaults(entity, schemaWithLegacyDefault, "task");
    expect(result.data.owner).toBe("alice");
    // Returns same reference when no changes needed
    expect(result).toBe(entity);
  });

  it("returns entity unmodified for unknown entity type", () => {
    const entity = makeEntity();
    const result = applyLegacyDefaults(entity, schemaWithLegacyDefault, "epic");
    expect(result).toBe(entity);
  });

  it("injects multiple missing defaults", () => {
    const multiDefaultSchema: TilaSchemaToml = {
      work_units: {
        task: {
          fields: {
            title: { type: "string", required: true },
            owner: {
              type: "string",
              required: true,
              default_for_legacy: "unassigned",
            },
            priority: {
              type: "string",
              required: true,
              default_for_legacy: "medium",
            },
          },
        },
      },
    };
    const entity = makeEntity({
      schema_version: 1,
      data: { title: "Test" },
    });
    const result = applyLegacyDefaults(entity, multiDefaultSchema, "task");
    expect(result.data).toEqual({
      title: "Test",
      owner: "unassigned",
      priority: "medium",
    });
  });

  it("combined flow: tolerantRead validates, applyLegacyDefaults materializes", () => {
    const entity = makeEntity({
      schema_version: 1,
      data: { title: "Test" },
    });
    // Step 1: validate
    const validation = tolerantRead(entity, schemaWithLegacyDefault, "task");
    expect(validation).toEqual({ ok: true });
    // Step 2: materialize
    const enriched = applyLegacyDefaults(
      entity,
      schemaWithLegacyDefault,
      "task",
    );
    expect(enriched.data).toEqual({ title: "Test", owner: "unassigned" });
  });
});

describe("tolerantRead fail path without default_for_legacy", () => {
  it("fails for legacy entity missing required field without default_for_legacy", () => {
    const entity = makeEntity({
      schema_version: 1,
      data: { title: "Test" }, // missing 'owner', which has no default_for_legacy in testSchema
    });
    const result = tolerantRead(entity, testSchema, "task");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('Required field "owner" is missing');
    }
  });
});

describe("diffSchemas", () => {
  const baseSchema: TilaSchemaToml = {
    schema_version: 1,
    work_units: {
      task: {
        fields: {
          title: { type: "string", required: true },
          owner: { type: "string", required: false },
        },
      },
    },
  };

  it("returns empty changes for identical schemas", () => {
    const result = diffSchemas(baseSchema, baseSchema);
    expect(result.changes).toEqual([]);
    expect(result.autoApplicable).toBe(true);
  });

  it("detects work-unit-added (non-destructive)", () => {
    const next: TilaSchemaToml = {
      schema_version: 2,
      work_units: {
        ...baseSchema.work_units,
        epic: {
          fields: { name: { type: "string", required: true } },
        },
      },
    };
    const result = diffSchemas(baseSchema, next);
    expect(result.changes).toContainEqual({
      kind: "work-unit-added",
      unitType: "epic",
    });
    expect(result.autoApplicable).toBe(true);
  });

  it("detects work-unit-removed (destructive)", () => {
    const next: TilaSchemaToml = { schema_version: 2, work_units: {} };
    const result = diffSchemas(baseSchema, next);
    expect(result.changes).toContainEqual({
      kind: "work-unit-removed",
      unitType: "task",
      entityCount: 0,
    });
    expect(result.autoApplicable).toBe(false);
  });

  it("detects field-added on existing unit (non-destructive for optional)", () => {
    const next: TilaSchemaToml = {
      schema_version: 2,
      work_units: {
        task: {
          fields: {
            ...baseSchema.work_units.task.fields,
            priority: { type: "string", required: false },
          },
        },
      },
    };
    const result = diffSchemas(baseSchema, next);
    expect(result.changes).toContainEqual({
      kind: "field-added",
      unitType: "task",
      fieldName: "priority",
      declaration: { type: "string", required: false },
    });
    expect(result.autoApplicable).toBe(true);
  });

  it("detects field-required-added (destructive)", () => {
    const next: TilaSchemaToml = {
      schema_version: 2,
      work_units: {
        task: {
          fields: {
            ...baseSchema.work_units.task.fields,
            status: { type: "string", required: true },
          },
        },
      },
    };
    const result = diffSchemas(baseSchema, next);
    expect(result.changes).toContainEqual({
      kind: "field-required-added",
      unitType: "task",
      fieldName: "status",
      declaration: { type: "string", required: true },
    });
    expect(result.autoApplicable).toBe(false);
  });

  it("treats a required field added WITH default_for_legacy as non-destructive (auto-applicable)", () => {
    const next: TilaSchemaToml = {
      schema_version: 2,
      work_units: {
        task: {
          fields: {
            ...baseSchema.work_units.task.fields,
            priority: {
              type: "string",
              required: true,
              default_for_legacy: "medium",
            },
          },
        },
      },
    };
    const result = diffSchemas(baseSchema, next);
    expect(result.changes).toContainEqual({
      kind: "field-added",
      unitType: "task",
      fieldName: "priority",
      declaration: {
        type: "string",
        required: true,
        default_for_legacy: "medium",
      },
    });
    expect(result.changes).not.toContainEqual(
      expect.objectContaining({ kind: "field-required-added" }),
    );
    expect(result.autoApplicable).toBe(true);
  });

  it("detects field-removed (destructive)", () => {
    const next: TilaSchemaToml = {
      schema_version: 2,
      work_units: {
        task: {
          fields: {
            title: { type: "string", required: true },
            // owner removed
          },
        },
      },
    };
    const result = diffSchemas(baseSchema, next);
    expect(result.changes).toContainEqual({
      kind: "field-removed",
      unitType: "task",
      fieldName: "owner",
    });
    expect(result.autoApplicable).toBe(false);
  });

  it("detects artifact-kind-added (non-destructive)", () => {
    const prev: TilaSchemaToml = { schema_version: 1, work_units: {} };
    const next: TilaSchemaToml = {
      schema_version: 2,
      work_units: {},
      artifacts: { document: { mime_types: [], retention_days: 0 } },
    };
    const result = diffSchemas(prev, next);
    expect(result.changes).toContainEqual({
      kind: "artifact-kind-added",
      artifactKind: "document",
    });
    expect(result.autoApplicable).toBe(true);
  });

  it("detects artifact-kind-removed (destructive)", () => {
    const prev: TilaSchemaToml = {
      schema_version: 1,
      work_units: {},
      artifacts: { document: { mime_types: [], retention_days: 0 } },
    };
    const next: TilaSchemaToml = { schema_version: 2, work_units: {} };
    const result = diffSchemas(prev, next);
    expect(result.changes).toContainEqual({
      kind: "artifact-kind-removed",
      artifactKind: "document",
      artifactCount: 0,
    });
    expect(result.autoApplicable).toBe(false);
  });

  it("handles mixed additive changes as autoApplicable", () => {
    const next: TilaSchemaToml = {
      schema_version: 2,
      work_units: {
        ...baseSchema.work_units,
        epic: { fields: {} },
      },
    };
    const result = diffSchemas(baseSchema, next);
    expect(result.autoApplicable).toBe(true);
  });

  it("handles field type change as field-removed + field-added pair", () => {
    const next: TilaSchemaToml = {
      schema_version: 2,
      work_units: {
        task: {
          fields: {
            title: { type: "text", required: true }, // changed type
            owner: { type: "string", required: false },
          },
        },
      },
    };
    const result = diffSchemas(baseSchema, next);
    const titleChanges = result.changes.filter(
      (c) => "fieldName" in c && c.fieldName === "title",
    );
    expect(titleChanges.length).toBe(2);
    expect(titleChanges).toContainEqual({
      kind: "field-removed",
      unitType: "task",
      fieldName: "title",
    });
    expect(titleChanges).toContainEqual({
      kind: "field-added",
      unitType: "task",
      fieldName: "title",
      declaration: { type: "text", required: true },
    });
    // Original was required, so removal is destructive
    expect(result.autoApplicable).toBe(false);
  });

  describe("records", () => {
    const recordBaseSchema: TilaSchemaToml = {
      schema_version: 1,
      work_units: {},
      records: {
        service: {
          format: "json",
          history: "revision",
          mcp_resource: false,
          fields: {
            name: { type: "string", required: true },
            port: { type: "number", required: false },
          },
        },
      },
    };

    it("detects record-type-added (non-destructive)", () => {
      const prev: TilaSchemaToml = {
        schema_version: 1,
        work_units: {},
        records: {},
      };
      const next: TilaSchemaToml = {
        schema_version: 2,
        work_units: {},
        records: {
          pipeline_config: {
            format: "json",
            history: "revision",
            mcp_resource: false,
            fields: {},
          },
        },
      };
      const result = diffSchemas(prev, next);
      expect(result.changes).toContainEqual({
        kind: "record-type-added",
        typeName: "pipeline_config",
      });
      expect(result.autoApplicable).toBe(true);
    });

    it("detects record-type-removed (destructive)", () => {
      const next: TilaSchemaToml = {
        schema_version: 2,
        work_units: {},
        records: {},
      };
      const result = diffSchemas(recordBaseSchema, next);
      expect(result.changes).toContainEqual({
        kind: "record-type-removed",
        typeName: "service",
        recordCount: 0,
      });
      expect(result.autoApplicable).toBe(false);
    });

    it("detects record-field-added for optional field (non-destructive)", () => {
      const next: TilaSchemaToml = {
        schema_version: 2,
        work_units: {},
        records: {
          service: {
            ...recordBaseSchema.records?.service,
            fields: {
              ...recordBaseSchema.records?.service.fields,
              region: { type: "string", required: false },
            },
          },
        },
      };
      const result = diffSchemas(recordBaseSchema, next);
      expect(result.changes).toContainEqual({
        kind: "record-field-added",
        typeName: "service",
        fieldName: "region",
        declaration: { type: "string", required: false },
      });
      expect(result.autoApplicable).toBe(true);
    });

    it("detects record-field-required-added without default_for_legacy (destructive)", () => {
      const next: TilaSchemaToml = {
        schema_version: 2,
        work_units: {},
        records: {
          service: {
            ...recordBaseSchema.records?.service,
            fields: {
              ...recordBaseSchema.records?.service.fields,
              owner: { type: "string", required: true },
            },
          },
        },
      };
      const result = diffSchemas(recordBaseSchema, next);
      expect(result.changes).toContainEqual({
        kind: "record-field-required-added",
        typeName: "service",
        fieldName: "owner",
        declaration: { type: "string", required: true },
      });
      expect(result.autoApplicable).toBe(false);
    });

    it("treats required field addition with default_for_legacy as non-destructive", () => {
      const next: TilaSchemaToml = {
        schema_version: 2,
        work_units: {},
        records: {
          service: {
            ...recordBaseSchema.records?.service,
            fields: {
              ...recordBaseSchema.records?.service.fields,
              owner: {
                type: "string",
                required: true,
                default_for_legacy: "platform",
              },
            },
          },
        },
      };
      const result = diffSchemas(recordBaseSchema, next);
      expect(result.changes).toContainEqual({
        kind: "record-field-added",
        typeName: "service",
        fieldName: "owner",
        declaration: {
          type: "string",
          required: true,
          default_for_legacy: "platform",
        },
      });
      expect(result.autoApplicable).toBe(true);
    });

    it("detects record-field-removed (destructive)", () => {
      const next: TilaSchemaToml = {
        schema_version: 2,
        work_units: {},
        records: {
          service: {
            ...recordBaseSchema.records?.service,
            fields: {
              name: { type: "string", required: true },
              // port removed
            },
          },
        },
      };
      const result = diffSchemas(recordBaseSchema, next);
      expect(result.changes).toContainEqual({
        kind: "record-field-removed",
        typeName: "service",
        fieldName: "port",
      });
      expect(result.autoApplicable).toBe(false);
    });

    it("handles record field type change as removed + added pair", () => {
      const next: TilaSchemaToml = {
        schema_version: 2,
        work_units: {},
        records: {
          service: {
            ...recordBaseSchema.records?.service,
            fields: {
              name: { type: "string", required: true },
              port: { type: "string", required: false }, // changed from number
            },
          },
        },
      };
      const result = diffSchemas(recordBaseSchema, next);
      const portChanges = result.changes.filter(
        (c) => "fieldName" in c && c.fieldName === "port",
      );
      expect(portChanges.length).toBe(2);
      expect(portChanges).toContainEqual({
        kind: "record-field-removed",
        typeName: "service",
        fieldName: "port",
      });
      expect(portChanges).toContainEqual({
        kind: "record-field-added",
        typeName: "service",
        fieldName: "port",
        declaration: { type: "string", required: false },
      });
      expect(result.autoApplicable).toBe(false);
    });

    it("ignores format/history/writers/mcp_resource metadata changes", () => {
      const next: TilaSchemaToml = {
        schema_version: 2,
        work_units: {},
        records: {
          service: {
            format: "yaml",
            history: "snapshot",
            writers: ["human"],
            mcp_resource: true,
            fields: {
              name: { type: "string", required: true },
              port: { type: "number", required: false },
            },
          },
        },
      };
      const result = diffSchemas(recordBaseSchema, next);
      expect(result.changes).toEqual([]);
      expect(result.autoApplicable).toBe(true);
    });

    it("handles schema with no records diffed against schema with records", () => {
      const prev: TilaSchemaToml = {
        schema_version: 1,
        work_units: {},
      };
      const next: TilaSchemaToml = {
        schema_version: 2,
        work_units: {},
        records: {
          config: {
            format: "json",
            history: "revision",
            mcp_resource: false,
            fields: {},
          },
        },
      };
      const result = diffSchemas(prev, next);
      expect(result.changes).toContainEqual({
        kind: "record-type-added",
        typeName: "config",
      });
      expect(result.autoApplicable).toBe(true);
    });

    it("handles mixed additive changes (add type + add optional field)", () => {
      const next: TilaSchemaToml = {
        schema_version: 2,
        work_units: {},
        records: {
          service: {
            ...recordBaseSchema.records?.service,
            fields: {
              ...recordBaseSchema.records?.service.fields,
              region: { type: "string", required: false },
            },
          },
          config: {
            format: "json",
            history: "revision",
            mcp_resource: false,
            fields: {},
          },
        },
      };
      const result = diffSchemas(recordBaseSchema, next);
      expect(result.autoApplicable).toBe(true);
      expect(result.changes.length).toBe(2);
    });
  });
});
