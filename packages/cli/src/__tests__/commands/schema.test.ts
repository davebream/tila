/**
 * Tests for the schema command wiring (Task 6, C4).
 *
 * Strategy:
 * - Mock loadComposedSchema from ../../lib/schema-loader (not node:fs directly),
 *   so the tests validate the wiring layer in schema.ts, not the loader itself.
 * - Mock resolveContext to provide a schema backend with spy functions.
 * - Spy on console.error, console.warn, console.log to verify output.
 * - Spy on process.exit to verify exit codes without actually exiting.
 */

import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks (must come before any SUT import)
// ---------------------------------------------------------------------------

const mockLoadComposedSchema = vi.fn();
vi.mock("../../lib/schema-loader", () => ({
  loadComposedSchema: (...args: unknown[]) => mockLoadComposedSchema(...args),
}));

const mockApplySchema = vi.fn();
const mockGetCurrentSchema = vi.fn();

vi.mock("../../context", () => ({
  resolveContext: vi.fn().mockResolvedValue({
    client: {
      post: vi.fn(),
    },
    config: { project_id: "test-project" },
    schema: {
      applySchema: (...args: unknown[]) => mockApplySchema(...args),
      getCurrentSchema: (...args: unknown[]) => mockGetCurrentSchema(...args),
    },
  }),
}));

// ---------------------------------------------------------------------------
// SUT import (after mocks)
// ---------------------------------------------------------------------------

const loadCommand = async () => {
  const mod = await import("../../commands/schema");
  return mod.default;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Flatten all spy calls to a single string for string-contains assertions. */
function spyOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return (spy.mock.calls as unknown[][]).map((c) => String(c[0])).join(" ");
}

// Fixture: a composed result with warnings
const COMPOSED_OK = {
  ok: true as const,
  definition: 'schema_version = 1\n\n[work_units.task]\nlabel = "Task"\n',
  schemaVersion: 1,
  warnings: [],
  fragmentCount: 1,
};

const COMPOSED_WITH_WARNINGS = {
  ok: true as const,
  definition: 'schema_version = 1\n\n[work_units.task]\nlabel = "Task"\n',
  schemaVersion: 1,
  warnings: [
    {
      message:
        "singleton section [hierarchy] differs between fragments; base value retained",
      fragments: ["tila.schema.toml", "extra.schema.toml"],
    },
  ],
  fragmentCount: 2,
};

const FILE_NOT_FOUND = {
  ok: false as const,
  code: "FILE_NOT_FOUND" as const,
  errors: [],
  warnings: [],
};

const SCHEMA_PARSE_ERROR = {
  ok: false as const,
  code: "SCHEMA_PARSE_ERROR" as const,
  errors: [
    {
      message:
        'duplicate work_units key "task" declared in tila.schema.toml and extra.schema.toml',
    },
  ],
  warnings: [],
};

// ---------------------------------------------------------------------------
// Tests: schema apply
// ---------------------------------------------------------------------------

