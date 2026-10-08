import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDeployWorkerWithAssets = vi.fn();
vi.mock("../../lib/deploy", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/deploy")>();
  return {
    deployWorkerWithAssets: (...args: unknown[]) =>
      mockDeployWorkerWithAssets(...args),
    // Keep pure helpers real — they drive messaging.
    describeUiOutcome: actual.describeUiOutcome,
    resolveDeployConfig: vi.fn(),
  };
});

const mockApplyD1Migrations = vi.fn();
const mockSetWorkerSecrets = vi.fn();
vi.mock("../../lib/cloudflare-resources", () => ({
  setWorkerSecrets: (...args: unknown[]) => mockSetWorkerSecrets(...args),
  applyD1Migrations: (...args: unknown[]) => mockApplyD1Migrations(...args),
}));

vi.mock("../../lib/github-app-setup", () => ({
  loadGithubAppCredentials: vi.fn(() => null),
}));

const mockCreateCloudflareClient = vi.fn();
vi.mock("../../lib/cloudflare-client", () => ({
  createCloudflareClient: (...args: unknown[]) =>
    mockCreateCloudflareClient(...args),
}));

const mockLoadInfraConfig = vi.fn();
const mockGetInfraSlug = vi.fn((_config: unknown) => "tila");
vi.mock("../../lib/infra-config", () => ({
  INFRA_CONFIG_FILE: "infra.toml",
  loadInfraConfig: (...args: unknown[]) => mockLoadInfraConfig(...args),
  getInfraSlug: (config: unknown) => mockGetInfraSlug(config),
}));

const mockResolveCfApiToken = vi.fn();
vi.mock("../../lib/provisioning", () => ({
  resolveCfApiToken: (...args: unknown[]) => mockResolveCfApiToken(...args),
  tilaHome: () => "/mock/.tila",
  resolveMigrationsDir: () => "/mock/migrations",
}));

const mockPrintJson = vi.fn();
const mockPrintJsonError = vi.fn((..._args: unknown[]): void => {
  throw new Error("printJsonError");
});
vi.mock("../../lib/output", () => ({
  exit: (code: number) => process.exit(code),
  printJson: (...args: unknown[]) => mockPrintJson(...args),
  printJsonError: (...args: unknown[]) => mockPrintJsonError(...args),
  jsonArg: {
    json: {
      type: "boolean" as const,
      description: "Output as structured JSON",
      default: false,
    },
  },
}));

const mockSpinnerStart = vi.fn();
const mockSpinnerStop = vi.fn();
const mockNote = vi.fn();
const mockCancel = vi.fn();
const mockLogWarn = vi.fn();
vi.mock("../../lib/prompts", () => ({
  spinner: vi.fn(() => ({
    start: mockSpinnerStart,
    message: vi.fn(),
    stop: mockSpinnerStop,
  })),
  note: (...args: unknown[]) => mockNote(...args),
  cancel: (...args: unknown[]) => mockCancel(...args),
  log: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
  },
}));

// biome-ignore lint/suspicious/noExplicitAny: vitest spy types
let exitSpy: any;

async function invokeDeploy(
  skipUi = false,
  extra: { json?: boolean; migrate?: boolean } = {},
): Promise<void> {
  const mod = await import("../../commands/deploy");
  const cmd = mod.default;
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  await (cmd.run as (opts: any) => Promise<void>)({
    args: {
      "skip-ui": skipUi,
      json: extra.json ?? false,
      migrate: extra.migrate ?? true,
    },
  });
}

