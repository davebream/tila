import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
const mockList = vi.fn();
const mockGet = vi.fn();

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: vi.fn().mockReturnValue({
    client: {
      get: vi.fn().mockResolvedValue({
        ok: true,
        entities: [],
        total: 0,
        limit: null,
        offset: 0,
        has_more: false,
      }),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    config: { project_id: "proj-test" },
    entity: {
      create: mockCreate,
      get: mockGet,
      list: mockList,
      update: vi.fn(),
      archive: vi.fn(),
    },
    coordination: {
      acquire: vi.fn(),
      renew: vi.fn(),
      release: vi.fn(),
      state: vi.fn(),
      heartbeat: vi.fn(),
      listPresence: vi.fn(),
    },
    artifact: { put: vi.fn(), get: vi.fn(), list: vi.fn(), delete: vi.fn() },
  }),
}));

// Mock yocto-spinner so withSpinner doesn't hang in tests
vi.mock("yocto-spinner", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    error: vi.fn().mockReturnThis(),
  })),
}));

const loadCommand = async () => {
  const mod = await import("../../commands/entity");
  return mod.default;
};

function getSubCommand(cmd: CommandDef, ...path: string[]): CommandDef {
  let current = cmd;
  for (const name of path) {
    const subs = current.subCommands;
    if (!subs || typeof subs === "function" || subs instanceof Promise) {
      throw new Error("subCommands is not a plain object");
    }
    const sub = (subs as SubCommandsDef)[name];
    if (!sub || typeof sub === "function" || sub instanceof Promise) {
      throw new Error(`subCommand "${name}" not found`);
    }
    current = sub;
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
  await (cmd.run as RunFn)({
    rawArgs: [],
    args: { _: [], ...args },
    cmd,
  });
}

describe("entity command --json (deprecated alias for task)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("entity command is a deprecation wrapper with task subCommands", async () => {
    const cmd = await loadCommand();
    expect(cmd.subCommands).toBeDefined();
    // Should have the same subCommands as task (new, list, show, update, etc.)
    const subs = cmd.subCommands as SubCommandsDef;
    expect(subs).toHaveProperty("new");
    expect(subs).toHaveProperty("list");
    expect(subs).toHaveProperty("show");
    expect(subs).toHaveProperty("tree");
  });

  it("entity new --json outputs created entity", async () => {
    const entity = {
      id: "E-test",
      type: "epic",
      schema_version: 1,
      data: { title: "Test Epic", status: "open" },
      archived: 0,
      created_at: 1000,
      updated_at: 1000,
      created_by: "cli",
    };
    mockCreate.mockResolvedValue(entity);
    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "new");
    await runCmd(sub, { title: "Test Epic", json: true });
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output.ok).toBe(true);
    expect(output.id).toBeDefined();
  });

  it("entity list --json outputs entities array", async () => {
    mockList.mockResolvedValue([]);
    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "list");
    await runCmd(sub, { json: true });
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output.entities).toEqual([]);
  });

  it("entity show --json outputs entity", async () => {
    const entity = {
      id: "T-1",
      type: "task",
      schema_version: 1,
      data: { title: "Test", status: "open" },
      archived: 0,
      created_at: 1000,
      updated_at: 1000,
      created_by: "cli",
    };
    mockGet.mockResolvedValue(entity);
    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "show");
    await runCmd(sub, { id: "T-1", json: true });
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output.id).toBe("T-1");
  });
});
