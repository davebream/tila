import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
/**
 * Tests for `tila switch <key>` (Task 6).
 *
 * Pattern: invoke run handler directly; mock buildAuthStore and
 * writeCurrentContext from lib/instance-context. FakeSecretStore-backed
 * AuthStore over a temp TILA_HOME.
 *
 * resetGlobalFlags() is called in beforeEach per the build-wide convention.
 *
 * Also covers:
 * - Positional integrity: `switch --instance prod mykey` → key="mykey"
 * - Exactly one writeCurrentContext call on success
 * - Unknown key → friendly error + non-zero exit
 */
import { AuthStore, FakeSecretStore, TilaPaths } from "@tila/auth-store";
import type { InstanceKey } from "@tila/schemas";
import type { CommandDef } from "citty";
import { parseArgs } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalFlagArgs } from "../../lib/global-flags";
import { resetGlobalFlags } from "../../lib/global-flags";
import { jsonArg } from "../../lib/output";

// ---- module mocks -------------------------------------------------------

const mockBuildAuthStore = vi.fn<() => AuthStore>();
const mockWriteCurrentContext = vi.fn();

vi.mock("../../lib/instance-context", () => ({
  buildAuthStore: () => mockBuildAuthStore(),
  writeCurrentContext: (...args: unknown[]) => mockWriteCurrentContext(...args),
  resolveInstanceContext: vi.fn(),
  toInstanceMetadata: vi.fn(),
  loadRepoPointer: vi.fn(() => null),
  maybePromoteLegacyAfterWrite: vi.fn().mockResolvedValue(undefined),
}));

// ---- citty helper -------------------------------------------------------

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

// ---- fixtures -----------------------------------------------------------

const FIXTURE_KEY = "my-instance" as InstanceKey;
const FIXTURE_URL = "https://my.tila.example.com";

// ---- test lifecycle -----------------------------------------------------

let tmpDir: string;
let savedTilaHome: string | undefined;
let authStore: AuthStore;
let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  // Build-wide convention: reset global flags singleton before each test.
  resetGlobalFlags();
  vi.clearAllMocks();

  // Temp TILA_HOME
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tila-switch-test-"));
  savedTilaHome = process.env.TILA_HOME;
  process.env.TILA_HOME = tmpDir;

  // Build real AuthStore backed by FakeSecretStore
  const fakeSecrets = new FakeSecretStore();
  const tilaPaths = new TilaPaths();
  authStore = new AuthStore({
    paths: tilaPaths,
    secrets: fakeSecrets,
    env: { isCI: false, isTTY: true },
  });

  // Register a fixture instance
  await authStore.registerInstance({
    instance_key: FIXTURE_KEY,
    instance_id_source: "client-uuid",
    worker_url: FIXTURE_URL,
    label: "My Instance",
  });

  // Wire mocks
  mockBuildAuthStore.mockReturnValue(authStore);
  mockWriteCurrentContext.mockResolvedValue(undefined);

  // Capture output
  stdoutWriteSpy = vi
    .spyOn(process.stdout, "write")
    .mockReturnValue(true as ReturnType<typeof process.stdout.write>);
  stderrWriteSpy = vi
    .spyOn(process.stderr, "write")
    .mockReturnValue(true as ReturnType<typeof process.stderr.write>);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  processExitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    });
});

afterEach(() => {
  process.env.TILA_HOME = savedTilaHome;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- load helper --------------------------------------------------------

const loadSwitch = async (): Promise<CommandDef> => {
  const mod = await import("../../commands/switch");
  return mod.default as unknown as CommandDef;
};

function allStdout(): string {
  return [
    ...stdoutWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])),
    ...consoleLogSpy.mock.calls.map((c: unknown[]) => String(c[0])),
  ].join("");
}

function allStderr(): string {
  return [
    ...stderrWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])),
    ...consoleErrorSpy.mock.calls.map((c: unknown[]) => String(c[0])),
  ].join("");
}

// =========================================================================
// Task 6: tila switch <key>
// =========================================================================

describe("switch", () => {
  it("calls writeCurrentContext exactly once with the key on success", async () => {
    const switchCmd = await loadSwitch();
    await runCmd(switchCmd, { key: FIXTURE_KEY, json: false });

    expect(mockWriteCurrentContext).toHaveBeenCalledTimes(1);
    expect(mockWriteCurrentContext).toHaveBeenCalledWith(
      authStore,
      FIXTURE_KEY,
    );
  });

  it("prints confirmation on success", async () => {
    const switchCmd = await loadSwitch();
    await runCmd(switchCmd, { key: FIXTURE_KEY, json: false });

    const out = allStdout();
    expect(out).toContain(FIXTURE_KEY);
  });

  it("unknown key → friendly error + non-zero exit", async () => {
    const switchCmd = await loadSwitch();
    await expect(
      runCmd(switchCmd, { key: "unknown-key" as InstanceKey, json: false }),
    ).rejects.toThrow(/process\.exit\(1\)/);

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteCurrentContext).not.toHaveBeenCalled();

    const err = allStderr();
    expect(err).toContain("unknown-key");
  });

  it("unknown key with --json → error envelope on stderr, non-zero exit", async () => {
    const switchCmd = await loadSwitch();
    await expect(
      runCmd(switchCmd, { key: "unknown-key" as InstanceKey, json: true }),
    ).rejects.toThrow(/process\.exit/);

    // stdout empty
    const out = allStdout();
    expect(out).toBe("");

    // stderr has error
    const err = allStderr();
    expect(err.length).toBeGreaterThan(0);
  });

  it("--json success emits { ok, result } envelope to stdout", async () => {
    const switchCmd = await loadSwitch();
    await runCmd(switchCmd, { key: FIXTURE_KEY, json: true });

    const out = allStdout();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toHaveProperty("instance_key", FIXTURE_KEY);
  });

  it("POSITIONAL INTEGRITY: switch --instance prod mykey → key=mykey not prod", () => {
    // This tests that spreading globalFlagArgs into switch's args prevents
    // --instance from being consumed as the positional <key>.
    const switchArgsDef = {
      key: {
        type: "positional" as const,
        description: "Instance key to switch to",
        required: true,
      },
      ...jsonArg,
      ...globalFlagArgs,
    };

    const parsed = parseArgs(["--instance", "prod", "mykey"], switchArgsDef);

    // key should be "mykey" — not "prod" which is --instance's value
    expect(parsed.key).toBe("mykey");
    expect(parsed.instance).toBe("prod");
  });
});
