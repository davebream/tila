import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module-level mocks (must come before any imports of the SUT) ---

const mockVerifyCloudflareAuth = vi.fn();
vi.mock("../../lib/wrangler", () => ({
  verifyCloudflareAuth: (...args: unknown[]) =>
    mockVerifyCloudflareAuth(...args),
}));

const mockEnsureD1Database = vi.fn();
const mockApplyD1Migrations = vi.fn();
const mockEnsureR2Bucket = vi.fn();
const mockApplyR2Lifecycle = vi.fn();
const mockSetWorkerSecrets = vi.fn();
const mockDeleteWorkerSecret = vi.fn();
const mockDeletePagesProject = vi.fn();
vi.mock("../../lib/cloudflare-resources", () => ({
  ensureD1Database: (...args: unknown[]) => mockEnsureD1Database(...args),
  applyD1Migrations: (...args: unknown[]) => mockApplyD1Migrations(...args),
  ensureR2Bucket: (...args: unknown[]) => mockEnsureR2Bucket(...args),
  applyR2Lifecycle: (...args: unknown[]) => mockApplyR2Lifecycle(...args),
  setWorkerSecrets: (...args: unknown[]) => mockSetWorkerSecrets(...args),
  deleteWorkerSecret: (...args: unknown[]) => mockDeleteWorkerSecret(...args),
  deletePagesProject: (...args: unknown[]) => mockDeletePagesProject(...args),
  queryD1: (...args: unknown[]) => mockQueryD1(...args),
}));
const mockQueryD1 = vi.fn().mockResolvedValue([{ cnt: 0 }]);

// Mock the deploy orchestrator so provision tests never run a real `vite build`.
const mockDeployWorkerWithAssets = vi.fn();
vi.mock("../../lib/deploy", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/deploy")>();
  return {
    deployWorkerWithAssets: (...args: unknown[]) =>
      mockDeployWorkerWithAssets(...args),
    describeUiOutcome: actual.describeUiOutcome,
  };
});

const mockCreateCloudflareClient = vi.fn();
vi.mock("../../lib/cloudflare-client", () => ({
  createCloudflareClient: (...args: unknown[]) =>
    mockCreateCloudflareClient(...args),
}));

const mockOpenInBrowser = vi.fn();
vi.mock("../../lib/browser", () => ({
  openInBrowser: (...args: unknown[]) => mockOpenInBrowser(...args),
}));

const mockStartManifestFlow = vi.fn();
const mockMintAppJwt = vi.fn();
const mockDiscoverInstallation = vi.fn();
vi.mock("../../lib/github-app-setup", () => ({
  startManifestFlow: (...args: unknown[]) => mockStartManifestFlow(...args),
  mintAppJwt: (...args: unknown[]) => mockMintAppJwt(...args),
  discoverInstallation: (...args: unknown[]) =>
    mockDiscoverInstallation(...args),
  loadGithubAppCredentials: vi.fn(() => null),
  registerWithWorker: vi.fn(),
}));

const mockLoadInfraConfig = vi.fn();
const mockWriteInfraConfig = vi.fn();
const mockGetInfraSlug = vi.fn((_config: unknown) => "tila");
vi.mock("../../lib/infra-config", () => ({
  INFRA_CONFIG_FILE: "infra.toml",
  loadInfraConfig: (...args: unknown[]) => mockLoadInfraConfig(...args),
  writeInfraConfig: (...args: unknown[]) => mockWriteInfraConfig(...args),
  getInfraSlug: (config: unknown) => mockGetInfraSlug(config),
}));

const mockEnsureInfraAdminToken = vi.fn();
vi.mock("../../lib/ensure-infra-admin-token", () => ({
  ensureInfraAdminToken: (...args: unknown[]) =>
    mockEnsureInfraAdminToken(...args),
}));

