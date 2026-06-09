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

describe("registerEntityTools — tags", () => {
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

  it("tila_task_create schema includes an optional tags field", () => {
    const createCall = server.tool.mock.calls.find(
      (c: unknown[]) => c[0] === "tila_task_create",
    );
    if (!createCall) throw new Error("tila_task_create not found");
    const schema = createCall[2] as Record<string, { _def?: unknown }>;
    expect(schema).toHaveProperty("tags");
  });

  it("tila_task_create passes tags to client.post when provided", async () => {
    client.post.mockResolvedValue({
      ok: true,
      entity: { id: "T-1", tags: ["team:eng"] },
    });

    const handler = findHandler("tila_task_create");
    const result = await handler({
      id: "T-1",
      type: "task",
      data: { title: "Build it" },
      tags: ["team:eng"],
    });

    expect(client.post).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/tasks`, {
      id: "T-1",
      type: "task",
      data: { title: "Build it" },
      tags: ["team:eng"],
    });
    expect(result.content[0].text).toContain('"team:eng"');
  });

  it("tila_task_create omits tags from body when not provided", async () => {
    client.post.mockResolvedValue({
      ok: true,
      entity: { id: "T-2", tags: [] },
    });

    const handler = findHandler("tila_task_create");
    await handler({ id: "T-2", type: "task", data: {} });

    expect(client.post).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/tasks`, {
      id: "T-2",
      type: "task",
      data: {},
    });
    const callBody = client.post.mock.calls[0][1] as Record<string, unknown>;
    expect(callBody.tags).toBeUndefined();
  });

  it("tila_task_show response surfaces tags returned by the server", async () => {
    client.get.mockResolvedValue({
      ok: true,
      entity: {
        id: "T-1",
        type: "task",
        data: {},
        tags: ["env:prod"],
        status: "open",
      },
      relationships: [],
    });

    const handler = findHandler("tila_task_show");
    const result = await handler({ id: "T-1" });
    expect(result.content[0].text).toContain('"env:prod"');
  });
});
