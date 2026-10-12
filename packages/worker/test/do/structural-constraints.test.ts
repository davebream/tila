import { constraintOps } from "@tila/ops-sqlite";
import type { TilaSchemaToml } from "@tila/schemas";
import { describe, expect, it } from "vitest";

const {
  checkArtifactKindDeclared,
  checkArtifactRelationshipTypeDeclared,
  checkEntityTypeDeclared,
  checkLeafRejection,
  checkRecordTypeDeclared,
  checkReferenceSlotDeclared,
} = constraintOps;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
// Uses T1's extended TilaSchemaToml shape:
//   - hierarchy.levels (not leaf_types)
//   - artifacts is Record<string, ArtifactKind> (not { kinds: string[] })
//   - work_units.<type>.references: ReferenceSlot[]

const FULL_SCHEMA: TilaSchemaToml = {
  schema_version: 1,
  work_units: {
    epic: {
      fields: {
        title: { type: "string", required: true },
      },
      parents: [],
      references: [],
    },
    task: {
      fields: {
        title: { type: "string", required: true },
        priority: { type: "enum", required: false },
      },
      parents: ["epic"],
      references: [
        { name: "design_doc", multiple: false, kinds: ["document"] },
        {
          name: "research_sources",
          multiple: true,
          kinds: ["document", "link"],
        },
      ],
    },
  },
  hierarchy: {
    levels: ["epic", "task"],
  },
  artifacts: {
    document: {
      mime_types: ["text/markdown"],
      retention_days: 0,
      searchable: false,
      search_mode: "none" as const,
    },
    screenshot: {
      mime_types: ["image/png"],
      retention_days: 90,
      searchable: false,
      search_mode: "none" as const,
    },
  },
  artifact_relationships: {
    types: ["references", "supersedes", "derived-from"],
  },
};

// Minimal schema: only work_units, no hierarchy/artifacts/relationships
const MINIMAL_SCHEMA: TilaSchemaToml = {
  schema_version: 1,
  work_units: {
    task: {
      fields: {},
    },
  },
};

// ---------------------------------------------------------------------------
// checkEntityTypeDeclared
// ---------------------------------------------------------------------------

describe("checkEntityTypeDeclared", () => {
  it("passes when entity type is declared in work_units", () => {
    const result = checkEntityTypeDeclared(FULL_SCHEMA, "task");
    expect(result).toEqual({ ok: true });
  });

  it("fails when entity type is not declared", () => {
    const result = checkEntityTypeDeclared(FULL_SCHEMA, "sprint");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("constraint-violation");
      expect(result.message).toContain('"sprint"');
      expect(result.message).toContain("work_units");
      expect(result.message).toContain("epic");
      expect(result.message).toContain("task");
    }
  });

  it("fails with empty work_units", () => {
    const emptySchema: TilaSchemaToml = {
      schema_version: 1,
      work_units: {},
    };
    const result = checkEntityTypeDeclared(emptySchema, "task");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("(none)");
    }
  });
});

// ---------------------------------------------------------------------------
// checkLeafRejection
// ---------------------------------------------------------------------------

