import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock context before importing the module under test
const mockGrepArtifacts = vi.fn();
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
      searchArtifacts: vi.fn(),
      grepArtifacts: mockGrepArtifacts,
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
 * Typed accessor for Citty sub-commands.
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

/** Args shape for the artifact grep sub-command. */
interface GrepArgs {
  pattern: string;
  kind: string | undefined;
  resource: string | undefined;
  regex: boolean;
  limit: string | undefined;
  json: boolean;
}

async function runCmd(cmd: CommandDef, args: GrepArgs): Promise<void> {
  if (!cmd.run) {
    throw new Error("Command has no run function");
  }
  type RunFn = (ctx: {
    rawArgs: string[];
    args: GrepArgs & { _: string[] };
    cmd: CommandDef;
  }) => Promise<void>;
  await (cmd.run as unknown as RunFn)({
    rawArgs: [],
    args: { ...args, _: [] },
    cmd,
  });
}

const makeGrepResponse = (
  overrides?: Partial<{
    results: Array<{
      key: string;
      kind: string;
      resource: string | null;
      lines: Array<{ line: number; text: string; col: number }>;
      truncated?: boolean;
    }>;
    scanned: number;
    skipped: number;
    truncated: boolean;
  }>,
) => ({
  ok: true as const,
  results: [
    {
      key: "produced/T-1/abc.md",
      kind: "plan",
      resource: null,
      lines: [
        { line: 3, text: "hello world", col: 1 },
        { line: 7, text: "hello again", col: 5 },
      ],
    },
  ],
  scanned: 1,
  skipped: 0,
  truncated: false,
  ...overrides,
});

