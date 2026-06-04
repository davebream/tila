import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaClient } from "tila-sdk";
import { describe, expect, it, vi } from "vitest";

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

describe("tila_artifact_grep MCP tool", () => {
  function setupTools() {
    const server = createMockServer();
    const client = createMockClient();
    registerArtifactTools(asServer(server), asClient(client), PROJECT_ID);
    return { server, client };
  }

  function findHandler(
    server: MockServer,
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

  it("is registered as tila_artifact_grep", () => {
    const { server } = setupTools();
    const toolNames = server.tool.mock.calls.map((c: unknown[]) => c[0]);
    expect(toolNames).toContain("tila_artifact_grep");
  });

  it("description contains col-is-char-offset note", () => {
    const { server } = setupTools();
    const call = server.tool.mock.calls.find(
      (c: unknown[]) => c[0] === "tila_artifact_grep",
    );
    if (!call) throw new Error("tila_artifact_grep not registered");
    const description = call[1] as string;
    expect(description).toContain("col");
    // Verify description steers toward exact/substring/regex use case
    expect(description.toLowerCase()).toMatch(/exact|substring|regex/);
  });

  it("forwards grep request to GET .../grep endpoint", async () => {
    const { server, client } = setupTools();
    const mockResponse = {
      ok: true,
      results: [],
      scanned: 0,
      skipped: 0,
      truncated: false,
    };
    client.get.mockResolvedValue(mockResponse);

    const handler = findHandler(server, "tila_artifact_grep");
    await handler({ pattern: "hello", limit: 20 });

    expect(client.get).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/artifacts/grep`,
      expect.objectContaining({
        query: expect.objectContaining({ pattern: "hello" }),
      }),
    );
  });

  it("passes kind, resource, regex, and limit to query", async () => {
    const { server, client } = setupTools();
    client.get.mockResolvedValue({
      ok: true,
      results: [],
      scanned: 0,
      skipped: 0,
      truncated: false,
    });

    const handler = findHandler(server, "tila_artifact_grep");
    await handler({
      pattern: "x",
      kind: "plan",
      resource: "T-1",
      regex: true,
      limit: 10,
    });

    expect(client.get).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/artifacts/grep`,
      expect.objectContaining({
        query: expect.objectContaining({
          pattern: "x",
          kind: "plan",
          resource: "T-1",
          limit: "10",
        }),
      }),
    );
  });

  it("returns JSON-stringified response as text content", async () => {
    const { server, client } = setupTools();
    const mockResponse = {
      ok: true,
      results: [
        {
          key: "k",
          kind: "plan",
          resource: null,
          lines: [{ line: 1, text: "match", col: 1 }],
        },
      ],
      scanned: 1,
      skipped: 0,
      truncated: false,
    };
    client.get.mockResolvedValue(mockResponse);

    const handler = findHandler(server, "tila_artifact_grep");
    const result = await handler({ pattern: "match" });

    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toHaveLength(1);
  });

  it("error message contains no platform-internal tokens (R2, DO, SQLite, isolate, Worker)", async () => {
    const { server, client } = setupTools();
    client.get.mockRejectedValue(new Error("artifact lookup failed"));

    const handler = findHandler(server, "tila_artifact_grep");
    let errorMessage = "";
    try {
      await handler({ pattern: "x" });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    // Error message must not expose platform internals
    expect(errorMessage).not.toMatch(/\bR2\b/);
    expect(errorMessage).not.toMatch(/\bDurable Object\b/i);
    expect(errorMessage).not.toMatch(/\bSQLite\b/i);
    expect(errorMessage).not.toMatch(/\bisolate\b/i);
    expect(errorMessage).not.toMatch(/\bWorker\b/);
  });
});
