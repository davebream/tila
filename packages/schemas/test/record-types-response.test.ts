import { describe, expect, it } from "vitest";
import {
  RecordTypesIncompleteSchema,
  RecordTypesResponseSchema,
} from "../src/api";

describe("RecordTypesResponseSchema", () => {
  it("still parses the legacy shape with only `ok` and `types`", () => {
    const parsed = RecordTypesResponseSchema.parse({ ok: true, types: ["a"] });
    expect(parsed).toEqual({ ok: true, types: ["a"] });
  });

  it("parses the full wire shape including the per-source lists", () => {
    const body = {
      ok: true as const,
      types: ["a", "b"],
      declared_types: ["a"],
      in_use_types: ["b"],
    };
    expect(RecordTypesResponseSchema.parse(body)).toEqual(body);
  });

  it("parses a partial listing with its incompleteness", () => {
    const parsed = RecordTypesResponseSchema.parse({
      ok: true,
      types: [],
      declared_types: [],
      in_use_types: [],
      incomplete: {
        declared_types: "unavailable",
        in_use_types: "unavailable",
      },
    });
    expect(parsed.incomplete).toEqual({
      declared_types: "unavailable",
      in_use_types: "unavailable",
    });
  });
});

describe("RecordTypesIncompleteSchema", () => {
  it.each(["unavailable", "invalid"])("accepts declared_types=%s", (reason) => {
    expect(
      RecordTypesIncompleteSchema.safeParse({ declared_types: reason }).success,
    ).toBe(true);
  });

  it("only allows `unavailable` for in_use_types", () => {
    expect(
      RecordTypesIncompleteSchema.safeParse({ in_use_types: "unavailable" })
        .success,
    ).toBe(true);
    expect(
      RecordTypesIncompleteSchema.safeParse({ in_use_types: "invalid" })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown reason", () => {
    expect(
      RecordTypesIncompleteSchema.safeParse({ declared_types: "missing" })
        .success,
    ).toBe(false);
  });
});
