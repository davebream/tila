import { describe, expect, it } from "vitest";
import {
  MAX_BYTES_FOR_NORMALIZATION,
  normalizeArtifactText,
} from "./normalize-text";

/** Helper: convert a string to ArrayBuffer */
function toBuffer(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer as ArrayBuffer;
}

describe("normalizeArtifactText", () => {
  describe("text/markdown", () => {
    it("extracts title from # Heading and strips markdown from body", () => {
      const md = "# My Document\n\nSome **bold** text and *italic* words.\n";
      const result = normalizeArtifactText(toBuffer(md), "text/markdown");
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.title).toBe("My Document");
      expect(result.body_text).toContain("Some bold text and italic words.");
      expect(result.body_text).not.toContain("**");
      expect(result.body_text).not.toContain("*italic*");
    });

    it("extracts title from YAML frontmatter", () => {
      const md =
        "---\ntitle: Frontmatter Title\nauthor: Test\n---\n\n# Heading After\n\nBody text here.\n";
      const result = normalizeArtifactText(toBuffer(md), "text/markdown");
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.title).toBe("Frontmatter Title");
    });

    it("prefers frontmatter title over heading when both present", () => {
      const md = "---\ntitle: FM Title\n---\n\n# Heading Title\n\nBody.\n";
      const result = normalizeArtifactText(toBuffer(md), "text/markdown");
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.title).toBe("FM Title");
    });

    it("returns null title when no heading and no frontmatter", () => {
      const md = "Just plain text without any heading.\n\nAnother paragraph.\n";
      const result = normalizeArtifactText(toBuffer(md), "text/markdown");
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.title).toBeNull();
      expect(result.body_text).toContain("Just plain text");
    });

    it("strips fenced code blocks from body_text", () => {
      const md =
        "# Doc\n\nBefore code.\n\n```typescript\nconst x = 1;\n```\n\nAfter code.\n";
      const result = normalizeArtifactText(toBuffer(md), "text/markdown");
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.body_text).toContain("Before code.");
      expect(result.body_text).toContain("After code.");
      expect(result.body_text).not.toContain("const x = 1");
    });

    it("preserves link text and strips URLs", () => {
      const md =
        "# Links\n\nCheck [this link](https://example.com) for details.\n";
      const result = normalizeArtifactText(toBuffer(md), "text/markdown");
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.body_text).toContain("this link");
      expect(result.body_text).not.toContain("https://example.com");
    });
  });

  describe("text/plain", () => {
    it("returns full text as body and first line as title", () => {
      const text = "First Line Title\n\nSecond paragraph.\nThird line.\n";
      const result = normalizeArtifactText(toBuffer(text), "text/plain");
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.title).toBe("First Line Title");
      expect(result.body_text).toBe(
        "First Line Title\n\nSecond paragraph.\nThird line.",
      );
    });

    it("returns null title and empty body for empty input", () => {
      const result = normalizeArtifactText(toBuffer(""), "text/plain");
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(result.title).toBeNull();
      expect(result.body_text).toBe("");
    });
  });

  describe("unsupported MIME types", () => {
    it("returns null for application/pdf", () => {
      const result = normalizeArtifactText(
        toBuffer("fake pdf"),
        "application/pdf",
      );
      expect(result).toBeNull();
    });

    it("returns null for application/octet-stream", () => {
      const result = normalizeArtifactText(
        toBuffer("binary"),
        "application/octet-stream",
      );
      expect(result).toBeNull();
    });
  });

  describe("size cap", () => {
    it("processes artifact exactly at MAX_BYTES_FOR_NORMALIZATION", () => {
      const text = "a".repeat(MAX_BYTES_FOR_NORMALIZATION);
      const result = normalizeArtifactText(toBuffer(text), "text/plain");
      expect(result).not.toBeNull();
    });

    it("returns null for artifact one byte over MAX_BYTES_FOR_NORMALIZATION", () => {
      const text = "a".repeat(MAX_BYTES_FOR_NORMALIZATION + 1);
      const result = normalizeArtifactText(toBuffer(text), "text/plain");
      expect(result).toBeNull();
    });
  });
});
