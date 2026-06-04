import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock backend-local to avoid bun:sqlite import
vi.mock("@tila/backend-local", () => ({
  LocalProject: {
    open: vi.fn(),
  },
  LocalArtifactBackend: vi.fn(),
}));

// Mock node:fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock @clack/prompts
const mockNote = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
const mockCancel = vi.fn();
vi.mock("@clack/prompts", () => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  note: (...args: unknown[]) => mockNote(...args),
  cancel: (...args: unknown[]) => mockCancel(...args),
  log: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));

// Mock context module to control auth mode
vi.mock("../../context", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    runStartupChecks: vi.fn(),
  };
});

// Mock node:os to control homedir (github-app.json lives in ~/.tila/)
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    homedir: vi.fn(() => "/tmp/fakehome"),
  };
});

import { existsSync, readFileSync } from "node:fs";
import { runStartupChecks } from "../../context";

function column(name: string) {
  return {
    cid: 0,
    name,
    type: "TEXT",
    notnull: 0,
    dflt_value: null,
    pk: 0,
  };
}

function defaultSchemaDiagnostic() {
  return {
    ok: true,
    sqlite_version: "3.47.0",
    migrations: Array.from({ length: 10 }, (_, i) => ({
      version: i + 1,
      applied_at: 123,
    })),
    tables: ["claims", "journal", "_schema_history"],
    columns: {
      claims: [
        "resource",
        "holder",
        "machine",
        "user",
        "mode",
        "fence",
        "acquired_at",
        "expires_at",
        "metadata",
      ].map(column),
      journal: [
        "seq",
        "t",
        "kind",
        "resource",
        "actor",
        "fence",
        "data",
        "token_id",
      ].map(column),
      _schema_history: [
        "version",
        "definition",
        "applied_at",
        "applied_by",
        "change_summary",
        "strategy",
      ].map(column),
    },
  };
}

// Helper to build a mock CommandContext
function buildMockContext(authMode: string, workerUrl: string) {
  return {
    config: {
      project_id: "test-proj",
      worker_url: workerUrl,
      backend: "cloudflare",
      auth: { mode: authMode },
    },
    machine: "test-host",
    client: {
      get: vi.fn((path: string) => {
        if (path.endsWith("/doctor/schema")) {
          return Promise.resolve(defaultSchemaDiagnostic());
        }
        return Promise.resolve({});
      }),
      request: vi.fn(),
    },
  };
}

function getNoteContent(): string {
  if (mockNote.mock.calls.length === 0) return "";
  return String(mockNote.mock.calls[0][0] ?? "");
}

async function runDoctor(
  ctx: ReturnType<typeof buildMockContext>,
  extraArgs: Record<string, unknown> = {},
) {
  vi.mocked(runStartupChecks).mockResolvedValue(ctx as never);
  vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

  const doctorCommand = await import("../../commands/doctor");
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  const run = doctorCommand.default.run as (opts: any) => Promise<void>;

  await run({ args: { "skip-auth": true, json: false, ...extraArgs } });

  return getNoteContent();
}

