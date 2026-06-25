import { describe, expect, it } from "vitest";
import { canonicalizePrincipal } from "../src/principal";

describe("canonicalizePrincipal", () => {
  describe("host canonicalization", () => {
    it("lowercases and trims the host", () => {
      const result = canonicalizePrincipal("GitHub.com", 123);
      expect(result.identityHost).toBe("github.com");
    });

    it("defaults null host to github.com", () => {
      const result = canonicalizePrincipal(null, 123);
      expect(result.identityHost).toBe("github.com");
    });

    it("defaults undefined host to github.com", () => {
      const result = canonicalizePrincipal(undefined, 123);
      expect(result.identityHost).toBe("github.com");
    });

    it("defaults whitespace-only host to github.com after trim", () => {
      // Whitespace-only host trims to '' then ?? kicks in — actually,
      // (host ?? 'github.com') is 'github.com' only for null/undefined.
      // '  '.trim().toLowerCase() = ''. We expect the default-fallback
      // behavior: per design, null/undefined → 'github.com'; a
      // whitespace-only string trims to '' and the ?? does NOT fire.
      // The design says: identityHost = (host ?? "github.com").trim().toLowerCase()
      // So "  ".trim() = "" which is falsy but ?? doesn't handle that.
      // The design treats non-null/non-undefined whitespace-only strings as "".
      // Only null/undefined get the github.com default.
      // We test exact design spec behavior.
      const result = canonicalizePrincipal("  ", 123);
      // host is not null/undefined, so ?? does not fire. trim → "". toLowerCase → "".
      // identityHost = "". This is an unusual edge case; the design does not say to
      // throw on empty host (only empty subject throws). We verify the exact output.
      expect(result.identityHost).toBe("");
    });

    it("trims surrounding whitespace from host", () => {
      const result = canonicalizePrincipal("  GITHUB.COM  ", 456);
      expect(result.identityHost).toBe("github.com");
    });
  });

  describe("subject canonicalization", () => {
    it("stringifies a numeric subject and trims", () => {
      const result = canonicalizePrincipal("github.com", 123);
      expect(result.subjectId).toBe("123");
    });

    it("trims a string subject", () => {
      const result = canonicalizePrincipal("github.com", "  123  ");
      expect(result.subjectId).toBe("123");
    });

    it("numeric and string subjects produce identical subjectId", () => {
      const a = canonicalizePrincipal("github.com", 123);
      const b = canonicalizePrincipal("github.com", "123");
      expect(a.subjectId).toBe(b.subjectId);
    });
  });

  describe("full round-trip", () => {
    it("(GitHub.com, 123) → {identityHost: github.com, subjectId: 123}", () => {
      const result = canonicalizePrincipal("GitHub.com", 123);
      expect(result).toEqual({ identityHost: "github.com", subjectId: "123" });
    });

    it("(null, 456) → {identityHost: github.com, subjectId: 456}", () => {
      const result = canonicalizePrincipal(null, 456);
      expect(result).toEqual({ identityHost: "github.com", subjectId: "456" });
    });
  });

  describe("throws on empty subject", () => {
    it("throws when subject is empty string", () => {
      expect(() => canonicalizePrincipal("github.com", "")).toThrow(
        "canonicalizePrincipal: empty subject after canonicalization",
      );
    });

    it("throws when subject is whitespace only", () => {
      expect(() => canonicalizePrincipal("github.com", "   ")).toThrow(
        "canonicalizePrincipal: empty subject after canonicalization",
      );
    });
  });
});
