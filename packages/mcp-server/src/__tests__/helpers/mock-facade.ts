import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { type Mock, vi } from "vitest";

export type MockServer = {
  tool: Mock;
  resource: Mock;
  prompt: Mock;
};

/**
 * A {@link TilaFacade} whose every resource method is a `vi.fn()` mock, so tests
 * can assert which facade method a tool calls (and with what args) instead of
 * the old raw `client.get/post(path)` assertions. The shape mirrors the real
 * facade so tool handlers run unchanged.
 */
export type MockFacade = {
  [K in keyof TilaFacade]: K extends "close"
    ? () => void
    : Record<string, Mock>;
};

export function createMockServer(): MockServer {
  return { tool: vi.fn(), resource: vi.fn(), prompt: vi.fn() };
}

/** Build a fully-mocked facade. Each resource method is an independent vi.fn(). */
export function createMockFacade(): MockFacade {
  const fns = (...names: string[]): Record<string, Mock> => {
    const obj: Record<string, Mock> = {};
    for (const n of names) obj[n] = vi.fn();
    return obj;
  };

  return {
    tasks: fns(
      "create",
      "get",
      "list",
      "update",
      "archive",
      "addRelationship",
      "listRelationships",
      "ready",
      "addArtifactRef",
      "listArtifactRefs",
    ),
    records: fns(
      "create",
      "set",
      "get",
      "patch",
      "archive",
      "unarchive",
      "history",
      "list",
      "types",
      "typesInUse",
    ),
    claims: fns("acquire", "renew", "release", "list", "get"),
    artifacts: fns(
      "upload",
      "download",
      "writeText",
      "readText",
      "list",
      "search",
      "grep",
      "getLatest",
      "addRelationship",
      "listRelationships",
    ),
    gates: fns("list", "create", "resolve", "remove"),
    signals: fns("inbox", "send", "ack"),
    journal: fns("query"),
    presence: fns("heartbeat", "list", "listAll"),
    schema: fns("get", "apply", "history"),
    summary: fns("get"),
    search: fns("search"),
    templates: fns("instantiate", "list"),
    tokens: fns("issue", "revoke", "list"),
    close: vi.fn(),
  };
}

export function asServer(s: MockServer): McpServer {
  return s as unknown as McpServer;
}

export function asFacade(f: MockFacade): TilaFacade {
  return f as unknown as TilaFacade;
}

/** Find a registered tool handler by name (the 4th `server.tool` arg). */
export function findToolHandler(
  server: MockServer,
  name: string,
): (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const call = server.tool.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!call) throw new Error(`Tool ${name} not found`);
  // Handler is always the LAST argument (name, [description], [schema], handler).
  return call[call.length - 1] as (args: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}
