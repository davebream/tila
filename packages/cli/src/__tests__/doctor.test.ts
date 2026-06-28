/**
 * Tests for doctor.ts --json local-mode guard (C2 fix) and auth-store checks (Task 10).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStore,
  FakeSecretStore,
  InstanceKeyMismatchError,
  InstanceResolutionError,
  KeychainUnavailableError,
  TilaPaths,
  processEnvProbe,
} from "@tila/auth-store";
import type { ResolveOutcome, TraceStep } from "@tila/auth-store";
import type { InstanceKey } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted — apply to all tests in this file)
// ---------------------------------------------------------------------------

// Mock @clack/prompts to avoid TTY rendering
const mockSpinnerObj = { start: vi.fn(), stop: vi.fn() };
const mockNote = vi.fn();
const mockCancel = vi.fn();
vi.mock("@clack/prompts", () => ({
  spinner: vi.fn(() => mockSpinnerObj),
  note: mockNote,
  cancel: mockCancel,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock lib/instance-context: expose buildAuthStore, resolveInstanceContext, toInstanceMetadata
const mockBuildAuthStore = vi.fn();
const mockResolveInstanceContext = vi.fn();

vi.mock("../lib/instance-context", () => ({
  buildAuthStore: () => mockBuildAuthStore(),
  resolveInstanceContext: (opts?: unknown) => mockResolveInstanceContext(opts),
  /**
   * toInstanceMetadata: security projection — NEVER includes the credential.
   * Returns { instance_key, worker_url, credentialSource, trust } only.
   */
  toInstanceMetadata: (resolved: {
    instance_key: unknown;
    worker_url: unknown;
    credentialSource: unknown;
    trust: unknown;
  }) => ({
    instance_key: resolved.instance_key,
    worker_url: resolved.worker_url,
    credentialSource: resolved.credentialSource,
    trust: resolved.trust,
  }),
}));

// Mock context — runStartupChecks throws by default (outside a repo)
const mockRunStartupChecks = vi.fn(() =>
  Promise.reject(new Error("no project found")),
);
vi.mock("../context", () => ({
  runStartupChecks: mockRunStartupChecks,
}));

// ---------------------------------------------------------------------------
// Existing tests (preserved)
// ---------------------------------------------------------------------------

