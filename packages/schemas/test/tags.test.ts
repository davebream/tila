import { describe, expect, it } from "vitest";
import { TagSchema, TagsSchema } from "../src/tags";

describe("TagSchema", () => {
  it("accepts a valid simple tag", () => {
    expect(TagSchema.safeParse("env").success).toBe(true);
  });

  it("accepts a tag with colon separator", () => {
    expect(TagSchema.safeParse("team:alpha").success).toBe(true);
  });

  it("accepts a tag with dot and hyphen", () => {
    expect(TagSchema.safeParse("repo-owner.org").success).toBe(true);
  });

  it("accepts a tag exactly 64 characters long", () => {
    // 1 leading alphanumeric + 63 body chars = 64 total
    expect(TagSchema.safeParse(`a${"b".repeat(63)}`).success).toBe(true);
  });

  it("rejects a tag starting with '!'", () => {
    expect(TagSchema.safeParse("!invalid").success).toBe(false);
  });

  it("rejects a tag that is 65 characters long", () => {
    expect(TagSchema.safeParse(`a${"b".repeat(64)}`).success).toBe(false);
  });

  it("rejects an empty tag", () => {
    expect(TagSchema.safeParse("").success).toBe(false);
  });
});

describe("TagsSchema", () => {
  it("normalizes tags to lowercase", () => {
    const result = TagsSchema.safeParse(["Env:Staging", "Team:Alpha"]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(["env:staging", "team:alpha"]);
    }
  });

  it("deduplicates case-insensitively", () => {
    const result = TagsSchema.safeParse(["Env:Staging", "env:staging"]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(["env:staging"]);
    }
  });

  it("rejects more than 20 tags after dedup", () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    expect(TagsSchema.safeParse(tags).success).toBe(false);
  });

  it("accepts exactly 20 tags", () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    expect(TagsSchema.safeParse(tags).success).toBe(true);
  });

  it("rejects invalid tag format ('!invalid')", () => {
    expect(TagsSchema.safeParse(["!invalid"]).success).toBe(false);
  });

  it("rejects a tag that is 65 characters long", () => {
    expect(TagsSchema.safeParse([`a${"b".repeat(64)}`]).success).toBe(false);
  });

  it("accepts an empty array", () => {
    expect(TagsSchema.safeParse([]).success).toBe(true);
  });
});
