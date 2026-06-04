import { describe, expect, it } from "vitest";
import { compareSemver } from "../src/semver.js";

describe("compareSemver", () => {
  describe("equal versions", () => {
    it("returns 0 for identical versions", () => {
      expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    });

    it("returns 0 for 0.0.0", () => {
      expect(compareSemver("0.0.0", "0.0.0")).toBe(0);
    });
  });

  describe("major version comparison", () => {
    it("returns -1 when a major < b major", () => {
      expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    });

    it("returns 1 when a major > b major", () => {
      expect(compareSemver("3.0.0", "2.0.0")).toBe(1);
    });

    it("major difference dominates minor and patch", () => {
      expect(compareSemver("1.9.9", "2.0.0")).toBe(-1);
      expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    });
  });

  describe("minor version comparison", () => {
    it("returns -1 when a minor < b minor (same major)", () => {
      expect(compareSemver("1.1.0", "1.2.0")).toBe(-1);
    });

    it("returns 1 when a minor > b minor (same major)", () => {
      expect(compareSemver("1.3.0", "1.2.0")).toBe(1);
    });

    it("minor difference dominates patch", () => {
      expect(compareSemver("1.1.9", "1.2.0")).toBe(-1);
      expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
    });
  });

  describe("patch version comparison", () => {
    it("returns -1 when a patch < b patch (same major.minor)", () => {
      expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    });

    it("returns 1 when a patch > b patch (same major.minor)", () => {
      expect(compareSemver("1.2.5", "1.2.4")).toBe(1);
    });
  });

  describe("pre-release / build metadata stripping", () => {
    it("strips pre-release tag and compares numeric components", () => {
      expect(compareSemver("1.2.3-alpha.1", "1.2.3")).toBe(0);
    });

    it("strips build metadata", () => {
      expect(compareSemver("1.2.3+build.42", "1.2.3")).toBe(0);
    });

    it("strips both pre-release and build metadata", () => {
      expect(compareSemver("1.2.3-beta+build.1", "1.2.3")).toBe(0);
    });

    it("correctly orders versions that differ after stripping tags", () => {
      expect(compareSemver("1.2.3-alpha", "1.2.4-alpha")).toBe(-1);
    });
  });

  describe("malformed and empty strings", () => {
    it("treats empty string as 0.0.0", () => {
      expect(compareSemver("", "")).toBe(0);
      expect(compareSemver("", "0.0.0")).toBe(0);
      expect(compareSemver("0.0.0", "")).toBe(0);
    });

    it("treats non-numeric segment as 0", () => {
      expect(compareSemver("abc.def.ghi", "0.0.0")).toBe(0);
    });

    it("treats partially malformed version gracefully", () => {
      // "1.x.3" — x is NaN → treated as 0
      expect(compareSemver("1.x.3", "1.0.3")).toBe(0);
    });

    it("treats missing patch as 0", () => {
      expect(compareSemver("1.2", "1.2.0")).toBe(0);
    });

    it("treats missing minor and patch as 0.0", () => {
      expect(compareSemver("1", "1.0.0")).toBe(0);
    });
  });

  describe("extra segments", () => {
    it("ignores segments beyond patch", () => {
      expect(compareSemver("1.2.3.4.5", "1.2.3")).toBe(0);
    });

    it("still compares major/minor/patch correctly with extra segments", () => {
      expect(compareSemver("1.2.3.99", "1.2.4.0")).toBe(-1);
    });
  });
});
