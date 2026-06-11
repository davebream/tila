import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAllResources } from "../resources/index";
import { registerRecordTools } from "../tools/records";
import {
  type MockFacade,
  type MockServer,
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
} from "./helpers/mock-facade";

describe("registerRecordTools", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers exactly 8 tools with correct names", () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");

    expect(server.tool).toHaveBeenCalledTimes(8);

    const toolNames = server.tool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toEqual([
      "tila_record_get",
      "tila_record_set",
      "tila_record_put",
      "tila_record_patch",
      "tila_record_list",
      "tila_record_archive",
      "tila_record_unarchive",
      "tila_record_history",
    ]);
  });

  it("tila_record_get calls records.get with type and key", async () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");
    facade.records.get.mockResolvedValue({
      ok: true,
      record: { type: "config", key: "main", value: {} },
      fence: 1,
    });

    const handler = server.tool.mock.calls[0][3] as (
      args: unknown,
    ) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({ type: "config", key: "main" });

    expect(facade.records.get).toHaveBeenCalledWith("config", "main");
    expect(result.content[0].text).toContain('"ok":true');
  });

  it("tila_record_set calls records.set with value and fence", async () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");
    facade.records.set.mockResolvedValue({ ok: true, fence: 2 });

    const handler = server.tool.mock.calls[1][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({
      type: "config",
      key: "main",
      value: { env: "prod" },
      fence: 1,
    });

    expect(facade.records.set).toHaveBeenCalledWith("config", "main", {
      value: { env: "prod" },
      fence: 1,
    });
  });

  it("tila_record_put creates on a missing key and returns fence/revision", async () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");
    facade.records.put.mockResolvedValue({ ok: true, fence: 1, revision: 1 });

    const handler = server.tool.mock.calls[2][3] as (
      args: unknown,
    ) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({
      type: "config",
      key: "env/staging",
      value: { env: "staging" },
    });

    expect(facade.records.put).toHaveBeenCalledWith("config", "env/staging", {
      value: { env: "staging" },
      tags: undefined,
      message: undefined,
    });
    expect(result.content[0].text).toContain('"revision":1');
    expect(result.content[0].text).toContain('"fence":1');
  });

  it("tila_record_put replaces on an existing key (no fence required)", async () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");
    facade.records.put.mockResolvedValue({ ok: true, fence: 7, revision: 2 });

    const handler = server.tool.mock.calls[2][3] as (
      args: unknown,
    ) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({
      type: "config",
      key: "main",
      value: { env: "prod" },
      tags: ["stable"],
      message: "promote",
    });

    expect(facade.records.put).toHaveBeenCalledWith("config", "main", {
      value: { env: "prod" },
      tags: ["stable"],
      message: "promote",
    });
    expect(result.content[0].text).toContain('"revision":2');
  });

  it("tila_record_put maps a schema-invalid value through toMcpError", async () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");
    facade.records.put.mockRejectedValue(
      Object.assign(new Error("record value invalid"), {
        code: "record_value_invalid",
      }),
    );

    const handler = server.tool.mock.calls[2][3] as (
      args: unknown,
    ) => Promise<unknown>;

    await expect(
      handler({ type: "config", key: "main", value: { bad: true } }),
    ).rejects.toThrow();
  });

  it("tila_record_patch calls records.patch with patch and fence", async () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");
    facade.records.patch.mockResolvedValue({ ok: true, fence: 3 });

    const handler = server.tool.mock.calls[3][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({
      type: "config",
      key: "main",
      patch: { env: "staging" },
      fence: 2,
    });

    expect(facade.records.patch).toHaveBeenCalledWith("config", "main", {
      patch: { env: "staging" },
      fence: 2,
    });
  });

  it("tila_record_list converts include_archived boolean to string", async () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");
    facade.records.list.mockResolvedValue({
      ok: true,
      records: [],
      total: 0,
    });

    const handler = server.tool.mock.calls[4][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({
      type: "config",
      tag: "stable",
      include_archived: true,
    });

    expect(facade.records.list).toHaveBeenCalledWith("config", {
      tag: "stable",
      filter: undefined,
      "include-archived": "true",
    });
  });

  it("tila_record_archive calls records.archive with fence", async () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");
    facade.records.archive.mockResolvedValue({ ok: true, fence: 4 });

    const handler = server.tool.mock.calls[5][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({ type: "config", key: "main", fence: 3 });

    expect(facade.records.archive).toHaveBeenCalledWith("config", "main", {
      fence: 3,
    });
  });

  it("tila_record_unarchive calls records.unarchive with fence", async () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");
    facade.records.unarchive.mockResolvedValue({ ok: true, fence: 5 });

    const handler = server.tool.mock.calls[6][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({ type: "config", key: "main", fence: 4 });

    expect(facade.records.unarchive).toHaveBeenCalledWith("config", "main", {
      fence: 4,
    });
  });

  it("tila_record_history passes limit and values opts", async () => {
    registerRecordTools(asServer(server), asFacade(facade), "proj-1");
    facade.records.history.mockResolvedValue({
      ok: true,
      history: [],
    });

    const handler = server.tool.mock.calls[7][3] as (
      args: unknown,
    ) => Promise<unknown>;
    await handler({
      type: "config",
      key: "main",
      limit: 10,
      values: true,
    });

    expect(facade.records.history).toHaveBeenCalledWith("config", "main", {
      limit: 10,
      values: true,
    });
  });

  describe("tila_record_list tag_filter", () => {
    it("forwards tag_filter array as tagFilter to records.list when provided", async () => {
      registerRecordTools(asServer(server), asFacade(facade), "proj-1");
      facade.records.list.mockResolvedValue({
        ok: true,
        records: [],
        total: 0,
      });

      const handler = server.tool.mock.calls[4][3] as (
        args: unknown,
      ) => Promise<unknown>;
      await handler({ type: "config", tag_filter: ["repo:a", "team:x"] });

      expect(facade.records.list).toHaveBeenCalledWith(
        "config",
        expect.objectContaining({ tagFilter: ["repo:a", "team:x"] }),
      );
    });

    it("omits tagFilter from records.list when tag_filter is not provided", async () => {
      registerRecordTools(asServer(server), asFacade(facade), "proj-1");
      facade.records.list.mockResolvedValue({
        ok: true,
        records: [],
        total: 0,
      });

      const handler = server.tool.mock.calls[4][3] as (
        args: unknown,
      ) => Promise<unknown>;
      await handler({ type: "config" });

      const callArgs = facade.records.list.mock.calls[0];
      const query = callArgs[1] as Record<string, unknown>;
      expect(query).not.toHaveProperty("tagFilter");
    });

    it("accepts tag_filter with invalid grammar (permissive — validation is worker's job)", () => {
      registerRecordTools(asServer(server), asFacade(facade), "proj-1");
      const { z } = require("zod");
      const listCall = server.tool.mock.calls[4];
      const schema = listCall[2] as Record<string, import("zod").ZodTypeAny>;
      const result = z
        .object(schema)
        .safeParse({ type: "config", tag_filter: ["bad tag!"] });
      expect(result.success).toBe(true);
    });
  });
});