describe("tila artifact grep", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGrepArtifacts.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("calls grepArtifacts with correct params", async () => {
    mockGrepArtifacts.mockResolvedValue(makeGrepResponse());
    const cmd = await loadCommand();
    const grepCmd = getSubCommand(cmd, "grep");
    await runCmd(grepCmd, {
      pattern: "hello",
      kind: undefined,
      resource: undefined,
      regex: false,
      limit: undefined,
      json: false,
    });

    expect(mockGrepArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: "hello" }),
    );
  });

  it("renders human-readable output as key:line: text per matching line", async () => {
    mockGrepArtifacts.mockResolvedValue(makeGrepResponse());
    const cmd = await loadCommand();
    const grepCmd = getSubCommand(cmd, "grep");
    await runCmd(grepCmd, {
      pattern: "hello",
      kind: undefined,
      resource: undefined,
      regex: false,
      limit: undefined,
      json: false,
    });

    // Each matching line should be printed as key:line: text
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("produced/T-1/abc.md:3: hello world"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("produced/T-1/abc.md:7: hello again"),
    );
  });

  it("outputs raw JSON response when --json flag is set", async () => {
    const resp = makeGrepResponse();
    mockGrepArtifacts.mockResolvedValue(resp);
    const cmd = await loadCommand();
    const grepCmd = getSubCommand(cmd, "grep");
    await runCmd(grepCmd, {
      pattern: "hello",
      kind: undefined,
      resource: undefined,
      regex: false,
      limit: undefined,
      json: true,
    });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.ok).toBe(true);
    expect(output.results).toHaveLength(1);
    expect(output.results[0].key).toBe("produced/T-1/abc.md");
  });

  it("exits with error when backend lacks grepArtifacts capability", async () => {
    // Override context to not have grepArtifacts
    const { resolveContext } = await import("../../context");
    (resolveContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
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
        searchArtifacts: vi.fn(),
        // grepArtifacts is absent
      },
      journal: { listJournal: vi.fn() },
      gate: {
        createGate: vi.fn(),
        listGates: vi.fn(),
        resolveGate: vi.fn(),
        cancelGate: vi.fn(),
      },
      signal: { sendSignal: vi.fn(), listSignals: vi.fn(), ackSignal: vi.fn() },
      schema: { getCurrentSchema: vi.fn(), applySchema: vi.fn() },
      summary: { getSummary: vi.fn() },
    });

    const mockExit = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    try {
      const cmd = await loadCommand();
      const grepCmd = getSubCommand(cmd, "grep");
      await expect(
        runCmd(grepCmd, {
          pattern: "hello",
          kind: undefined,
          resource: undefined,
          regex: false,
          limit: undefined,
          json: false,
        }),
      ).rejects.toThrow("process.exit called");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("not supported"),
      );
    } finally {
      mockExit.mockRestore();
    }
  });

  it("forwards --kind and --resource to grepArtifacts", async () => {
    mockGrepArtifacts.mockResolvedValue(makeGrepResponse());
    const cmd = await loadCommand();
    const grepCmd = getSubCommand(cmd, "grep");
    await runCmd(grepCmd, {
      pattern: "hello",
      kind: "plan",
      resource: "T-1",
      regex: false,
      limit: undefined,
      json: false,
    });

    expect(mockGrepArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "plan", resource: "T-1" }),
    );
  });

  it("forwards --regex flag as boolean", async () => {
    mockGrepArtifacts.mockResolvedValue(makeGrepResponse());
    const cmd = await loadCommand();
    const grepCmd = getSubCommand(cmd, "grep");
    await runCmd(grepCmd, {
      pattern: "a.c",
      kind: undefined,
      resource: undefined,
      regex: true,
      limit: undefined,
      json: false,
    });

    expect(mockGrepArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ regex: true }),
    );
  });

  it("forwards --limit as number", async () => {
    mockGrepArtifacts.mockResolvedValue(makeGrepResponse());
    const cmd = await loadCommand();
    const grepCmd = getSubCommand(cmd, "grep");
    await runCmd(grepCmd, {
      pattern: "hello",
      kind: undefined,
      resource: undefined,
      regex: false,
      limit: "25",
      json: false,
    });

    expect(mockGrepArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
  });

  it("appends (truncated) to last line of a per-result truncated artifact", async () => {
    const resp = makeGrepResponse({
      results: [
        {
          key: "produced/T-1/big.md",
          kind: "plan",
          resource: null,
          lines: [
            { line: 1, text: "first match", col: 1 },
            { line: 5, text: "last match", col: 3 },
          ],
          truncated: true,
        },
      ],
    });
    mockGrepArtifacts.mockResolvedValue(resp);
    const cmd = await loadCommand();
    const grepCmd = getSubCommand(cmd, "grep");
    await runCmd(grepCmd, {
      pattern: "match",
      kind: undefined,
      resource: undefined,
      regex: false,
      limit: undefined,
      json: false,
    });

    // The last line for the truncated result should have " (truncated)" appended
    const allLogs = (logSpy.mock.calls as unknown[][]).map(
      (call) => call[0] as string,
    );
    const lastLine = allLogs.find((line) => line.includes("last match"));
    expect(lastLine).toBeDefined();
    expect(lastLine).toContain("(truncated)");

    // The first line should NOT have (truncated)
    const firstLine = allLogs.find((line) => line.includes("first match"));
    expect(firstLine).toBeDefined();
    expect(firstLine).not.toContain("(truncated)");
  });

  it("prints request-level truncation note to stderr when response.truncated is true", async () => {
    const resp = makeGrepResponse({ truncated: true });
    mockGrepArtifacts.mockResolvedValue(resp);
    const cmd = await loadCommand();
    const grepCmd = getSubCommand(cmd, "grep");
    await runCmd(grepCmd, {
      pattern: "hello",
      kind: undefined,
      resource: undefined,
      regex: false,
      limit: undefined,
      json: false,
    });

    // A truncation note must appear on stderr
    const errorOutput = (errorSpy.mock.calls as unknown[][])
      .map((call) => call[0] as string)
      .join("\n");
    expect(errorOutput).toMatch(/truncat/i);
  });

  it("literal-mode: regex=false pattern 'a.c' does NOT match 'abc'", async () => {
    // When regex=false, the pattern is a literal substring
    // 'a.c' should only match the literal string 'a.c', not 'abc'
    // We verify this by checking what is forwarded to grepArtifacts
    // The backend enforces literal matching; the CLI must pass regex=false
    mockGrepArtifacts.mockResolvedValue(
      makeGrepResponse({
        results: [], // no match for literal 'a.c' in 'abc'
        scanned: 1,
      }),
    );
    const cmd = await loadCommand();
    const grepCmd = getSubCommand(cmd, "grep");
    await runCmd(grepCmd, {
      pattern: "a.c",
      kind: undefined,
      resource: undefined,
      regex: false,
      limit: undefined,
      json: false,
    });

    // The call must carry regex: false (not regex: true)
    expect(mockGrepArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ regex: false }),
    );
    // No results should produce a "no results" message
    const allLogs = (logSpy.mock.calls as unknown[][])
      .map((call) => call[0] as string)
      .join("\n");
    expect(allLogs).toMatch(/no results/i);
  });

  it("no results message when results array is empty", async () => {
    mockGrepArtifacts.mockResolvedValue(makeGrepResponse({ results: [] }));
    const cmd = await loadCommand();
    const grepCmd = getSubCommand(cmd, "grep");
    await runCmd(grepCmd, {
      pattern: "nomatch",
      kind: undefined,
      resource: undefined,
      regex: false,
      limit: undefined,
      json: false,
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/no results/i));
  });
});
