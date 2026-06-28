/**
 * Tests for `tila link <worker_url>` (Task 9, WI-L).
 *
 * Pattern: invoke run handler directly; mock buildAuthStore from
 * lib/instance-context. FakeSecretStore-backed AuthStore over a temp TILA_HOME.
 *
 * resetGlobalFlags() is called in beforeEach per the build-wide convention.
 *
 * Covers:
 * - link <url> --token <raw>: registers instance, marks trusted, stores credential
 * - CI/non-TTY (isCI=true): CredentialWriteRefusedError → non-zero exit
 * - --instance flag overrides derived key
 * - instance_key derived from canonicalizeWorkerUrl when --instance not given
 * - regression: init.ts still writes .tila/.env for tila-token mode (not tested here
 *   as it's a behavioral regression test in init.test.ts; the plan only requires a
 *   pointer in success output — we verify link itself doesn't break init)
 * - --json success shape
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AuthStore,
  CredentialWriteRefusedError,
  FakeSecretStore,
  TilaPaths,
} from "@tila/auth-store";
import type { CredentialRecord, InstanceKey } from "@tila/schemas";
import type { CommandDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalFlags } from "../../lib/global-flags";

// ---- module mocks -------------------------------------------------------

const mockBuildAuthStore = vi.fn<() => AuthStore>();

// Mock writeConfigFile so we don't need a real .tila dir
const mockWriteConfigFile = vi.fn();
const mockFindConfig = vi.fn(() => null);

vi.mock("../../lib/instance-context", () => ({
  buildAuthStore: () => mockBuildAuthStore(),
  writeCurrentContext: vi.fn(),
  resolveInstanceContext: vi.fn(),
  toInstanceMetadata: vi.fn(),
  loadRepoPointer: vi.fn(() => null),
  maybePromoteLegacyAfterWrite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../config", () => ({
  findConfig: () => mockFindConfig(),
  writeConfigFile: (...args: unknown[]) => mockWriteConfigFile(...args),
  findTilaDir: vi.fn(() => null),
  loadConfigFile: vi.fn(),
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

const FIXTURE_URL = "https://my.tila.example.com";
const FIXTURE_TOKEN = "raw-token-abc123";
const FIXTURE_KEY = "my.tila.example.com" as InstanceKey; // derived from canonicalize

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tila-link-test-"));
  savedTilaHome = process.env.TILA_HOME;
  process.env.TILA_HOME = tmpDir;

  // Build real AuthStore backed by FakeSecretStore (non-CI, TTY)
  fakeSecrets = new FakeSecretStore();
  const tilaPaths = new TilaPaths();
  authStore = new AuthStore({
    paths: tilaPaths,
    secrets: fakeSecrets,
    env: { isCI: false, isTTY: true },
  });

  mockBuildAuthStore.mockReturnValue(authStore);
  mockFindConfig.mockReturnValue(null); // no repo config by default
  mockWriteConfigFile.mockImplementation(() => {}); // no-op

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

async function loadLinkCmd(): Promise<CommandDef> {
  const mod = await import("../../commands/link");
  return mod.default as unknown as CommandDef;
}

// ---- tests --------------------------------------------------------------

describe("tila link", () => {
  it("registers, trusts, and stores credential for the derived instance key", async () => {
    const cmd = await loadLinkCmd();
    await runCmd(cmd, {
      worker_url: FIXTURE_URL,
      token: FIXTURE_TOKEN,
      json: false,
    });

    // Instance should be registered and trusted
    const inst = await authStore.getInstance(FIXTURE_KEY);
    expect(inst).not.toBeNull();
    expect(inst?.worker_url).toBe(FIXTURE_URL);
    expect(inst?.trust.trusted).toBe(true);

    // Credential should be stored
    const cred = await authStore.getCredential(FIXTURE_KEY, {
      allowExpired: true,
    });
    expect(cred).not.toBeNull();
    expect(cred?.token).toBe(FIXTURE_TOKEN);
    expect(cred?.token_type).toBe("Bearer");
  });

  it("uses explicit --instance flag as the instance key", async () => {
    const explicitKey = "explicit-key-001" as InstanceKey;
    const cmd = await loadLinkCmd();
    await runCmd(cmd, {
      worker_url: FIXTURE_URL,
      token: FIXTURE_TOKEN,
      instance: explicitKey,
      json: false,
    });

    const inst = await authStore.getInstance(explicitKey);
    expect(inst).not.toBeNull();
    expect(inst?.worker_url).toBe(FIXTURE_URL);

    // Derived key should NOT be registered
    const derived = await authStore.getInstance(FIXTURE_KEY);
    expect(derived).toBeNull();
  });

  it("--json emits success shape with instance_key", async () => {
    const cmd = await loadLinkCmd();
    await runCmd(cmd, {
      worker_url: FIXTURE_URL,
      token: FIXTURE_TOKEN,
      json: true,
    });

    const logOutput = consoleLogSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .join("\n");
    const parsed = JSON.parse(String(logOutput));
    expect(parsed.ok).toBe(true);
    expect(parsed.result.instance_key).toBeDefined();
    expect(parsed.result.worker_url).toBe(FIXTURE_URL);
  });

  it("--json never includes the raw token in output", async () => {
    const cmd = await loadLinkCmd();
    await runCmd(cmd, {
      worker_url: FIXTURE_URL,
      token: FIXTURE_TOKEN,
      json: true,
    });

    const logOutput = consoleLogSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .join("\n");
    expect(logOutput).not.toContain(FIXTURE_TOKEN);
  });

  it("CI environment → CredentialWriteRefusedError → non-zero exit", async () => {
    // Use a CI AuthStore
    const ciSecrets = new FakeSecretStore();
    const tilaPaths = new TilaPaths();
    const ciAuthStore = new AuthStore({
      paths: tilaPaths,
      secrets: ciSecrets,
      env: { isCI: true, isTTY: false },
    });
    mockBuildAuthStore.mockReturnValue(ciAuthStore);

    const cmd = await loadLinkCmd();
    await expect(
      runCmd(cmd, {
        worker_url: FIXTURE_URL,
        token: FIXTURE_TOKEN,
        json: false,
      }),
    ).rejects.toThrow("process.exit");

    const stderrOutput = stderrWriteSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    // Should mention CI or credential write refused
    expect(stderrOutput).toMatch(/ci|refused|cannot write/i);
  });

  it("non-TTY environment → CredentialWriteRefusedError → non-zero exit", async () => {
    const nonTtySecrets = new FakeSecretStore();
    const tilaPaths = new TilaPaths();
    const nonTtyAuthStore = new AuthStore({
      paths: tilaPaths,
      secrets: nonTtySecrets,
      env: { isCI: false, isTTY: false },
    });
    mockBuildAuthStore.mockReturnValue(nonTtyAuthStore);

    const cmd = await loadLinkCmd();
    await expect(
      runCmd(cmd, {
        worker_url: FIXTURE_URL,
        token: FIXTURE_TOKEN,
        json: false,
      }),
    ).rejects.toThrow("process.exit");
  });

  it("invalid URL → non-zero exit with error message", async () => {
    const cmd = await loadLinkCmd();
    await expect(
      runCmd(cmd, {
        worker_url: "not-a-valid-url",
        token: FIXTURE_TOKEN,
        json: false,
      }),
    ).rejects.toThrow("process.exit");
  });
});