describe("doctor GitHub App checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows GitHub App section when auth mode is github-repo", async () => {
    const ctx = buildMockContext("github-repo", "https://test.workers.dev");

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        app_id: 12345,
        client_id: "Iv1.abc123",
        pem: "-----BEGIN RSA PRIVATE KEY-----\n...",
        client_secret: "secret",
        webhook_secret: "whsec_...",
      }),
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        app_id: 12345,
        client_id: "Iv1.abc123",
      }),
    });

    ctx.client.get.mockResolvedValueOnce({ version: "0.1.0" });
    ctx.client.get.mockResolvedValueOnce({
      token_name: "test-token",
      project_id: "test-proj",
    });
    ctx.client.get.mockResolvedValueOnce({
      doRttMs: 10,
      r2Reachable: true,
      doHealth: { expiredClaimsCount: 0, journalRows: 100, maxSeq: 100 },
    });

    const output = await runDoctor(ctx);
    expect(output).toContain("GitHub App");
  });

  it("skips GitHub App section when auth mode is tila-token", async () => {
    const ctx = buildMockContext("tila-token", "https://test.workers.dev");

    ctx.client.get.mockResolvedValueOnce({ version: "0.1.0" });
    ctx.client.get.mockResolvedValueOnce({
      token_name: "test-token",
      project_id: "test-proj",
    });
    ctx.client.get.mockResolvedValueOnce({
      doRttMs: 10,
      r2Reachable: true,
      doHealth: { expiredClaimsCount: 0, journalRows: 100, maxSeq: 100 },
    });

    const output = await runDoctor(ctx);
    expect(output).not.toContain("GitHub App");
    expect(output).toContain("DO schema ok");
  });

  it("reports schema drift when required columns are missing", async () => {
    const ctx = buildMockContext("tila-token", "https://test.workers.dev");

    ctx.client.get.mockResolvedValueOnce({ version: "0.1.0" });
    ctx.client.get.mockResolvedValueOnce({
      token_name: "test-token",
      project_id: "test-proj",
    });
    ctx.client.get.mockResolvedValueOnce({
      doRttMs: 10,
      r2Reachable: true,
      doHealth: { expiredClaimsCount: 0, journalRows: 100, maxSeq: 100 },
    });
    ctx.client.get.mockResolvedValueOnce({
      ...defaultSchemaDiagnostic(),
      columns: {
        ...defaultSchemaDiagnostic().columns,
        claims: ["resource", "holder"].map(column),
      },
    });

    const output = await runDoctor(ctx);
    expect(output).toMatch(/DO schema drift/i);
    expect(output).toContain("claims.machine");
  });

  it("reports fail when local config is missing", async () => {
    const ctx = buildMockContext("github-repo", "https://test.workers.dev");

    // ~/.tila/ exists but github-app.json does not
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith("github-app.json")) return false;
      return true;
    });

    ctx.client.get.mockResolvedValueOnce({ version: "0.1.0" });
    ctx.client.get.mockResolvedValueOnce({
      token_name: "test-token",
      project_id: "test-proj",
    });
    ctx.client.get.mockResolvedValueOnce({
      doRttMs: 10,
      r2Reachable: true,
      doHealth: { expiredClaimsCount: 0, journalRows: 100, maxSeq: 100 },
    });

    const output = await runDoctor(ctx);
    expect(output).toMatch(/GitHub App.*not configured/i);
  });

  it("reports warn when local/remote app_id mismatch", async () => {
    const ctx = buildMockContext("github-repo", "https://test.workers.dev");

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        app_id: 12345,
        client_id: "Iv1.abc123",
        pem: "-----BEGIN RSA PRIVATE KEY-----\n...",
        client_secret: "secret",
        webhook_secret: "whsec_...",
      }),
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        app_id: 99999,
        client_id: "Iv1.different",
      }),
    });

    ctx.client.get.mockResolvedValueOnce({ version: "0.1.0" });
    ctx.client.get.mockResolvedValueOnce({
      token_name: "test-token",
      project_id: "test-proj",
    });
    ctx.client.get.mockResolvedValueOnce({
      doRttMs: 10,
      r2Reachable: true,
      doHealth: { expiredClaimsCount: 0, journalRows: 100, maxSeq: 100 },
    });

    const output = await runDoctor(ctx);
    expect(output).toMatch(/app_id mismatch/i);
  });

  it("reports fail when worker endpoint is unreachable", async () => {
    const ctx = buildMockContext("github-repo", "https://test.workers.dev");

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        app_id: 12345,
        client_id: "Iv1.abc123",
        pem: "-----BEGIN RSA PRIVATE KEY-----\n...",
        client_secret: "secret",
        webhook_secret: "whsec_...",
      }),
    );

    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    ctx.client.get.mockResolvedValueOnce({ version: "0.1.0" });
    ctx.client.get.mockResolvedValueOnce({
      token_name: "test-token",
      project_id: "test-proj",
    });
    ctx.client.get.mockResolvedValueOnce({
      doRttMs: 10,
      r2Reachable: true,
      doHealth: { expiredClaimsCount: 0, journalRows: 100, maxSeq: 100 },
    });

    const output = await runDoctor(ctx);
    expect(output).toMatch(/Worker.*unreachable/i);
  });
});
