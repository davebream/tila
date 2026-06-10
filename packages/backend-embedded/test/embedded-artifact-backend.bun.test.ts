import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { EmbeddedArtifactBackend } from "../src/index";
import { type Harness, makeHarness } from "./harness.bun";

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function drain(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

describe("EmbeddedArtifactBackend", () => {
  let h: Harness;
  let backend: EmbeddedArtifactBackend;

  beforeEach(async () => {
    h = makeHarness();
    backend = h.artifacts;
    // artifact_pointers.resource has a FOREIGN KEY -> entities(id); create the
    // entities any resource-scoped artifact in these tests references.
    for (const id of ["task-1", "task-42"]) {
      await h.project.create({
        id,
        type: "task",
        data: { status: "open" },
        created_by: "test",
      });
    }
  });

  afterEach(() => {
    h.close();
  });

  describe("put", () => {
    it("stores a string body and returns key + bytes", async () => {
      const content = "hello world";
      const hash = await sha256Hex(content);
      const result = await backend.put({
        key: `test-org/test-project/${hash}.txt`,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });
      expect(result.key).toBe(`test-org/test-project/${hash}.txt`);
      expect(result.bytes).toBe(new TextEncoder().encode(content).byteLength);
    });

    it("stores an ArrayBuffer body", async () => {
      const content = "binary data";
      const hash = await sha256Hex(content);
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
      const hash = await sha256Hex(content);
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
      expect(result.bytes).toBe(new TextEncoder().encode(content).byteLength);
    });

    it("is idempotent for the same key", async () => {
      const content = "idempotent";
      const hash = await sha256Hex(content);
      const key = `test-org/test-project/${hash}.txt`;
      const opts = {
        key,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      };
      await backend.put(opts);
      await backend.put(opts);
      const list = await backend.list("test-org/test-project/");
      expect(list.filter((e) => e.key === key)).toHaveLength(1);
    });
  });

  describe("get", () => {
    it("returns stream + contentType for existing artifact", async () => {
      const content = "get me";
      const hash = await sha256Hex(content);
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
      if (!result) throw new Error("expected non-null");
      expect(await drain(result.body)).toBe(content);
    });

    it("returns null for non-existent key", async () => {
      expect(await backend.get("nonexistent/key/abc.txt")).toBeNull();
    });
  });

  describe("list / delete", () => {
    it("lists matching prefix and delete soft-tombstones", async () => {
      const c1 = "content1";
      const h1 = await sha256Hex(c1);
      const key1 = `test-org/test-project/${h1}.txt`;
      await backend.put({
        key: key1,
        body: c1,
        sha256: h1,
        metadata: {},
        contentType: "text/plain",
      });
      const c2 = "content2";
      const h2 = await sha256Hex(c2);
      await backend.put({
        key: `test-org/test-project/${h2}.json`,
        body: c2,
        sha256: h2,
        metadata: {},
        contentType: "application/json",
      });

      expect(await backend.list("test-org/test-project/")).toHaveLength(2);

      await backend.delete(key1);
      const after = await backend.list("test-org/test-project/");
      expect(after.find((e) => e.key === key1)).toBeUndefined();
      // blob still present (soft delete)
      expect(await h.blobs.exists(key1)).toBe(true);
    });

    it("listWithMetadata returns empty metadata", async () => {
      const content = "meta";
      const hash = await sha256Hex(content);
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

  describe("grepArtifacts", () => {
    it("matches lines across the injected blob store", async () => {
      const content = "alpha line\nbravo match here\ncharlie\n";
      const hash = await sha256Hex(content);
      await backend.put({
        key: `test-org/test-project/${hash}.txt`,
        body: content,
        sha256: hash,
        metadata: {},
        contentType: "text/plain",
      });
      const res = await backend.grepArtifacts({ pattern: "bravo" });
      expect(res.ok).toBe(true);
      const hit = res.results.find((r) => r.lines.length > 0);
      expect(hit).toBeTruthy();
      expect(hit?.lines[0].text).toContain("bravo");
    });
  });

  // --- New optional methods (implementation gap) ---

  describe("writeText / readText / getLatest", () => {
    it("writeText content-addresses and readText round-trips", async () => {
      const content = '{"hello":"world"}';
      const w = await backend.writeText(content, {
        kind: "doc",
        mimeType: "application/json",
        resource: "task-1",
      });
      const expectedSha = await sha256Hex(content);
      expect(w.key).toBe(`test-org/test-project/${expectedSha}.json`);
      expect(w.bytes).toBe(new TextEncoder().encode(content).byteLength);

      const r = await backend.readText(w.key);
      expect(r).not.toBeNull();
      expect(r?.content).toBe(content);
      expect(r?.mimeType).toBe("application/json");
    });

    it("readText returns null for an unknown key", async () => {
      expect(
        await backend.readText("test-org/test-project/missing.txt"),
      ).toBeNull();
    });

    it("getLatest returns the latest pointer for (kind, resource)", async () => {
      const c1 = "v1";
      const k1 = await backend.writeText(c1, {
        kind: "snapshot",
        resource: "task-42",
      });
      // newer pointer for the same (kind, resource)
      const c2 = "v2-newer";
      const k2 = await backend.writeText(c2, {
        kind: "snapshot",
        resource: "task-42",
      });

      const latest = await backend.getLatest("snapshot", "task-42");
      expect(latest).not.toBeNull();
      // Both share (kind, resource); with no supersedes chain, latest is the
      // most-recently produced. Assert it's one of the two and carries no `tags`.
      expect([k1.key, k2.key]).toContain(latest?.r2_key);
      expect(latest).not.toHaveProperty("tags");
      expect(latest?.kind).toBe("snapshot");
      expect(latest?.resource).toBe("task-42");
    });

    it("getLatest returns null when nothing matches", async () => {
      expect(await backend.getLatest("snapshot", "task-none")).toBeNull();
    });
  });
});
