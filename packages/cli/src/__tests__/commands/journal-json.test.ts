import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockListJournal = vi.fn();

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: vi.fn().mockReturnValue({
    client: {},
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
      listClaims: vi.fn(),
    },
    artifact: { put: vi.fn(), get: vi.fn(), list: vi.fn(), delete: vi.fn() },
    journal: { listJournal: mockListJournal },
    gate: {
      createGate: vi.fn(),
      listGates: vi.fn(),
      resolveGate: vi.fn(),
      cancelGate: vi.fn(),
    },
    signal: {
      sendSignal: vi.fn(),
      listSignals: vi.fn(),
      ackSignal: vi.fn(),
    },
    schema: {
      getCurrentSchema: vi.fn(),
      applySchema: vi.fn(),
    },
    summary: { getSummary: vi.fn() },
  }),
}));

const loadCommand = async () => {
  const mod = await import("../../commands/journal");
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

describe("tila journal tail --json", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockListJournal.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("outputs events with ISO 8601 timestamps when --json", async () => {
    mockListJournal.mockResolvedValue([
      {
        seq: 1,
        t: 1700000000000,
        kind: "entity.created",
        resource: "T-1",
        actor: "cli",
        fence: null,
      },
    ]);
    const cmd = await loadCommand();
    const tailCmd = getSubCommand(cmd, "tail");
    await runCmd(tailCmd, {
      resource: undefined,
      kind: undefined,
      limit: "20",
      json: true,
    });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.events).toHaveLength(1);
    expect(output.events[0].t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mockListJournal).toHaveBeenCalledWith({
      resource: undefined,
      kind: undefined,
      limit: 20,
    });
  });
});