describe("registerAllResources (record resources)", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
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

    facade.schema.get.mockResolvedValue({
      ok: true,
      schema: { definition: schemaDef },
    });

    await registerAllResources(asServer(server), asFacade(facade), "proj-1");

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

    facade.schema.get.mockResolvedValue({
      ok: true,
      schema: { definition: schemaDef },
    });

    await registerAllResources(asServer(server), asFacade(facade), "proj-1");

    const resourceCalls = server.resource.mock.calls;
    const recordResourceCall = resourceCalls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].startsWith("record-"),
    );

    expect(recordResourceCall).toBeUndefined();
  });

  it("silently handles schema fetch failure", async () => {
    facade.schema.get.mockRejectedValue(new Error("Network error"));

    // Should not throw -- schema fetch failure is non-fatal
    await expect(
      registerAllResources(asServer(server), asFacade(facade), "proj-1"),
    ).resolves.not.toThrow();

    // Static resources are still registered (synchronous, before the async fetch)
    const resourceNames = server.resource.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(resourceNames).toContain("project-summary");
  });

  it("silently handles null schema", async () => {
    facade.schema.get.mockResolvedValue({
      ok: true,
      schema: null,
    });

    await expect(
      registerAllResources(asServer(server), asFacade(facade), "proj-1"),
    ).resolves.not.toThrow();
  });
});
