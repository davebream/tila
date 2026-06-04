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

const mockSetWorkerSecrets = vi.fn();
vi.mock("../../lib/cloudflare-resources", () => ({
  setWorkerSecrets: (...args: unknown[]) => mockSetWorkerSecrets(...args),
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
}));

const mockPrintJson = vi.fn();
const mockPrintJsonError = vi.fn((..._args: unknown[]): void => {
  throw new Error("printJsonError");
});
vi.mock("../../lib/output", () => ({
  printJson: (...args: unknown[]) => mockPrintJson(...args),
  printJsonError: (...args: unknown[]) => mockPrintJsonError(...args),
}));

const mockSpinnerStart = vi.fn();
const mockSpinnerStop = vi.fn();
const mockNote = vi.fn();
const mockCancel = vi.fn();
const mockLogWarn = vi.fn();
vi.mock("@clack/prompts", () => ({
  spinner: vi.fn(() => ({
    start: mockSpinnerStart,
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
  extra: { json?: boolean } = {},
): Promise<void> {
  const mod = await import("../../commands/deploy");
  const cmd = mod.default;
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  await (cmd.run as (opts: any) => Promise<void>)({
    args: {
      "skip-ui": skipUi,
      json: extra.json ?? false,
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
});
