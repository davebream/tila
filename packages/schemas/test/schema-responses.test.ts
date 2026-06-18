import { describe, expect, it } from "vitest";
import {
  SchemaApplyResponseSchema,
  SchemaGetResponseSchema,
  SchemaHistoryResponseSchema,
} from "../src/api";

describe("SchemaGetResponseSchema", () => {
  it("parses a valid schema-get response with unknown schema field", () => {
    const raw = {
      ok: true,
      schema: { entities: { task: { fields: [] } } },
      version: 1,
    };
    const result = SchemaGetResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.version).toBe(1);
    }
  });

  it("parses with a null schema field", () => {
    const raw = { ok: true, schema: null, version: 0 };
    const result = SchemaGetResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("parses with schema as a string (arbitrary caller-defined content)", () => {
    const raw = { ok: true, schema: "raw toml string", version: 2 };
    const result = SchemaGetResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe("SchemaApplyResponseSchema", () => {
  it("parses a valid schema-apply response with diff field", () => {
    const raw = {
      ok: true,
      diff: { added: ["field_a"], removed: [] },
      version: 3,
    };
    const result = SchemaApplyResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.version).toBe(3);
    }
  });

  it("parses with diff as null", () => {
    const raw = { ok: true, diff: null, version: 1 };
    const result = SchemaApplyResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("parses with diff as a string", () => {
    const raw = { ok: true, diff: "no changes", version: 0 };
    const result = SchemaApplyResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe("SchemaHistoryResponseSchema", () => {
  it("parses a schema-history response with entries array", () => {
    const raw = {
      ok: true,
      entries: [
        { version: 1, applied_at: 1000000 },
        { version: 2, applied_at: 2000000 },
      ],
    };
    const result = SchemaHistoryResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.entries).toHaveLength(2);
    }
  });

  it("parses with an empty entries array", () => {
    const raw = { ok: true, entries: [] };
    const result = SchemaHistoryResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("entries are unknown (arbitrary objects pass)", () => {
    const raw = {
      ok: true,
      entries: [{ arbitrary: true }, "string-entry", 42],
    };
    const result = SchemaHistoryResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});
