import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: vi.fn().mockReturnValue({
    client: { get: mockGet, post: vi.fn(), delete: vi.fn() },
    config: { project_id: "proj-test" },
    entity: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
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

const loadCommand = async () => {
  const mod = await import("../../commands/token");
  return mod.default;
};

function getSubCommand(cmd: CommandDef, name: string): CommandDef {
  const subs = cmd.subCommands;
  if (!subs || typeof subs === "function" || subs instanceof Promise)
    throw new Error("no subCommands");
  const sub = (subs as SubCommandsDef)[name];
  if (!sub || typeof sub === "function" || sub instanceof Promise)
    throw new Error(`no ${name}`);
  return sub;
}

async function runCmd(
  cmd: CommandDef,
  args: Record<string, unknown>,
): Promise<void> {
  if (!cmd.run) throw new Error("no run");
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

describe("tila token list --json", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("outputs tokens with ISO 8601 timestamps (epoch seconds x1000 conversion)", async () => {
    mockGet.mockResolvedValue({
      tokens: [
        {
          name: "my-token",
          scopes: "full",
          created_at: 1700000000,
          last_used_at: 1700000100,
          revoked_at: null,
        },
      ],
    });
    const cmd = await loadCommand();
    const listCmd = getSubCommand(cmd, "list");
    await runCmd(listCmd, { json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.tokens).toHaveLength(1);
    // Verify epoch seconds were converted (not epoch ms)
    // 1700000000 seconds = 2023-11-14T22:13:20.000Z
    expect(output.tokens[0].created_at).toBe("2023-11-14T22:13:20.000Z");
    expect(output.tokens[0].last_used_at).toBe("2023-11-14T22:15:00.000Z");
    expect(output.tokens[0].revoked_at).toBeNull();
  });
});
