import { describe, expect, it } from "vitest";
import {
  RecordKeySchema,
  RecordTagSchema,
  RecordTypeSchema,
  RecordValueSchema,
  canonicalJson,
  canonicalJsonSha256,
  formatRecordResource,
  parseRecordResource,
} from "../src/record";

describe("RecordTypeSchema", () => {
  it("accepts valid types", () => {
    for (const valid of [
      "pipeline_config",
      "service",
      "agent-policy",
      "a",
      "a1",
    ]) {
      expect(RecordTypeSchema.safeParse(valid).success).toBe(true);
    }
  });

  it("rejects uppercase", () => {
    expect(RecordTypeSchema.safeParse("Pipeline").success).toBe(false);
  });

  it("rejects leading digit", () => {
    expect(RecordTypeSchema.safeParse("1config").success).toBe(false);
  });

  it("rejects slash", () => {
    expect(RecordTypeSchema.safeParse("pipe/config").success).toBe(false);
  });

  it("rejects colon", () => {
    expect(RecordTypeSchema.safeParse("pipe:config").success).toBe(false);
  });

  it("rejects dot", () => {
    expect(RecordTypeSchema.safeParse("pipe.config").success).toBe(false);
  });
});

describe("RecordKeySchema", () => {
  it("accepts simple key", () => {
    expect(RecordKeySchema.safeParse("main").success).toBe(true);
  });

  it("accepts multi-segment key", () => {
    expect(RecordKeySchema.safeParse("api/staging").success).toBe(true);
  });

  it("accepts deep path", () => {
    expect(RecordKeySchema.safeParse("package/auth").success).toBe(true);
  });

  it("accepts key with dots and hyphens in segment", () => {
    expect(RecordKeySchema.safeParse("frontend/build-v2.1").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(RecordKeySchema.safeParse("").success).toBe(false);
  });

  it("rejects empty segment (consecutive slashes)", () => {
    expect(RecordKeySchema.safeParse("api//staging").success).toBe(false);
  });

  it("rejects trailing slash", () => {
    expect(RecordKeySchema.safeParse("api/staging/").success).toBe(false);
  });

  it("rejects leading slash", () => {
    expect(RecordKeySchema.safeParse("/api/staging").success).toBe(false);
  });

  it("rejects dot-dot segment", () => {
    expect(RecordKeySchema.safeParse("api/../staging").success).toBe(false);
  });

  it("rejects tilde", () => {
    expect(RecordKeySchema.safeParse("api/~staging").success).toBe(false);
  });

  it("rejects colon", () => {
    expect(RecordKeySchema.safeParse("api/stag:ing").success).toBe(false);
  });

  it("rejects segment starting with dot", () => {
    expect(RecordKeySchema.safeParse("api/.hidden").success).toBe(false);
  });

  it("rejects segment starting with underscore", () => {
    expect(RecordKeySchema.safeParse("api/_internal").success).toBe(false);
  });

  it("rejects more than 8 segments", () => {
    const key = "a/b/c/d/e/f/g/h/i";
    expect(RecordKeySchema.safeParse(key).success).toBe(false);
  });

  it("accepts exactly 8 segments", () => {
    const key = "a/b/c/d/e/f/g/h";
    expect(RecordKeySchema.safeParse(key).success).toBe(true);
  });

  it("rejects total length over 256 characters", () => {
    const key = "a".repeat(257);
    expect(RecordKeySchema.safeParse(key).success).toBe(false);
  });

  it("rejects segment over 64 characters", () => {
    const key = "a".repeat(65);
    expect(RecordKeySchema.safeParse(key).success).toBe(false);
  });
});

describe("RecordTagSchema", () => {
  it("normalizes tags to lowercase", () => {
    const result = RecordTagSchema.safeParse(["Env:Staging", "Team:Alpha"]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(["env:staging", "team:alpha"]);
    }
  });

  it("deduplicates case-insensitively", () => {
    const result = RecordTagSchema.safeParse(["Env:Staging", "env:staging"]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(["env:staging"]);
    }
  });

  it("rejects more than 20 tags after dedup", () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    expect(RecordTagSchema.safeParse(tags).success).toBe(false);
  });

  it("accepts exactly 20 tags", () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    expect(RecordTagSchema.safeParse(tags).success).toBe(true);
  });

  it("rejects invalid tag format", () => {
    expect(RecordTagSchema.safeParse(["!invalid"]).success).toBe(false);
  });

  it("accepts empty array", () => {
    expect(RecordTagSchema.safeParse([]).success).toBe(true);
  });
});