describe("checkLeafRejection", () => {
  it("passes when parent type is not the leaf type", () => {
    const result = checkLeafRejection(FULL_SCHEMA, "epic");
    expect(result).toEqual({ ok: true });
  });

  it("fails when parent type is the leaf type (last in levels)", () => {
    const result = checkLeafRejection(FULL_SCHEMA, "task");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("constraint-violation");
      expect(result.message).toContain('"task"');
      expect(result.message).toContain("leaf type");
    }
  });

  it("passes when hierarchy.levels is absent", () => {
    const result = checkLeafRejection(MINIMAL_SCHEMA, "task");
    expect(result).toEqual({ ok: true });
  });

  it("passes when hierarchy.levels is empty", () => {
    const schema: TilaSchemaToml = {
      ...FULL_SCHEMA,
      hierarchy: { levels: [] },
    };
    const result = checkLeafRejection(schema, "task");
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// checkArtifactKindDeclared
// ---------------------------------------------------------------------------

describe("checkArtifactKindDeclared", () => {
  it("passes when kind is declared in artifacts", () => {
    const result = checkArtifactKindDeclared(FULL_SCHEMA, "document");
    expect(result).toEqual({ ok: true });
  });

  it("fails when kind is not declared", () => {
    const result = checkArtifactKindDeclared(FULL_SCHEMA, "video");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("constraint-violation");
      expect(result.message).toContain('"video"');
      expect(result.message).toContain("document");
      expect(result.message).toContain("screenshot");
    }
  });

  it("passes when artifacts section is absent", () => {
    const result = checkArtifactKindDeclared(MINIMAL_SCHEMA, "anything");
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// checkArtifactRelationshipTypeDeclared
// ---------------------------------------------------------------------------

describe("checkArtifactRelationshipTypeDeclared", () => {
  it("passes when relationship type is declared", () => {
    const result = checkArtifactRelationshipTypeDeclared(
      FULL_SCHEMA,
      "references",
    );
    expect(result).toEqual({ ok: true });
  });

  it("fails when relationship type is not declared", () => {
    const result = checkArtifactRelationshipTypeDeclared(FULL_SCHEMA, "blocks");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("constraint-violation");
      expect(result.message).toContain('"blocks"');
      expect(result.message).toContain("references");
    }
  });

  it("passes when artifact_relationships.types is absent", () => {
    const result = checkArtifactRelationshipTypeDeclared(
      MINIMAL_SCHEMA,
      "anything",
    );
    expect(result).toEqual({ ok: true });
  });

  it("passes when types array is empty", () => {
    const schema: TilaSchemaToml = {
      ...FULL_SCHEMA,
      artifact_relationships: { types: [] },
    };
    const result = checkArtifactRelationshipTypeDeclared(schema, "anything");
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// checkReferenceSlotDeclared
// ---------------------------------------------------------------------------

describe("checkReferenceSlotDeclared", () => {
  it("passes when slot is declared in work unit references", () => {
    const result = checkReferenceSlotDeclared(
      FULL_SCHEMA,
      "task",
      "design_doc",
    );
    expect(result).toEqual({ ok: true });
  });

  it("passes for second declared slot", () => {
    const result = checkReferenceSlotDeclared(
      FULL_SCHEMA,
      "task",
      "research_sources",
    );
    expect(result).toEqual({ ok: true });
  });

  it("fails when slot is not declared", () => {
    const result = checkReferenceSlotDeclared(
      FULL_SCHEMA,
      "task",
      "unknown_slot",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("constraint-violation");
      expect(result.message).toContain('"unknown_slot"');
      expect(result.message).toContain("design_doc");
      expect(result.message).toContain("research_sources");
    }
  });

  it("passes when work unit has no references declared (open schema)", () => {
    const result = checkReferenceSlotDeclared(FULL_SCHEMA, "epic", "any_slot");
    expect(result).toEqual({ ok: true });
  });

  it("passes when work unit does not exist (entity type check catches this)", () => {
    const result = checkReferenceSlotDeclared(
      FULL_SCHEMA,
      "nonexistent",
      "any_slot",
    );
    expect(result).toEqual({ ok: true });
  });

  it("passes when references is empty array (open schema)", () => {
    const schema: TilaSchemaToml = {
      schema_version: 1,
      work_units: {
        task: {
          fields: {},
          references: [],
        },
      },
    };
    const result = checkReferenceSlotDeclared(schema, "task", "any_slot");
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// checkRecordTypeDeclared
// ---------------------------------------------------------------------------

describe("checkRecordTypeDeclared", () => {
  it("returns ok:true when record type is declared", () => {
    const schema = {
      schema_version: 1,
      work_units: {},
      records: {
        pipeline_config: {
          format: "json" as const,
          history: "revision" as const,
          mcp_resource: false,
          fields: {},
        },
      },
    };
    const result = checkRecordTypeDeclared(schema, "pipeline_config");
    expect(result).toEqual({ ok: true });
  });

  it("returns constraint-violation when record type is not declared", () => {
    const schema = {
      schema_version: 1,
      work_units: {},
      records: {
        pipeline_config: {
          format: "json" as const,
          history: "revision" as const,
          mcp_resource: false,
          fields: {},
        },
      },
    };
    const result = checkRecordTypeDeclared(schema, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("constraint-violation");
      expect(result.message).toContain("nonexistent");
      expect(result.message).toContain("pipeline_config");
    }
  });

  it("returns constraint-violation when records is empty", () => {
    const schema = {
      schema_version: 1,
      work_units: {},
      records: {},
    };
    const result = checkRecordTypeDeclared(schema, "any_type");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("(none)");
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: all violations have correct shape
// ---------------------------------------------------------------------------

describe("ConstraintResult shape", () => {
  it("all violations have code constraint-violation and ok false", () => {
    const violations = [
      checkEntityTypeDeclared(FULL_SCHEMA, "nonexistent"),
      checkLeafRejection(FULL_SCHEMA, "task"),
      checkArtifactKindDeclared(FULL_SCHEMA, "video"),
      checkArtifactRelationshipTypeDeclared(FULL_SCHEMA, "blocks"),
      checkReferenceSlotDeclared(FULL_SCHEMA, "task", "unknown_slot"),
    ];
    for (const v of violations) {
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.code).toBe("constraint-violation");
        expect(typeof v.message).toBe("string");
        expect(v.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("all passing results have ok true and no extra fields", () => {
    const passes = [
      checkEntityTypeDeclared(FULL_SCHEMA, "task"),
      checkLeafRejection(FULL_SCHEMA, "epic"),
      checkArtifactKindDeclared(FULL_SCHEMA, "document"),
      checkArtifactRelationshipTypeDeclared(FULL_SCHEMA, "references"),
      checkReferenceSlotDeclared(FULL_SCHEMA, "task", "design_doc"),
    ];
    for (const p of passes) {
      expect(p).toEqual({ ok: true });
    }
  });
});
