import { beforeEach, describe, expect, it, vi } from "vitest";
import { R2ArtifactBackend } from "./r2-artifact-backend";

function createMockBucket(overrides: Record<string, unknown> = {}): R2Bucket {
  return {
    put: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    head: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
    ...overrides,
  } as unknown as R2Bucket;
}

/** Build a stable list of N distinct keys */
function makeKeys(n: number, prefix = "produced/T-1/"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}key-${i}.bin`);
}

describe("R2ArtifactBackend", () => {
  describe("put()", () => {
    it("returns key and size on fresh write", async () => {
      const bucket = createMockBucket({
        put: vi.fn().mockResolvedValue({ size: 1024 }),
      });
      const backend = new R2ArtifactBackend(bucket);

      const result = await backend.put({
        key: "produced/T-1/abc123.md",
        body: new ArrayBuffer(1024),
        sha256: "abc123",
        metadata: { "tila-kind": "output" },
        contentType: "text/markdown",
      });

      expect(result).toEqual({ key: "produced/T-1/abc123.md", bytes: 1024 });
      expect(bucket.put).toHaveBeenCalledWith(
        "produced/T-1/abc123.md",
        expect.anything(),
        expect.objectContaining({
          httpMetadata: { contentType: "text/markdown" },
          customMetadata: { "tila-kind": "output" },
          sha256: "abc123",
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      );
    });

    it("returns bytes: 0 on dedup hit (R2 returns null)", async () => {
      const bucket = createMockBucket({
        put: vi.fn().mockResolvedValue(null),
      });
      const backend = new R2ArtifactBackend(bucket);

      const result = await backend.put({
        key: "sources/abc123.md",
        body: new ArrayBuffer(512),
        sha256: "abc123",
        metadata: {},
        contentType: "text/markdown",
      });

      expect(result).toEqual({ key: "sources/abc123.md", bytes: 0 });
    });
  });

  describe("get()", () => {
    it("returns contentType from httpMetadata", async () => {
      const mockBody = new ReadableStream();
      const bucket = createMockBucket({
        get: vi.fn().mockResolvedValue({
          body: mockBody,
          httpMetadata: { contentType: "text/markdown" },
          customMetadata: { "tila-kind": "output" },
        }),
      });
      const backend = new R2ArtifactBackend(bucket);

      const result = await backend.get("produced/T-1/abc123.md");

      expect(result).not.toBeNull();
      expect(result?.contentType).toBe("text/markdown");
      expect(result?.metadata).toEqual({ "tila-kind": "output" });
      expect(result?.body).toBe(mockBody);
    });

    it("defaults contentType to application/octet-stream when httpMetadata missing", async () => {
      const mockBody = new ReadableStream();
      const bucket = createMockBucket({
        get: vi.fn().mockResolvedValue({
          body: mockBody,
          httpMetadata: undefined,
          customMetadata: {},
        }),
      });
      const backend = new R2ArtifactBackend(bucket);

      const result = await backend.get("sources/abc123.bin");

      expect(result).not.toBeNull();
      expect(result?.contentType).toBe("application/octet-stream");
    });

    it("returns null when key not found", async () => {
      const bucket = createMockBucket({
        get: vi.fn().mockResolvedValue(null),
      });
      const backend = new R2ArtifactBackend(bucket);

      const result = await backend.get("nonexistent/key.bin");

      expect(result).toBeNull();
    });
  });

  describe("list()", () => {
    it("returns matching keys with size", async () => {
      const bucket = createMockBucket({
        list: vi.fn().mockResolvedValue({
          objects: [
            { key: "produced/T-1/aaa.md", size: 100 },
            { key: "produced/T-1/bbb.txt", size: 200 },
          ],
        }),
      });
      const backend = new R2ArtifactBackend(bucket);

      const result = await backend.list("produced/T-1/");

      expect(result).toEqual([
        { key: "produced/T-1/aaa.md", size: 100 },
        { key: "produced/T-1/bbb.txt", size: 200 },
      ]);
      expect(bucket.list).toHaveBeenCalledWith({ prefix: "produced/T-1/" });
    });
  });

  describe("listWithMetadata()", () => {
    it("returns keys with custom metadata from R2 listing", async () => {
      const mockObjects = [
        {
          key: "produced/task:T-1/abc.md",
          size: 100,
          customMetadata: { "tila-kind": "output", "tila-sha256": "abc" },
        },
        {
          key: "sources/def.txt",
          size: 200,
          customMetadata: {},
        },
      ];
      const bucket = createMockBucket({
        list: vi.fn().mockResolvedValue({ objects: mockObjects }),
      });
      const backend = new R2ArtifactBackend(bucket);

      const result = await backend.listWithMetadata("produced/");

      expect(result).toEqual([
        {
          key: "produced/task:T-1/abc.md",
          size: 100,
          metadata: { "tila-kind": "output", "tila-sha256": "abc" },
        },
        { key: "sources/def.txt", size: 200, metadata: {} },
      ]);
      expect(bucket.list).toHaveBeenCalledWith({
        prefix: "produced/",
        include: ["customMetadata"],
      });
    });

    it("defaults metadata to empty object when customMetadata is undefined", async () => {
      const mockObjects = [{ key: "produced/task:T-1/xyz.bin", size: 50 }];
      const bucket = createMockBucket({
        list: vi.fn().mockResolvedValue({ objects: mockObjects }),
      });
      const backend = new R2ArtifactBackend(bucket);

      const result = await backend.listWithMetadata("produced/");

      expect(result[0].metadata).toEqual({});
    });

    it("paginates until the full prefix has been listed", async () => {
      const list = vi
        .fn()
        .mockResolvedValueOnce({
          objects: [
            {
              key: "produced/task:T-1/a.md",
              size: 100,
              customMetadata: { page: "1" },
            },
          ],
          truncated: true,
          cursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          objects: [
            {
              key: "produced/task:T-1/b.md",
              size: 200,
              customMetadata: { page: "2" },
            },
          ],
          truncated: false,
        });
      const bucket = createMockBucket({ list });
      const backend = new R2ArtifactBackend(bucket);

      const result = await backend.listWithMetadata("produced/");

      expect(result).toEqual([
        {
          key: "produced/task:T-1/a.md",
          size: 100,
          metadata: { page: "1" },
        },
        {
          key: "produced/task:T-1/b.md",
          size: 200,
          metadata: { page: "2" },
        },
      ]);
    });
  });

  describe("deleteMany()", () => {
    let deleteMock: ReturnType<typeof vi.fn>;
    let bucket: R2Bucket;
    let backend: R2ArtifactBackend;

    beforeEach(() => {
      deleteMock = vi.fn().mockResolvedValue(undefined);
      bucket = createMockBucket({ delete: deleteMock });
      backend = new R2ArtifactBackend(bucket);
    });

    it("calls bucket.delete once for ≤1000 keys", async () => {
      const keys = makeKeys(500);
      const result = await backend.deleteMany(keys);

      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledWith(keys);
      expect(result.deleted).toBe(500);
      expect(result.failed).toEqual([]);
    });

    it("chunks a 1500-key array into two calls of ≤1000 keys each", async () => {
      const keys = makeKeys(1500);
      const result = await backend.deleteMany(keys);

      expect(deleteMock).toHaveBeenCalledTimes(2);
      const [firstCall, secondCall] = deleteMock.mock.calls;
      expect(firstCall[0]).toHaveLength(1000);
      expect(secondCall[0]).toHaveLength(500);
      expect(result.deleted).toBe(1500);
      expect(result.failed).toEqual([]);
    });

    it("collects failed keys when a chunk throws", async () => {
      const keys = makeKeys(1500);
      // First chunk succeeds, second chunk fails
      deleteMock
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("R2 unavailable"));

      const result = await backend.deleteMany(keys);

      expect(result.deleted).toBe(1000);
      expect(result.failed).toHaveLength(500);
      // Failed keys come from the second chunk
      expect(result.failed).toEqual(keys.slice(1000));
    });

    it("returns empty result for empty key array", async () => {
      const result = await backend.deleteMany([]);
      expect(deleteMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
      expect(result.failed).toEqual([]);
    });
  });

  describe("deleteByPrefix()", () => {
    it("deletes all keys on a single non-truncated page", async () => {
      const pageObjects = makeKeys(3, "journal-archive/proj-a/").map((k) => ({
        key: k,
      }));
      const listMock = vi
        .fn()
        .mockResolvedValue({ objects: pageObjects, truncated: false });
      const deleteMock = vi.fn().mockResolvedValue(undefined);

      const backend = new R2ArtifactBackend(
        createMockBucket({ list: listMock, delete: deleteMock }),
      );

      const result = await backend.deleteByPrefix("journal-archive/proj-a/");

      expect(listMock).toHaveBeenCalledTimes(1);
      expect(listMock).toHaveBeenCalledWith({
        prefix: "journal-archive/proj-a/",
        cursor: undefined,
      });
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(result.deleted).toBe(3);
      expect(result.failed).toEqual([]);
    });

    it("paginates across two pages using truncated + cursor", async () => {
      const page1Objects = makeKeys(2, "sources/").map((k) => ({ key: k }));
      const page2Objects = makeKeys(1, "sources/").map((k, i) => ({
        key: `sources/extra-${i}.bin`,
      }));

      const listMock = vi
        .fn()
        .mockResolvedValueOnce({
          objects: page1Objects,
          truncated: true,
          cursor: "cursor-abc",
        })
        .mockResolvedValueOnce({
          objects: page2Objects,
          truncated: false,
        });

      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const backend = new R2ArtifactBackend(
        createMockBucket({ list: listMock, delete: deleteMock }),
      );

      const result = await backend.deleteByPrefix("sources/");

      expect(listMock).toHaveBeenCalledTimes(2);
      // Second call must pass the cursor from the first response
      expect(listMock).toHaveBeenNthCalledWith(2, {
        prefix: "sources/",
        cursor: "cursor-abc",
      });
      expect(result.deleted).toBe(3);
      expect(result.failed).toEqual([]);
    });

    it("returns zero deleted for an empty prefix", async () => {
      const listMock = vi
        .fn()
        .mockResolvedValue({ objects: [], truncated: false });
      const deleteMock = vi.fn();
      const backend = new R2ArtifactBackend(
        createMockBucket({ list: listMock, delete: deleteMock }),
      );

      const result = await backend.deleteByPrefix("nonexistent/");

      expect(deleteMock).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
      expect(result.failed).toEqual([]);
    });
  });
});