const mockResolveCfApiToken = vi.fn();
const mockResolveMigrationsDir = vi.fn();
const mockGenerateHmacKey = vi.fn();
const mockResolveWorkerMainPath = vi.fn();
const mockResolveUiDistDir = vi.fn();
vi.mock("../../lib/provisioning", () => ({
  resolveCfApiToken: (...args: unknown[]) => mockResolveCfApiToken(...args),
  resolveMigrationsDir: (...args: unknown[]) =>
    mockResolveMigrationsDir(...args),
  generateHmacKey: (...args: unknown[]) => mockGenerateHmacKey(...args),
  resolveWorkerMainPath: (...args: unknown[]) =>
    mockResolveWorkerMainPath(...args),
  resolveUiDistDir: (...args: unknown[]) => mockResolveUiDistDir(...args),
  tilaHome: () => "/mock/.tila",
}));

const mockDeleteD1Database = vi.fn();
const mockDeleteGitHubApp = vi.fn();
const mockDeleteWorker = vi.fn();
const mockDeleteR2Bucket = vi.fn();
const mockFindNonEmptyR2Prefix = vi.fn();
vi.mock("../../lib/teardown", () => ({
  deleteD1Database: (...args: unknown[]) => mockDeleteD1Database(...args),
  deleteGitHubApp: (...args: unknown[]) => mockDeleteGitHubApp(...args),
  deleteWorker: (...args: unknown[]) => mockDeleteWorker(...args),
  deleteR2Bucket: (...args: unknown[]) => mockDeleteR2Bucket(...args),
  findNonEmptyR2Prefix: (...args: unknown[]) =>
    mockFindNonEmptyR2Prefix(...args),
}));

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockStatSync = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
  };
});

// @clack/prompts mock — stable references via named mock fns
const mockClackSpinnerStart = vi.fn();
const mockClackSpinnerStop = vi.fn();
const mockText = vi.fn();
const mockPassword = vi.fn();
const mockConfirm = vi.fn();
const mockNote = vi.fn();
const mockCancel = vi.fn();
const mockIsCancel = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
const mockLogSuccess = vi.fn();
vi.mock("@clack/prompts", () => ({
  text: (...args: unknown[]) => mockText(...args),
  password: (...args: unknown[]) => mockPassword(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  select: vi.fn().mockResolvedValue(null),
  spinner: vi.fn(() => ({
    start: mockClackSpinnerStart,
    stop: mockClackSpinnerStop,
  })),
  note: (...args: unknown[]) => mockNote(...args),
  cancel: (...args: unknown[]) => mockCancel(...args),
  isCancel: (...args: unknown[]) => mockIsCancel(...args),
  log: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
    step: vi.fn(),
    success: (...args: unknown[]) => mockLogSuccess(...args),
    message: vi.fn(),
  },
}));

// --- Helpers ---
const mockCfClient = {
  d1: {
    database: {
      query: vi.fn(),
      delete: vi.fn(),
    },
  },
};

async function invokeProvision(
  forceGithubApp = false,
  rotateAdminToken = false,
): Promise<void> {
  const mod = await import("../../commands/infra/provision");
  const cmd = mod.default;
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  await (cmd.run as (opts: any) => Promise<void>)({
    args: {
      "force-github-app": forceGithubApp,
      "rotate-admin-token": rotateAdminToken,
    },
  });
}

async function invokeTeardown(): Promise<void> {
  const mod = await import("../../commands/infra/teardown");
  const cmd = mod.default;
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  await (cmd.run as (opts: any) => Promise<void>)({ args: {} });
}

async function invokeStatus(): Promise<void> {
  const mod = await import("../../commands/infra/status");
  const cmd = mod.default;
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  await (cmd.run as (opts: any) => Promise<void>)({ args: {} });
}

// --- Test suites ---

