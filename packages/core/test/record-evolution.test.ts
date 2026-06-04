import type { TilaSchemaToml } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import { applyRecordLegacyDefaults } from "../src/record-evolution";

// Schema v1: only has "title" field
const schemaV1: TilaSchemaToml = {
  schema_version: 1,
  work_units: {},
  records: {
    config: {
      format: "json",
      history: "revision",
      mcp_resource: false,
      fields: {
        title: { type: "string", required: true },
      },
    },
  },
};

// Schema v2: adds "priority" with default_for_legacy
const schemaV2: TilaSchemaToml = {
  schema_version: 2,
  work_units: {},
  records: {
    config: {
      format: "json",
      history: "revision",
      mcp_resource: false,
      fields: {
        title: { type: "string", required: true },
        priority: {
          type: "string",
          required: false,
          default_for_legacy: "normal",
        },
      },
    },
  },
};

// Schema v3: adds both "priority" and "status" with defaults_for_legacy
const schemaV3: TilaSchemaToml = {
  schema_version: 3,
  work_units: {},
  records: {
    config: {
      format: "json",
      history: "revision",
      mcp_resource: false,
      fields: {
        title: { type: "string", required: true },
        priority: {
          type: "string",
          required: false,
          default_for_legacy: "normal",
        },
        status: {
          type: "string",
          required: false,
          default_for_legacy: "active",
        },
      },
    },
  },
};

describe("applyRecordLegacyDefaults", () => {
  it("injects default_for_legacy values for fields missing from value (happy path)", () => {
    // Record was written under schema v1 (no "priority" field),
    // now schema v2 adds "priority" with default_for_legacy: "normal"
    const value = { title: "hello" };
    const enriched = applyRecordLegacyDefaults(value, schemaV2, "config");
    expect(enriched).toEqual({ title: "hello", priority: "normal" });
  });

  it("returns unmodified value when no defaults are needed (record matches current schema)", () => {
    // Record already has all fields — no injection needed
    const value = { title: "hello", priority: "urgent" };
    const enriched = applyRecordLegacyDefaults(value, schemaV2, "config");
    expect(enriched).toBe(value); // same reference (copy-on-write: no copy)
    expect(enriched).toEqual({ title: "hello", priority: "urgent" });
  });

  it("returns unmodified value when record type is not in schema (unknown type passthrough)", () => {
    const value = { title: "hello" };
    const enriched = applyRecordLegacyDefaults(value, schemaV2, "unknown-type");
    expect(enriched).toBe(value); // same reference
  });

  it("injects multiple defaults when schema adds multiple fields with default_for_legacy", () => {
    const value = { title: "hello" };
    const enriched = applyRecordLegacyDefaults(value, schemaV3, "config");
    expect(enriched).toEqual({
      title: "hello",
      priority: "normal",
      status: "active",
    });
  });

  it("does not overwrite existing field values with defaults", () => {
    // "priority" is present — should not be overwritten by default
    const value = { title: "hello", priority: "urgent" };
    const enriched = applyRecordLegacyDefaults(value, schemaV3, "config");
    // priority stays "urgent", only "status" is injected
    expect(enriched).toEqual({
      title: "hello",
      priority: "urgent",
      status: "active",
    });
  });

  it("handles schema with no records section (empty records)", () => {
    const emptySchema: TilaSchemaToml = {
      schema_version: 1,
      work_units: {},
      records: {},
    };
    const value = { title: "hello" };
    const enriched = applyRecordLegacyDefaults(value, emptySchema, "config");
    expect(enriched).toBe(value); // passthrough, same reference
  });

  it("handles fields without default_for_legacy (only fields with defaults are injected)", () => {
    const schemaWithMixedFields: TilaSchemaToml = {
      schema_version: 2,
      work_units: {},
      records: {
        config: {
          format: "json",
          history: "revision",
          mcp_resource: false,
          fields: {
            title: { type: "string", required: true },
            // No default_for_legacy on "description"
            description: { type: "string", required: false },
            // Has default_for_legacy on "priority"
            priority: {
              type: "string",
              required: false,
              default_for_legacy: "low",
            },
          },
        },
      },
    };
    const value = { title: "hello" };
    const enriched = applyRecordLegacyDefaults(
      value,
      schemaWithMixedFields,
      "config",
    );
    // "description" not injected (no default_for_legacy), "priority" is injected
    expect(enriched).toEqual({ title: "hello", priority: "low" });
  });
});
