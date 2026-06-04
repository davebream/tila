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

import { registerGateTools } from "../tools/gates";

const PROJECT_ID = "test-project";

describe("registerGateTools", () => {
  let server: MockServer;
  let client: MockClient;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    registerGateTools(asServer(server), asClient(client), PROJECT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers 3 tools with correct names", () => {
    expect(server.tool).toHaveBeenCalledTimes(3);

    const toolNames = server.tool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toEqual([
      "tila_gate_create",
      "tila_gate_resolve",
      "tila_gate_cancel",
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

  describe("tila_gate_create", () => {
    it("calls client.post with all required and optional fields", async () => {
      client.post.mockResolvedValue({
        ok: true,
        gate: { id: "gate-1", status: "pending" },
      });

      const handler = findHandler("tila_gate_create");
      const result = await handler({
        resource: "T-1",
        await_type: "ci",
        fence: 42,
        timeout_at: 1700000000000,
        data: { run_url: "https://ci.example.com/123" },
      });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/gates`,
        {
          resource: "T-1",
          await_type: "ci",
          fence: 42,
          timeout_at: 1700000000000,
          data: { run_url: "https://ci.example.com/123" },
        },
      );
      expect(result.content[0].text).toContain('"ok":true');
      expect(result.content[0].text).toContain('"gate-1"');
    });

    it("calls client.post with only required fields (timeout_at and data omitted)", async () => {
      client.post.mockResolvedValue({ ok: true, gate: { id: "gate-2" } });

      const handler = findHandler("tila_gate_create");
      await handler({
        resource: "T-2",
        await_type: "human",
        fence: 10,
      });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/gates`,
        {
          resource: "T-2",
          await_type: "human",
          fence: 10,
          timeout_at: undefined,
          data: undefined,
        },
      );
    });
  });

  describe("tila_gate_resolve", () => {
    it("calls client.post on the resolve endpoint with resolution", async () => {
      client.post.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_gate_resolve");
      const result = await handler({
        gate_id: "gate-1",
        resolution: "ci-passed",
      });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/gates/gate-1/resolve`,
        { resolution: "ci-passed" },
      );
      expect(result.content[0].text).toContain('"ok":true');
    });

    it("calls client.post without resolution when omitted", async () => {
      client.post.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_gate_resolve");
      await handler({ gate_id: "gate-5" });

      expect(client.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/gates/gate-5/resolve`,
        { resolution: undefined },
      );
    });
  });

  describe("tila_gate_cancel", () => {
    it("calls client.delete on the gate endpoint", async () => {
      client.delete.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_gate_cancel");
      const result = await handler({ gate_id: "gate-3" });

      expect(client.delete).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/gates/gate-3`,
      );
      expect(result.content[0].text).toContain('"ok":true');
    });
  });

  describe("error handling", () => {
    it("wraps errors via toMcpError for gate_create", async () => {
      client.post.mockRejectedValue(new Error("timeout"));

      const handler = findHandler("tila_gate_create");
      await expect(
        handler({ resource: "T-1", await_type: "ci", fence: 1 }),
      ).rejects.toThrow("timeout");
    });

    it("wraps errors via toMcpError for gate_cancel", async () => {
      client.delete.mockRejectedValue(new Error("not found"));

      const handler = findHandler("tila_gate_cancel");
      await expect(handler({ gate_id: "gate-999" })).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("response formatting", () => {
    it("returns JSON-stringified response in text content array", async () => {
      const responseData = {
        ok: true,
        gate: { id: "gate-7", status: "resolved" },
      };
      client.post.mockResolvedValue(responseData);

      const handler = findHandler("tila_gate_resolve");
      const result = await handler({
        gate_id: "gate-7",
        resolution: "approved",
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(JSON.parse(result.content[0].text)).toEqual(responseData);
    });
  });
});