describe("tila schema apply", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("(a) passes composed definition to applySchema", async () => {
    mockLoadComposedSchema.mockReturnValue(COMPOSED_OK);
    mockApplySchema.mockResolvedValue({
      ok: true,
      version: 1,
      changes: ["work-unit-added: task"],
      noChange: false,
    });

    const cmd = await loadCommand();
    const apply = getSubCommand(cmd, "apply");
    await runCmd(apply, { json: false });

    expect(mockApplySchema).toHaveBeenCalledWith(
      expect.objectContaining({ definition: COMPOSED_OK.definition }),
    );
  });

  it("(b) FILE_NOT_FOUND → JSON error + exit 1, no extra human stderr line in --json mode", async () => {
    mockLoadComposedSchema.mockReturnValue(FILE_NOT_FOUND);

    const cmd = await loadCommand();
    const apply = getSubCommand(cmd, "apply");
    await runCmd(apply, { json: true });

    // process.exit(1) should be called
    expect(exitSpy).toHaveBeenCalledWith(1);

    const stderrText = spyOutput(errorSpy);

    // In --json mode, the JSON error should go to stderr via console.error
    expect(stderrText).toContain("FILE_NOT_FOUND");

    // The apply double-emit fix: in --json mode there must be NO extra
    // human-readable "Error: ..." stderr line after the JSON blob.
    // The JSON blob itself contains '"error"', so we detect the plain-text
    // "Error:" prefix (without quotes around the word) as a human-readable line.
    const calls = errorSpy.mock.calls as unknown[][];
    const humanErrorCalls = calls.filter(
      (call) =>
        /^Error:/i.test(String(call[0])) &&
        !String(call[0]).includes('"error"'),
    );
    expect(humanErrorCalls.length).toBe(0);
  });

  it("(b2) FILE_NOT_FOUND in non-json mode → human error to stderr + exit 1", async () => {
    mockLoadComposedSchema.mockReturnValue(FILE_NOT_FOUND);

    const cmd = await loadCommand();
    const apply = getSubCommand(cmd, "apply");
    await runCmd(apply, { json: false });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("schema fragment"),
    );
  });

  it("SCHEMA_PARSE_ERROR → exit 1 with parse error message", async () => {
    mockLoadComposedSchema.mockReturnValue(SCHEMA_PARSE_ERROR);

    const cmd = await loadCommand();
    const apply = getSubCommand(cmd, "apply");
    await runCmd(apply, { json: false });

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Should mention the error
    expect(spyOutput(errorSpy)).toContain("parse");
  });

  it("(d) advisory warnings printed as a single block, not N bullets", async () => {
    mockLoadComposedSchema.mockReturnValue(COMPOSED_WITH_WARNINGS);
    mockApplySchema.mockResolvedValue({
      ok: true,
      version: 2,
      changes: [],
      noChange: false,
    });

    const cmd = await loadCommand();
    const apply = getSubCommand(cmd, "apply");
    await runCmd(apply, { json: false });

    // Warnings should appear — but in a single consolidated call, not per-warning.
    // Count calls that contain warning-related content.
    const warnCalls = warnSpy.mock.calls as unknown[][];
    const warningCallCount = warnCalls.filter(
      (call) =>
        String(call[0]).toLowerCase().includes("warning") ||
        String(call[0]).includes("singleton") ||
        String(call[0]).includes("hierarchy"),
    ).length;
    // Single consolidated block means ≤ 1 call with all warnings
    expect(warningCallCount).toBeLessThanOrEqual(1);
  });

  it("(e) no platform-internal terms in error/warning strings", async () => {
    mockLoadComposedSchema.mockReturnValue(FILE_NOT_FOUND);

    const cmd = await loadCommand();
    const apply = getSubCommand(cmd, "apply");
    await runCmd(apply, { json: false });

    const allOutput = [
      spyOutput(errorSpy),
      spyOutput(warnSpy),
      spyOutput(logSpy),
    ].join(" ");

    // Must not contain platform internals
    expect(allOutput).not.toMatch(/\bD1\b/);
    expect(allOutput).not.toMatch(/Durable Object/i);
    expect(allOutput).not.toMatch(/\bR2\b/);
    expect(allOutput).not.toMatch(/\bSQLite\b/i);
    expect(allOutput).not.toMatch(/\bWorker\b/);
  });
});

// ---------------------------------------------------------------------------
// Tests: schema diff
// ---------------------------------------------------------------------------

