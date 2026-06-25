import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
/**
 * Tests for `auth status` (Task 4) and `auth token` (Task 5).
 *
 * Pattern: invoke run handlers directly; mock buildAuthStore/resolveInstanceContext
 * from lib/instance-context so no real keychain is hit. FakeSecretStore-backed
 * AuthStore over a temp TILA_HOME.
 *
 * resetGlobalFlags() is called in beforeEach per the build-wide convention.
 */
import {
  AuthStore,
  FakeSecretStore,
  InstanceResolutionError,
  TilaPaths,
} from "@tila/auth-store";
import type { CredentialRecord, InstanceKey } from "@tila/schemas";
import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalFlags } from "../../lib/global-flags";
import type { InstanceMetadata } from "../../lib/instance-context";

// ---- module mocks -------------------------------------------------------

// Mock buildAuthStore and resolveInstanceContext so no real keychain is touched.
// toInstanceMetadata is re-implemented here to match the real projection (strips credential).
const mockBuildAuthStore = vi.fn<() => AuthStore>();
const mockResolveInstanceContext = vi.fn();

vi.mock("../../lib/instance-context", () => ({
  buildAuthStore: () => mockBuildAuthStore(),
  resolveInstanceContext: (..._args: unknown[]) => mockResolveInstanceContext(),
  toInstanceMetadata: (resolved: {
    instance_key: InstanceKey | null;
    worker_url: string;
    credentialSource: string;
    trust: unknown;
  }): InstanceMetadata => ({
    instance_key: resolved.instance_key,
    worker_url: resolved.worker_url,
    credentialSource:
      resolved.credentialSource as InstanceMetadata["credentialSource"],
    trust: resolved.trust as InstanceMetadata["trust"],
  }),
  loadRepoPointer: vi.fn(() => null),
  writeCurrentContext: vi.fn(),
  maybePromoteLegacyAfterWrite: vi.fn().mockResolvedValue(undefined),
}));

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

// ---- fixtures -----------------------------------------------------------

const FIXTURE_TOKEN = "fixture-secret-token-xyz-abc-12345-never-in-stdout";
const FIXTURE_KEY = "my-tila-instance" as InstanceKey;
const FIXTURE_URL = "https://my.tila.example.com";

function makeCred(key: InstanceKey, token: string): CredentialRecord {
  return {
    instance_key: key,
    token,
    token_type: "Bearer",
    expires_at: Date.now() + 3_600_000,
    obtained_at: Date.now(),
  };
}

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

  // Temp TILA_HOME so paths work without hitting ~/.tila
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tila-auth-test-"));
  savedTilaHome = process.env.TILA_HOME;
  process.env.TILA_HOME = tmpDir;

  // Build a real AuthStore backed by FakeSecretStore
  const fakeSecrets = new FakeSecretStore();
  const tilaPaths = new TilaPaths();
  authStore = new AuthStore({
    paths: tilaPaths,
    secrets: fakeSecrets,
    env: { isCI: false, isTTY: true },
  });

  // Register a fixture instance in the store
  await authStore.registerInstance({
    instance_key: FIXTURE_KEY,
    instance_id_source: "client-uuid",
    worker_url: FIXTURE_URL,
    label: "My Instance",
  });
  await authStore.markTrusted(FIXTURE_KEY);
  await authStore.putCredential(
    FIXTURE_KEY,
    makeCred(FIXTURE_KEY, FIXTURE_TOKEN),
  );
  await authStore.setCurrentContext(FIXTURE_KEY);

  // Wire mock to return our test store
  mockBuildAuthStore.mockReturnValue(authStore);

  // Default resolve outcome: keychain credential for FIXTURE_KEY
  mockResolveInstanceContext.mockResolvedValue({
    ok: true,
    instance: {
      instance_key: FIXTURE_KEY,
      worker_url: FIXTURE_URL,
      credentialSource: "keychain" as const,
      credential: {
        source: "keychain" as const,
        record: makeCred(FIXTURE_KEY, FIXTURE_TOKEN),
      },
      trust: { kind: "trusted" as const },
    },
    trace: [],
  });

  // Capture stdout / stderr
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

const loadAuth = async () => {
  const mod = await import("../../commands/auth");
  return mod.default;
};

// helpers to collect all stdout / stderr output
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
// Task 4: auth status
// =========================================================================