describe("tila infra provision", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  const APP_CREDENTIALS = {
    app_id: 12345,
    slug: "tila-test",
    client_id: "Iv1.abc123",
    client_secret: "secret_abc",
    pem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
    webhook_secret: "whsec_test",
  };

  const INSTALLATION = { id: 999, account: "test-org" };

  beforeEach(() => {
    vi.resetAllMocks();

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Clack defaults
    mockText.mockResolvedValue("tila");
    mockPassword.mockResolvedValue("test-cf-token");
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockReturnValue(false);

    // Defaults: CF token from env, valid auth, successful provisioning
    mockResolveCfApiToken.mockReturnValue("test-cf-token");
    mockResolveMigrationsDir.mockReturnValue("/mock/migrations/global");
    mockVerifyCloudflareAuth.mockResolvedValue({
      account_id: "acct-123",
      account_name: "Test Account",
    });
    mockCreateCloudflareClient.mockReturnValue(mockCfClient);
    mockEnsureD1Database.mockResolvedValue("d1-uuid-abc");
    mockApplyD1Migrations.mockResolvedValue(undefined);

    // Worker/R2/secrets defaults
    mockEnsureR2Bucket.mockResolvedValue(undefined);
    mockApplyR2Lifecycle.mockResolvedValue(undefined);
    mockResolveWorkerMainPath.mockReturnValue("/mock/worker/index.ts");
    mockDeployWorkerWithAssets.mockResolvedValue({
      workerUrl: "https://tila.test-sub.workers.dev",
      ui: { kind: "deployed", url: "https://tila.test-sub.workers.dev" },
    });
    mockResolveUiDistDir.mockReturnValue("/mock/ui/dist");
    mockGenerateHmacKey.mockReturnValue("mock-hmac-key");
    mockEnsureInfraAdminToken.mockReturnValue({
      token: "mock-admin-token",
      generated: true,
    });
    mockSetWorkerSecrets.mockResolvedValue(undefined);
    mockDeleteWorkerSecret.mockResolvedValue(undefined);

    // No existing infra.toml or github-app.json by default
    mockExistsSync.mockReturnValue(false);
    mockLoadInfraConfig.mockImplementation(() => {
      throw new Error("No infra.toml found");
    });

    // GitHub flow defaults — invoke onReady callback if provided
    mockStartManifestFlow.mockImplementation(
      (opts: { onReady?: (port: number) => void }) => {
        if (opts?.onReady) opts.onReady(12345);
        return Promise.resolve(APP_CREDENTIALS);
      },
    );
    mockMintAppJwt.mockResolvedValue("jwt.token.here");
    mockDiscoverInstallation.mockResolvedValue(INSTALLATION);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates ~/.tila/ with mode 0o700 as pre-flight step", async () => {
    await invokeProvision();

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".tila"),
      { recursive: true, mode: 0o700 },
    );
  });

  it("calls verifyCloudflareAuth with the resolved CF token", async () => {
    await invokeProvision();

    expect(mockVerifyCloudflareAuth).toHaveBeenCalledWith("test-cf-token");
  });

  it("calls ensureD1Database with correct args (cf, account_id, cfToken)", async () => {
    await invokeProvision();

    expect(mockEnsureD1Database).toHaveBeenCalledWith(
      mockCfClient,
      "acct-123",
      "test-cf-token",
    );
  });

  it("calls applyD1Migrations with correct args (cf, account_id, d1Id, migrationsDir)", async () => {
    await invokeProvision();

    expect(mockApplyD1Migrations).toHaveBeenCalledWith(
      mockCfClient,
      "acct-123",
      "d1-uuid-abc",
      "/mock/migrations/global",
    );
  });

  it("calls deployWorkerWithAssets (wrangler path) during provision", async () => {
    await invokeProvision();

    expect(mockDeployWorkerWithAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-123",
        scriptName: "tila",
        d1DatabaseId: "d1-uuid-abc",
        apiToken: "test-cf-token",
      }),
    );
  });

  it("calls setWorkerSecrets unconditionally after deploy", async () => {
    await invokeProvision();

    expect(mockSetWorkerSecrets).toHaveBeenCalled();
  });

  it("calls deleteWorkerSecret with UI_ORIGIN to clean up stale secret after deploy", async () => {
    await invokeProvision();

    expect(mockDeleteWorkerSecret).toHaveBeenCalledWith(
      expect.anything(),
      "acct-123",
      "tila",
      "UI_ORIGIN",
    );
  });

  it("calls writeInfraConfig with correct shape (no pages_project_name on new provision)", async () => {
    await invokeProvision();

    expect(mockWriteInfraConfig).toHaveBeenCalledWith(
      {
        account_id: "acct-123",
        account_name: "Test Account",
        d1_database_id: "d1-uuid-abc",
        worker_url: "https://tila.test-sub.workers.dev",
        r2_bucket_name: "tila-artifacts",
        hmac_key: "mock-hmac-key",
        infra_admin_token: "mock-admin-token",
        infra_slug: "tila",
        github_app: {
          app_id: APP_CREDENTIALS.app_id,
          installation_id: INSTALLATION.id,
        },
      },
      expect.stringContaining(".tila"),
    );
  });

  it("skips GitHub App step when infra.toml has github_app and --force-github-app is not set", async () => {
    mockLoadInfraConfig.mockReturnValue({
      account_id: "acct-123",
      account_name: "Test Account",
      d1_database_id: "d1-uuid-abc",
      github_app: { app_id: 999, installation_id: 888 },
    });

    await invokeProvision(false);

    expect(mockStartManifestFlow).not.toHaveBeenCalled();
    expect(mockMintAppJwt).not.toHaveBeenCalled();
    expect(mockDiscoverInstallation).not.toHaveBeenCalled();

    // Should still write infra config with the existing github_app and new fields
    expect(mockWriteInfraConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        worker_url: "https://tila.test-sub.workers.dev",
        r2_bucket_name: "tila-artifacts",
        hmac_key: "mock-hmac-key",
        github_app: { app_id: 999, installation_id: 888 },
      }),
      expect.any(String),
    );
  });

  it("re-runs GitHub App step when --force-github-app is set even if existing config has it", async () => {
    mockLoadInfraConfig.mockReturnValue({
      account_id: "acct-123",
      account_name: "Test Account",
      d1_database_id: "d1-uuid-abc",
      github_app: { app_id: 999, installation_id: 888 },
    });

    await invokeProvision(true);

    expect(mockStartManifestFlow).toHaveBeenCalled();
    expect(mockMintAppJwt).toHaveBeenCalledWith(
      APP_CREDENTIALS.app_id,
      APP_CREDENTIALS.pem,
    );
    expect(mockDiscoverInstallation).toHaveBeenCalledWith("jwt.token.here");
  });

  it("writes infra config without github_app when manifest flow fails", async () => {
    mockStartManifestFlow.mockRejectedValue(new Error("manifest flow error"));

    await invokeProvision();

    expect(mockWriteInfraConfig).toHaveBeenCalledWith(
      {
        account_id: "acct-123",
        account_name: "Test Account",
        d1_database_id: "d1-uuid-abc",
        worker_url: "https://tila.test-sub.workers.dev",
        r2_bucket_name: "tila-artifacts",
        hmac_key: "mock-hmac-key",
        infra_admin_token: "mock-admin-token",
        infra_slug: "tila",
      },
      expect.any(String),
    );
  });

  it("prompts for CF token when resolveCfApiToken returns null", async () => {
    mockResolveCfApiToken.mockReturnValue(null);

    await invokeProvision();

    expect(mockPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("CLOUDFLARE_API_TOKEN"),
      }),
    );
    // Should still proceed with the prompted token
    expect(mockVerifyCloudflareAuth).toHaveBeenCalledWith("test-cf-token");
  });

  it("exits 1 when user cancels CF token prompt", async () => {
    mockResolveCfApiToken.mockReturnValue(null);
    mockIsCancel.mockReturnValueOnce(true);

    await expect(invokeProvision()).rejects.toThrow("process.exit(1)");
    expect(mockCancel).toHaveBeenCalledWith("Operation cancelled.");
  });

  it("warns about orphaned github-app.json when infra.toml is missing", async () => {
    // github-app.json exists, infra.toml does not
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("github-app.json"))
        return true;
      return false;
    });

    await invokeProvision();

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("github-app.json without infra.toml"),
    );
  });

  it("asks for overwrite confirmation when infra.toml already exists", async () => {
    // infra.toml exists
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("infra.toml")) return true;
      return false;
    });
    mockConfirm.mockResolvedValueOnce(true);

    await invokeProvision();

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("infra.toml already exists"),
      }),
    );
  });

  it("exits 0 when user declines overwrite of existing infra.toml", async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("infra.toml")) return true;
      return false;
    });
    mockConfirm.mockResolvedValueOnce(false);

    await expect(invokeProvision()).rejects.toThrow("process.exit(0)");
  });

  it("prints success summary with Worker and github_app info when flow succeeds", async () => {
    await invokeProvision();

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("acct-123"),
      expect.stringContaining("provisioned"),
    );
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("d1-uuid-abc"),
      expect.any(String),
    );
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("tila.test-sub.workers.dev"),
      expect.any(String),
    );
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("tila-artifacts"),
      expect.any(String),
    );
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining(`app_id=${APP_CREDENTIALS.app_id}`),
      expect.any(String),
    );
  });

  it("adds INFRA_ADMIN_TOKEN to the setWorkerSecrets map", async () => {
    await invokeProvision();

    const secretsArgs = mockSetWorkerSecrets.mock.calls.map(
      (call: unknown[]) => call[3],
    );
    expect(secretsArgs).toContainEqual(
      expect.objectContaining({ INFRA_ADMIN_TOKEN: "mock-admin-token" }),
    );
  });

  it("persists infra_admin_token via writeInfraConfig", async () => {
    await invokeProvision();

    expect(mockWriteInfraConfig).toHaveBeenCalledWith(
      expect.objectContaining({ infra_admin_token: "mock-admin-token" }),
      expect.any(String),
    );
  });

  it("calls ensureInfraAdminToken with rotate=false by default", async () => {
    await invokeProvision();

    const rotateOpts = mockEnsureInfraAdminToken.mock.calls.map(
      (call: unknown[]) => call[1],
    );
    expect(rotateOpts).toContainEqual({ rotate: false });
  });

  it("calls ensureInfraAdminToken with rotate=true when --rotate-admin-token is set", async () => {
    await invokeProvision(false, true);

    const rotateOpts = mockEnsureInfraAdminToken.mock.calls.map(
      (call: unknown[]) => call[1],
    );
    expect(rotateOpts).toContainEqual({ rotate: true });
  });

  it("prints a propagation-delay hint when --rotate-admin-token is set", async () => {
    await invokeProvision(false, true);

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("propagat"),
    );
  });

  it("never logs the generated admin token value (RC-6)", async () => {
    await invokeProvision(false, true);

    const logFns = [
      mockLogInfo,
      mockLogWarn,
      mockLogError,
      mockLogSuccess,
      mockNote,
      mockClackSpinnerStart,
      mockClackSpinnerStop,
    ];
    const consoleLogSpy = console.log as unknown as ReturnType<typeof vi.fn>;
    const consoleErrorSpy = console.error as unknown as ReturnType<
      typeof vi.fn
    >;

    const allLogged = [
      ...logFns.flatMap((fn) => fn.mock.calls),
      ...consoleLogSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ]
      .flat()
      .map((arg) => String(arg))
      .join("\n");

    expect(allLogged).not.toContain("mock-admin-token");
  });
});

