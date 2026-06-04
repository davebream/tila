import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaClient } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockServer = {
  tool: ReturnType<typeof vi.fn>;
};

type MockClient = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

function createMockServer(): MockServer {
  return { tool: vi.fn() };
}

function createMockClient(): MockClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  };
}

function asServer(s: MockServer): McpServer {
  return s as unknown as McpServer;
}

function asClient(c: MockClient): TilaClient {
  return c as unknown as TilaClient;
}

import { registerPresenceTools } from "../tools/presence";

const PROJECT_ID = "test-project";

describe("registerPresenceTools", () => {
  let server: MockServer;
  let client: MockClient;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    registerPresenceTools(asServer(server), asClient(client), PROJECT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers exactly 1 tool named tila_presence_heartbeat", () => {
    expect(server.tool).toHaveBeenCalledTimes(1);

    const toolNames = server.tool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toEqual(["tila_presence_heartbeat"]);
  });

  it("does not include a machine property in the input schema", () => {
    const inputSchema = server.tool.mock.calls[0][2] as Record<string, unknown>;
    expect(inputSchema).not.toHaveProperty("machine");
    expect(inputSchema).toHaveProperty("info");
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

  describe("tila_presence_heartbeat", () => {
    it("sends machine: 'mcp-agent' in the request body", async () => {
      client.post.mockResolvedValue({ ok: true, machine: "mcp-agent" });

      const handler = findHandler("tila_presence_heartbeat");
      const result = await handler({ info: { task: "coding" } });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/presence/heartbeat`,
        {
          machine: "mcp-agent",
          info: { task: "coding" },
        },
      );
      expect(result.content[0].text).toContain('"ok":true');
    });

    it("sends machine: 'mcp-agent' even when info is empty", async () => {
      client.post.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_presence_heartbeat");
      await handler({ info: {} });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/presence/heartbeat`,
        {
          machine: "mcp-agent",
          info: {},
        },
      );
    });
  });

  describe("error handling", () => {
    it("wraps errors via toMcpError", async () => {
      client.post.mockRejectedValue(new Error("network error"));

      const handler = findHandler("tila_presence_heartbeat");
      await expect(handler({ info: {} })).rejects.toThrow("network error");
    });
  });

  describe("response formatting", () => {
    it("returns JSON-stringified response in text content array", async () => {
      const responseData = {
        ok: true,
        machine: "mcp-agent",
        lastSeen: "2026-05-25T12:00:00Z",
      };
      client.post.mockResolvedValue(responseData);

      const handler = findHandler("tila_presence_heartbeat");
      const result = await handler({ info: {} });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(JSON.parse(result.content[0].text)).toEqual(responseData);
    });
  });
});
