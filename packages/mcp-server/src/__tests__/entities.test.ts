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
  };
}

function asServer(s: MockServer): McpServer {
  return s as unknown as McpServer;
}

function asClient(c: MockClient): TilaClient {
  return c as unknown as TilaClient;
}

import { registerEntityTools } from "../tools/entities";

const PROJECT_ID = "test-project";

describe("registerEntityTools", () => {
  let server: MockServer;
  let client: MockClient;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    registerEntityTools(asServer(server), asClient(client), PROJECT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers 8 tools with correct names", () => {
    expect(server.tool).toHaveBeenCalledTimes(8);

    const toolNames = server.tool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toEqual([
      "tila_task_create",
      "tila_task_list",
      "tila_task_show",
      "tila_task_update",
      "tila_task_ready",
      "tila_task_archive",
      "tila_task_relationships_add",
      "tila_task_relationships_list",
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

  describe("tila_task_create", () => {
    it("calls client.post with correct path and body", async () => {
      client.post.mockResolvedValue({ ok: true, entity: { id: "T-1" } });

      const handler = findHandler("tila_task_create");
      const result = await handler({
        id: "T-1",
        type: "task",
        data: { title: "Build it" },
      });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tasks`,
        { id: "T-1", type: "task", data: { title: "Build it" } },
      );
      expect(result.content[0].text).toContain('"ok":true');
    });
  });

  describe("tila_task_list", () => {
    it("calls client.get with compact mode and optional filters", async () => {
      client.get.mockResolvedValue({ ok: true, entities: [], total: 0 });

      const handler = findHandler("tila_task_list");
      await handler({ type: "task", status: "open" });

      expect(client.get).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/tasks`, {
        query: { compact: "true", type: "task", status: "open" },
      });
    });

    it("passes undefined for omitted optional filters", async () => {
      client.get.mockResolvedValue({ ok: true, entities: [] });

      const handler = findHandler("tila_task_list");
      await handler({});

      expect(client.get).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/tasks`, {
        query: { compact: "true", type: undefined, status: undefined },
      });
    });
  });

  describe("tila_task_show", () => {
    it("calls client.get with task path", async () => {
      client.get.mockResolvedValue({
        ok: true,
        entity: { id: "T-1" },
        relationships: [],
      });

      const handler = findHandler("tila_task_show");
      const result = await handler({ id: "T-1" });

      expect(client.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tasks/T-1`,
      );
      expect(result.content[0].text).toContain('"T-1"');
    });
  });

  describe("tila_task_update", () => {
    it("calls client.patch with data and fence", async () => {
      client.patch.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_task_update");
      await handler({ id: "T-1", data: { status: "done" }, fence: 42 });

      expect(client.patch).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tasks/T-1`,
        { data: { status: "done" }, fence: 42 },
      );
    });
  });

  describe("tila_task_ready", () => {
    it("calls client.get on the ready endpoint with optional type filter", async () => {
      client.get.mockResolvedValue({ ok: true, entities: [] });

      const handler = findHandler("tila_task_ready");
      await handler({ type: "task" });

      expect(client.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tasks/ready`,
        { query: { type: "task" } },
      );
    });

    it("slices entities to limit and adds truncated+total when over limit", async () => {
      const entities = Array.from({ length: 60 }, (_, i) => ({ id: `T-${i}` }));
      client.get.mockResolvedValue({ ok: true, entities });

      const handler = findHandler("tila_task_ready");
      const result = await handler({ limit: 50 });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entities).toHaveLength(50);
      expect(parsed.truncated).toBe(true);
      expect(parsed.total).toBe(60);
    });

    it("returns result unchanged when under limit (no truncated key)", async () => {
      const entities = Array.from({ length: 10 }, (_, i) => ({ id: `T-${i}` }));
      client.get.mockResolvedValue({ ok: true, entities });

      const handler = findHandler("tila_task_ready");
      const result = await handler({ limit: 50 });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entities).toHaveLength(10);
      expect(parsed).not.toHaveProperty("truncated");
      expect(parsed).not.toHaveProperty("total");
    });
  });

  describe("tila_task_list — no limit param (CRUD tools excluded)", () => {
    it("tila_task_list has no limit key in its input schema", () => {
      const listCall = server.tool.mock.calls.find(
        (c: unknown[]) => c[0] === "tila_task_list",
      );
      if (!listCall) throw new Error("tila_task_list not found");
      const schema = listCall[2] as Record<string, unknown>;
      expect(schema).not.toHaveProperty("limit");
    });

    it("tila_task_show has no limit key in its input schema", () => {
      const showCall = server.tool.mock.calls.find(
        (c: unknown[]) => c[0] === "tila_task_show",
      );
      if (!showCall) throw new Error("tila_task_show not found");
      const schema = showCall[2] as Record<string, unknown>;
      expect(schema).not.toHaveProperty("limit");
    });
  });

  describe("tila_task_archive", () => {
    it("calls client.post on the archive endpoint with fence", async () => {
      client.post.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_task_archive");
      await handler({ id: "T-1", fence: 10 });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tasks/T-1/archive`,
        { fence: 10 },
      );
    });
  });

  describe("tila_task_relationships_add", () => {
    it("calls client.post on the relationships endpoint", async () => {
      client.post.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_task_relationships_add");
      await handler({ from_id: "T-1", to_id: "T-2", type: "blocks" });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tasks/T-1/relationships`,
        { to_id: "T-2", type: "blocks" },
      );
    });
  });

  describe("tila_task_relationships_list", () => {
    it("calls client.get on the relationships endpoint", async () => {
      client.get.mockResolvedValue({ ok: true, relationships: [] });

      const handler = findHandler("tila_task_relationships_list");
      await handler({ id: "T-1" });

      expect(client.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tasks/T-1/relationships`,
      );
    });

    it("slices relationships to limit and adds truncated+total when over limit", async () => {
      const relationships = Array.from({ length: 75 }, (_, i) => ({
        from_id: `T-${i}`,
        to_id: "T-X",
        type: "blocks",
      }));
      client.get.mockResolvedValue({ ok: true, relationships });

      const handler = findHandler("tila_task_relationships_list");
      const result = await handler({ id: "T-1", limit: 50 });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.relationships).toHaveLength(50);
      expect(parsed.truncated).toBe(true);
      expect(parsed.total).toBe(75);
    });

    it("returns result unchanged when under limit (no truncated key)", async () => {
      const relationships = Array.from({ length: 5 }, (_, i) => ({
        from_id: `T-${i}`,
        to_id: "T-X",
        type: "blocks",
      }));
      client.get.mockResolvedValue({ ok: true, relationships });

      const handler = findHandler("tila_task_relationships_list");
      const result = await handler({ id: "T-1", limit: 50 });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.relationships).toHaveLength(5);
      expect(parsed).not.toHaveProperty("truncated");
      expect(parsed).not.toHaveProperty("total");
    });
  });

  describe("error handling", () => {
    it("wraps errors via toMcpError", async () => {
      client.post.mockRejectedValue(new Error("network failure"));

      const handler = findHandler("tila_task_create");
      await expect(
        handler({ id: "T-1", type: "task", data: {} }),
      ).rejects.toThrow("network failure");
    });
  });

  describe("tila_task_list tag_filter", () => {
    it("forwards tag_filter as comma-joined query param when provided", async () => {
      client.get.mockResolvedValue({ ok: true, entities: [], total: 0 });

      const handler = findHandler("tila_task_list");
      await handler({ tag_filter: ["repo:a", "team:x"] });

      expect(client.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tasks`,
        expect.objectContaining({
          query: expect.objectContaining({ tag_filter: "repo:a,team:x" }),
        }),
      );
    });

    it("omits tag_filter query param when tag_filter is not provided", async () => {
      client.get.mockResolvedValue({ ok: true, entities: [], total: 0 });

      const handler = findHandler("tila_task_list");
      await handler({});

      const callArgs = client.get.mock.calls[0];
      const query = callArgs[1]?.query as Record<string, unknown>;
      expect(query).not.toHaveProperty("tag_filter");
    });

    it("accepts tag_filter with invalid grammar (permissive — validation is worker's job)", () => {
      const { z } = require("zod");
      const listCall = server.tool.mock.calls.find(
        (c: unknown[]) => c[0] === "tila_task_list",
      );
      if (!listCall) throw new Error("tila_task_list not found");
      const schema = listCall[2] as Record<string, import("zod").ZodTypeAny>;
      const result = z.object(schema).safeParse({ tag_filter: ["bad tag!"] });
      expect(result.success).toBe(true);
    });
  });
});
