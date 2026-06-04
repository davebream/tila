import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaClient } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockServer = {
  tool: ReturnType<typeof vi.fn>;
};

type MockClient = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  postFormData: ReturnType<typeof vi.fn>;
  requestRaw: ReturnType<typeof vi.fn>;
};

function createMockServer(): MockServer {
  return { tool: vi.fn() };
}

function createMockClient(): MockClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    postFormData: vi.fn(),
    requestRaw: vi.fn(),
  };
}

function asServer(s: MockServer): McpServer {
  return s as unknown as McpServer;
}

function asClient(c: MockClient): TilaClient {
  return c as unknown as TilaClient;
}

import { registerArtifactTools } from "../tools/artifacts";

const PROJECT_ID = "test-project";

describe("registerArtifactTools", () => {
  let server: MockServer;
  let client: MockClient;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    registerArtifactTools(asServer(server), asClient(client), PROJECT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers 9 tools with correct names", () => {
    expect(server.tool).toHaveBeenCalledTimes(9);

    const toolNames = server.tool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toEqual([
      "tila_artifact_put",
      "tila_artifact_search",
      "tila_artifact_write_text",
      "tila_artifact_read_text",
      "tila_search",
      "tila_artifact_get_latest",
      "tila_artifact_relationships_add",
      "tila_artifact_relationships_list",
      "tila_artifact_grep",
    ]);
  });

  // Helper to find a tool handler by name
  function findHandler(
    name: string,
  ): (
    args: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }> {
    const call = server.tool.mock.calls.find((c: unknown[]) => c[0] === name);
    if (!call) throw new Error(`Tool ${name} not found`);
    return call[3] as (
      args: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }

  describe("tila_artifact_put", () => {
    it("calls client.postFormData with FormData containing file and metadata", async () => {
      client.postFormData.mockResolvedValue({
        ok: true,
        key: "sources/abc.txt",
        bytes: 5,
        dedup: false,
      });

      const handler = findHandler("tila_artifact_put");
      // base64 for "hello"
      const result = await handler({
        content: "aGVsbG8=",
        kind: "log",
        mime_type: "text/plain",
        resource: "T-1",
        fence: 42,
      });

      expect(client.postFormData).toHaveBeenCalledTimes(1);
      const [path, formData] = client.postFormData.mock.calls[0];
      expect(path).toBe(`/projects/${PROJECT_ID}/artifacts`);
      expect(formData).toBeInstanceOf(FormData);
      expect(formData.get("kind")).toBe("log");
      expect(formData.get("mime_type")).toBe("text/plain");
      expect(formData.get("resource")).toBe("T-1");
      expect(formData.get("fence")).toBe("42");
      expect(result.content[0].text).toContain('"ok":true');
    });

    it("omits optional resource and fence from FormData when not provided", async () => {
      client.postFormData.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_artifact_put");
      await handler({
        content: "aGVsbG8=",
        kind: "log",
        mime_type: "application/octet-stream",
      });

      const formData = client.postFormData.mock.calls[0][1] as FormData;
      expect(formData.get("resource")).toBeNull();
      expect(formData.get("fence")).toBeNull();
    });
  });

  describe("tila_artifact_search", () => {
    it("calls client.get with search query params", async () => {
      client.get.mockResolvedValue({ ok: true, results: [], total: 0 });

      const handler = findHandler("tila_artifact_search");
      await handler({
        q: "deployment",
        kind: "log",
        resource: "T-1",
        limit: 10,
      });

      expect(client.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/artifacts/search`,
        {
          query: {
            q: "deployment",
            kind: "log",
            resource: "T-1",
            limit: "10",
          },
        },
      );
    });

    it("passes undefined for omitted optional filters", async () => {
      client.get.mockResolvedValue({ ok: true, results: [] });

      const handler = findHandler("tila_artifact_search");
      await handler({ q: "test", limit: 20 });

      expect(client.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/artifacts/search`,
        {
          query: {
            q: "test",
            kind: undefined,
            resource: undefined,
            limit: "20",
          },
        },
      );
    });
  });

  describe("tila_artifact_write_text", () => {
    it("calls client.post with text content body", async () => {
      client.post.mockResolvedValue({
        ok: true,
        key: "sources/abc.md",
        bytes: 12,
      });

      const handler = findHandler("tila_artifact_write_text");
      const result = await handler({
        content: "# My Plan",
        kind: "plan",
        mime_type: "text/markdown",
        resource: "T-1",
        fence: 5,
      });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/artifacts/text`,
        {
          content: "# My Plan",
          kind: "plan",
          mime_type: "text/markdown",
          resource: "T-1",
          fence: 5,
        },
      );
      expect(result.content[0].text).toContain('"ok":true');
    });
  });

  describe("tila_artifact_read_text", () => {
    it("calls client.requestRaw and returns text content", async () => {
      const mockResponse = {
        headers: new Headers({ "content-type": "text/markdown" }),
        text: vi.fn().mockResolvedValue("# Hello"),
      };
      client.requestRaw.mockResolvedValue(mockResponse);

      const handler = findHandler("tila_artifact_read_text");
      const result = await handler({ key: "sources/abc.md" });

      expect(client.requestRaw).toHaveBeenCalledWith(
        "GET",
        `/projects/${PROJECT_ID}/artifacts/sources%2Fabc.md`,
      );
      expect(result.content[0].text).toBe("# Hello");
    });

    it("throws McpError for non-text content types", async () => {
      const mockResponse = {
        headers: new Headers({ "content-type": "image/png" }),
        text: vi.fn(),
      };
      client.requestRaw.mockResolvedValue(mockResponse);

      const handler = findHandler("tila_artifact_read_text");
      await expect(handler({ key: "sources/img.png" })).rejects.toThrow(
        /only supports text/,
      );
    });

    it("truncates text over max_chars and appends marker with char/byte counts", async () => {
      const fullText = "a".repeat(20000);
      const mockResponse = {
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue(fullText),
      };
      client.requestRaw.mockResolvedValue(mockResponse);

      const handler = findHandler("tila_artifact_read_text");
      const result = await handler({ key: "sources/big.txt", max_chars: 100 });

      const text = result.content[0].text;
      expect(text).toHaveLength(
        100 +
          "\n\n...[truncated: returned 100 chars of 20000 bytes total]".length,
      );
      expect(text.startsWith("a".repeat(100))).toBe(true);
      expect(text).toContain(
        "...[truncated: returned 100 chars of 20000 bytes total]",
      );
    });

    it("returns full text unchanged when under max_chars", async () => {
      const shortText = "short content";
      const mockResponse = {
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue(shortText),
      };
      client.requestRaw.mockResolvedValue(mockResponse);

      const handler = findHandler("tila_artifact_read_text");
      const result = await handler({
        key: "sources/small.txt",
        max_chars: 10000,
      });

      expect(result.content[0].text).toBe(shortText);
    });

    it("uses default max_chars of 10000 when not specified", async () => {
      const overLimit = "x".repeat(15000);
      const mockResponse = {
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue(overLimit),
      };
      client.requestRaw.mockResolvedValue(mockResponse);

      const handler = findHandler("tila_artifact_read_text");
      const result = await handler({ key: "sources/big.txt" });

      const text = result.content[0].text;
      expect(text.startsWith("x".repeat(10000))).toBe(true);
      expect(text).toContain(
        "...[truncated: returned 10000 chars of 15000 bytes total]",
      );
    });

    it("reports bytes (not chars) in the marker for multibyte content", async () => {
      // 200 emoji: 200 chars, but 800 bytes in UTF-8 (4 bytes each).
      const fullText = "😀".repeat(200);
      const byteTotal = Buffer.byteLength(fullText, "utf8"); // 800
      expect(byteTotal).toBe(800);
      const mockResponse = {
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue(fullText),
      };
      client.requestRaw.mockResolvedValue(mockResponse);

      const handler = findHandler("tila_artifact_read_text");
      const result = await handler({ key: "sources/emoji.txt", max_chars: 50 });

      const text = result.content[0].text;
      // Marker proves the byte count (800) diverges from the char count (50).
      expect(text).toContain(
        "...[truncated: returned 50 chars of 800 bytes total]",
      );
    });
  });

  describe("tila_search", () => {
    it("calls client.get on the unified search endpoint", async () => {
      client.get.mockResolvedValue({ ok: true, results: [] });

      const handler = findHandler("tila_search");
      await handler({ q: "deploy", limit: 50 });

      expect(client.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/search`,
        { query: { q: "deploy", limit: "50" } },
      );
    });
  });

  describe("tila_artifact_get_latest", () => {
    it("calls client.get with kind and resource query params", async () => {
      client.get.mockResolvedValue({ ok: true, artifact: { key: "abc.md" } });

      const handler = findHandler("tila_artifact_get_latest");
      const result = await handler({ kind: "plan", resource: "T-1" });

      expect(client.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/artifacts/latest`,
        { query: { kind: "plan", resource: "T-1" } },
      );
      expect(result.content[0].text).toContain('"ok":true');
    });
  });

  describe("tila_artifact_relationships_add", () => {
    it("calls client.post with to_key", async () => {
      client.post.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_artifact_relationships_add");
      await handler({
        from_key: "sources/a.md",
        to_key: "sources/b.md",
        type: "derived-from",
      });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/artifacts/sources%2Fa.md/relationships`,
        { type: "derived-from", to_key: "sources/b.md" },
      );
    });

    it("calls client.post with to_uri when to_key is absent", async () => {
      client.post.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_artifact_relationships_add");
      await handler({
        from_key: "sources/a.md",
        to_uri: "https://example.com/doc",
        type: "entry-of",
      });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/artifacts/sources%2Fa.md/relationships`,
        { type: "entry-of", to_uri: "https://example.com/doc" },
      );
    });

    it("throws McpError when neither to_key nor to_uri is provided", async () => {
      const handler = findHandler("tila_artifact_relationships_add");
      await expect(
        handler({ from_key: "sources/a.md", type: "derived-from" }),
      ).rejects.toThrow(/to_key or to_uri/);
    });
  });

  describe("tila_artifact_relationships_list", () => {
    it("calls client.get on the relationships endpoint", async () => {
      client.get.mockResolvedValue({ ok: true, relationships: [] });

      const handler = findHandler("tila_artifact_relationships_list");
      await handler({ key: "sources/a.md" });

      expect(client.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/artifacts/sources%2Fa.md/relationships`,
      );
    });
  });

  describe("error handling", () => {
    it("wraps client errors via toMcpError", async () => {
      client.post.mockRejectedValue(new Error("server down"));

      const handler = findHandler("tila_artifact_write_text");
      await expect(
        handler({ content: "x", kind: "log", mime_type: "text/plain" }),
      ).rejects.toThrow("server down");
    });
  });
});