describe("auth status", () => {
  it("lists instances including key and worker_url in table output", async () => {
    const auth = await loadAuth();
    const status = getSubCommand(auth, "status");
    await runCmd(status, { json: false, "all-instances": true });

    expect(mockBuildAuthStore).toHaveBeenCalled();
    expect(mockResolveInstanceContext).toHaveBeenCalled();

    const out = allStdout();
    expect(out).toContain(FIXTURE_KEY);
    expect(out).toContain(FIXTURE_URL);
  });

  it("works outside a repo — no runStartupChecks called", async () => {
    const auth = await loadAuth();
    const status = getSubCommand(auth, "status");
    // Should not throw (no project config present)
    await expect(
      runCmd(status, { json: false, "all-instances": true }),
    ).resolves.toBeUndefined();
  });

  it("emits --json shape: { ok, result: { current_context, resolved, instances } }", async () => {
    const auth = await loadAuth();
    const status = getSubCommand(auth, "status");
    await runCmd(status, { json: true, "all-instances": true });

    const out = allStdout();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toHaveProperty("current_context");
    expect(parsed.result).toHaveProperty("resolved");
    expect(parsed.result).toHaveProperty("instances");
    expect(Array.isArray(parsed.result.instances)).toBe(true);
  });

  it("SECURITY: raw credential token NEVER appears in --json stdout", async () => {
    const auth = await loadAuth();
    const status = getSubCommand(auth, "status");
    await runCmd(status, { json: true, "all-instances": true });

    const out = allStdout();
    // The raw fixture token must not appear anywhere in stdout output
    expect(out).not.toContain(FIXTURE_TOKEN);
  });

  it("SECURITY: raw credential token NEVER appears in table stdout", async () => {
    const auth = await loadAuth();
    const status = getSubCommand(auth, "status");
    await runCmd(status, { json: false, "all-instances": true });

    const out = allStdout();
    expect(out).not.toContain(FIXTURE_TOKEN);
  });

  it("--json resolved field uses toInstanceMetadata projection (no credential field)", async () => {
    const auth = await loadAuth();
    const status = getSubCommand(auth, "status");
    await runCmd(status, { json: true, "all-instances": true });

    const out = allStdout();
    const parsed = JSON.parse(out);

    expect(parsed.result.resolved).toMatchObject({
      instance_key: FIXTURE_KEY,
      worker_url: FIXTURE_URL,
    });
    // Must not have raw credential
    expect(parsed.result.resolved).not.toHaveProperty("credential");
    // Must not contain the token anywhere in the resolved sub-object
    expect(JSON.stringify(parsed.result.resolved)).not.toContain(FIXTURE_TOKEN);
  });

  it("--json current_context matches the registered current context", async () => {
    const auth = await loadAuth();
    const status = getSubCommand(auth, "status");
    await runCmd(status, { json: true, "all-instances": true });

    const out = allStdout();
    const parsed = JSON.parse(out);
    expect(parsed.result.current_context).toBe(FIXTURE_KEY);
  });
});

// =========================================================================
// Task 5: auth token
// =========================================================================