describe("tila infra teardown", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  const INFRA_CONFIG = {
    account_id: "acct-123",
    account_name: "Test Account",
    d1_database_id: "d1-uuid-abc",
    github_app: { app_id: 12345, installation_id: 999 },
  };

  const APP_CREDENTIALS = {
    app_id: 12345,
    slug: "tila-test",
    client_id: "Iv1.abc123",
    client_secret: "secret_abc",
    pem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
    webhook_secret: "whsec_test",
  };

  beforeEach(() => {
    vi.resetAllMocks();

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Clack defaults
    mockText.mockResolvedValue(`teardown ${INFRA_CONFIG.account_name}`);
    mockPassword.mockResolvedValue("test-cf-token");
    mockIsCancel.mockReturnValue(false);

    // Infra config present
    mockLoadInfraConfig.mockReturnValue(INFRA_CONFIG);
    mockResolveCfApiToken.mockReturnValue("test-cf-token");
    mockCreateCloudflareClient.mockReturnValue(mockCfClient);

    // D1 returns zero projects by default
    mockQueryD1.mockResolvedValue([{ cnt: 0 }]);
    mockCfClient.d1.database.query.mockResolvedValue({
      result: [{ results: [{ cnt: 0 }] }],
    });

    // R2 empty-check returns null (bucket is empty) by default
    mockFindNonEmptyR2Prefix.mockResolvedValue(null);

    // Teardown functions succeed by default
    mockDeletePagesProject.mockResolvedValue(undefined);
    mockDeleteWorker.mockResolvedValue({
      ok: true,
      message: "Worker deleted",
    });
    mockDeleteR2Bucket.mockResolvedValue({
      ok: true,
      message: "R2 bucket deleted",
    });
    mockDeleteD1Database.mockResolvedValue({
      ok: true,
      message: "D1 database tila-global deleted",
    });
    mockDeleteGitHubApp.mockResolvedValue({
      ok: true,
      message:
        "Installations removed. Delete the App manually at: https://github.com/settings/apps/test-app",
    });

    // github-app.json exists and contains valid credentials
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("github-app.json"))
        return true;
      if (typeof path === "string" && path.endsWith("infra.toml")) return true;
      if (typeof path === "string" && path.endsWith(".env")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(APP_CREDENTIALS));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses when D1 has remaining projects", async () => {
    mockQueryD1.mockResolvedValueOnce([{ cnt: 3 }]);

    await expect(invokeTeardown()).rejects.toThrow("process.exit(1)");
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining("3 project(s)"),
    );
  });

  it("deletes D1, GitHub App, and files when D1 is empty", async () => {
    await invokeTeardown();

    // D1 database deleted
    expect(mockDeleteD1Database).toHaveBeenCalledWith(
      mockCfClient,
      "acct-123",
      "d1-uuid-abc",
    );

    // GitHub App deleted
    expect(mockDeleteGitHubApp).toHaveBeenCalledWith(APP_CREDENTIALS);

    // Files deleted
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("infra.toml"),
    );
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("github-app.json"),
    );
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining(".env"),
    );
  });

  it("cancels when confirmation text doesn't match", async () => {
    mockText.mockResolvedValue("wrong text");
    mockIsCancel.mockReturnValue(false);

    await expect(invokeTeardown()).rejects.toThrow("process.exit(1)");
    expect(mockDeleteD1Database).not.toHaveBeenCalled();
  });

  it("deletes ~/.tila/.env alongside infra.toml and github-app.json", async () => {
    await invokeTeardown();

    const deletedPaths = mockUnlinkSync.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(deletedPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining("infra.toml"),
        expect.stringContaining("github-app.json"),
        expect.stringContaining(".env"),
      ]),
    );
  });

  it("deletes Pages project when pages_project_name is configured (legacy pre-Option-A cleanup)", async () => {
    mockLoadInfraConfig.mockReturnValue({
      ...INFRA_CONFIG,
      pages_project_name: "tila-ui",
    });
    mockDeletePagesProject.mockResolvedValue(undefined);

    await invokeTeardown();

    expect(mockDeletePagesProject).toHaveBeenCalledWith(
      mockCfClient,
      "acct-123",
      "tila-ui",
    );
  });

  it("skips Pages deletion when pages_project_name is not configured", async () => {
    // INFRA_CONFIG has no pages_project_name
    await invokeTeardown();

    expect(mockDeletePagesProject).not.toHaveBeenCalled();
  });

  it("refuses teardown when R2 bucket has residual objects under a known prefix", async () => {
    // Simulate "produced/" prefix still has objects
    mockFindNonEmptyR2Prefix.mockResolvedValue("produced/");

    await expect(invokeTeardown()).rejects.toThrow("process.exit(1)");

    // Should log an actionable error referencing the prefix and project destroy
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining("produced/"),
    );
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining("tila project destroy"),
    );

    // Destructive teardown steps must NOT be called when bucket is non-empty
    expect(mockDeleteWorker).not.toHaveBeenCalled();
    expect(mockDeleteR2Bucket).not.toHaveBeenCalled();
    expect(mockDeleteD1Database).not.toHaveBeenCalled();
  });

  it("proceeds with teardown when R2 bucket is empty and _projects==0", async () => {
    // Both gates pass: no projects in D1, R2 bucket is empty
    mockQueryD1.mockResolvedValue([{ cnt: 0 }]);
    mockFindNonEmptyR2Prefix.mockResolvedValue(null);

    await invokeTeardown();

    // Should proceed to delete all infra resources
    expect(mockDeleteWorker).toHaveBeenCalled();
    expect(mockDeleteR2Bucket).toHaveBeenCalled();
    expect(mockDeleteD1Database).toHaveBeenCalled();
  });
});

