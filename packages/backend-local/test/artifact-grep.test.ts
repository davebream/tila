import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactOps } from "@tila/ops-sqlite";
import type { ArtifactGrepResponse } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalConnection } from "../src/connection";
import { LocalArtifactBackend } from "../src/local-artifact-backend";

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("LocalArtifactBackend.grepArtifacts", () => {
  let tempDir: string;
  let artifactsRoot: string;
  // biome-ignore lint/suspicious/noExplicitAny: test-only
  let db: any;
  let backend: LocalArtifactBackend;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-grep-test-"));
    const dbPath = join(tempDir, "test.db");
    artifactsRoot = join(tempDir, "artifacts");

    db = createLocalConnection(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
    backend = new LocalArtifactBackend(
      db,
      artifactsRoot,
      "test-org",
      "test-project",
    );
  });

  afterEach(() => {
    db.$client.close();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("grepArtifacts is defined on the backend", () => {
    expect(typeof backend.grepArtifacts).toBe("function");
  });

  describe("inline artifact — zero blob-store reads", () => {
    it("matches pattern in inline content without reading from disk", async () => {
      const key = "test-org/test-project/inline-artifact.txt";
      const inlineContent = "line one\nline two has MATCH here\nline three";

      // Insert the artifact pointer with content_inline set directly
      artifactOps.upsertPointer(
        db,
        {
          r2_key: key,
          resource: null,
          kind: "text",
          sha256: sha256(inlineContent),
          bytes: inlineContent.length,
          fence: null,
          mime_type: "text/plain",
          produced_at: Date.now(),
          produced_by: "test",
          expires_at: null,
          content_inline: inlineContent,
        },
        { actor: "test" },
      );

      // Spy on Bun.file to track blob disk reads
      const bunFileSpy = vi.spyOn(Bun, "file");

      const result = await backend.grepArtifacts({ pattern: "MATCH" });

      // Verify the spy was NOT called (inline path — 0 blob-store reads)
      const grepRelatedCalls = bunFileSpy.mock.calls.filter(([path]) =>
        String(path).includes(key),
      );
      expect(grepRelatedCalls).toHaveLength(0);

      bunFileSpy.mockRestore();

      // Verify results
      expect(result.ok).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].key).toBe(key);
      expect(result.results[0].lines).toHaveLength(1);
      expect(result.results[0].lines[0].line).toBe(2);
      expect(result.results[0].lines[0].text).toContain("MATCH");
      expect(result.results[0].lines[0].col).toBeGreaterThan(0);
      expect(result.scanned).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.truncated).toBe(false);
    });
  });

  describe("local blob artifact — reads from disk", () => {
    it("matches pattern in local blob content and calls disk read", async () => {
      const content = "first line\nsecond line with target_string\nthird line";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;

      // Put normally (no content_inline — local backend always stores null for content_inline)
      await backend.put({
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });

      const bunFileSpy = vi.spyOn(Bun, "file");

      const result = await backend.grepArtifacts({ pattern: "target_string" });

      // Verify the spy WAS called for this blob
      const grepRelatedCalls = bunFileSpy.mock.calls.filter(([path]) =>
        String(path).includes(hash),
      );
      expect(grepRelatedCalls.length).toBeGreaterThan(0);

      bunFileSpy.mockRestore();

      expect(result.ok).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].key).toBe(key);
      expect(result.results[0].lines).toHaveLength(1);
      expect(result.results[0].lines[0].line).toBe(2);
      expect(result.results[0].lines[0].text).toContain("target_string");
      expect(result.scanned).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it("returns skipped=1 when blob file is missing", async () => {
      const key = "test-org/test-project/ghost-artifact.txt";
      const ghostContent = "ghost content";

      // Insert pointer WITHOUT writing blob to disk
      artifactOps.upsertPointer(
        db,
        {
          r2_key: key,
          resource: null,
          kind: "text",
          sha256: sha256(ghostContent),
          bytes: ghostContent.length,
          fence: null,
          mime_type: "text/plain",
          produced_at: Date.now(),
          produced_by: "test",
          expires_at: null,
          content_inline: null, // no inline, and no blob on disk
        },
        { actor: "test" },
      );

      const result = await backend.grepArtifacts({ pattern: "ghost" });

      expect(result.ok).toBe(true);
      expect(result.results).toHaveLength(0);
      expect(result.scanned).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe("literal vs regex matching", () => {
    it("literal pattern matches exact substring", async () => {
      const content = "the abc is here\nno match here";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;

      await backend.put({
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });

      // literal "a.c" should NOT match "abc" (not a regex)
      const literalResult = await backend.grepArtifacts({
        pattern: "a.c",
        regex: false,
      });
      expect(literalResult.results).toHaveLength(0);

      // literal "abc" should match
      const exactResult = await backend.grepArtifacts({
        pattern: "abc",
        regex: false,
      });
      expect(exactResult.results).toHaveLength(1);
      expect(exactResult.results[0].lines).toHaveLength(1);
    });

    it("regex pattern matches with regex engine", async () => {
      // Use content where "a.c" as regex matches but "a.c" literal does not
      // "xyzabc" contains "abc" which matches the regex "a.c" (a, any char, c)
      const content = "xyzabc_line\nno_hit_here";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;

      await backend.put({
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });

      // regex "a.c" should match "abc" on line 1
      const regexResult = await backend.grepArtifacts({
        pattern: "a.c",
        regex: true,
      });
      expect(regexResult.results).toHaveLength(1);
      expect(regexResult.results[0].lines).toHaveLength(1);
      expect(regexResult.results[0].lines[0].line).toBe(1);

      // literal "a.c" should NOT match — no literal "a.c" substring
      const literalResult = await backend.grepArtifacts({
        pattern: "a.c",
        regex: false,
      });
      expect(literalResult.results).toHaveLength(0);
    });
  });

  describe("response shape conforms to ArtifactGrepResponse", () => {
    it("returns proper shape with ok, results, scanned, skipped, truncated", async () => {
      const content = "hello world";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;

      await backend.put({
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });

      const result: ArtifactGrepResponse = await backend.grepArtifacts({
        pattern: "hello",
      });

      // ArtifactGrepResponse shape
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.results)).toBe(true);
      expect(typeof result.scanned).toBe("number");
      expect(typeof result.skipped).toBe("number");
      expect(typeof result.truncated).toBe("boolean");

      // Must have at least one result for "hello" in "hello world"
      expect(result.results.length).toBeGreaterThan(0);

      const firstResult = result.results[0];
      const firstLines = firstResult?.lines;

      // result entries
      expect(firstResult.key).toEqual(expect.any(String));
      expect(firstResult.kind).toEqual(expect.any(String));
      expect(Array.isArray(firstLines)).toBe(true);

      // Must have at least one matching line
      expect(firstLines.length).toBeGreaterThan(0);
      const firstLine = firstLines[0];
      expect(firstLine.line).toEqual(expect.any(Number));
      expect(firstLine.text).toEqual(expect.any(String));
      expect(firstLine.col).toEqual(expect.any(Number));
    });

    it("scanned + skipped <= candidates found", async () => {
      const content1 = "artifact one content";
      const hash1 = sha256(content1);
      await backend.put({
        key: `test-org/test-project/${hash1}.txt`,
        body: content1,
        sha256: hash1,
        metadata: {},
        contentType: "text/plain",
      });

      // ghost artifact — pointer with no blob
      artifactOps.upsertPointer(
        db,
        {
          r2_key: "test-org/test-project/ghost2.txt",
          resource: null,
          kind: "text",
          sha256: "0".repeat(64),
          bytes: 10,
          fence: null,
          mime_type: "text/plain",
          produced_at: Date.now(),
          produced_by: "test",
          expires_at: null,
          content_inline: null,
        },
        { actor: "test" },
      );

      const result = await backend.grepArtifacts({ pattern: "artifact" });
      expect(result.scanned + result.skipped).toBeLessThanOrEqual(2);
    });
  });

  describe("filtering by kind and resource", () => {
    it("filters candidates by kind", async () => {
      const jsonContent = '{"key": "value", "match": true}';
      const jsonHash = sha256(jsonContent);
      await backend.put({
        key: `test-org/test-project/${jsonHash}.json`,
        body: jsonContent,
        sha256: jsonHash,
        metadata: {},
        contentType: "application/json",
      });

      const txtContent = "match this text";
      const txtHash = sha256(txtContent);
      await backend.put({
        key: `test-org/test-project/${txtHash}.txt`,
        body: txtContent,
        sha256: txtHash,
        metadata: {},
        contentType: "text/plain",
      });

      // Search only text kind
      const result = await backend.grepArtifacts({
        pattern: "match",
        kind: "text",
      });

      // Only the text artifact should appear
      for (const r of result.results) {
        expect(r.kind).toBe("text");
      }
    });
  });
});
