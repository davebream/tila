import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerArtifactTools } from "../tools/artifacts";
import {
  type MockFacade,
  type MockServer,
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
  findToolHandler,
} from "./helpers/mock-facade";

const PROJECT_ID = "test-project";

describe("registerArtifactTools", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerArtifactTools(asServer(server), asFacade(facade), PROJECT_ID);
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

  const findHandler = (name: string) => findToolHandler(server, name);

  describe("tila_artifact_put", () => {
    it("calls artifacts.upload with a Blob and upload opts", async () => {
      facade.artifacts.upload.mockResolvedValue({
        ok: true,
        key: "sources/abc.txt",
        bytes: 5,
        deduplicated: false,
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

      expect(facade.artifacts.upload).toHaveBeenCalledTimes(1);
      const [blob, opts] = facade.artifacts.upload.mock.calls[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(opts).toEqual({
        kind: "log",
        mimeType: "text/plain",
        resource: "T-1",
        fence: 42,
        tags: undefined,
      });
      expect(result.content[0].text).toContain('"ok":true');
    });
  });

  describe("tila_artifact_search", () => {
    it("calls artifacts.search with query opts", async () => {
      facade.artifacts.search.mockResolvedValue({
        ok: true,
        results: [],
        total: 0,
      });

      const handler = findHandler("tila_artifact_search");
      await handler({
        q: "deployment",
        kind: "log",
        resource: "T-1",
        limit: 10,
      });

      expect(facade.artifacts.search).toHaveBeenCalledWith("deployment", {
        kind: "log",
        resource: "T-1",
        limit: "10",
      });
    });

    it("passes undefined for omitted optional filters", async () => {
      facade.artifacts.search.mockResolvedValue({ ok: true, results: [] });

      const handler = findHandler("tila_artifact_search");
      await handler({ q: "test", limit: 20 });

      expect(facade.artifacts.search).toHaveBeenCalledWith("test", {
        kind: undefined,
        resource: undefined,
        limit: "20",
      });
    });
  });

  describe("tila_artifact_write_text", () => {
    it("calls artifacts.writeText with text content opts", async () => {
      facade.artifacts.writeText.mockResolvedValue({
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

      expect(facade.artifacts.writeText).toHaveBeenCalledWith("# My Plan", {
        kind: "plan",
        mimeType: "text/markdown",
        resource: "T-1",
        fence: 5,
      });
      expect(result.content[0].text).toContain('"ok":true');
    });
  });

  describe("tila_artifact_read_text", () => {
    it("calls artifacts.readText and returns text content", async () => {
      facade.artifacts.readText.mockResolvedValue({
        content: "# Hello",
        mimeType: "text/markdown",
      });

      const handler = findHandler("tila_artifact_read_text");
      const result = await handler({ key: "sources/abc.md" });

      expect(facade.artifacts.readText).toHaveBeenCalledWith("sources/abc.md");
      expect(result.content[0].text).toBe("# Hello");
    });

    it("throws McpError for non-text content types", async () => {
      facade.artifacts.readText.mockResolvedValue({
        content: "",
        mimeType: "image/png",
      });

      const handler = findHandler("tila_artifact_read_text");
      await expect(handler({ key: "sources/img.png" })).rejects.toThrow(
        /only supports text/,
      );
    });

    it("truncates text over max_chars and appends marker with char/byte counts", async () => {
      const fullText = "a".repeat(20000);
      facade.artifacts.readText.mockResolvedValue({
        content: fullText,
        mimeType: "text/plain",
      });

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
      facade.artifacts.readText.mockResolvedValue({
        content: "short content",
        mimeType: "text/plain",
      });

      const handler = findHandler("tila_artifact_read_text");
      const result = await handler({
        key: "sources/small.txt",
        max_chars: 10000,
      });

      expect(result.content[0].text).toBe("short content");
    });

    it("uses default max_chars of 10000 when not specified", async () => {
      facade.artifacts.readText.mockResolvedValue({
        content: "x".repeat(15000),
        mimeType: "text/plain",
      });

      const handler = findHandler("tila_artifact_read_text");
      const result = await handler({ key: "sources/big.txt" });

      const text = result.content[0].text;
      expect(text.startsWith("x".repeat(10000))).toBe(true);
      expect(text).toContain(
        "...[truncated: returned 10000 chars of 15000 bytes total]",
      );
    });

    it("reports bytes (not chars) in the marker for multibyte content", async () => {
      const fullText = "😀".repeat(200);
      const byteTotal = Buffer.byteLength(fullText, "utf8");
      expect(byteTotal).toBe(800);
      facade.artifacts.readText.mockResolvedValue({
        content: fullText,
        mimeType: "text/plain",
      });

      const handler = findHandler("tila_artifact_read_text");
      const result = await handler({ key: "sources/emoji.txt", max_chars: 50 });

      const text = result.content[0].text;
      expect(text).toContain(
        "...[truncated: returned 50 chars of 800 bytes total]",
      );
    });
  });

  describe("tila_search", () => {
    it("calls search.search with limit", async () => {
      facade.search.search.mockResolvedValue({ ok: true, results: [] });

      const handler = findHandler("tila_search");
      await handler({ q: "deploy", limit: 50 });

      expect(facade.search.search).toHaveBeenCalledWith("deploy", {
        limit: 50,
      });
    });
  });

  describe("tila_artifact_get_latest", () => {
    it("calls artifacts.getLatest and wraps the pointer in an envelope", async () => {
      facade.artifacts.getLatest.mockResolvedValue({ r2_key: "abc.md" });

      const handler = findHandler("tila_artifact_get_latest");
      const result = await handler({ kind: "plan", resource: "T-1" });

      expect(facade.artifacts.getLatest).toHaveBeenCalledWith("plan", "T-1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ ok: true, pointer: { r2_key: "abc.md" } });
    });

    it("returns ok:true with a null pointer when none exists", async () => {
      facade.artifacts.getLatest.mockResolvedValue(null);

      const handler = findHandler("tila_artifact_get_latest");
      const result = await handler({ kind: "plan", resource: "T-9" });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ ok: true, pointer: null });
    });
  });

  describe("tila_artifact_relationships_add", () => {
    it("calls artifacts.addRelationship with to_key target", async () => {
      facade.artifacts.addRelationship.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_artifact_relationships_add");
      await handler({
        from_key: "sources/a.md",
        to_key: "sources/b.md",
        type: "derived-from",
      });

      expect(facade.artifacts.addRelationship).toHaveBeenCalledWith(
        "sources/a.md",
        "sources/b.md",
        "derived-from",
      );
    });

    it("calls artifacts.addRelationship with to_uri when to_key is absent", async () => {
      facade.artifacts.addRelationship.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_artifact_relationships_add");
      await handler({
        from_key: "sources/a.md",
        to_uri: "https://example.com/doc",
        type: "entry-of",
      });

      expect(facade.artifacts.addRelationship).toHaveBeenCalledWith(
        "sources/a.md",
        "https://example.com/doc",
        "entry-of",
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
    it("calls artifacts.listRelationships with the key", async () => {
      facade.artifacts.listRelationships.mockResolvedValue({
        ok: true,
        relationships: [],
      });

      const handler = findHandler("tila_artifact_relationships_list");
      await handler({ key: "sources/a.md" });

      expect(facade.artifacts.listRelationships).toHaveBeenCalledWith(
        "sources/a.md",
      );
    });
  });

  describe("error handling", () => {
    it("wraps facade errors via toMcpError", async () => {
      facade.artifacts.writeText.mockRejectedValue(new Error("server down"));

      const handler = findHandler("tila_artifact_write_text");
      await expect(
        handler({ content: "x", kind: "log", mime_type: "text/plain" }),
      ).rejects.toThrow("server down");
    });
  });

  describe("tila_artifact_search tag_filter", () => {
    it("forwards tag_filter as tagFilter when provided", async () => {
      facade.artifacts.search.mockResolvedValue({
        ok: true,
        results: [],
        total: 0,
      });

      const handler = findHandler("tila_artifact_search");
      await handler({ q: "test", limit: 20, tag_filter: ["repo:a", "team:x"] });

      expect(facade.artifacts.search).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({ tagFilter: ["repo:a", "team:x"] }),
      );
    });

    it("omits tagFilter when not provided", async () => {
      facade.artifacts.search.mockResolvedValue({
        ok: true,
        results: [],
        total: 0,
      });

      const handler = findHandler("tila_artifact_search");
      await handler({ q: "test", limit: 20 });

      const callArg = facade.artifacts.search.mock.calls[0][1];
      expect(callArg).not.toHaveProperty("tagFilter");
    });

    it("accepts tag_filter with invalid grammar (permissive — validation is worker's job)", () => {
      const { z } = require("zod");
      const call = server.tool.mock.calls.find(
        (c: unknown[]) => c[0] === "tila_artifact_search",
      );
      if (!call) throw new Error("tila_artifact_search not found");
      const schema = call[2] as Record<string, import("zod").ZodTypeAny>;
      const result = z
        .object(schema)
        .safeParse({ q: "x", tag_filter: ["bad tag!"] });
      expect(result.success).toBe(true);
    });
  });

  describe("tila_search tag_filter", () => {
    it("forwards tag_filter as tagFilter when provided", async () => {
      facade.search.search.mockResolvedValue({ ok: true, results: [] });

      const handler = findHandler("tila_search");
      await handler({
        q: "deploy",
        limit: 50,
        tag_filter: ["repo:a", "team:x"],
      });

      expect(facade.search.search).toHaveBeenCalledWith(
        "deploy",
        expect.objectContaining({ tagFilter: ["repo:a", "team:x"] }),
      );
    });

    it("omits tagFilter when not provided", async () => {
      facade.search.search.mockResolvedValue({ ok: true, results: [] });

      const handler = findHandler("tila_search");
      await handler({ q: "deploy", limit: 50 });

      const callArg = facade.search.search.mock.calls[0][1];
      expect(callArg).not.toHaveProperty("tagFilter");
    });

    it("accepts tag_filter with invalid grammar (permissive — validation is worker's job)", () => {
      const { z } = require("zod");
      const call = server.tool.mock.calls.find(
        (c: unknown[]) => c[0] === "tila_search",
      );
      if (!call) throw new Error("tila_search not found");
      const schema = call[2] as Record<string, import("zod").ZodTypeAny>;
      const result = z
        .object(schema)
        .safeParse({ q: "x", tag_filter: ["bad tag!"] });
      expect(result.success).toBe(true);
    });
  });
});