describe("formatRecordResource / parseRecordResource", () => {
  it("round-trips a simple resource", () => {
    const resource = formatRecordResource("pipeline_config", "main");
    expect(resource).toBe("record:pipeline_config/main");
    const parsed = parseRecordResource(resource);
    expect(parsed).toEqual({ type: "pipeline_config", key: "main" });
  });

  it("round-trips a multi-slash key", () => {
    const resource = formatRecordResource("pipeline_config", "api/staging");
    expect(resource).toBe("record:pipeline_config/api/staging");
    const parsed = parseRecordResource(resource);
    expect(parsed).toEqual({ type: "pipeline_config", key: "api/staging" });
  });

  it("returns null for missing slash", () => {
    expect(parseRecordResource("record:noslash")).toBeNull();
  });

  it("returns null for wrong prefix", () => {
    expect(parseRecordResource("entity:something/key")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRecordResource("")).toBeNull();
  });
});

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    const result = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    expect(result).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    const result = canonicalJson({ items: [3, 1, 2] });
    expect(result).toBe('{"items":[3,1,2]}');
  });

  it("sorts keys inside array elements", () => {
    const result = canonicalJson({ arr: [{ z: 1, a: 2 }] });
    expect(result).toBe('{"arr":[{"a":2,"z":1}]}');
  });

  it("emits no whitespace", () => {
    const result = canonicalJson({ key: "value" });
    expect(result).not.toContain(" ");
    expect(result).not.toContain("\n");
  });
});

describe("canonicalJsonSha256", () => {
  it("returns a 64-character hex string", async () => {
    const hash = await canonicalJsonSha256({ hello: "world" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", async () => {
    const a = await canonicalJsonSha256({ x: 1, y: 2 });
    const b = await canonicalJsonSha256({ y: 2, x: 1 });
    expect(a).toBe(b);
  });
});

describe("RecordValueSchema", () => {
  it("accepts a plain object", () => {
    expect(RecordValueSchema.safeParse({ key: "value" }).success).toBe(true);
  });

  it("accepts an empty object", () => {
    expect(RecordValueSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an array", () => {
    expect(RecordValueSchema.safeParse([1, 2, 3]).success).toBe(false);
  });

  it("rejects a string", () => {
    expect(RecordValueSchema.safeParse("hello").success).toBe(false);
  });

  it("rejects a number", () => {
    expect(RecordValueSchema.safeParse(42).success).toBe(false);
  });

  it("rejects null", () => {
    expect(RecordValueSchema.safeParse(null).success).toBe(false);
  });

  it("rejects value exceeding 64 KiB", () => {
    // A single key with a value string that pushes the canonical JSON beyond 64 KiB
    const largeValue = { data: "x".repeat(70000) };
    expect(RecordValueSchema.safeParse(largeValue).success).toBe(false);
  });

  it("accepts value just under 64 KiB", () => {
    // Build an object whose canonical JSON is just under 65536 bytes
    // {"data":"x...x"} has overhead of 10 bytes for the envelope
    const value = { data: "x".repeat(65520) };
    const canonical = JSON.stringify({ data: value.data });
    // Verify our test fixture is actually under the limit
    expect(new TextEncoder().encode(canonical).length).toBeLessThanOrEqual(
      65536,
    );
    expect(RecordValueSchema.safeParse(value).success).toBe(true);
  });
});
