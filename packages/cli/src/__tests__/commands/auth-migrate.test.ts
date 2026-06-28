/**
 * Integration tests for `tila auth migrate` subcommand (WI-M Task 9).
 *
 * Pattern: invoke run handler directly; mock buildAuthStore + maybePromoteLegacyAfterWrite
 * from lib/instance-context; mock promoteLegacy from @tila/auth-store; use
 * FakeSecretStore-backed AuthStore over a temp TILA_HOME + temp project .tila dir.
 *
 * Tests:
 *   - headless/CI → exit 1
 *   - --dry-run → no mutation, prints plan
 *   - full run registers + promotes + leaves legacy files
 *   - report JSON has no secret/token values
 *   - permission warning for 0o644 legacy file
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { PromoteOptions, PromoteResult } from "@tila/auth-store";
import { AuthStore, FakeSecretStore, TilaPaths } from "@tila/auth-store";
import type { InstanceKey } from "@tila/schemas";
import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalFlags } from "../../lib/global-flags";

// ---- module mocks -------------------------------------------------------

// vi.hoisted ensures variables are available when hoisted vi.mock factories run.
const { mockBuildAuthStore, mockPromoteLegacy } = vi.hoisted(() => ({
  mockBuildAuthStore: vi.fn<() => AuthStore>(),
  mockPromoteLegacy: vi.fn<(opts: PromoteOptions) => Promise<PromoteResult>>(),
}));

vi.mock("../../lib/instance-context", () => ({
  buildAuthStore: () => mockBuildAuthStore(),
  resolveInstanceContext: vi.fn(),
  toInstanceMetadata: vi.fn(),
  loadRepoPointer: vi.fn(() => null),
  writeCurrentContext: vi.fn(),
  maybePromoteLegacyAfterWrite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../config", () => ({
  findConfig: vi.fn(() => null),
  findTilaDir: vi.fn(() => null),
  writeConfigFile: vi.fn(),
  loadConfigFile: vi.fn(),
}));

vi.mock("../../lib/provisioning", () => ({
  tilaHome: vi.fn(() => "/fake-tila-home"),
}));

// Replace promoteLegacy at the module level so the command uses our mock.
vi.mock("@tila/auth-store", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, promoteLegacy: mockPromoteLegacy };
});

// ---- citty helper -------------------------------------------------------

function getSubCommand(cmd: CommandDef, name: string): CommandDef {
  const subs = cmd.subCommands;
  if (!subs || typeof subs === "function" || subs instanceof Promise)
    throw new Error("no subCommands");
  const sub = (subs as SubCommandsDef)[name];
  if (!sub || typeof sub === "function" || sub instanceof Promise)
    throw new Error(`no sub-command: ${name}`);
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

// ---- test lifecycle -----------------------------------------------------

let tmpDir: string;
let projectDir: string;
let savedTilaHome: string | undefined;
let savedStdoutIsTTY: boolean | undefined;
let authStore: AuthStore;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetGlobalFlags();
  vi.clearAllMocks();
  // Ensure non-headless by default (individual headless tests override this).
  // Use Reflect.deleteProperty to avoid `process.env.X = undefined` → string "undefined" bug.
  Reflect.deleteProperty(process.env, "CI");
  savedStdoutIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    writable: true,
    configurable: true,
  });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tila-auth-migrate-test-"));
  projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "tila-auth-migrate-proj-"),
  );
  fs.mkdirSync(path.join(projectDir, ".tila"), { recursive: true });

  savedTilaHome = process.env.TILA_HOME;
  process.env.TILA_HOME = tmpDir;

  const fakeSecrets = new FakeSecretStore();
  authStore = new AuthStore({
    paths: new TilaPaths(),
    secrets: fakeSecrets,
    env: { isCI: false, isTTY: true },
  });
  mockBuildAuthStore.mockReturnValue(authStore);

  // Default: promoteLegacy succeeds with no-legacy-data (no-op)
  mockPromoteLegacy.mockResolvedValue({
    promotedCredential: false,
    promotedInfraSlugs: [],
    instanceKey: null,
    skippedReason: "no-legacy-data" as const,
  });

  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  consoleWarnSpy = vi
    .spyOn(console, "warn")
    .mockImplementation(() => undefined);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  processExitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: string | number | null,
  ) => {
    throw new Error(`process.exit(${code})`);
  }) as (code?: string | number | null) => never);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  stderrSpy.mockRestore();
  processExitSpy.mockRestore();
  if (savedTilaHome !== undefined) {
    process.env.TILA_HOME = savedTilaHome;
  } else {
    process.env.TILA_HOME = undefined;
  }
  // Restore isTTY to what it was before beforeEach set it to true
  Object.defineProperty(process.stdout, "isTTY", {
    value: savedStdoutIsTTY,
    writable: true,
    configurable: true,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

async function importAuthCmd(): Promise<CommandDef> {
  const mod = await import("../../commands/auth");
  return (mod as { default: CommandDef }).default;
}

// ---- tests ---------------------------------------------------------------

describe("tila auth migrate — headless guard", () => {
  it("exits 1 under CI (process.env.CI set)", async () => {
    process.env.CI = "1";
    const authCmd = await importAuthCmd();
    const migrateCmd = getSubCommand(authCmd, "migrate");
    try {
      await expect(
        runCmd(migrateCmd, { json: false, "dry-run": false, yes: false }),
      ).rejects.toThrow("process.exit(1)");
    } finally {
      Reflect.deleteProperty(process.env, "CI");
    }
  });

  it("exits 1 when stdout is non-TTY", async () => {
    const savedIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    try {
      const authCmd = await importAuthCmd();
      const migrateCmd = getSubCommand(authCmd, "migrate");
      await expect(
        runCmd(migrateCmd, { json: false, "dry-run": false, yes: false }),
      ).rejects.toThrow("process.exit(1)");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: savedIsTTY,
        writable: true,
        configurable: true,
      });
    }
  });
});

describe("tila auth migrate — dry-run", () => {
  it("--dry-run calls promoteLegacy with dryRun:true and mutates nothing", async () => {
    mockPromoteLegacy.mockResolvedValue({
      promotedCredential: true,
      promotedInfraSlugs: ["tila"],
      instanceKey: "preview-key" as InstanceKey,
    });

    const { findConfig, findTilaDir } = await import("../../config");
    vi.mocked(findConfig).mockReturnValue({
      project_id: "p1",
      schema_version: 1,
      tila_version: "0.2.7",
      created_at: "2026-01-01T00:00:00Z",
      worker_url: "https://example.tila.dev",
    } as unknown as ReturnType<typeof findConfig>);
    vi.mocked(findTilaDir).mockReturnValue(path.join(projectDir, ".tila"));

    const authCmd = await importAuthCmd();
    const migrateCmd = getSubCommand(authCmd, "migrate");
    await runCmd(migrateCmd, { json: false, "dry-run": true, yes: false });

    // promoteLegacy called with dryRun:true
    expect(mockPromoteLegacy).toHaveBeenCalled();
    const call = mockPromoteLegacy.mock.calls[0][0] as { dryRun: boolean };
    expect(call.dryRun).toBe(true);

    // The authStore should have NO registered instances (dry-run mutates nothing)
    const instances = await authStore.listInstances();
    expect(instances).toHaveLength(0);
  });
});

describe("tila auth migrate — full run", () => {
  it("calls promoteLegacy with dryRun:false, legacy files are left in place", async () => {
    // Write legacy .tila/.env so readLegacyCredential would find it
    const legacyEnvPath = path.join(projectDir, ".tila", ".env");
    fs.writeFileSync(legacyEnvPath, "TILA_API_TOKEN=migrate-test-tok\n");

    const { findConfig, findTilaDir } = await import("../../config");
    vi.mocked(findConfig).mockReturnValue({
      project_id: "p1",
      schema_version: 1,
      tila_version: "0.2.7",
      created_at: "2026-01-01T00:00:00Z",
      worker_url: "https://example.tila.dev",
    } as unknown as ReturnType<typeof findConfig>);
    vi.mocked(findTilaDir).mockReturnValue(path.join(projectDir, ".tila"));

    mockPromoteLegacy.mockResolvedValue({
      promotedCredential: true,
      promotedInfraSlugs: [],
      instanceKey: "example.tila.dev" as InstanceKey,
    });

    const authCmd = await importAuthCmd();
    const migrateCmd = getSubCommand(authCmd, "migrate");
    await runCmd(migrateCmd, { json: false, "dry-run": false, yes: false });

    // promoteLegacy called with dryRun:false
    expect(mockPromoteLegacy).toHaveBeenCalled();
    const call = mockPromoteLegacy.mock.calls[0][0] as { dryRun?: boolean };
    expect(call.dryRun).toBeFalsy();

    // Legacy file is still present (copy-and-leave)
    expect(fs.existsSync(legacyEnvPath)).toBe(true);
  });

  it("full run with --json outputs no secret or token values", async () => {
    const { findConfig, findTilaDir } = await import("../../config");
    vi.mocked(findConfig).mockReturnValue({
      project_id: "p1",
      schema_version: 1,
      tila_version: "0.2.7",
      created_at: "2026-01-01T00:00:00Z",
      worker_url: "https://example.tila.dev",
    } as unknown as ReturnType<typeof findConfig>);
    vi.mocked(findTilaDir).mockReturnValue(path.join(projectDir, ".tila"));

    mockPromoteLegacy.mockResolvedValue({
      promotedCredential: true,
      promotedInfraSlugs: ["tila"],
      instanceKey: "example.tila.dev" as InstanceKey,
    });

    const authCmd = await importAuthCmd();
    const migrateCmd = getSubCommand(authCmd, "migrate");
    await runCmd(migrateCmd, { json: true, "dry-run": false, yes: false });

    // Collect all console.log output
    const output = consoleLogSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");

    // Must contain ok:true envelope (JSON output)
    expect(output).toContain('"ok"');

    // SECURITY: must never contain raw token values
    const SECRET_VALUE = "migrate-test-tok";
    expect(output).not.toContain(SECRET_VALUE);
    // Common secret field names used as values should not appear verbatim
    expect(output).not.toMatch(/"token"\s*:\s*"[^"]+"/);
  });
});

describe("tila auth migrate — insecure file warning", () => {
  it("warns when a legacy file has insecure mode (0644)", async () => {
    // Write legacy .env with world-readable permissions
    const legacyEnvPath = path.join(projectDir, ".tila", ".env");
    fs.writeFileSync(legacyEnvPath, "TILA_API_TOKEN=insecure-tok\n", {
      mode: 0o644,
    });

    const { findConfig, findTilaDir } = await import("../../config");
    vi.mocked(findConfig).mockReturnValue({
      project_id: "p1",
      schema_version: 1,
      tila_version: "0.2.7",
      created_at: "2026-01-01T00:00:00Z",
      worker_url: "https://example.tila.dev",
    } as unknown as ReturnType<typeof findConfig>);
    vi.mocked(findTilaDir).mockReturnValue(path.join(projectDir, ".tila"));

    // promoteLegacy itself doesn't check permissions — the migrate command does.
    // We inject a real readLegacyCredential result indirectly via promoteLegacy mock
    // returning the needed info.
    mockPromoteLegacy.mockResolvedValue({
      promotedCredential: true,
      promotedInfraSlugs: [],
      instanceKey: "example.tila.dev" as InstanceKey,
    });

    const authCmd = await importAuthCmd();
    const migrateCmd = getSubCommand(authCmd, "migrate");
    await runCmd(migrateCmd, { json: false, "dry-run": false, yes: false });

    // Since the file is 0o644, the command should emit a warning mentioning the path
    // or "insecure" / "0644" / "rotate"
    const stderrOutput = stderrSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    const logOutput = consoleLogSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    const warnOutput = consoleWarnSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    const combined = stderrOutput + logOutput + warnOutput;

    // Check that a permission warning is emitted (warning goes to console.warn)
    expect(combined.toLowerCase()).toMatch(
      /mode|permission|insecure|0644|rotate/,
    );
  });
});