describe("tila infra status", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  const INFRA_CONFIG = {
    account_id: "acct-123",
    account_name: "Test Account",
    d1_database_id: "d1-uuid-abc",
    github_app: { app_id: 12345, installation_id: 999 },
  };

  beforeEach(() => {
    vi.resetAllMocks();

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    mockIsCancel.mockReturnValue(false);

    // Infra config present
    mockLoadInfraConfig.mockReturnValue(INFRA_CONFIG);
    mockResolveCfApiToken.mockReturnValue("test-cf-token");
    mockCreateCloudflareClient.mockReturnValue(mockCfClient);

    // D1 returns project count
    mockCfClient.d1.database.query.mockResolvedValue({
      result: [{ results: [{ cnt: 2 }] }],
    });

    // File inventory defaults
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({
      mtime: new Date("2025-01-15T10:30:00Z"),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints account summary from infra.toml", async () => {
    mockExistsSync.mockReturnValue(false);

    await invokeStatus();

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("Test Account"),
      "Infrastructure Status",
    );
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("acct-123"),
      "Infrastructure Status",
    );
  });

  it("skips D1 check when CF token not available", async () => {
    mockResolveCfApiToken.mockReturnValue(null);
    mockExistsSync.mockReturnValue(false);

    await invokeStatus();

    expect(mockCfClient.d1.database.query).not.toHaveBeenCalled();
  });

  it('shows "MISSING" when github-app.json does not exist but is configured', async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("github-app.json"))
        return false;
      return false;
    });

    await invokeStatus();

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("MISSING"),
      "Infrastructure Status",
    );
  });

  it("shows Pages URL when pages_project_name is configured (legacy pre-Option-A)", async () => {
    mockLoadInfraConfig.mockReturnValue({
      ...INFRA_CONFIG,
      pages_project_name: "tila-ui",
    });

    await invokeStatus();

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("tila-ui.pages.dev"),
      "Infrastructure Status",
    );
  });

  it('shows "Pages: not configured" when pages_project_name is absent', async () => {
    // INFRA_CONFIG has no pages_project_name
    await invokeStatus();

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("not configured"),
      "Infrastructure Status",
    );
  });
});
