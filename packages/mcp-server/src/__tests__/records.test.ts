import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaClient } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the SDK module before importing the function under test
vi.mock("tila-sdk", () => ({
  createRecordMethods: vi.fn(),
}));

import { createRecordMethods } from "tila-sdk";
import { registerAllResources } from "../resources/index";
import { registerRecordTools } from "../tools/records";

const mockCreateRecordMethods = vi.mocked(createRecordMethods);

type MockServer = {
  tool: ReturnType<typeof vi.fn>;
  resource: ReturnType<typeof vi.fn>;
};

type MockClient = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  postFormData: ReturnType<typeof vi.fn>;
};

function createMockServer(): MockServer {
  return {
    tool: vi.fn(),
    resource: vi.fn(),
  };
}

function createMockClient(): MockClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
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

describe("registerRecordTools", () => {
  let server: MockServer;
  let client: MockClient;
  let mockRecords: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    mockRecords = {
      get: vi.fn(),
      set: vi.fn(),
      patch: vi.fn(),
      list: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      history: vi.fn(),
    };
    mockCreateRecordMethods.mockReturnValue(
      mockRecords as unknown as ReturnType<typeof createRecordMethods>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers exactly 7 tools with correct names", () => {
    registerRecordTools(asServer(server), asClient(client), "proj-1");

    expect(server.tool).toHaveBeenCalledTimes(7);

    const toolNames = server.tool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toEqual([
      "tila_record_get",
      "tila_record_set",
      "tila_record_patch",
      "tila_record_list",
      "tila_record_archive",
      "tila_record_unarchive",
      "tila_record_history",
    ]);
  });

  it("tila_record_get calls records.get with type and key", async () => {
    registerRecordTools(asServer(server), asClient(client), "proj-1");
    mockRecords.get.mockResolvedValue({
      ok: true,
      record: { type: "config", key: "main", value: {} },
      fence: 1,
    });

    // Extract the handler (4th argument of the first server.tool call)
    const handler = server.tool.mock.calls[0][3] as (
      args: unknown,
    ) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({ type: "config", key: "main" });

    expect(mockRecords.get).toHaveBeenCalledWith("config", "main");
    expect(result.content[0].text).toContain('"ok":true');
  });

  it("tila_record_set calls records.set with value and fence", async () => {
    registerRecordTools(asServer(server), asClient(client), "proj-1");
    mockRecords.set.mockResolvedValue({ ok: true, fence: 2 });

    const handler = server.tool.mock.calls[1][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({
      type: "config",
      key: "main",
      value: { env: "prod" },
      fence: 1,
    });

    expect(mockRecords.set).toHaveBeenCalledWith("config", "main", {
      value: { env: "prod" },
      fence: 1,
    });
  });

  it("tila_record_patch calls records.patch with patch and fence", async () => {
    registerRecordTools(asServer(server), asClient(client), "proj-1");
    mockRecords.patch.mockResolvedValue({ ok: true, fence: 3 });

    const handler = server.tool.mock.calls[2][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({
      type: "config",
      key: "main",
      patch: { env: "staging" },
      fence: 2,
    });

    expect(mockRecords.patch).toHaveBeenCalledWith("config", "main", {
      patch: { env: "staging" },
      fence: 2,
    });
  });

  it("tila_record_list converts include_archived boolean to string", async () => {
    registerRecordTools(asServer(server), asClient(client), "proj-1");
    mockRecords.list.mockResolvedValue({
      ok: true,
      records: [],
      total: 0,
    });

    const handler = server.tool.mock.calls[3][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({
      type: "config",
      tag: "stable",
      include_archived: true,
    });

    expect(mockRecords.list).toHaveBeenCalledWith("config", {
      tag: "stable",
      filter: undefined,
      "include-archived": "true",
    });
  });

  it("tila_record_archive calls records.archive with fence", async () => {
    registerRecordTools(asServer(server), asClient(client), "proj-1");
    mockRecords.archive.mockResolvedValue({ ok: true, fence: 4 });

    const handler = server.tool.mock.calls[4][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({ type: "config", key: "main", fence: 3 });

    expect(mockRecords.archive).toHaveBeenCalledWith("config", "main", {
      fence: 3,
    });
  });

  it("tila_record_unarchive calls records.unarchive with fence", async () => {
    registerRecordTools(asServer(server), asClient(client), "proj-1");
    mockRecords.unarchive.mockResolvedValue({ ok: true, fence: 5 });

    const handler = server.tool.mock.calls[5][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({ type: "config", key: "main", fence: 4 });

    expect(mockRecords.unarchive).toHaveBeenCalledWith("config", "main", {
      fence: 4,
    });
  });

  it("tila_record_history passes limit and values opts", async () => {
    registerRecordTools(asServer(server), asClient(client), "proj-1");
    mockRecords.history.mockResolvedValue({
      ok: true,
      history: [],
    });

    const handler = server.tool.mock.calls[6][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({
      type: "config",
      key: "main",
      limit: 10,
      values: true,
    });

    expect(mockRecords.history).toHaveBeenCalledWith("config", "main", {
      limit: 10,
      values: true,
    });
  });
});

describe("registerAllResources (record resources)", () => {
  let server: MockServer;
  let client: MockClient;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a resource for mcp_resource = true record type", async () => {
    const schemaDef = [
      "schema_version = 1",
      "[records.pipeline_config]",
      "mcp_resource = true",
      "",
      "[records.pipeline_config.fields]",
      'env = { type = "string" }',
    ].join("\n");

    client.get.mockResolvedValue({
      ok: true,
      schema: { definition: schemaDef },
    });

    await registerAllResources(asServer(server), asClient(client), "proj-1");

    // 4 static resources + 1 record resource
    const resourceCalls = server.resource.mock.calls;
    const recordResourceCall = resourceCalls.find(
      (call: unknown[]) => call[0] === "record-pipeline_config",
    );

    expect(recordResourceCall).toBeDefined();
    // Second argument should be a ResourceTemplate instance
    expect(recordResourceCall?.[1]).toBeDefined();
    expect(typeof recordResourceCall?.[1]).toBe("object");
  });

  it("does NOT register a resource for mcp_resource = false (default)", async () => {
    const schemaDef = [
      "schema_version = 1",
      "[records.internal_state]",
      "",
      "[records.internal_state.fields]",
      'status = { type = "string" }',
    ].join("\n");

    client.get.mockResolvedValue({
      ok: true,
      schema: { definition: schemaDef },
    });

    await registerAllResources(asServer(server), asClient(client), "proj-1");

    const resourceCalls = server.resource.mock.calls;
    const recordResourceCall = resourceCalls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].startsWith("record-"),
    );

    expect(recordResourceCall).toBeUndefined();
  });

  it("silently handles schema fetch failure", async () => {
    client.get.mockRejectedValue(new Error("Network error"));

    // Should not throw -- schema fetch failure is non-fatal
    await expect(
      registerAllResources(asServer(server), asClient(client), "proj-1"),
    ).resolves.not.toThrow();

    // Static resources are still registered (synchronous, before the async fetch)
    const resourceNames = server.resource.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(resourceNames).toContain("project-summary");
  });

  it("silently handles null schema", async () => {
    client.get.mockResolvedValue({
      ok: true,
      schema: null,
    });

    await expect(
      registerAllResources(asServer(server), asClient(client), "proj-1"),
    ).resolves.not.toThrow();
  });
});
