import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalConnection } from "../src/connection";
import { LocalArtifactBackend } from "../src/local-artifact-backend";

describe("LocalArtifactBackend", () => {
  let tempDir: string;
  let artifactsRoot: string;
  // biome-ignore lint/suspicious/noExplicitAny: test-only -- createLocalConnection returns typed DB for @tila/ops-sqlite schema
  let db: any;
  let backend: LocalArtifactBackend;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-art-test-"));
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

  function sha256(data: string): string {
    return createHash("sha256").update(data).digest("hex");
  }

  describe("put", () => {
    it("stores a string body and returns key + bytes", async () => {
      const content = "hello world";
      const hash = sha256(content);
      const result = await backend.put({
        key: `test-org/test-project/${hash}.txt`,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });
      expect(result.key).toBe(`test-org/test-project/${hash}.txt`);
      expect(result.bytes).toBe(Buffer.from(content).byteLength);
    });

    it("stores an ArrayBuffer body", async () => {
      const content = "binary data";
      const hash = sha256(content);
      const buf = new TextEncoder().encode(content).buffer;
      const result = await backend.put({
        key: `test-org/test-project/${hash}.bin`,
        body: buf as ArrayBuffer,
        sha256: hash,
        metadata: {},
        contentType: "application/octet-stream",
      });
      expect(result.bytes).toBe(buf.byteLength);
    });

    it("stores a ReadableStream body", async () => {
      const content = "stream content";
      const hash = sha256(content);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content));
          controller.close();
        },
      });
      const result = await backend.put({
        key: `test-org/test-project/${hash}.txt`,
        body: stream,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });
      expect(result.bytes).toBe(Buffer.from(content).byteLength);
    });

    it("creates the blob file on disk", async () => {
      const content = "on disk";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;
      await backend.put({
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });
      const blobPath = join(artifactsRoot, key);
      expect(existsSync(blobPath)).toBe(true);
    });

    it("is idempotent for the same key", async () => {
      const content = "idempotent";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;
      const opts = {
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      };
      await backend.put(opts);
      await backend.put(opts); // Second put should not throw
      const list = await backend.list("test-org/test-project/");
      // Should have exactly one entry (not duplicated)
      const matching = list.filter((e) => e.key === key);
      expect(matching).toHaveLength(1);
    });
  });

  describe("get", () => {
    it("returns stream + contentType for existing artifact", async () => {
      const content = "get me";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;
      await backend.put({
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });

      const result = await backend.get(key);
      expect(result).not.toBeNull();
      expect(result?.contentType).toBe("text/plain");
      expect(result?.metadata).toEqual({});

      // Read and concatenate the stream
      if (!result) throw new Error("expected result to be non-null");
      const reader = result.body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
      const concatenated = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        concatenated.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(concatenated);
      expect(text).toBe(content);
    });

    it("returns null for non-existent key", async () => {
      const result = await backend.get("nonexistent/key/abc.txt");
      expect(result).toBeNull();
    });
  });

  describe("list", () => {
    it("returns artifacts matching prefix", async () => {
      const c1 = "content1";
      const h1 = sha256(c1);
      await backend.put({
        key: `test-org/test-project/${h1}.txt`,
        body: c1,
        sha256: h1,
        metadata: {},
        contentType: "text/plain",
      });

      const c2 = "content2";
      const h2 = sha256(c2);
      await backend.put({
        key: `test-org/test-project/${h2}.json`,
        body: c2,
        sha256: h2,
        metadata: {},
        contentType: "application/json",
      });

      const list = await backend.list("test-org/test-project/");
      expect(list).toHaveLength(2);
      expect(list.every((item) => item.key && item.size > 0)).toBe(true);
    });

    it("returns empty array for no matches", async () => {
      const list = await backend.list("nonexistent/prefix/");
      expect(list).toEqual([]);
    });
  });

  describe("delete", () => {
    it("soft-tombstones the artifact", async () => {
      const content = "delete me";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;
      await backend.put({
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });

      await backend.delete(key);

      // Should no longer appear in list
      const list = await backend.list("test-org/test-project/");
      expect(list.find((e) => e.key === key)).toBeUndefined();

      // But the file should still exist on disk (soft delete)
      const blobPath = join(artifactsRoot, key);
      expect(existsSync(blobPath)).toBe(true);
    });
  });

  describe("listWithMetadata", () => {
    it("returns items with empty metadata", async () => {
      const content = "meta test";
      const hash = sha256(content);
      await backend.put({
        key: `test-org/test-project/${hash}.txt`,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });

      const list = await backend.listWithMetadata?.("test-org/test-project/");
      expect(list).toHaveLength(1);
      expect(list?.[0].metadata).toEqual({});
    });
  });
});
