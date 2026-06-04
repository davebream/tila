import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaClient } from "tila-sdk";
import { describe, expect, it, vi } from "vitest";

type ResourceHandler = (
  uri: { href: string },
  variables?: Record<string, string>,
) => Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}>;

type MockServer = {
  tool: ReturnType<typeof vi.fn>;
  resource: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
};

type MockClient = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

function createMockServer(): MockServer {
  return {
    tool: vi.fn(),
    resource: vi.fn(),
    prompt: vi.fn(),
  };
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

import { registerAllResources } from "../resources/index";

const PROJECT_ID = "test-project";

describe("registerAllResources — project-presence", () => {
  it("calls GET .../presence/all (not /presence)", async () => {
    const server = createMockServer();
    const client = createMockClient();

    // Non-fatal: schema fetch returns nothing (no record resources registered)
    client.get.mockResolvedValue({ ok: true, schema: null });

    await registerAllResources(asServer(server), asClient(client), PROJECT_ID);

    // Find the project-presence registration
    const presenceCall = server.resource.mock.calls.find(
      (c: unknown[]) => c[0] === "project-presence",
    );
    expect(presenceCall).toBeDefined();

    // Get the handler (last arg in the resource() call)
    if (!presenceCall)
      throw new Error("project-presence resource not registered");
    const handler = presenceCall[presenceCall.length - 1] as ResourceHandler;

    // Mock the /presence/all response with mixed active/inactive machines
    const allMachinesResponse = {
      ok: true,
      machines: [
        { machine: "agent-1", last_seen: 1000, info: {}, active: true },
        { machine: "agent-2", last_seen: 500, info: {}, active: false },
      ],
    };

    // Reset the mock to track this specific call
    client.get.mockReset();
    client.get.mockResolvedValue(allMachinesResponse);

    const result = await handler({ href: "tila://project/presence" });

    // (a) Handler called /presence/all path
    expect(client.get).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/presence/all`,
    );

    // (b) Both machines are present in the response with their active flags passed through
    const text = result.contents[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.machines).toHaveLength(2);
    expect(parsed.machines[0].active).toBe(true);
    expect(parsed.machines[1].active).toBe(false);

    // (c) No client-side window computation — active flags come from server as-is
    // The handler must NOT compute active based on last_seen/Date.now()
    // We verify this indirectly: the flags in the response match the server response exactly
    expect(parsed.machines[0].machine).toBe("agent-1");
    expect(parsed.machines[1].machine).toBe("agent-2");
  });

  it("passes through mixed active:true and active:false flags unchanged", async () => {
    const server = createMockServer();
    const client = createMockClient();

    client.get.mockResolvedValue({ ok: true, schema: null });

    await registerAllResources(asServer(server), asClient(client), PROJECT_ID);

    const presenceCall2 = server.resource.mock.calls.find(
      (c: unknown[]) => c[0] === "project-presence",
    );
    if (!presenceCall2)
      throw new Error("project-presence resource not registered");
    const handler = presenceCall2[presenceCall2.length - 1] as ResourceHandler;

    // All machines inactive (e.g. old last_seen times)
    const allInactiveResponse = {
      ok: true,
      machines: [
        { machine: "old-agent", last_seen: 1, info: {}, active: false },
      ],
    };

    client.get.mockReset();
    client.get.mockResolvedValue(allInactiveResponse);

    const result = await handler({ href: "tila://project/presence" });
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.machines[0].active).toBe(false);
  });
});
