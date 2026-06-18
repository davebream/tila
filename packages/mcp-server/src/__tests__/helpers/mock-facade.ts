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

/**
 * Helper that returns an object with the GIVEN method names as `vi.fn()`s, typed
 * with those names as LITERAL keys (`Record<N, Mock>`) so the inferred return
 * type of {@link createMockFacade} carries each resource's exact method-key set.
 * That literal key set is what the {@link _MockMatchesFacade} drift guard below
 * checks against the real {@link TilaFacade}.
 */
function fns<const N extends string>(...names: N[]): Record<N, Mock> {
  const obj = {} as Record<N, Mock>;
  for (const n of names) obj[n] = vi.fn();
  return obj;
}

/**
 * The mock facade's EXACT shape: each resource is a `Record` keyed by its mocked
 * method names (literal string unions), each value a vitest `Mock`. This is an
 * explicit (nameable) annotation — TS would otherwise refuse to emit the
 * inferred type because it references vitest's internal `Mock` path (TS2742) —
 * AND it's what the {@link _MockMatchesFacade} drift guard checks against the
 * real {@link TilaFacade}. Keep these key unions in sync with the `fns(...)`
 * calls below; the drift guard catches the case where the FACADE adds a method
 * the mock lacks.
 */
export type MockFacadeShape = {
  tasks: Record<
    | "create"
    | "get"
    | "list"
    | "update"
    | "archive"
    | "addRelationship"
    | "listRelationships"
    | "ready"
    | "addArtifactRef"
    | "listArtifactRefs",
    Mock
  >;
  records: Record<
    | "create"
    | "set"
    | "put"
    | "get"
    | "patch"
    | "archive"
    | "unarchive"
    | "history"
    | "list"
    | "types"
    | "typesInUse",
    Mock
  >;
  claims: Record<"acquire" | "renew" | "release" | "list" | "get", Mock>;
  artifacts: Record<
    | "upload"
    | "download"
    | "writeText"
    | "readText"
    | "list"
    | "search"
    | "grep"
    | "getLatest"
    | "addRelationship"
    | "listRelationships",
    Mock
  >;
  gates: Record<"list" | "create" | "resolve" | "remove", Mock>;
  signals: Record<"inbox" | "send" | "ack", Mock>;
  journal: Record<"query", Mock>;
  presence: Record<"heartbeat" | "list" | "listAll", Mock>;
  schema: Record<"get" | "apply" | "history", Mock>;
  summary: Record<"get", Mock>;
  search: Record<"search", Mock>;
  indexes: Record<"create" | "addEntry" | "listEntries", Mock>;
  templates: Record<"instantiate" | "list", Mock>;
  tokens: Record<"issue" | "revoke" | "list", Mock>;
  close: Mock;
};

/**
 * Build a fully-mocked facade. Each resource method is an independent vi.fn().
 * The {@link _MockMatchesFacade} compile-time guard ties {@link MockFacadeShape}
 * to the real {@link TilaFacade}, turning mock drift (a facade method the mock
 * lacks) into a build error.
 */
export function createMockFacade(): MockFacadeShape {
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
      "put",
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
    indexes: fns("create", "addEntry", "listEntries"),
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

// ---------------------------------------------------------------------------
// Compile-time drift guard (mirrors the `_SurfaceMatch` mapped-type pattern in
// sdk/src/local/resource-adapters.ts). The mock hand-enumerates resource method
// names; without this guard, a NEW or RENAMED method on the real `TilaFacade`
// would leave the mock silently stale (tools hitting the new method get
// `undefined`). Here, for every facade resource, we require the mock's
// method-key set to be a SUPERSET of the facade's — a missing key turns the
// matching property to `never`, so assigning `true` below fails to compile.
// Using a PER-RESOURCE mapped type names the offending resource at the failing
// property instead of an opaque whole-object error.
// ---------------------------------------------------------------------------
type _MockMatchesFacade = {
  [K in keyof TilaFacade as K extends "close"
    ? never
    : K]: K extends keyof MockFacadeShape
    ? keyof TilaFacade[K] extends keyof MockFacadeShape[K]
      ? true
      : never
    : never;
};

const _assertMockMatchesFacade: _MockMatchesFacade = {
  tasks: true,
  records: true,
  claims: true,
  artifacts: true,
  gates: true,
  signals: true,
  journal: true,
  presence: true,
  schema: true,
  summary: true,
  search: true,
  indexes: true,
  templates: true,
  tokens: true,
};
void _assertMockMatchesFacade;

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
