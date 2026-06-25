/**
 * Tests for `tila instances` command group (Task 7b, WI-L).
 *
 * Pattern: invoke run handlers directly; mock buildAuthStore from
 * lib/instance-context. FakeSecretStore-backed AuthStore over a temp TILA_HOME.
 *
 * resetGlobalFlags() is called in beforeEach per the build-wide convention.
 *
 * Covers:
 * - list: renders all registered instances
 * - list --json: correct shape
 * - remove: deleteInstance called, keychain secrets deleted first (best-effort)
 * - remove: unknown key → friendly error + non-zero exit
 * - remove: when removed key was current_context, getCurrentContext() returns null
 * - forget: alias for remove
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStore, FakeSecretStore, TilaPaths } from "@tila/auth-store";
import type { CredentialRecord, InstanceKey } from "@tila/schemas";
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

async function runSubCmd(
  parentDef: CommandDef,
  subName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const subCmds = (parentDef as { subCommands?: Record<string, CommandDef> })
    .subCommands;
  if (!subCmds) throw new Error("no subCommands");
  const sub = subCmds[subName];
  if (!sub) throw new Error(`no subcommand: ${subName}`);
  await runCmd(sub, args);
}

// ---- fixtures -----------------------------------------------------------

const FIXTURE_KEY = "my-instance" as InstanceKey;
const FIXTURE_KEY_2 = "other-instance" as InstanceKey;
const FIXTURE_URL = "https://my.tila.example.com";
const FIXTURE_URL_2 = "https://other.tila.example.com";
const FIXTURE_TOKEN = "secret-token-abc123";

// ---- test lifecycle -----------------------------------------------------

let tmpDir: string;
let savedTilaHome: string | undefined;
let authStore: AuthStore;
let fakeSecrets: FakeSecretStore;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  // Build-wide convention: reset global flags singleton before each test.
  resetGlobalFlags();
  vi.clearAllMocks();

  // Temp TILA_HOME
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tila-instances-test-"));
  savedTilaHome = process.env.TILA_HOME;
  process.env.TILA_HOME = tmpDir;

  // Build real AuthStore backed by FakeSecretStore
  fakeSecrets = new FakeSecretStore();
  const tilaPaths = new TilaPaths();
  authStore = new AuthStore({
    paths: tilaPaths,
    secrets: fakeSecrets,
    env: { isCI: false, isTTY: true },
  });

  // Register fixture instances
  await authStore.registerInstance({
    instance_key: FIXTURE_KEY,
    instance_id_source: "client-uuid",
    worker_url: FIXTURE_URL,
    label: "My Instance",
  });
  await authStore.registerInstance({
    instance_key: FIXTURE_KEY_2,
    instance_id_source: "server",
    worker_url: FIXTURE_URL_2,
    label: "Other Instance",
  });

  // Wire mocks
  mockBuildAuthStore.mockReturnValue(authStore);

  // Capture output
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---- helpers ------------------------------------------------------------

async function loadInstancesCmd(): Promise<CommandDef> {
  const mod = await import("../../commands/instances");
  return mod.default;
}

// ---- tests --------------------------------------------------------------

describe("instances list", () => {
  it("renders all registered instances as a table", async () => {
    const cmd = await loadInstancesCmd();
    await runSubCmd(cmd, "list", { json: false });

    // Table output should include our fixture keys (via console.log)
    const allOutput = consoleLogSpy.mock.calls
      .map((c) => c.join(" "))
      .join("\n");
    expect(allOutput).toContain(FIXTURE_KEY);
    expect(allOutput).toContain(FIXTURE_KEY_2);
  });

  it("--json emits correct shape with instance keys", async () => {
    const cmd = await loadInstancesCmd();
    await runSubCmd(cmd, "list", { json: true });

    const logCalls = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
    const parsed = JSON.parse(logCalls);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.instances).toBeDefined();
    const keys = parsed.result.instances.map(
      (r: { instance_key: string }) => r.instance_key,
    );
    expect(keys).toContain(FIXTURE_KEY);
    expect(keys).toContain(FIXTURE_KEY_2);
  });

  it("--json never includes a token field in any instance", async () => {
    // Store a credential for one instance
    await authStore.markTrusted(FIXTURE_KEY);
    const cred: CredentialRecord = {
      instance_key: FIXTURE_KEY,
      token: FIXTURE_TOKEN,
      token_type: "Bearer",
      expires_at: Date.now() + 3_600_000,
      obtained_at: Date.now(),
    };
    await authStore.putCredential(FIXTURE_KEY, cred);

    const cmd = await loadInstancesCmd();
    await runSubCmd(cmd, "list", { json: true });

    const logOutput = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logOutput).not.toContain(FIXTURE_TOKEN);
  });
});

describe("instances remove", () => {
  it("removes the instance from the registry", async () => {
    const cmd = await loadInstancesCmd();
    await runSubCmd(cmd, "remove", {
      key: FIXTURE_KEY,
      yes: true,
      json: false,
    });

    expect(await authStore.getInstance(FIXTURE_KEY)).toBeNull();
  });

  it("clears current_context when the removed key was current", async () => {
    await authStore.setCurrentContext(FIXTURE_KEY);
    expect(await authStore.getCurrentContext()).toBe(FIXTURE_KEY);

    const cmd = await loadInstancesCmd();
    await runSubCmd(cmd, "remove", {
      key: FIXTURE_KEY,
      yes: true,
      json: false,
    });

    // deleteInstance internally clears the pin
    expect(await authStore.getCurrentContext()).toBeNull();
  });

  it("attempts to delete keychain credential before registry removal (ordering)", async () => {
    // Track call order by wrapping deleteCredential and deleteInstance
    const callOrder: string[] = [];

    const origDeleteCredential = authStore.deleteCredential.bind(authStore);
    const origDeleteInstance = authStore.deleteInstance.bind(authStore);
    vi.spyOn(authStore, "deleteCredential").mockImplementation(async (k) => {
      callOrder.push("deleteCredential");
      return origDeleteCredential(k);
    });
    vi.spyOn(authStore, "deleteInstance").mockImplementation(async (k) => {
      callOrder.push("deleteInstance");
      return origDeleteInstance(k);
    });

    const cmd = await loadInstancesCmd();
    await runSubCmd(cmd, "remove", {
      key: FIXTURE_KEY,
      yes: true,
      json: false,
    });

    expect(callOrder).toEqual(["deleteCredential", "deleteInstance"]);
  });

  it("unknown key → friendly error + non-zero exit", async () => {
    const cmd = await loadInstancesCmd();
    await expect(
      runSubCmd(cmd, "remove", {
        key: "nonexistent-key" as InstanceKey,
        yes: true,
        json: false,
      }),
    ).rejects.toThrow("process.exit(1)");
  });

  it("--json unknown key → structured error", async () => {
    const cmd = await loadInstancesCmd();
    await expect(
      runSubCmd(cmd, "remove", {
        key: "nonexistent-key" as InstanceKey,
        yes: true,
        json: true,
      }),
    ).rejects.toThrow("process.exit");

    const errOutput = consoleErrorSpy.mock.calls.map((c) => c[0]).join("\n");
    const parsed = JSON.parse(errOutput);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBeDefined();
  });
});

describe("instances forget (alias for remove)", () => {
  it("forget removes the instance from the registry", async () => {
    const cmd = await loadInstancesCmd();
    await runSubCmd(cmd, "forget", {
      key: FIXTURE_KEY,
      yes: true,
      json: false,
    });

    expect(await authStore.getInstance(FIXTURE_KEY)).toBeNull();
  });
});
