/**
 * Tests for `tila shell --instance <key>` (Task 8, WI-L).
 *
 * Pattern: invoke run handler directly; mock buildAuthStore from
 * lib/instance-context. Mock node:child_process spawn.
 *
 * resetGlobalFlags() is called in beforeEach per the build-wide convention.
 *
 * Covers:
 * - spawn receives TILA_INSTANCE=<key> + TILA_SHELL_PINNED=1 in env
 * - current_context is NEVER written (setCurrentContext never called)
 * - child process exit code propagated
 * - spawn error event → non-zero exit + stderr message
 * - unknown instance → friendly error + non-zero exit
 * - $SHELL used; falls back to /bin/sh
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStore, FakeSecretStore, TilaPaths } from "@tila/auth-store";
import type { InstanceKey } from "@tila/schemas";
import type { CommandDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalFlags } from "../../lib/global-flags";

// ---- module mocks -------------------------------------------------------

const mockBuildAuthStore = vi.fn<() => AuthStore>();

vi.mock("../../lib/instance-context", () => ({
  buildAuthStore: () => mockBuildAuthStore(),
  writeCurrentContext: vi.fn(),
  resolveInstanceContext: vi.fn(),
  toInstanceMetadata: vi.fn(),
  loadRepoPointer: vi.fn(() => null),
}));

// ---- spawn mock ---------------------------------------------------------
// The spawn mock is self-triggering: `pendingSpawnOutcome` controls whether
// the child fires "close" (with an exit code) or "error" (with an Error).
// The outcome fires via queueMicrotask so the `.on()` handlers are registered
// before the callback executes — avoids the async timing gap.

type SpawnOutcome =
  | { kind: "close"; code: number }
  | { kind: "error"; err: Error };

let pendingSpawnOutcome: SpawnOutcome = { kind: "close", code: 0 };
let capturedShell = "";
let capturedEnv: NodeJS.ProcessEnv | undefined;

const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Reset per test (called in beforeEach)
function setupSpawnMock(outcome: SpawnOutcome): void {
  pendingSpawnOutcome = outcome;
  mockSpawn.mockImplementation(
    (shell: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedShell = shell;
      capturedEnv = opts.env;

      const outcome = pendingSpawnOutcome;

      // Fire event synchronously when `.on(event, handler)` is called.
      // This keeps the throw from process.exit() INSIDE the Promise executor
      // (new Promise catches executor throws → rejects the promise).
      const child = {
        on(event: string, handler: (...a: unknown[]) => void) {
          if (event === "close" && outcome.kind === "close") {
            handler(outcome.code);
          } else if (event === "error" && outcome.kind === "error") {
            handler(outcome.err);
          }
          return child;
        },
      };

      return child;
    },
  );
}

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
let savedShell: string | undefined;
let authStore: AuthStore;
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  // Build-wide convention: reset global flags singleton before each test.
  resetGlobalFlags();
  vi.clearAllMocks();
  capturedShell = "";
  capturedEnv = undefined;

  // Temp TILA_HOME
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tila-shell-test-"));
  savedTilaHome = process.env.TILA_HOME;
  process.env.TILA_HOME = tmpDir;

  // Set a known SHELL for predictable testing
  savedShell = process.env.SHELL;
  process.env.SHELL = "/bin/zsh";

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

  // Default spawn outcome: clean exit
  setupSpawnMock({ kind: "close", code: 0 });

  // Capture output
  stderrWriteSpy = vi
    .spyOn(process.stderr, "write")
    .mockReturnValue(true as ReturnType<typeof process.stderr.write>);
  processExitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    });
});

afterEach(() => {
  process.env.TILA_HOME = savedTilaHome;
  process.env.SHELL = savedShell;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---- helpers ------------------------------------------------------------

async function loadShellCmd(): Promise<CommandDef> {
  const mod = await import("../../commands/shell");
  return mod.default as unknown as CommandDef;
}

// ---- tests --------------------------------------------------------------

describe("tila shell --instance", () => {
  it("spawns $SHELL with TILA_INSTANCE and TILA_SHELL_PINNED in env", async () => {
    const cmd = await loadShellCmd();
    await runCmd(cmd, { instance: FIXTURE_KEY, json: false });

    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(capturedShell).toBe("/bin/zsh");
    expect(capturedEnv?.TILA_INSTANCE).toBe(FIXTURE_KEY);
    expect(capturedEnv?.TILA_SHELL_PINNED).toBe("1");
  });

  it("falls back to /bin/sh when SHELL is not set", async () => {
    Reflect.deleteProperty(process.env, "SHELL");
    const cmd = await loadShellCmd();
    await runCmd(cmd, { instance: FIXTURE_KEY, json: false });

    expect(capturedShell).toBe("/bin/sh");
  });

  it("exits with child process exit code (non-zero)", async () => {
    setupSpawnMock({ kind: "close", code: 42 });
    const cmd = await loadShellCmd();

    await expect(
      runCmd(cmd, { instance: FIXTURE_KEY, json: false }),
    ).rejects.toThrow("process.exit(42)");
  });

  it("exits cleanly (code 0) without calling process.exit", async () => {
    setupSpawnMock({ kind: "close", code: 0 });
    const cmd = await loadShellCmd();
    await runCmd(cmd, { instance: FIXTURE_KEY, json: false });

    // process.exit should NOT have been called with any code
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("NEVER writes current_context (setCurrentContext not called)", async () => {
    const setCurrentContextSpy = vi.spyOn(authStore, "setCurrentContext");

    const cmd = await loadShellCmd();
    await runCmd(cmd, { instance: FIXTURE_KEY, json: false });

    expect(setCurrentContextSpy).not.toHaveBeenCalled();
  });

  it("spawn error event → non-zero exit + stderr message", async () => {
    setupSpawnMock({
      kind: "error",
      err: new Error("ENOENT: spawn failed"),
    });
    const cmd = await loadShellCmd();

    await expect(
      runCmd(cmd, { instance: FIXTURE_KEY, json: false }),
    ).rejects.toThrow("process.exit");

    // stderr should have an error message
    const stderrOutput = stderrWriteSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(stderrOutput).toContain("ENOENT");
  });

  it("unknown instance → friendly error + non-zero exit", async () => {
    const cmd = await loadShellCmd();

    await expect(
      runCmd(cmd, {
        instance: "nonexistent-instance" as InstanceKey,
        json: false,
      }),
    ).rejects.toThrow("process.exit(1)");

    const stderrOutput = stderrWriteSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(stderrOutput).toMatch(/unknown instance|nonexistent-instance/i);
  });

  it("inherits parent process env in addition to injected vars", async () => {
    // Ensure parent env vars are passed through
    process.env.MY_CUSTOM_VAR = "test-value-xyz";
    const cmd = await loadShellCmd();
    await runCmd(cmd, { instance: FIXTURE_KEY, json: false });

    expect(capturedEnv?.MY_CUSTOM_VAR).toBe("test-value-xyz");
    Reflect.deleteProperty(process.env, "MY_CUSTOM_VAR");
  });
});