describe("tila schema diff", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("(a) computes the diff LOCALLY against getCurrentSchema (no client.post)", async () => {
    // Proposed schema adds a `priority` field to the existing `task` work-unit.
    mockLoadComposedSchema.mockReturnValue({
      ok: true as const,
      definition:
        'schema_version = 2\n\n[work_units.task]\nlabel = "Task"\n[work_units.task.fields.priority]\ntype = "string"\n',
      schemaVersion: 2,
      warnings: [],
      fragmentCount: 1,
    });

    // Current applied schema: just `task` with no fields (TOML definition).
    const mockPost = vi.fn();
    const { resolveContext } = await import("../../context");
    (resolveContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      client: { post: mockPost },
      config: { project_id: "test-project", backend: "local" },
      schema: {
        applySchema: mockApplySchema,
        getCurrentSchema: vi.fn().mockResolvedValue({
          version: 1,
          definition:
            'schema_version = 1\n\n[work_units.task]\nlabel = "Task"\n',
        }),
      },
    });

    const cmd = await loadCommand();
    const diff = getSubCommand(cmd, "diff");
    await runCmd(diff, { json: true });

    // No HTTP call — diff is computed locally via @tila/core diffSchemas.
    expect(mockPost).not.toHaveBeenCalled();

    const out = JSON.parse(logSpy.mock.calls[0][0] as string) as {
      changes: { kind: string; unitType?: string; fieldName?: string }[];
      autoApplicable: boolean;
    };
    expect(out.autoApplicable).toBe(true);
    expect(out.changes).toEqual([
      expect.objectContaining({
        kind: "field-added",
        unitType: "task",
        fieldName: "priority",
      }),
    ]);
  });

  it("(b) FILE_NOT_FOUND in --json mode → JSON error, no extra human-readable stderr", async () => {
    mockLoadComposedSchema.mockReturnValue(FILE_NOT_FOUND);

    // Reset context mock
    const { resolveContext } = await import("../../context");
    (resolveContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      client: { post: vi.fn() },
      config: { project_id: "test-project" },
      schema: {
        applySchema: mockApplySchema,
        getCurrentSchema: mockGetCurrentSchema,
      },
    });

    const cmd = await loadCommand();
    const diff = getSubCommand(cmd, "diff");
    await runCmd(diff, { json: true });

    expect(exitSpy).toHaveBeenCalledWith(1);

    const stderrText = spyOutput(errorSpy);

    // Verify JSON error emitted
    expect(stderrText).toContain("FILE_NOT_FOUND");

    // In JSON mode, no extra human-readable error after the JSON error
    const calls = errorSpy.mock.calls as unknown[][];
    const humanErrorCalls = calls.filter(
      (call) =>
        /^Error:/i.test(String(call[0])) &&
        !String(call[0]).includes('"error"'),
    );
    expect(humanErrorCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: schema status
// ---------------------------------------------------------------------------

describe("tila schema status", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Default: no applied schema
    mockGetCurrentSchema.mockResolvedValue({ version: null, definition: null });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("(c) reads schemaVersion from loader (no regex)", async () => {
    // Provide composed result with schemaVersion = 3
    mockLoadComposedSchema.mockReturnValue({
      ...COMPOSED_OK,
      schemaVersion: 3,
    });
    mockGetCurrentSchema.mockResolvedValue({ version: 3, definition: null });

    const cmd = await loadCommand();
    const status = getSubCommand(cmd, "status");
    await runCmd(status, { json: true });

    // Should not exit with error
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    // JSON output should reflect declared_version = 3
    expect(spyOutput(logSpy)).toContain('"declared_version": 3');
  });

  it("(c2) SCHEMA_PARSE_ERROR → swallows error, declared version null, no throw", async () => {
    mockLoadComposedSchema.mockReturnValue(SCHEMA_PARSE_ERROR);
    mockGetCurrentSchema.mockResolvedValue({ version: 2, definition: null });

    const cmd = await loadCommand();
    const status = getSubCommand(cmd, "status");
    // Should NOT throw
    await expect(runCmd(status, { json: true })).resolves.toBeUndefined();

    // Should not exit with error
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    // declared_version should be null (swallowed)
    expect(spyOutput(logSpy)).toContain('"declared_version": null');
  });

  it("FILE_NOT_FOUND → keeps 'no local file is fine' behavior (declared version null)", async () => {
    mockLoadComposedSchema.mockReturnValue(FILE_NOT_FOUND);
    mockGetCurrentSchema.mockResolvedValue({ version: 1, definition: null });

    const cmd = await loadCommand();
    const status = getSubCommand(cmd, "status");
    await runCmd(status, { json: true });

    // Should not exit with error
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    // declared_version should be null
    expect(spyOutput(logSpy)).toContain('"declared_version": null');
  });
});
