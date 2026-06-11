/**
 * Remote-mode `--parent` filter regression guard.
 *
 * Wires the `task list` command onto a REAL `RemoteBackend` over a mocked
 * `TilaClient`, then asserts the OUTGOING request query carries the `parent`
 * query param the Worker actually reads (NOT `parent_id`). This directly
 * guards the regression where the CLI built `dataFilter: { parent_id }` and
 * the Worker silently dropped it, returning ALL tasks.
 */

import { RemoteBackend, type TilaClient } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("yocto-spinner", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    error: vi.fn().mockReturnThis(),
  })),
}));

const mockResolveContext = vi.fn();
vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: () => mockResolveContext(),
}));

function createMockClient() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
    request: vi.fn(),
    requestRaw: vi.fn(),
    postFormData: vi.fn(),
  };
}

import type { CommandDef, SubCommandsDef } from "citty";

const loadCommand = async () => (await import("../../commands/task")).default;

function getSubCommand(cmd: CommandDef, ...path: string[]): CommandDef {
  let current = cmd;
  for (const name of path) {
    const subs = current.subCommands as SubCommandsDef;
    current = subs[name] as CommandDef;
  }
  return current;
}

async function runCmd(
  cmd: CommandDef,
  args: Record<string, unknown>,
): Promise<void> {
  if (!cmd.run) throw new Error("No run function");
  type RunFn = (ctx: {
    rawArgs: string[];
    args: Record<string, unknown> & { _: string[] };
    cmd: CommandDef;
  }) => void | Promise<void>;
  await (cmd.run as RunFn)({ rawArgs: [], args: { _: [], ...args }, cmd });
}

describe("task list --parent (remote mode, real RemoteBackend)", () => {
  let client: ReturnType<typeof createMockClient>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
    const remote = new RemoteBackend(client as unknown as TilaClient, "proj-x");
    mockResolveContext.mockReturnValue({
      config: { project_id: "proj-x" },
      client,
      machine: "m",
      entity: remote,
      coordination: remote,
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("non-compact sends parent=X (not parent_id) to the Worker", async () => {
    client.get.mockResolvedValue({
      ok: true,
      entities: [],
      total: 0,
      limit: null,
      offset: 0,
      has_more: false,
    });

    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "list"), { parent: "P-1", json: true });

    const [, opts] = client.get.mock.calls[0];
    const query = (opts as { query: Record<string, string> }).query;
    expect(query.parent).toBe("P-1");
    expect(query).not.toHaveProperty("parent_id");
  });

  it("compact sends parent=X (not parent_id) to the Worker", async () => {
    // The compact path calls entity.list() (tasks) then
    // coordination.listClaims() (claims); route the mock by URL.
    client.get.mockImplementation((url: string) => {
      if (url.endsWith("/claims")) {
        return Promise.resolve({ ok: true, claims: [] });
      }
      return Promise.resolve({
        ok: true,
        entities: [],
        total: 0,
        limit: null,
        offset: 0,
        has_more: false,
      });
    });

    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "list"), {
      compact: true,
      parent: "P-1",
      json: true,
    });

    // The compact path calls entity.list() then coordination.listClaims().
    const listCall = client.get.mock.calls.find(
      (call) => (call[0] as string) === "/projects/proj-x/tasks",
    );
    expect(listCall).toBeDefined();
    const query = (listCall?.[1] as { query: Record<string, string> }).query;
    expect(query.parent).toBe("P-1");
    expect(query).not.toHaveProperty("parent_id");
  });
});