describe("doctor --json local-mode guard", () => {
  it("describeCliError returns the right code for a local-mode-style error", async () => {
    // We can't import doctor.ts (it imports bun:sqlite transitively).
    // Instead, verify the guard behavior via describeCliError.
    const { describeCliError } = await import("../lib/output");
    const err = Object.assign(
      new Error("This command requires a remote connection (tila init)."),
      { name: "Error" },
    );
    const result = describeCliError(err);
    // When the local-mode error is surfaced as a plain Error (not TilaApiError),
    // describeCliError returns code "ERROR" (fallback)
    expect(result.message).toMatch(/remote connection|tila init/i);
    expect(typeof result.code).toBe("string");
  });

  it("doctor exits with non-zero exit code (documented: 1 for local mode, 2 for startup fail)", async () => {
    // The doctor's health-tier contract (0/1/2) is separate from exitCodeFor.
    // Verify EXIT_CODES are defined and correct.
    const { EXIT_CODES } = await import("../lib/exit-codes");
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(EXIT_CODES.USER_ERROR).toBe(1);
    expect(EXIT_CODES.NETWORK_ERROR).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Auth-store diagnostic checks (Task 10)
// ---------------------------------------------------------------------------

describe("doctor auth-store checks", () => {
  let tilaHomeDir: string;
  let authStore: AuthStore;
  let fakeSecrets: FakeSecretStore;

  beforeEach(() => {
    vi.clearAllMocks();
    // Note: vi.resetModules() is intentionally NOT called here — it would cause
    // instanceof checks in doctor.ts to fail due to module duplication (the
    // KeychainUnavailableError class from the test would differ from the class
    // in the fresh doctor.ts import).

    // Use a real temp directory so existsSync works without node:fs mocking
    tilaHomeDir = mkdtempSync(join(tmpdir(), "tila-doctor-auth-"));
    process.env.TILA_HOME = tilaHomeDir;

    fakeSecrets = new FakeSecretStore();
    // TilaPaths reads TILA_HOME from process.env
    const paths = new TilaPaths();
    authStore = new AuthStore({
      paths,
      secrets: fakeSecrets,
      env: processEnvProbe,
    });

    // Default: buildAuthStore returns controlled store
    mockBuildAuthStore.mockReturnValue(authStore);

    // Default: resolution fails (no instance configured)
    mockResolveInstanceContext.mockResolvedValue({
      ok: false,
      error: new InstanceResolutionError("no instance", "none"),
      trace: [
        {
          rung: "flag",
          attempted: false,
          matched: false,
          detail: "no --instance flag",
        },
        {
          rung: "env",
          attempted: false,
          matched: false,
          detail: "TILA_INSTANCE not set",
        },
        {
          rung: "repo-pointer",
          attempted: false,
          matched: false,
          detail: "no .tila/config.toml",
        },
        {
          rung: "current-context",
          attempted: true,
          matched: false,
          detail: "no current context",
        },
      ],
    } satisfies ResolveOutcome);
  });

  afterEach(() => {
    process.env.TILA_HOME = undefined;
    vi.restoreAllMocks();
    try {
      rmSync(tilaHomeDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  /**
   * Run doctor in JSON mode and capture the parsed output.
   * process.exit is spied so it doesn't actually terminate.
   */
  async function runDoctorJson(args: Record<string, unknown> = {}): Promise<{
    checks: Array<{ name: string; status: string; detail: string }>;
    exitCode: number | undefined;
  }> {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const doctorMod = await import("../commands/doctor");
    // biome-ignore lint/suspicious/noExplicitAny: citty run function args bypass
    const run = doctorMod.default.run as (ctx: any) => Promise<void>;

    await run({
      args: {
        "skip-auth": true,
        json: true,
        reconcile: false,
        apply: false,
        "search-drift": false,
        "search-rebuild": false,
        ...args,
      },
    });

    const rawLogs = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    let checks: Array<{ name: string; status: string; detail: string }> = [];
    try {
      const parsed = JSON.parse(rawLogs);
      checks = parsed.checks ?? [];
    } catch {
      // If not JSON, checks stays empty
    }

    const exitMock = vi.mocked(process.exit);
    const exitCode = exitMock.mock.calls[0]?.[0] as number | undefined;

    return { checks, exitCode };
  }

  // -------------------------------------------------------------------------
  // Check: no ~/.tila → single informational pass row, skip all sub-checks
  // -------------------------------------------------------------------------

  it("no ~/.tila → emits single informational pass row and skips all sub-checks", async () => {
    // Remove the temp dir to simulate missing ~/.tila
    rmSync(tilaHomeDir, { recursive: true, force: true });

    const { checks } = await runDoctorJson();

    const authCheck = checks.find((c) => c.name === "auth-store");
    expect(authCheck).toBeDefined();
    expect(authCheck?.status).toBe("pass");
    expect(authCheck?.detail).toMatch(/no auth|not found|link/i);

    // Sub-checks must not appear when ~/.tila is absent
    expect(checks.some((c) => c.name === "auth-store/store-backend")).toBe(
      false,
    );
    expect(checks.some((c) => c.name === "auth-store/resolve-trace")).toBe(
      false,
    );
    expect(checks.some((c) => c.name === "auth-store/orphaned-creds")).toBe(
      false,
    );
    expect(checks.some((c) => c.name === "auth-store/stale-alias")).toBe(false);
    expect(
      checks.some((c) => c.name === "auth-store/ambiguous-inference"),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Check 1: store-backend — warns on KeychainUnavailableError
  // -------------------------------------------------------------------------

  it("store-backend: pass when probe succeeds", async () => {
    vi.spyOn(authStore, "probe").mockResolvedValue(undefined);

    const { checks } = await runDoctorJson();
    const check = checks.find((c) => c.name === "auth-store/store-backend");
    expect(check?.status).toBe("pass");
  });

  it("store-backend: warn on KeychainUnavailableError", async () => {
    vi.spyOn(authStore, "probe").mockRejectedValue(
      new KeychainUnavailableError("get", new Error("locked")),
    );

    const { checks } = await runDoctorJson();
    const check = checks.find((c) => c.name === "auth-store/store-backend");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/keychain unavailable/i);
    expect(check?.detail).toMatch(/step: get/i);
  });

  // -------------------------------------------------------------------------
  // Check 2: resolve-trace — renders matched rung via toInstanceMetadata
  // NEGATIVE SECURITY TEST: raw token MUST NOT appear in any output
  // -------------------------------------------------------------------------

  it("resolve-trace: renders matched rung; raw token is absent from all output", async () => {
    const RAW_TOKEN = "super-secret-token-abc123xyz";

    mockResolveInstanceContext.mockResolvedValue({
      ok: true,
      instance: {
        instance_key: "my-instance.example.com" as InstanceKey,
        worker_url: "https://my-instance.example.com",
        credentialSource: "keychain" as const,
        trust: { kind: "trusted" as const },
        // credential carries the raw token — must NOT be serialized to output
        credential: {
          source: "keychain" as const,
          record: {
            token: RAW_TOKEN,
            instance_key: "my-instance.example.com" as InstanceKey,
            token_type: "Bearer" as const,
            expires_at: Date.now() + 3_600_000,
            obtained_at: Date.now(),
          },
        },
      },
      trace: [
        {
          rung: "repo-pointer" as const,
          attempted: true,
          matched: true,
          detail: "matched via .tila/config.toml",
          trust: { kind: "trusted" as const },
        },
      ] satisfies TraceStep[],
    } satisfies ResolveOutcome);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    const doctorMod = await import("../commands/doctor");
    // biome-ignore lint/suspicious/noExplicitAny: citty run args bypass
    const run = doctorMod.default.run as (ctx: any) => Promise<void>;
    await run({
      args: {
        "skip-auth": true,
        json: true,
        reconcile: false,
        apply: false,
        "search-drift": false,
        "search-rebuild": false,
      },
    });

    const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");

    // Positive: resolve-trace check must be pass and mention the rung
    const parsed = JSON.parse(allOutput);
    const traceCheck = parsed.checks.find(
      (c: { name: string }) => c.name === "auth-store/resolve-trace",
    );
    expect(traceCheck?.status).toBe("pass");
    expect(traceCheck?.detail).toContain("repo-pointer");
    expect(traceCheck?.detail).toContain("my-instance.example.com");

    // NEGATIVE SECURITY TEST: raw token must not appear anywhere in output
    expect(allOutput).not.toContain(RAW_TOKEN);
  });

  it("resolve-trace: warn when resolution fails", async () => {
    // default mock already returns ok: false
    const { checks } = await runDoctorJson();
    const check = checks.find((c) => c.name === "auth-store/resolve-trace");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/resolution failed/i);
  });

  // -------------------------------------------------------------------------
  // Check 3: orphaned-creds — trusted instance with no credential
  // -------------------------------------------------------------------------

  it("orphaned-creds: pass when no trusted instances", async () => {
    // Registry is empty (fresh temp dir)
    const { checks } = await runDoctorJson();
    const check = checks.find((c) => c.name === "auth-store/orphaned-creds");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toMatch(/no orphaned/i);
  });

  it("orphaned-creds: warn when trusted instance has no credential", async () => {
    // Register and trust an instance — FakeSecretStore has no credential for it
    await authStore.registerInstance({
      instance_key: "orphan.example.com" as InstanceKey,
      instance_id_source: "client-uuid",
      worker_url: "https://orphan.example.com",
      label: "Orphan",
    });
    await authStore.markTrusted("orphan.example.com" as InstanceKey);
    // No credential stored → getCredential returns null

    const { checks } = await runDoctorJson();
    const check = checks.find((c) => c.name === "auth-store/orphaned-creds");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("orphan.example.com");
    expect(check?.detail).toMatch(/no credential/i);
  });

  it("orphaned-creds: warn on InstanceKeyMismatchError", async () => {
    await authStore.registerInstance({
      instance_key: "mismatched.example.com" as InstanceKey,
      instance_id_source: "client-uuid",
      worker_url: "https://mismatched.example.com",
    });
    await authStore.markTrusted("mismatched.example.com" as InstanceKey);

    vi.spyOn(authStore, "getCredential").mockRejectedValue(
      new InstanceKeyMismatchError(
        "mismatched.example.com",
        "other.example.com",
      ),
    );

    const { checks } = await runDoctorJson();
    const check = checks.find((c) => c.name === "auth-store/orphaned-creds");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/key mismatch/i);
  });

  // -------------------------------------------------------------------------
  // Check 4: stale-alias — dangling current_context pin
  // -------------------------------------------------------------------------

  it("stale-alias: pass when no current context is pinned", async () => {
    // No current context in fresh registry
    const { checks } = await runDoctorJson();
    const check = checks.find((c) => c.name === "auth-store/stale-alias");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toMatch(/no current context/i);
  });

  it("stale-alias: pass when current context is registered", async () => {
    await authStore.registerInstance({
      instance_key: "valid.example.com" as InstanceKey,
      instance_id_source: "client-uuid",
      worker_url: "https://valid.example.com",
    });
    await authStore.setCurrentContext("valid.example.com" as InstanceKey);

    const { checks } = await runDoctorJson();
    const check = checks.find((c) => c.name === "auth-store/stale-alias");
    expect(check?.status).toBe("pass");
  });

  it("stale-alias: fail when current_context is absent from registry (dangling pin)", async () => {
    // Simulate: current_context set to a key not in the registry
    vi.spyOn(authStore, "getCurrentContext").mockResolvedValue(
      "dangling.example.com" as InstanceKey,
    );
    vi.spyOn(authStore, "listInstances").mockResolvedValue([]);

    const { checks } = await runDoctorJson();
    const check = checks.find((c) => c.name === "auth-store/stale-alias");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toMatch(/dangling/i);
    expect(check?.detail).toContain("dangling.example.com");
    // Should hint how to fix
    expect(check?.detail).toMatch(/tila switch|tila instances/i);
  });

  // -------------------------------------------------------------------------
  // Check 5: ambiguous-inference — >1 conflicting matched rungs
  // -------------------------------------------------------------------------

  it("ambiguous-inference: pass when single rung matched", async () => {
    mockResolveInstanceContext.mockResolvedValue({
      ok: true,
      instance: {
        instance_key: "single.example.com" as InstanceKey,
        worker_url: "https://single.example.com",
        credentialSource: "keychain" as const,
        trust: { kind: "trusted" as const },
        credential: {
          source: "keychain" as const,
          record: {
            token: "tok",
            instance_key: "single.example.com" as InstanceKey,
            token_type: "Bearer" as const,
            expires_at: Date.now() + 3_600_000,
            obtained_at: Date.now(),
          },
        },
      },
      trace: [
        {
          rung: "repo-pointer" as const,
          attempted: true,
          matched: true,
          detail: "matched",
        },
        {
          rung: "current-context" as const,
          attempted: true,
          matched: false,
          detail: "no match",
        },
      ] satisfies TraceStep[],
    } satisfies ResolveOutcome);

    const { checks } = await runDoctorJson();
    const check = checks.find(
      (c) => c.name === "auth-store/ambiguous-inference",
    );
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("repo-pointer");
  });

  it("ambiguous-inference: warn when >1 rungs matched (conflicting signals)", async () => {
    mockResolveInstanceContext.mockResolvedValue({
      ok: true,
      instance: {
        instance_key: "winner.example.com" as InstanceKey,
        worker_url: "https://winner.example.com",
        credentialSource: "keychain" as const,
        trust: { kind: "trusted" as const },
        credential: {
          source: "keychain" as const,
          record: {
            token: "tok",
            instance_key: "winner.example.com" as InstanceKey,
            token_type: "Bearer" as const,
            expires_at: Date.now() + 3_600_000,
            obtained_at: Date.now(),
          },
        },
      },
      trace: [
        {
          rung: "repo-pointer" as const,
          attempted: true,
          matched: true,
          detail: "matched via repo-pointer",
        },
        {
          rung: "current-context" as const,
          attempted: true,
          matched: true,
          detail: "matched via current-context",
        },
      ] satisfies TraceStep[],
    } satisfies ResolveOutcome);

    const { checks } = await runDoctorJson();
    const check = checks.find(
      (c) => c.name === "auth-store/ambiguous-inference",
    );
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/ambiguous/i);
    expect(check?.detail).toContain("repo-pointer");
    expect(check?.detail).toContain("current-context");
  });

  // -------------------------------------------------------------------------
  // Structural: auth checks are NOT dropped by the startup-fail early-exit branch
  // -------------------------------------------------------------------------

  it("auth checks present in JSON output even when runStartupChecks throws", async () => {
    // runStartupChecks already throws by default
    vi.spyOn(authStore, "probe").mockResolvedValue(undefined);

    const { checks, exitCode } = await runDoctorJson();

    // Auth-store checks must appear even though startup failed
    const storeCheck = checks.find(
      (c) => c.name === "auth-store/store-backend",
    );
    expect(storeCheck).toBeDefined();

    // Startup fail row must also be present
    const startupCheck = checks.find((c) => c.name === "startup");
    expect(startupCheck?.status).toBe("fail");

    // Should exit 2 (startup failure)
    expect(exitCode).toBe(2);
  });
});
