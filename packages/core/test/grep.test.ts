import { describe, expect, it } from "vitest";
import {
  GREP_MAX_LINE_TEXT,
  GREP_REGEX_LINE_INPUT_CAP,
  GrepQueryError,
  compileGrepMatcher,
  matchLine,
  splitChunkIntoLines,
  validateGrepPattern,
} from "../src/grep";

// ---------------------------------------------------------------------------
// validateGrepPattern
// ---------------------------------------------------------------------------

describe("validateGrepPattern", () => {
  describe("length cap", () => {
    it("accepts a pattern of exactly 200 chars", () => {
      expect(() =>
        validateGrepPattern("a".repeat(200), { regex: false }),
      ).not.toThrow();
    });

    it("rejects a pattern of 201 chars", () => {
      expect(() =>
        validateGrepPattern("a".repeat(201), { regex: false }),
      ).toThrow(GrepQueryError);
    });

    it("throws GrepQueryError with name 'GrepQueryError'", () => {
      try {
        validateGrepPattern("a".repeat(201), { regex: false });
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(GrepQueryError);
        expect((e as GrepQueryError).name).toBe("GrepQueryError");
      }
    });
  });

  describe("literal mode skips grammar checks", () => {
    it("accepts a backreference pattern in literal mode", () => {
      expect(() =>
        validateGrepPattern("(a)\\1", { regex: false }),
      ).not.toThrow();
    });

    it("accepts a lookahead pattern in literal mode", () => {
      expect(() =>
        validateGrepPattern("(?=foo)", { regex: false }),
      ).not.toThrow();
    });

    it("accepts nested quantifier pattern in literal mode", () => {
      expect(() =>
        validateGrepPattern("(a+)+", { regex: false }),
      ).not.toThrow();
    });
  });

  describe("regex mode — backreferences rejected", () => {
    it("rejects \\1 backreference", () => {
      expect(() => validateGrepPattern("(a)\\1", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("rejects \\9 backreference", () => {
      expect(() => validateGrepPattern("(a)\\9", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("accepts \\0 (not a backreference)", () => {
      expect(() => validateGrepPattern("\\0", { regex: true })).not.toThrow();
    });
  });

  describe("regex mode — lookaround rejected", () => {
    it("rejects lookahead (?=", () => {
      expect(() => validateGrepPattern("foo(?=bar)", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("rejects negative lookahead (?!", () => {
      expect(() => validateGrepPattern("foo(?!bar)", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("rejects lookbehind (?<=", () => {
      expect(() => validateGrepPattern("(?<=foo)bar", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("rejects negative lookbehind (?<!", () => {
      expect(() => validateGrepPattern("(?<!foo)bar", { regex: true })).toThrow(
        GrepQueryError,
      );
    });
  });

  describe("regex mode — nested unbounded quantifiers rejected", () => {
    it("rejects (a+)+", () => {
      expect(() => validateGrepPattern("(a+)+", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("rejects (a*)* ", () => {
      expect(() => validateGrepPattern("(a*)*", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("rejects (.+)+", () => {
      expect(() => validateGrepPattern("(.+)+", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("rejects (a+){2,}", () => {
      expect(() => validateGrepPattern("(a+){2,}", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("accepts (a+){2} — bounded outer quantifier", () => {
      expect(() =>
        validateGrepPattern("(a+){2}", { regex: true }),
      ).not.toThrow();
    });

    it("accepts (ab)+ — group without inner quantifier", () => {
      expect(() => validateGrepPattern("(ab)+", { regex: true })).not.toThrow();
    });
  });

  describe("regex mode — ambiguous alternation rejected", () => {
    it("rejects (a|aa)+", () => {
      expect(() => validateGrepPattern("(a|aa)+", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("rejects identical alternatives in an unbounded group", () => {
      expect(() => validateGrepPattern("(foo|foo)+", { regex: true })).toThrow(
        GrepQueryError,
      );
    });

    it("accepts disjoint alternatives in an unbounded group", () => {
      expect(() =>
        validateGrepPattern("(foo|bar)+", { regex: true }),
      ).not.toThrow();
    });
  });

  describe("regex mode — safe patterns accepted", () => {
    it("accepts simple literal-like regex", () => {
      expect(() =>
        validateGrepPattern("hello world", { regex: true }),
      ).not.toThrow();
    });

    it("accepts anchored regex", () => {
      expect(() =>
        validateGrepPattern("^foo.*bar$", { regex: true }),
      ).not.toThrow();
    });

    it("accepts character class with quantifier", () => {
      expect(() =>
        validateGrepPattern("[a-z]+", { regex: true }),
      ).not.toThrow();
    });
  });

  describe("error messages sanitized", () => {
    it("error message contains no platform internals", () => {
      try {
        validateGrepPattern("a".repeat(201), { regex: false });
        expect.fail("should have thrown");
      } catch (e) {
        const msg = (e as Error).message.toLowerCase();
        for (const word of [
          "r2",
          "durable object",
          "sqlite",
          "isolate",
          "worker",
        ]) {
          expect(msg).not.toContain(word);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// compileGrepMatcher
// ---------------------------------------------------------------------------

describe("compileGrepMatcher", () => {
  describe("literal mode", () => {
    it("returns 1-based col for a match at index 0", () => {
      const m = compileGrepMatcher("hello", { regex: false });
      expect(m.test("hello world")).toBe(1);
    });

    it("returns 1-based col for a match in the middle", () => {
      const m = compileGrepMatcher("world", { regex: false });
      expect(m.test("hello world")).toBe(7);
    });

    it("returns null for no match", () => {
      const m = compileGrepMatcher("xyz", { regex: false });
      expect(m.test("hello world")).toBeNull();
    });

    it("is case-sensitive", () => {
      const m = compileGrepMatcher("Hello", { regex: false });
      expect(m.test("hello world")).toBeNull();
    });

    it("does NOT treat . as a wildcard (literal dot)", () => {
      const m = compileGrepMatcher("a.c", { regex: false });
      expect(m.test("abc")).toBeNull();
      expect(m.test("a.c")).toBe(1);
    });
  });

  describe("regex mode", () => {
    it("returns 1-based col for a regex match at start", () => {
      const m = compileGrepMatcher("^foo", { regex: true });
      expect(m.test("foobar")).toBe(1);
    });

    it("returns 1-based col when match is not at start", () => {
      const m = compileGrepMatcher("\\d+", { regex: true });
      expect(m.test("abc123def")).toBe(4);
    });

    it("returns null for no regex match", () => {
      const m = compileGrepMatcher("\\d+", { regex: true });
      expect(m.test("abcdef")).toBeNull();
    });

    it("compiled regex has no global flag", () => {
      // If the regex had the g flag, repeated calls on the same line would
      // advance lastIndex and could fail incorrectly on a second call.
      const m = compileGrepMatcher("a", { regex: true });
      expect(m.test("abc")).toBe(1);
      expect(m.test("abc")).toBe(1); // must be consistent on repeated calls
    });
  });
});

// ---------------------------------------------------------------------------
// matchLine
// ---------------------------------------------------------------------------

describe("matchLine", () => {
  it("returns null when there is no match", () => {
    const m = compileGrepMatcher("xyz", { regex: false });
    expect(matchLine(m, "hello world", 1)).toBeNull();
  });

  it("returns { line, text, col } on a match", () => {
    const m = compileGrepMatcher("world", { regex: false });
    const result = matchLine(m, "hello world", 3);
    expect(result).toEqual({ line: 3, text: "hello world", col: 7 });
  });

  it("col is 1-based UTF-16 index", () => {
    const m = compileGrepMatcher("B", { regex: false });
    // 'A' = 1 char, so 'B' starts at index 1, col should be 2
    const result = matchLine(m, "AB", 1);
    expect(result?.col).toBe(2);
  });

  it("text is truncated to GREP_MAX_LINE_TEXT (512) UTF-16 code units", () => {
    const longLine = "a".repeat(600);
    const m = compileGrepMatcher("a", { regex: false });
    const result = matchLine(m, longLine, 1);
    expect(result).not.toBeNull();
    expect(result?.text.length).toBe(GREP_MAX_LINE_TEXT);
  });

  it("does not truncate text shorter than 512 chars", () => {
    const shortLine = "hello world";
    const m = compileGrepMatcher("hello", { regex: false });
    const result = matchLine(m, shortLine, 1);
    expect(result?.text).toBe(shortLine);
  });

  it("regex input is capped at GREP_REGEX_LINE_INPUT_CAP (4096) chars", () => {
    // Build a line longer than 4096 chars where the pattern only exists past cap
    const longLine = `${"x".repeat(4100)}TARGET`;
    const m = compileGrepMatcher("TARGET", { regex: true });
    // The pattern is beyond 4096 chars so it should not be found
    expect(matchLine(m, longLine, 1)).toBeNull();
  });

  it("regex input cap does not affect matches within the cap", () => {
    const line = `${"x".repeat(100)}TARGET${"x".repeat(4000)}`;
    const m = compileGrepMatcher("TARGET", { regex: true });
    const result = matchLine(m, line, 1);
    expect(result).not.toBeNull();
    expect(result?.col).toBe(101); // 100 x's then TARGET at index 100 → col 101
  });

  it("returns line number passed in", () => {
    const m = compileGrepMatcher("x", { regex: false });
    const result = matchLine(m, "x", 42);
    expect(result?.line).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// splitChunkIntoLines
// ---------------------------------------------------------------------------

describe("splitChunkIntoLines", () => {
  it("splits a simple chunk with newlines", () => {
    const result = splitChunkIntoLines("", "line1\nline2\nline3\n");
    expect(result.lines).toEqual(["line1", "line2", "line3"]);
    expect(result.pending).toBe("");
  });

  it("carries a partial line into pending", () => {
    const result = splitChunkIntoLines("", "line1\npartial");
    expect(result.lines).toEqual(["line1"]);
    expect(result.pending).toBe("partial");
  });

  it("prepends pending from previous chunk to new chunk", () => {
    const first = splitChunkIntoLines("", "line1\npartia");
    expect(first.lines).toEqual(["line1"]);
    expect(first.pending).toBe("partia");

    const second = splitChunkIntoLines(first.pending, "l\nline3\n");
    expect(second.lines).toEqual(["partial", "line3"]);
    expect(second.pending).toBe("");
  });

  it("strips trailing \\r from completed lines", () => {
    const result = splitChunkIntoLines("", "line1\r\nline2\r\n");
    expect(result.lines).toEqual(["line1", "line2"]);
  });

  it("does NOT strip \\r from pending (partial line not yet complete)", () => {
    const result = splitChunkIntoLines("", "line1\npartial\r");
    expect(result.lines).toEqual(["line1"]);
    // pending carries the raw partial; caller flushes at EOF
    expect(result.pending).toBe("partial\r");
  });

  it("handles empty chunk with non-empty pending", () => {
    const result = splitChunkIntoLines("pending", "");
    expect(result.lines).toEqual([]);
    expect(result.pending).toBe("pending");
  });

  it("handles chunk that is all one line (no newline)", () => {
    const result = splitChunkIntoLines("", "no newline here");
    expect(result.lines).toEqual([]);
    expect(result.pending).toBe("no newline here");
  });

  it("handles empty pending and empty chunk", () => {
    const result = splitChunkIntoLines("", "");
    expect(result.lines).toEqual([]);
    expect(result.pending).toBe("");
  });

  it("caller flushes non-empty pending at EOF as final line", () => {
    // Simulate the caller's responsibility: after all chunks, flush pending
    const { pending } = splitChunkIntoLines("", "last line without newline");
    expect(pending).toBe("last line without newline");
    // Caller would process 'pending' as the last line
  });
});