describe("auth token", () => {
  it("writes ONLY bare token to stdout, diagnostics to stderr (keychain branch)", async () => {
    const auth = await loadAuth();
    const tokenCmd = getSubCommand(auth, "token");
    await runCmd(tokenCmd, { json: false });

    // Bare token + newline on stdout
    const out = allStdout();
    expect(out).toBe(`${FIXTURE_TOKEN}\n`);

    // Some diagnostic on stderr
    const err = allStderr();
    expect(err.length).toBeGreaterThan(0);
  });

  it("writes bare inline token to stdout (inline-token branch)", async () => {
    const INLINE = "inline-raw-bearer-token-xyz";
    mockResolveInstanceContext.mockResolvedValue({
      ok: true,
      instance: {
        instance_key: null,
        worker_url: FIXTURE_URL,
        credentialSource: "inline-token" as const,
        credential: { source: "inline-token" as const, token: INLINE },
        trust: { kind: "trusted" as const },
      },
      trace: [],
    });

    const auth = await loadAuth();
    const tokenCmd = getSubCommand(auth, "token");
    await runCmd(tokenCmd, { json: false });

    const out = allStdout();
    expect(out).toBe(`${INLINE}\n`);
  });

  it("resolution failure: nothing on stdout, error on stderr, non-zero exit", async () => {
    mockResolveInstanceContext.mockResolvedValue({
      ok: false,
      error: new InstanceResolutionError("No instance resolved", "none"),
      trace: [],
    });

    const auth = await loadAuth();
    const tokenCmd = getSubCommand(auth, "token");
    await expect(runCmd(tokenCmd, { json: false })).rejects.toThrow(
      /process\.exit\(1\)/,
    );

    // Nothing on stdout
    const out = allStdout();
    expect(out).toBe("");

    // Error on stderr
    const err = allStderr();
    expect(err.length).toBeGreaterThan(0);
  });

  it("--json emits keychain shape: { token, token_type, expires_at, instance_key, source }", async () => {
    const auth = await loadAuth();
    const tokenCmd = getSubCommand(auth, "token");
    await runCmd(tokenCmd, { json: true });

    const out = allStdout();
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      token: FIXTURE_TOKEN,
      token_type: "Bearer",
      instance_key: FIXTURE_KEY,
      source: "keychain",
    });
    expect(parsed.expires_at).toBeTypeOf("number");
  });

  it("--json emits inline-token shape: { token, token_type:Bearer, expires_at:null, instance_key:null, source }", async () => {
    const INLINE = "inline-bearer-for-json-shape-test";
    mockResolveInstanceContext.mockResolvedValue({
      ok: true,
      instance: {
        instance_key: null,
        worker_url: FIXTURE_URL,
        credentialSource: "inline-token" as const,
        credential: { source: "inline-token" as const, token: INLINE },
        trust: { kind: "trusted" as const },
      },
      trace: [],
    });

    const auth = await loadAuth();
    const tokenCmd = getSubCommand(auth, "token");
    await runCmd(tokenCmd, { json: true });

    const out = allStdout();
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      token: INLINE,
      token_type: "Bearer",
      expires_at: null,
      instance_key: null,
      source: "inline-token",
    });
  });

  it("--json failure: nothing on stdout, error envelope on stderr, non-zero exit", async () => {
    mockResolveInstanceContext.mockResolvedValue({
      ok: false,
      error: new InstanceResolutionError("No instance resolved", "none"),
      trace: [],
    });

    const auth = await loadAuth();
    const tokenCmd = getSubCommand(auth, "token");
    await expect(runCmd(tokenCmd, { json: true })).rejects.toThrow(
      /process\.exit/,
    );

    // stdout must be empty
    const out = allStdout();
    expect(out).toBe("");

    // stderr should have error content
    const err = allStderr();
    expect(err.length).toBeGreaterThan(0);
  });

  it("processExitSpy was called — non-zero exit on failure", async () => {
    mockResolveInstanceContext.mockResolvedValue({
      ok: false,
      error: new InstanceResolutionError("No instance", "none"),
      trace: [],
    });

    const auth = await loadAuth();
    const tokenCmd = getSubCommand(auth, "token");
    try {
      await runCmd(tokenCmd, { json: false });
    } catch {
      // expected
    }
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  // Regression: the "legacy" credential variant (WI-M) has no .record —
  // only a bare .token. These tests verify the handler does NOT crash.
  it("writes bare legacy token to stdout (legacy branch)", async () => {
    const LEGACY = "legacy-bare-token-abc123";
    mockResolveInstanceContext.mockResolvedValue({
      ok: true,
      instance: {
        instance_key: null,
        worker_url: FIXTURE_URL,
        credentialSource: "legacy" as const,
        credential: { source: "legacy" as const, token: LEGACY },
        trust: { kind: "trusted" as const },
      },
      trace: [],
    });

    const auth = await loadAuth();
    const tokenCmd = getSubCommand(auth, "token");
    // Must not throw (regression: accessing .record on legacy would crash)
    await expect(runCmd(tokenCmd, { json: false })).resolves.toBeUndefined();

    const out = allStdout();
    expect(out).toBe(`${LEGACY}\n`);
  });

  it("--json emits legacy shape: { token, token_type:Bearer, expires_at:null, source:'legacy' }", async () => {
    const LEGACY = "legacy-json-shape-tok-xyz";
    mockResolveInstanceContext.mockResolvedValue({
      ok: true,
      instance: {
        instance_key: null,
        worker_url: FIXTURE_URL,
        credentialSource: "legacy" as const,
        credential: { source: "legacy" as const, token: LEGACY },
        trust: { kind: "trusted" as const },
      },
      trace: [],
    });

    const auth = await loadAuth();
    const tokenCmd = getSubCommand(auth, "token");
    await runCmd(tokenCmd, { json: true });

    const out = allStdout();
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      token: LEGACY,
      token_type: "Bearer",
      expires_at: null,
      instance_key: null,
      source: "legacy",
    });
  });
});
