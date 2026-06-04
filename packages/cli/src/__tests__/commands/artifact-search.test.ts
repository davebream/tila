import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock context before importing the module under test
const mockSearchArtifacts = vi.fn();
vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: vi.fn().mockReturnValue({
    client: {},
    config: { project_id: "proj-abc" },
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
    artifact: {
      put: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      searchArtifacts: mockSearchArtifacts,
    },
    journal: { listJournal: vi.fn() },
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

// Dynamic import so mocks are in place before module loads
const loadCommand = async () => {
  const mod = await import("../../commands/artifact");
  return mod.default;
};

/**
 * Typed accessor for Citty sub-commands. Narrows Resolvable<SubCommandsDef>
 * to a plain object and returns the named sub-command as CommandDef.
 */
function getSubCommand(cmd: CommandDef, name: string): CommandDef {
  const subs = cmd.subCommands;
  if (!subs || typeof subs === "function" || subs instanceof Promise) {
    throw new Error("subCommands is not a plain object on command");
  }
  const sub = (subs as SubCommandsDef)[name];
  if (!sub || typeof sub === "function" || sub instanceof Promise) {
    throw new Error(`subCommand "${name}" is not a plain CommandDef`);
  }
  return sub;
}

/** Args shape for the artifact search sub-command. */
interface SearchArgs {
  query: string;
  kind: string | undefined;
  resource: string | undefined;
  limit: string | undefined;
  json: boolean;
}

/**
 * Invokes the run function of a CommandDef with typed args.
 * Asserts that run is defined (safe for sub-commands that always define run).
 */
async function runCmd(cmd: CommandDef, args: SearchArgs): Promise<void> {
  if (!cmd.run) {
    throw new Error("Command has no run function");
  }
  type RunFn = (ctx: {
    rawArgs: string[];
    args: SearchArgs & { _: string[] };
    cmd: CommandDef;
  }) => Promise<void>;
  await (cmd.run as unknown as RunFn)({
    rawArgs: [],
    args: { ...args, _: [] },
    cmd,
  });
}

describe("tila artifact search", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockSearchArtifacts.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const searchResult = (overrides = {}) => [
    {
      r2_key: "produced/T-1/abc123.md",
      kind: "lesson",
      title: null,
      snippet: "matched text here",
      ...overrides,
    },
  ];

  it("calls searchArtifacts with correct query params", async () => {
    mockSearchArtifacts.mockResolvedValue(searchResult());
    const cmd = await loadCommand();
    const searchCmd = getSubCommand(cmd, "search");
    await runCmd(searchCmd, {
      query: "test query",
      kind: undefined,
      resource: undefined,
      limit: undefined,
      json: false,
    });

    expect(mockSearchArtifacts).toHaveBeenCalledWith({
      q: "test query",
      kind: undefined,
      resource: undefined,
      limit: undefined,
    });
  });

  it("renders human-readable output with snippet", async () => {
    mockSearchArtifacts.mockResolvedValue(
      searchResult({ snippet: "found it" }),
    );
    const cmd = await loadCommand();
    const searchCmd = getSubCommand(cmd, "search");
    await runCmd(searchCmd, {
      query: "test",
      kind: undefined,
      resource: undefined,
      limit: undefined,
      json: false,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("produced/T-1/abc123.md  lesson"),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("found it"));
  });

  it("renders title when present", async () => {
    mockSearchArtifacts.mockResolvedValue(searchResult({ title: "My Note" }));
    const cmd = await loadCommand();
    const searchCmd = getSubCommand(cmd, "search");
    await runCmd(searchCmd, {
      query: "test",
      kind: undefined,
      resource: undefined,
      limit: undefined,
      json: false,
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("My Note"));
  });

  it("prints No results found when results array is empty", async () => {
    mockSearchArtifacts.mockResolvedValue([]);
    const cmd = await loadCommand();
    const searchCmd = getSubCommand(cmd, "search");
    await runCmd(searchCmd, {
      query: "nonexistent",
      kind: undefined,
      resource: undefined,
      limit: undefined,
      json: false,
    });

    expect(logSpy).toHaveBeenCalledWith("No results found.");
  });

  it("outputs JSON when --json flag is set", async () => {
    const results = searchResult();
    mockSearchArtifacts.mockResolvedValue(results);
    const cmd = await loadCommand();
    const searchCmd = getSubCommand(cmd, "search");
    await runCmd(searchCmd, {
      query: "test",
      kind: undefined,
      resource: undefined,
      limit: undefined,
      json: true,
    });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.results).toHaveLength(1);
    expect(output.results[0].r2_key).toBe("produced/T-1/abc123.md");
  });

  it("forwards --kind filter to searchArtifacts", async () => {
    mockSearchArtifacts.mockResolvedValue(searchResult());
    const cmd = await loadCommand();
    const searchCmd = getSubCommand(cmd, "search");
    await runCmd(searchCmd, {
      query: "test",
      kind: "lesson",
      resource: undefined,
      limit: undefined,
      json: false,
    });

    expect(mockSearchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "lesson" }),
    );
  });

  it("forwards --resource filter to searchArtifacts", async () => {
    mockSearchArtifacts.mockResolvedValue(searchResult());
    const cmd = await loadCommand();
    const searchCmd = getSubCommand(cmd, "search");
    await runCmd(searchCmd, {
      query: "test",
      kind: undefined,
      resource: "T-42",
      limit: undefined,
      json: false,
    });

    expect(mockSearchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ resource: "T-42" }),
    );
  });

  it("forwards --limit to searchArtifacts as number", async () => {
    mockSearchArtifacts.mockResolvedValue(searchResult());
    const cmd = await loadCommand();
    const searchCmd = getSubCommand(cmd, "search");
    await runCmd(searchCmd, {
      query: "test",
      kind: undefined,
      resource: undefined,
      limit: "5",
      json: false,
    });

    expect(mockSearchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it("propagates error from searchArtifacts", async () => {
    mockSearchArtifacts.mockRejectedValue(new Error("Worker unreachable"));
    const cmd = await loadCommand();
    const searchCmd = getSubCommand(cmd, "search");

    await expect(
      runCmd(searchCmd, {
        query: "test",
        kind: undefined,
        resource: undefined,
        limit: undefined,
        json: false,
      }),
    ).rejects.toThrow("Worker unreachable");
  });
});
