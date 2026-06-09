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

describe("registerArtifactTools — tags", () => {
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

  it("tila_artifact_put schema includes an optional tags field", () => {
    const putCall = server.tool.mock.calls.find(
      (c: unknown[]) => c[0] === "tila_artifact_put",
    );
    if (!putCall) throw new Error("tila_artifact_put not found");
    const schema = putCall[2] as Record<string, unknown>;
    expect(schema).toHaveProperty("tags");
  });

  it("tila_artifact_put passes tags to FormData when provided", async () => {
    client.postFormData.mockResolvedValue({
      ok: true,
      key: "sources/abc.txt",
      bytes: 5,
      dedup: false,
    });

    const handler = findHandler("tila_artifact_put");
    // base64 for "hello"
    await handler({
      content: "aGVsbG8=",
      kind: "log",
      mime_type: "text/plain",
      tags: ["team:eng", "env:prod"],
    });

    const formData = client.postFormData.mock.calls[0][1] as FormData;
    expect(formData.get("tags")).toBe(JSON.stringify(["team:eng", "env:prod"]));
  });

  it("tila_artifact_put omits tags from FormData when not provided", async () => {
    client.postFormData.mockResolvedValue({ ok: true });

    const handler = findHandler("tila_artifact_put");
    await handler({
      content: "aGVsbG8=",
      kind: "log",
      mime_type: "application/octet-stream",
    });

    const formData = client.postFormData.mock.calls[0][1] as FormData;
    expect(formData.get("tags")).toBeNull();
  });

  it("tila_artifact_write_text schema includes an optional tags field", () => {
    const writeCall = server.tool.mock.calls.find(
      (c: unknown[]) => c[0] === "tila_artifact_write_text",
    );
    if (!writeCall) throw new Error("tila_artifact_write_text not found");
    const schema = writeCall[2] as Record<string, unknown>;
    expect(schema).toHaveProperty("tags");
  });

  it("tila_artifact_write_text passes tags to client.post body when provided", async () => {
    client.post.mockResolvedValue({
      ok: true,
      key: "sources/abc.md",
      bytes: 12,
    });

    const handler = findHandler("tila_artifact_write_text");
    await handler({
      content: "# My Plan",
      kind: "plan",
      mime_type: "text/markdown",
      tags: ["repo:api"],
    });

    const callBody = client.post.mock.calls[0][1] as Record<string, unknown>;
    expect(callBody.tags).toEqual(["repo:api"]);
  });

  it("tila_artifact_write_text omits tags from body when not provided", async () => {
    client.post.mockResolvedValue({ ok: true });

    const handler = findHandler("tila_artifact_write_text");
    await handler({ content: "x", kind: "log", mime_type: "text/plain" });

    const callBody = client.post.mock.calls[0][1] as Record<string, unknown>;
    expect(callBody.tags).toBeUndefined();
  });
});
