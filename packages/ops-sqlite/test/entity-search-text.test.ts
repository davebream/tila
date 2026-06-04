import { describe, expect, it } from "vitest";
import { entitySearchText } from "../src/entity-search-text";

describe("entitySearchText", () => {
  it("returns data.title when it is a string", () => {
    expect(entitySearchText({ title: "Auth System" })).toBe("Auth System");
  });

  it("falls back to data.name when title is missing", () => {
    expect(entitySearchText({ name: "Deploy pipeline" })).toBe(
      "Deploy pipeline",
    );
  });

  it("prefers data.title over data.name when both present", () => {
    expect(entitySearchText({ title: "Payments", name: "Legacy" })).toBe(
      "Payments",
    );
  });

  it("falls back to data.name when title is a non-string (issue #412)", () => {
    expect(entitySearchText({ title: 42, name: "Fallback" })).toBe("Fallback");
  });

  it("returns null when neither field is a string", () => {
    expect(entitySearchText({})).toBeNull();
  });

  it("returns null when both are non-strings", () => {
    expect(entitySearchText({ title: null, name: 99 })).toBeNull();
  });
});