describe("deploy command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });

    mockLoadInfraConfig.mockReturnValue({
      account_id: "acc-123",
      account_name: "test",
      d1_database_id: "d1-456",
      worker_url: "https://tila.workers.dev",
      r2_bucket_name: "tila-artifacts",
    });
    mockResolveCfApiToken.mockReturnValue("cf-token-abc");
    mockCreateCloudflareClient.mockReturnValue({});
    mockApplyD1Migrations.mockResolvedValue({
      applied: 1,
      skipped: 27,
      appliedNames: ["0028_session_authenticated_at.sql"],
      watermark: "0028_session_authenticated_at.sql",
    });
    mockDeployWorkerWithAssets.mockResolvedValue({
      workerUrl: "https://tila.workers.dev",
      ui: { kind: "deployed", url: "https://tila.workers.dev" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deploys Worker and UI via wrangler and exits 0", async () => {
    await invokeDeploy(false);

    expect(mockDeployWorkerWithAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-123",
        skipUi: false,
      }),
    );
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("tila.workers.dev"),
      "Deploy complete",
    );
  });

  it("skips UI when --skip-ui is set", async () => {
    mockDeployWorkerWithAssets.mockResolvedValue({
      workerUrl: "https://tila.workers.dev",
      ui: { kind: "skipped", reason: "flag" },
    });

    await invokeDeploy(true);

    expect(mockDeployWorkerWithAssets).toHaveBeenCalledWith(
      expect.objectContaining({ skipUi: true }),
    );
    // A deliberate skip is not a warning.
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("exits 1 when wrangler deploy throws (non-zero wrangler exit)", async () => {
    mockDeployWorkerWithAssets.mockRejectedValue(
      new Error("wrangler command failed:\nDeploy error output"),
    );

    await expect(invokeDeploy(false)).rejects.toThrow("process.exit(1)");

    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("Deploy failed"),
    );
  });

  it("exits 1 when smoke check fails (5xx from deployed worker)", async () => {
    mockDeployWorkerWithAssets.mockRejectedValue(
      new Error(
        "Smoke check failed: https://tila.workers.dev/ returned HTTP 503",
      ),
    );

    await expect(invokeDeploy(false)).rejects.toThrow("process.exit(1)");

    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("Deploy failed"),
    );
  });

  it("fails when infra.toml is missing", async () => {
    mockLoadInfraConfig.mockImplementation(() => {
      throw new Error("No infra.toml");
    });

    await expect(invokeDeploy(false)).rejects.toThrow("process.exit(1)");

    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("infra.toml"),
    );
  });

  it("fails when CF token is missing", async () => {
    mockResolveCfApiToken.mockReturnValue(null);

    await expect(invokeDeploy(false)).rejects.toThrow("process.exit(1)");

    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("CLOUDFLARE_API_TOKEN"),
    );
  });

  it("emits JSON and no clack output in --json mode on success", async () => {
    await invokeDeploy(false, { json: true });

    expect(mockPrintJson).toHaveBeenCalledWith(
      expect.objectContaining({
        workerUrl: "https://tila.workers.dev",
        ui: expect.objectContaining({ kind: "deployed" }),
      }),
    );
    expect(mockNote).not.toHaveBeenCalled();
    expect(mockSpinnerStart).not.toHaveBeenCalled();
  });

  it("emits JSON error when deploy throws in --json mode", async () => {
    // printJsonError mock throws — so we catch that throw, but verify the call was made
    mockPrintJsonError.mockImplementationOnce(() => {
      // Don't throw here so process.exit(1) can be reached
    });
    mockDeployWorkerWithAssets.mockRejectedValue(new Error("boom"));

    await expect(invokeDeploy(false, { json: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(mockPrintJsonError).toHaveBeenCalledWith(
      expect.stringContaining("boom"),
      "DEPLOY_FAILED",
    );
  });

  it("shows worker URL in deploy complete note", async () => {
    await invokeDeploy(false);

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("tila.workers.dev"),
      "Deploy complete",
    );
  });
  it("finishes migrations against the configured database before uploading the Worker", async () => {
    mockApplyD1Migrations.mockImplementationOnce(async () => {
      expect(mockDeployWorkerWithAssets).not.toHaveBeenCalled();
      return {
        applied: 1,
        skipped: 27,
        appliedNames: ["0028_session_authenticated_at.sql"],
        watermark: "0028_session_authenticated_at.sql",
      };
    });
    await invokeDeploy();
    expect(mockApplyD1Migrations).toHaveBeenCalledWith(
      {},
      "acc-123",
      "d1-456",
      "/mock/migrations",
      { migrate: true, quiet: false },
    );
    expect(mockDeployWorkerWithAssets).toHaveBeenCalledOnce();
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("0028_session_authenticated_at.sql"),
      "Deploy complete",
    );
  });

  it.each([false, true])(
    "blocks Worker and secret writes if migrations fail (json=%s)",
    async (json) => {
      mockApplyD1Migrations.mockRejectedValueOnce(
        new Error("migration query failed"),
      );
      await expect(invokeDeploy(false, { json })).rejects.toThrow();
      expect(mockDeployWorkerWithAssets).not.toHaveBeenCalled();
      expect(mockSetWorkerSecrets).not.toHaveBeenCalled();
      if (json)
        expect(mockPrintJsonError).toHaveBeenCalledWith(
          expect.stringContaining("migration query failed"),
          "DEPLOY_FAILED",
        );
      else
        expect(mockCancel).toHaveBeenCalledWith(
          expect.stringContaining("migration query failed"),
        );
    },
  );

  it("uses a read-only migration check for --no-migrate and blocks pending files", async () => {
    mockApplyD1Migrations.mockRejectedValueOnce(
      new Error("Pending D1 migrations: 0028_session_authenticated_at.sql"),
    );
    await expect(invokeDeploy(false, { migrate: false })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockApplyD1Migrations).toHaveBeenCalledWith(
      {},
      "acc-123",
      "d1-456",
      "/mock/migrations",
      { migrate: false, quiet: false },
    );
    expect(mockDeployWorkerWithAssets).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("0028_session_authenticated_at.sql"),
    );
  });

  it("deploys with --no-migrate when current and includes the watermark in JSON", async () => {
    await invokeDeploy(false, { migrate: false, json: true });
    expect(mockApplyD1Migrations).toHaveBeenCalledWith(
      {},
      "acc-123",
      "d1-456",
      "/mock/migrations",
      { migrate: false, quiet: true },
    );
    expect(mockDeployWorkerWithAssets).toHaveBeenCalledOnce();
    expect(mockPrintJson).toHaveBeenCalledWith(
      expect.objectContaining({
        migrations: expect.objectContaining({
          watermark: "0028_session_authenticated_at.sql",
        }),
      }),
    );
  });
  it("parses --no-migrate through the CLI argument parser", async () => {
    const { runCommand } = await import("citty");
    const { default: command } = await import("../../commands/deploy");
    await runCommand(command, { rawArgs: ["--no-migrate", "--json"] });
    expect(mockApplyD1Migrations).toHaveBeenCalledWith(
      {},
      "acc-123",
      "d1-456",
      "/mock/migrations",
      { migrate: false, quiet: true },
    );
  });
});
