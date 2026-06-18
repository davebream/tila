import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema } from "../src/api";
import { errorEnvelope, okEnvelope } from "../src/envelope";

describe("errorEnvelope", () => {
  it("produces the expected shape", () => {
    const result = errorEnvelope("NOT_FOUND", "resource not found", false);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "resource not found",
        retryable: false,
      },
    });
  });

  it("satisfies ErrorEnvelopeSchema", () => {
    const result = errorEnvelope("INTERNAL_ERROR", "boom", true);
    const parsed = ErrorEnvelopeSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("merges extras (e.g. gateIds)", () => {
    const result = errorEnvelope(
      "GATE_FENCE_CONFLICT",
      "gate conflict",
      false,
      {
        gateIds: ["gate-1", "gate-2"],
      },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "GATE_FENCE_CONFLICT",
        message: "gate conflict",
        retryable: false,
        gateIds: ["gate-1", "gate-2"],
      },
    });
  });

  it("extras with gateIds satisfies ErrorEnvelopeSchema", () => {
    const result = errorEnvelope(
      "GATE_FENCE_CONFLICT",
      "gate conflict",
      false,
      {
        gateIds: ["g1"],
      },
    );
    const parsed = ErrorEnvelopeSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("ok is always false", () => {
    const result = errorEnvelope("BAD_REQUEST", "bad input", false);
    expect(result.ok).toBe(false);
  });
});

describe("okEnvelope", () => {
  it("wraps a body object with ok:true", () => {
    const result = okEnvelope({ entity: { id: "e-1", type: "task" } });
    expect(result).toEqual({
      ok: true,
      entity: { id: "e-1", type: "task" },
    });
  });

  it("ok is always true", () => {
    const result = okEnvelope({ key: "abc", bytes: 100 });
    expect(result.ok).toBe(true);
  });

  it("preserves all body fields at the top level", () => {
    const body = { a: 1, b: "two", c: [3] };
    const result = okEnvelope(body);
    expect(result.a).toBe(1);
    expect(result.b).toBe("two");
    expect((result as typeof result & { c: number[] }).c).toEqual([3]);
  });

  it("produces { ok:true, entity } shape compatible with EntityResponse", () => {
    const entity = {
      id: "e-123",
      type: "task",
      schema_version: 1,
      data: {},
      archived: 0,
      created_at: 1000,
      updated_at: 1000,
      created_by: "user",
      tags: [],
    };
    const result = okEnvelope({ entity });
    expect(result.ok).toBe(true);
    expect(result.entity).toBe(entity);
  });
});
