import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock yocto-spinner so withSpinner doesn't hang in tests
vi.mock("yocto-spinner", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    error: vi.fn().mockReturnThis(),
  })),
}));

const mockClientGet = vi.fn();
const mockClientPost = vi.fn();
const mockClientPatch = vi.fn();
const mockClientDelete = vi.fn();
const mockEntityCreate = vi.fn();
const mockEntityGet = vi.fn();
const mockEntityList = vi.fn();

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: vi.fn().mockImplementation(() => ({
    client: {
      get: mockClientGet,
      post: mockClientPost,
      patch: mockClientPatch,
      delete: mockClientDelete,
    },
    config: { project_id: "proj-test" },
    entity: {
      create: mockEntityCreate,
      get: mockEntityGet,
      list: mockEntityList,
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
  })),
}));

const loadCommand = async () => {
  const mod = await import("../../commands/work-unit");
  return mod.default;
};

function getSubCommand(cmd: CommandDef, ...path: string[]): CommandDef {
  let current = cmd;
  for (const name of path) {
    const subs = current.subCommands;
    if (!subs || typeof subs === "function" || subs instanceof Promise) {
      throw new Error("subCommands is not a plain object on command");
    }
    const sub = (subs as SubCommandsDef)[name];
    if (!sub || typeof sub === "function" || sub instanceof Promise) {
      throw new Error(`subCommand "${name}" is not a plain CommandDef`);
    }
    current = sub;
  }
  return current;
}

async function runCmd(
  cmd: CommandDef,
  args: Record<string, unknown>,
): Promise<void> {
  if (!cmd.run) throw new Error("Command has no run function");
  type RunFn = (ctx: {
    rawArgs: string[];
    args: Record<string, unknown> & { _: string[] };
    cmd: CommandDef;
  }) => Promise<void>;
  await (cmd.run as unknown as RunFn)({
    rawArgs: [],
    args: { ...args, _: [] },
    cmd,
  });
}

describe("tila work-unit --json (deprecated alias for task)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockEntityCreate.mockReset();
    mockEntityGet.mockReset();
    mockEntityList.mockReset();
    mockClientGet.mockReset();
    mockClientPost.mockReset();
    mockClientPatch.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("work-unit command is a deprecation wrapper with task subCommands", async () => {
    const cmd = await loadCommand();
    expect(cmd.subCommands).toBeDefined();
    const subs = cmd.subCommands as SubCommandsDef;
    expect(subs).toHaveProperty("new");
    expect(subs).toHaveProperty("list");
    expect(subs).toHaveProperty("show");
    expect(subs).toHaveProperty("tree");
  });

  it("work-unit new --json creates via task entity backend", async () => {
    mockEntityCreate.mockResolvedValue({
      id: "T-test1",
      type: "task",
      schema_version: 1,
      data: { title: "My task", status: "open" },
      archived: 0,
      created_at: 1000,
      updated_at: 1000,
      created_by: "cli",
    });
    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "new");
    await runCmd(sub, { title: "My task", json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.ok).toBe(true);
  });

  it("work-unit list --json returns entity list via entity backend", async () => {
    mockEntityList.mockResolvedValue([]);
    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "list");
    await runCmd(sub, { json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.entities).toEqual([]);
  });

  it("work-unit show --json returns entity via entity backend", async () => {
    const entityData = {
      id: "T-1",
      type: "task",
      schema_version: 1,
      data: { title: "Test", status: "open" },
      archived: 0,
      created_at: 1000,
      updated_at: 1000,
      created_by: "cli",
    };
    mockEntityGet.mockResolvedValue(entityData);

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "show");
    await runCmd(sub, { id: "T-1", json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.id).toBe("T-1");
  });
});
