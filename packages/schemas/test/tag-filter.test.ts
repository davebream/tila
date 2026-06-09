import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseTagFilter, tagFilterQueryParam } from "../src/api";

describe("parseTagFilter", () => {
  it("splits comma-separated tags", () => {
    expect(parseTagFilter("repo:tila,team:platform")).toEqual([
      "repo:tila",
      "team:platform",
    ]);
  });

  it("lowercases tags", () => {
    expect(parseTagFilter("Repo:Tila")).toEqual(["repo:tila"]);
  });

  it("trims whitespace around tags", () => {
    expect(parseTagFilter(" repo:tila , team:platform ")).toEqual([
      "repo:tila",
      "team:platform",
    ]);
  });

  it("deduplicates tags (case-insensitive)", () => {
    expect(parseTagFilter("repo:tila,REPO:TILA,repo:tila")).toEqual([
      "repo:tila",
    ]);
  });

  it("returns undefined for undefined input", () => {
    expect(parseTagFilter(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseTagFilter("")).toBeUndefined();
  });

  it("returns undefined for a string of only commas/spaces", () => {
    expect(parseTagFilter(",  , ")).toBeUndefined();
  });

  it("throws ZodError for a tag with invalid grammar", () => {
    expect(() => parseTagFilter("bad tag!")).toThrow(ZodError);
  });

  it("throws ZodError when more than 20 tags are provided", () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`).join(",");
    expect(() => parseTagFilter(tags)).toThrow(ZodError);
  });

  it("accepts exactly 20 tags", () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`).join(",");
    const result = parseTagFilter(tags);
    expect(result).toHaveLength(20);
  });

  it("handles a single tag", () => {
    expect(parseTagFilter("repo:tila")).toEqual(["repo:tila"]);
  });
});

describe("tagFilterQueryParam", () => {
  it("parses a valid comma-separated tag_filter string", () => {
    const schema = tagFilterQueryParam;
    const result = schema.parse("repo:tila,team:platform");
    expect(result).toEqual(["repo:tila", "team:platform"]);
  });

  it("returns undefined for undefined", () => {
    const schema = tagFilterQueryParam;
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const schema = tagFilterQueryParam;
    expect(schema.parse("")).toBeUndefined();
  });

  it("throws for invalid tag grammar", () => {
    const schema = tagFilterQueryParam;
    expect(() => schema.parse("bad tag!")).toThrow(ZodError);
  });
});
