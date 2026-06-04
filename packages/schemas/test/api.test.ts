import { describe, expect, it } from "vitest";
import {
  ArtifactGrepLineSchema,
  ArtifactGrepQuerySchema,
  ArtifactGrepResponseSchema,
  ArtifactGrepResultSchema,
} from "../src/api";

describe("ArtifactGrepQuerySchema", () => {
  describe("regex coercion", () => {
    it('coerces "true" to true', () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        regex: "true",
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.regex).toBe(true);
    });

    it('coerces "false" to false', () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        regex: "false",
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.regex).toBe(false);
    });

    it("defaults to false when regex is absent", () => {
      const result = ArtifactGrepQuerySchema.safeParse({ pattern: "hello" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.regex).toBe(false);
    });

    it('coerces "1" to false (only "true" maps to true)', () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        regex: "1",
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.regex).toBe(false);
    });

    it('coerces "yes" to false', () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        regex: "yes",
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.regex).toBe(false);
    });
  });

  describe("limit coercion", () => {
    it("defaults to 50 when limit is absent", () => {
      const result = ArtifactGrepQuerySchema.safeParse({ pattern: "hello" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.limit).toBe(50);
    });

    it('coerces "10" to integer 10', () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        limit: "10",
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.limit).toBe(10);
    });

    it("accepts minimum value 1", () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        limit: "1",
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.limit).toBe(1);
    });

    it("accepts maximum value 100", () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        limit: "100",
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.limit).toBe(100);
    });

    it("rejects 0 (below min)", () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        limit: "0",
      });
      expect(result.success).toBe(false);
    });

    it("rejects 101 (above max)", () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        limit: "101",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("pattern validation", () => {
    it("accepts a non-empty pattern", () => {
      const result = ArtifactGrepQuerySchema.safeParse({ pattern: "x" });
      expect(result.success).toBe(true);
    });

    it("accepts a 200-char pattern", () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "a".repeat(200),
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty pattern (min 1)", () => {
      const result = ArtifactGrepQuerySchema.safeParse({ pattern: "" });
      expect(result.success).toBe(false);
    });

    it("rejects a 201-char pattern (max 200)", () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "a".repeat(201),
      });
      expect(result.success).toBe(false);
    });
  });

  describe("optional fields", () => {
    it("accepts kind", () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        kind: "patch",
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.kind).toBe("patch");
    });

    it("accepts resource", () => {
      const result = ArtifactGrepQuerySchema.safeParse({
        pattern: "hello",
        resource: "task/123",
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.resource).toBe("task/123");
    });
  });
});

describe("ArtifactGrepLineSchema", () => {
  it("accepts a valid line object", () => {
    const result = ArtifactGrepLineSchema.safeParse({
      line: 1,
      text: "hello world",
      col: 7,
    });
    expect(result.success).toBe(true);
  });

  it("requires line, text, col", () => {
    expect(
      ArtifactGrepLineSchema.safeParse({ line: 1, text: "x" }).success,
    ).toBe(false);
    expect(ArtifactGrepLineSchema.safeParse({ line: 1, col: 1 }).success).toBe(
      false,
    );
    expect(
      ArtifactGrepLineSchema.safeParse({ text: "x", col: 1 }).success,
    ).toBe(false);
  });
});

describe("ArtifactGrepResultSchema", () => {
  it("accepts a result with resource: null", () => {
    const result = ArtifactGrepResultSchema.safeParse({
      key: "artifacts/abc/deadbeef.txt",
      kind: "patch",
      resource: null,
      lines: [{ line: 3, text: "foo bar", col: 1 }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a result with resource set", () => {
    const result = ArtifactGrepResultSchema.safeParse({
      key: "artifacts/abc/deadbeef.txt",
      kind: "log",
      resource: "task/42",
      lines: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional truncated field", () => {
    const result = ArtifactGrepResultSchema.safeParse({
      key: "artifacts/abc/deadbeef.txt",
      kind: "log",
      resource: null,
      lines: [],
      truncated: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.truncated).toBe(true);
  });

  it("allows truncated to be absent (optional)", () => {
    const result = ArtifactGrepResultSchema.safeParse({
      key: "artifacts/abc/deadbeef.txt",
      kind: "log",
      resource: null,
      lines: [],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.truncated).toBeUndefined();
  });
});

describe("ArtifactGrepResponseSchema", () => {
  it("accepts a valid full response", () => {
    const result = ArtifactGrepResponseSchema.safeParse({
      ok: true,
      results: [
        {
          key: "artifacts/abc/deadbeef.txt",
          kind: "patch",
          resource: null,
          lines: [{ line: 1, text: "hello", col: 1 }],
          truncated: false,
        },
      ],
      scanned: 1,
      skipped: 0,
      truncated: false,
    });
    expect(result.success).toBe(true);
  });

  it("requires ok: true (literal)", () => {
    const result = ArtifactGrepResponseSchema.safeParse({
      ok: false,
      results: [],
      scanned: 0,
      skipped: 0,
      truncated: false,
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty results with truncated: true at request level", () => {
    const result = ArtifactGrepResponseSchema.safeParse({
      ok: true,
      results: [],
      scanned: 100,
      skipped: 5,
      truncated: true,
    });
    expect(result.success).toBe(true);
  });

  it("requires scanned, skipped, truncated fields", () => {
    expect(
      ArtifactGrepResponseSchema.safeParse({
        ok: true,
        results: [],
        skipped: 0,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      ArtifactGrepResponseSchema.safeParse({
        ok: true,
        results: [],
        scanned: 0,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      ArtifactGrepResponseSchema.safeParse({
        ok: true,
        results: [],
        scanned: 0,
        skipped: 0,
      }).success,
    ).toBe(false);
  });
});
