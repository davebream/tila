import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalArtifactBackend } from "../../src/local-artifact-backend";
import { LocalProject } from "../../src/local-project";

describe("artifact-lifecycle: put/get/list/delete round-trip", () => {
  let tempDir: string;
  let project: LocalProject;
  let backend: LocalArtifactBackend;
  let artifactsRoot: string;

  function sha256(data: string): string {
    return createHash("sha256").update(data).digest("hex");
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-artifact-"));
    const dbPath = join(tempDir, "artifact.db");
    artifactsRoot = join(tempDir, "artifacts");

    project = LocalProject.open(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
    backend = new LocalArtifactBackend(
      project.getDb(),
      artifactsRoot,
      "test-org",
      "test-project",
    );
  });

  afterEach(() => {
    project.close();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it(
    "full lifecycle: put -> get -> list -> delete -> verify tombstoned",
    async () => {
      const content = "hello world";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;

      // 1. PUT
      const putResult = await backend.put({
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });
      expect(putResult.key).toBe(key);
      expect(putResult.bytes).toBe(Buffer.from(content).byteLength);

      // 2. GET -- read back the content
      const getResult = await backend.get(key);
      expect(getResult).not.toBeNull();
      expect(getResult?.contentType).toBe("text/plain");
      expect(getResult?.metadata).toEqual({});

      // Read the stream
      const reader = getResult?.body.getReader();
      const chunks: Uint8Array[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
      const concatenated = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        concatenated.set(chunk, offset);
        offset += chunk.byteLength;
      }
      expect(new TextDecoder().decode(concatenated)).toBe(content);

      // 3. LIST -- verify the key is listed
      const listResult = await backend.list("test-org/test-project/");
      expect(listResult.some((item) => item.key === key)).toBe(true);

      // 4. DELETE -- soft tombstone
      await backend.delete(key);

      // 5. Verify tombstoned -- not in list, but file still on disk
      const listAfterDelete = await backend.list("test-org/test-project/");
      expect(listAfterDelete.some((item) => item.key === key)).toBe(false);

      // File should still exist on disk (soft delete, not physical)
      const blobPath = join(artifactsRoot, key);
      expect(existsSync(blobPath)).toBe(true);

      // GET should return null for tombstoned artifact
      const getAfterDelete = await backend.get(key);
      expect(getAfterDelete).toBeNull();
    },
    { timeout: 15000 },
  );

  it(
    "put with ArrayBuffer body",
    async () => {
      const content = "binary data";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.bin`;
      const buf = new TextEncoder().encode(content).buffer;

      const result = await backend.put({
        key,
        body: buf as ArrayBuffer,
        sha256: hash,
        metadata: {},
        contentType: "application/octet-stream",
      });
      expect(result.bytes).toBe(buf.byteLength);

      // Verify the file on disk
      expect(existsSync(join(artifactsRoot, key))).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    "put with ReadableStream body",
    async () => {
      const content = "stream content for artifact";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content));
          controller.close();
        },
      });

      const result = await backend.put({
        key,
        body: stream,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });
      expect(result.bytes).toBe(Buffer.from(content).byteLength);

      // Verify roundtrip
      const getResult = await backend.get(key);
      expect(getResult).not.toBeNull();
    },
    { timeout: 15000 },
  );

  it(
    "listWithMetadata returns items with empty metadata",
    async () => {
      const content = "metadata test content";
      const hash = sha256(content);
      const key = `test-org/test-project/${hash}.txt`;

      await backend.put({
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });

      const list = await backend.listWithMetadata("test-org/test-project/");
      expect(list).toHaveLength(1);
      expect(list[0].metadata).toEqual({});
      expect(list[0].key).toBe(key);
      expect(list[0].size).toBeGreaterThan(0);
    },
    { timeout: 15000 },
  );
});
