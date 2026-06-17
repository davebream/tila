import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module-level mocks (must come before any imports of the SUT) ---

// Mock @tila/backend-local before importing anything that uses it (dynamic import in create.ts)
vi.mock("@tila/backend-local", () => ({
  LocalProject: {
    open: vi.fn().mockReturnValue({ close: vi.fn(), getDb: vi.fn() }),
  },
  LocalArtifactBackend: vi.fn(),
  LocalFilesystemError: class LocalFilesystemError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "LocalFilesystemError";
    }
  },
}));

const mockVerifyCloudflareAuth = vi.fn();
vi.mock("../../lib/wrangler", () => ({
  verifyCloudflareAuth: (...args: unknown[]) =>
    mockVerifyCloudflareAuth(...args),
}));

const mockInsertTokenAndProject = vi.fn();
const mockQueryD1 = vi.fn().mockResolvedValue([]);
const mockResolveZoneId = vi.fn();
const mockCreateCustomDomain = vi.fn();
vi.mock("../../lib/cloudflare-resources", () => ({
  insertTokenAndProject: (...args: unknown[]) =>
    mockInsertTokenAndProject(...args),
  insertGithubAppConfig: vi.fn(),
  queryD1: (...args: unknown[]) => mockQueryD1(...args),
  resolveZoneId: (...args: unknown[]) => mockResolveZoneId(...args),
  createCustomDomain: (...args: unknown[]) => mockCreateCustomDomain(...args),
}));

const mockCreateCloudflareClient = vi.fn();
vi.mock("../../lib/cloudflare-client", () => ({
  createCloudflareClient: (...args: unknown[]) =>
    mockCreateCloudflareClient(...args),
}));

const mockDeleteWorker = vi.fn();
const mockDeleteR2Bucket = vi.fn();
const mockDeleteGitHubApp = vi.fn();
const mockCleanD1ProjectRecords = vi.fn();
const mockCleanD1NonTokenRecords = vi.fn();
const mockDeleteD1TokenRecord = vi.fn();
const mockCleanLocalFiles = vi.fn();
const mockWipeProjectViaWorker = vi.fn();
const mockWipeProjectViaInfraToken = vi.fn();
const mockVerifyStoresEmpty = vi.fn();
vi.mock("../../lib/teardown", () => ({
  deleteWorker: (...args: unknown[]) => mockDeleteWorker(...args),
  deleteR2Bucket: (...args: unknown[]) => mockDeleteR2Bucket(...args),
  deleteGitHubApp: (...args: unknown[]) => mockDeleteGitHubApp(...args),
  cleanD1ProjectRecords: (...args: unknown[]) =>
    mockCleanD1ProjectRecords(...args),
  cleanD1NonTokenRecords: (...args: unknown[]) =>
    mockCleanD1NonTokenRecords(...args),
  deleteD1TokenRecord: (...args: unknown[]) => mockDeleteD1TokenRecord(...args),
  cleanLocalFiles: (...args: unknown[]) => mockCleanLocalFiles(...args),
  wipeProjectViaWorker: (...args: unknown[]) =>
    mockWipeProjectViaWorker(...args),
  wipeProjectViaInfraToken: (...args: unknown[]) =>
    mockWipeProjectViaInfraToken(...args),
  verifyStoresEmpty: (...args: unknown[]) => mockVerifyStoresEmpty(...args),
}));

const mockSmolTomlParse = vi.fn();
vi.mock("smol-toml", () => ({
  parse: (...args: unknown[]) => mockSmolTomlParse(...args),
  stringify: vi.fn((obj: unknown) => JSON.stringify(obj)),
}));

const mockCreateCliClient = vi.fn();
vi.mock("../../lib/client-factory", () => ({
  createCliClient: (...args: unknown[]) => mockCreateCliClient(...args),
}));

const mockLoadInfraConfig = vi.fn();
const mockGetInfraSlug = vi.fn((_config: unknown) => "tila");
vi.mock("../../lib/infra-config", () => ({
  INFRA_CONFIG_FILE: "infra.toml",
  loadInfraConfig: (...args: unknown[]) => mockLoadInfraConfig(...args),
  getInfraSlug: (config: unknown) => mockGetInfraSlug(config),
}));

const mockResolveCfApiToken = vi.fn();
const mockResolveProjectName = vi.fn();
const mockGenerateSlug = vi.fn();
const mockDeriveRepo = vi.fn();
const mockDeriveOrg = vi.fn();
const mockGenerateRawToken = vi.fn();
const mockHashToken = vi.fn();
const mockEnsureGitignored = vi.fn();
const mockGenerateDefaultSchemaToml = vi.fn();
vi.mock("../../lib/provisioning", () => ({
  resolveCfApiToken: (...args: unknown[]) => mockResolveCfApiToken(...args),
  resolveProjectName: (...args: unknown[]) => mockResolveProjectName(...args),
  generateSlug: (...args: unknown[]) => mockGenerateSlug(...args),
  deriveRepo: (...args: unknown[]) => mockDeriveRepo(...args),
  deriveOrg: (...args: unknown[]) => mockDeriveOrg(...args),
  generateRawToken: (...args: unknown[]) => mockGenerateRawToken(...args),
  hashToken: (...args: unknown[]) => mockHashToken(...args),
  ensureGitignored: (...args: unknown[]) => mockEnsureGitignored(...args),
  generateDefaultSchemaToml: (...args: unknown[]) =>
    mockGenerateDefaultSchemaToml(...args),
  tilaHome: () => "/mock/.tila",
}));

const mockRunMcpInitPrompt = vi.fn();
vi.mock("../../lib/mcp-targets", () => ({
  runMcpInitPrompt: (...args: unknown[]) => mockRunMcpInitPrompt(...args),
}));

const mockWriteTokenFile = vi.fn();
vi.mock("../../auth", () => ({
  writeTokenFile: (...args: unknown[]) => mockWriteTokenFile(...args),
}));

const mockFindConfig = vi.fn();
const mockWriteConfigFile = vi.fn();
vi.mock("../../config", () => ({
  findConfig: (...args: unknown[]) => mockFindConfig(...args),
  writeConfigFile: (...args: unknown[]) => mockWriteConfigFile(...args),
}));

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  };
});

const mockHomedir = vi.fn();
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: (...args: unknown[]) => mockHomedir(...args),
    default: {
      ...actual,
      homedir: (...args: unknown[]) => mockHomedir(...args),
    },
  };
});

// @clack/prompts mock
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
vi.mock("@clack/prompts", () => ({
  text: (...args: unknown[]) => mockText(...args),
  password: (...args: unknown[]) => mockPassword(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  select: vi.fn().mockResolvedValue(null),
  spinner: vi.fn(() => ({
    start: mockClackSpinnerStart,
    stop: mockClackSpinnerStop,
    message: vi.fn(),
  })),
  note: (...args: unknown[]) => mockNote(...args),
  cancel: (...args: unknown[]) => mockCancel(...args),
  isCancel: (...args: unknown[]) => mockIsCancel(...args),
  log: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
    step: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

import { LocalProject } from "@tila/backend-local";
import configureCmd from "../../commands/project/configure";
// --- Static import AFTER all vi.mock calls (vitest hoists vi.mock above imports) ---
import createCmd from "../../commands/project/create";
import destroyCmd from "../../commands/project/destroy";
import listCmd from "../../commands/project/list";

const mockLocalProjectOpen = vi.mocked(LocalProject.open);

// --- Helpers ---

const INFRA_CONFIG = {
  account_id: "acct-123",
  account_name: "Test Account",
  d1_database_id: "d1-uuid-abc",
  worker_url: "https://tila-shared.workers.dev",
  github_app: { app_id: 12345, installation_id: 999 },
};

const GITHUB_APP_CREDENTIALS = {
  app_id: 12345,
  client_id: "Iv1.abc123",
  client_secret: "secret_abc",
  pem: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
  webhook_secret: "whsec_test",
};

const mockCfClient = {};
const mockTilaClient = {
  post: vi.fn(),
};

async function invokeProjectCreate(
  args: Record<string, unknown> = {},
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  await (createCmd.run as (opts: any) => Promise<void>)({
    args: {
      local: false,
      "skip-github": false,
      ...args,
    },
  });
}

// --- Test suites ---

describe("tila project create (cloudflare)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // OS defaults
    mockHomedir.mockReturnValue("/home/testuser");

    // Clack defaults
    mockText.mockResolvedValue("");
    mockConfirm.mockResolvedValue(true);
    mockIsCancel.mockReturnValue(false);

    // Infrastructure config defaults
    mockLoadInfraConfig.mockReturnValue(INFRA_CONFIG);
    mockResolveCfApiToken.mockReturnValue("test-cf-token");
    mockResolveProjectName.mockResolvedValue("test-project");
    mockGenerateSlug.mockReturnValue("test-project");
    mockDeriveRepo.mockReturnValue({ owner: "test-org", repo: "test-repo" });
    mockDeriveOrg.mockReturnValue("test-org");
    mockGenerateRawToken.mockReturnValue("tila_mock-raw-token");
    mockHashToken.mockReturnValue("mock-token-hash");
    mockGenerateDefaultSchemaToml.mockReturnValue("mock-schema-toml");

    // Cloudflare defaults
    mockCreateCloudflareClient.mockReturnValue(mockCfClient);
    mockInsertTokenAndProject.mockResolvedValue(undefined);
    mockRunMcpInitPrompt.mockResolvedValue(undefined);

    // Client defaults
    mockCreateCliClient.mockReturnValue(mockTilaClient);
    mockTilaClient.post.mockResolvedValue({ ok: true });

    // File system defaults
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue(JSON.stringify(GITHUB_APP_CREDENTIALS));

    // Config defaults
    mockFindConfig.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls loadInfraConfig and fails when missing", async () => {
    mockLoadInfraConfig.mockImplementation(() => {
      throw new Error("No infra.toml found");
    });

    await expect(invokeProjectCreate()).rejects.toThrow("process.exit(1)");
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("tila infra provision"),
    );
  });

  it("fails when worker_url is missing from infra config", async () => {
    mockLoadInfraConfig.mockReturnValue({
      account_id: "acct-123",
      account_name: "Test Account",
      d1_database_id: "d1-uuid-abc",
      // no worker_url
    });
    mockExistsSync.mockReturnValue(false);

    await expect(invokeProjectCreate({ "skip-github": true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("worker_url"),
    );
  });

  it("validates github-app.json exists when github_app configured", async () => {
    // github-app.json doesn't exist
    mockExistsSync.mockReturnValue(false);

    await expect(invokeProjectCreate()).rejects.toThrow("process.exit(1)");
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("github-app.json is missing"),
    );
  });

  it("validates github-app.json fields before use", async () => {
    // github-app.json exists but has invalid content
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("github-app.json"))
        return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ app_id: 123 }), // missing pem, client_id, client_secret
    );

    await expect(invokeProjectCreate()).rejects.toThrow("process.exit(1)");
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("missing or invalid"),
    );
  });

  it("skips github-app.json validation when --skip-github is set", async () => {
    // github-app.json doesn't exist, but --skip-github is set
    mockExistsSync.mockReturnValue(false);

    await invokeProjectCreate({ "skip-github": true });

    // Should not fail — should proceed without GitHub credentials
    expect(mockInsertTokenAndProject).toHaveBeenCalled();
  });

  it("fails non-interactively when CF token is missing", async () => {
    mockResolveCfApiToken.mockReturnValue(null);
    mockExistsSync.mockReturnValue(false);

    await expect(invokeProjectCreate({ "skip-github": true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("CLOUDFLARE_API_TOKEN"),
    );
  });

  it("generates API token and inserts in D1", async () => {
    mockExistsSync.mockReturnValue(false);

    await invokeProjectCreate({ "skip-github": true });

    expect(mockInsertTokenAndProject).toHaveBeenCalledWith({
      client: mockCfClient,
      accountId: "acct-123",
      databaseId: "d1-uuid-abc",
      tokenHash: "mock-token-hash",
      slug: "test-project",
    });
  });

  it("registers repo when github credentials and repo info available", async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("github-app.json"))
        return true;
      return false;
    });

    await invokeProjectCreate();

    expect(mockCreateCliClient).toHaveBeenCalledWith(
      "https://tila-shared.workers.dev",
      "tila_mock-raw-token",
    );
    expect(mockTilaClient.post).toHaveBeenCalledWith(
      "/api/repos",
      { owner: "test-org", repo: "test-repo" },
      expect.objectContaining({ schema: expect.any(Object), validate: true }),
    );
  });

  it("writes config.toml with worker_url from infra config", async () => {
    mockExistsSync.mockReturnValue(false);

    await invokeProjectCreate({ "skip-github": true });

    expect(mockWriteConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        worker_url: "https://tila-shared.workers.dev",
        project_id: "test-project",
      }),
      expect.stringContaining(".tila"),
    );
  });

  it("writes config.toml, .env, .gitignore, and schema.toml", async () => {
    mockExistsSync.mockReturnValue(false);

    await invokeProjectCreate({ "skip-github": true });

    expect(mockWriteConfigFile).toHaveBeenCalled();
    expect(mockWriteTokenFile).toHaveBeenCalledWith(
      "tila_mock-raw-token",
      expect.stringContaining(".tila"),
    );
    expect(mockEnsureGitignored).toHaveBeenCalled();
  });

  it("does not include wrangler.toml in gitignore entries", async () => {
    mockExistsSync.mockReturnValue(false);

    await invokeProjectCreate({ "skip-github": true });

    const gitignoreCall = mockEnsureGitignored.mock.calls[0];
    const entries = gitignoreCall[0] as string[];
    expect(entries).not.toContain(".tila/wrangler.toml");
  });

  it("prints success note with project info", async () => {
    mockExistsSync.mockReturnValue(false);

    await invokeProjectCreate({ "skip-github": true });

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("test-project"),
      expect.stringContaining("project created"),
    );
  });

  it("offers MCP setup at the end", async () => {
    mockExistsSync.mockReturnValue(false);

    await invokeProjectCreate({ "skip-github": true });

    expect(mockRunMcpInitPrompt).toHaveBeenCalled();
  });

  it("skips github_app validation when infra config has no github_app", async () => {
    mockLoadInfraConfig.mockReturnValue({
      account_id: "acct-123",
      account_name: "Test Account",
      d1_database_id: "d1-uuid-abc",
      worker_url: "https://tila-shared.workers.dev",
      // no github_app field
    });
    mockExistsSync.mockReturnValue(false);

    await invokeProjectCreate();

    // Should proceed without checking for github-app.json
    expect(mockInsertTokenAndProject).toHaveBeenCalled();
  });

  it("does not call any Worker deployment functions", async () => {
    mockExistsSync.mockReturnValue(false);

    await invokeProjectCreate({ "skip-github": true });

    // Verify no deployment-related functions were called
    expect(mockVerifyCloudflareAuth).not.toHaveBeenCalled();
  });
});

describe("tila project create --local", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // OS defaults
    mockHomedir.mockReturnValue("/home/testuser");

    // Clack defaults
    mockIsCancel.mockReturnValue(false);

    // Provisioning defaults
    mockResolveProjectName.mockResolvedValue("local-project");
    mockDeriveOrg.mockReturnValue("local-org");
    mockGenerateDefaultSchemaToml.mockReturnValue("mock-schema-toml");
    mockRunMcpInitPrompt.mockResolvedValue(undefined);

    // File system defaults
    mockExistsSync.mockReturnValue(false);

    // Re-configure @tila/backend-local mock after clearAllMocks
    mockLocalProjectOpen.mockReturnValue({
      close: vi.fn(),
      getDb: vi.fn(),
    } as unknown as ReturnType<typeof LocalProject.open>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to local provisioning flow", async () => {
    await invokeProjectCreate({ local: true });

    // Should NOT call loadInfraConfig or any Cloudflare functions
    expect(mockLoadInfraConfig).not.toHaveBeenCalled();
    expect(mockVerifyCloudflareAuth).not.toHaveBeenCalled();

    // Should call local-specific functions
    expect(mockResolveProjectName).toHaveBeenCalled();
    expect(mockDeriveOrg).toHaveBeenCalled();
    expect(mockWriteConfigFile).toHaveBeenCalled();
    expect(mockEnsureGitignored).toHaveBeenCalled();
  });

  it("fails if config.toml already exists", async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("config.toml")) return true;
      return false;
    });

    await expect(invokeProjectCreate({ local: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("already initialized"),
    );
  });

  it("writes config with local backend settings", async () => {
    await invokeProjectCreate({ local: true });

    expect(mockWriteConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "local-project",
        backend: "local",
        local: expect.objectContaining({
          org: "local-org",
        }),
      }),
      expect.stringContaining(".tila"),
    );
  });

  it("prints success summary for local mode", async () => {
    await invokeProjectCreate({ local: true });

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("local-project"),
      expect.stringContaining("local mode"),
    );
  });
});

// --- Project Destroy Tests ---

async function invokeProjectDestroy(
  args: Record<string, unknown> = {},
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  await (destroyCmd.run as (opts: any) => Promise<void>)({
    args: {
      force: true,
      "keep-local": false,
      ...args,
    },
  });
}

describe("tila project destroy", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  const DEPLOYED_CONFIG = {
    project_id: "test-proj",
    worker_url: "https://tila-test-proj.workers.dev",
    cloudflare: { account_id: "acct-123" },
  };

  const LOCAL_CONFIG = {
    project_id: "local-proj",
    backend: "local" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    mockHomedir.mockReturnValue("/home/testuser");
    mockIsCancel.mockReturnValue(false);

    // Default: deployed project config with worker_url
    mockFindConfig.mockReturnValue(DEPLOYED_CONFIG);

    // Default infra.toml
    mockLoadInfraConfig.mockReturnValue({
      account_id: "acct-123",
      account_name: "Test Account",
      d1_database_id: "d1-uuid-abc",
    });

    // Default CF token
    mockResolveCfApiToken.mockReturnValue("test-cf-token");
    mockCreateCloudflareClient.mockReturnValue({});

    // Default: .tila/.env exists with TILA_API_TOKEN
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".env")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".env")) {
        return "TILA_API_TOKEN=tila_test-api-token\n";
      }
      return "";
    });

    // Default worker wipe succeeds
    mockWipeProjectViaWorker.mockResolvedValue({
      ok: true,
      doWiped: true,
      journalDeleted: 0,
      r2Deleted: 2,
      r2Kept: 0,
      r2Failed: 0,
      r2GcSkipped: false,
    });

    // Default infra-token wipe succeeds
    mockWipeProjectViaInfraToken.mockResolvedValue({
      ok: true,
      doWiped: true,
      journalDeleted: 0,
      r2Deleted: 1,
      r2Kept: 0,
      r2Failed: 0,
      r2GcSkipped: false,
    });

    // Default D1 cleanup succeeds
    mockCleanD1ProjectRecords.mockResolvedValue({ ok: true, message: "done" });
    mockCleanD1NonTokenRecords.mockResolvedValue({ ok: true, message: "done" });
    mockDeleteD1TokenRecord.mockResolvedValue({ ok: true, message: "done" });
    mockCleanLocalFiles.mockReturnValue({ ok: true, message: "done" });

    // Default verification succeeds (all stores empty)
    mockVerifyStoresEmpty.mockResolvedValue({ ok: true, failures: [] });

    // Default legacy teardown results (should NOT be called by new destroy)
    mockDeleteWorker.mockResolvedValue({ ok: true, message: "done" });
    mockDeleteR2Bucket.mockResolvedValue({ ok: true, message: "done" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exits 1 when no config found", async () => {
    mockFindConfig.mockReturnValue(null);

    await expect(invokeProjectDestroy()).rejects.toThrow("process.exit(1)");
  });

  // Infra-owner destroy by slug: no local .tila/, target resolved from infra.toml
  it("destroys by slug via the infra token when no local config exists", async () => {
    mockFindConfig.mockReturnValue(null);
    mockLoadInfraConfig.mockReturnValue({
      account_id: "acct-infra",
      account_name: "Infra Account",
      d1_database_id: "d1-infra",
      worker_url: "https://tila-infra.workers.dev",
    });
    vi.stubEnv("INFRA_DESTROY_TOKEN", "infra-secret");

    await invokeProjectDestroy({ slug: "remote-proj" });

    // Remote wipe goes through the infra-token client, with the resolved slug.
    expect(mockWipeProjectViaInfraToken).toHaveBeenCalledWith(
      "https://tila-infra.workers.dev",
      "infra-secret",
      "remote-proj",
    );
    // Per-project worker wipe must NOT be used in infra mode.
    expect(mockWipeProjectViaWorker).not.toHaveBeenCalled();
    // D1 cleanup uses the infra account + database + the target slug.
    expect(mockCleanD1NonTokenRecords).toHaveBeenCalledWith(
      expect.anything(),
      "acct-infra",
      "d1-infra",
      "remote-proj",
    );
    // No local .tila/ to remove when destroying a project by slug.
    expect(mockCleanLocalFiles).not.toHaveBeenCalled();
  });

  it("exits 1 in slug mode when no infra destroy token is available", async () => {
    mockFindConfig.mockReturnValue(null);
    mockLoadInfraConfig.mockReturnValue({
      account_id: "acct-infra",
      account_name: "Infra Account",
      d1_database_id: "d1-infra",
      worker_url: "https://tila-infra.workers.dev",
    });
    // Empty env value is treated as unset by resolveInfraDestroyToken.
    vi.stubEnv("INFRA_DESTROY_TOKEN", "");

    await expect(invokeProjectDestroy({ slug: "remote-proj" })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockWipeProjectViaInfraToken).not.toHaveBeenCalled();
  });

  // (a) Happy path: worker→D1 5 tables→verify→_tokens→local
  it("happy path: calls wipeProjectViaWorker then D1 cleanup then verify then local cleanup", async () => {
    await invokeProjectDestroy();

    // Worker wipe called with correct args
    expect(mockWipeProjectViaWorker).toHaveBeenCalledWith(
      "https://tila-test-proj.workers.dev",
      "tila_test-api-token",
      "test-proj",
    );

    // D1 non-token cleanup called
    expect(mockCleanD1NonTokenRecords).toHaveBeenCalledWith(
      expect.anything(),
      "acct-123",
      "d1-uuid-abc",
      "test-proj",
    );

    // Store verification called
    expect(mockVerifyStoresEmpty).toHaveBeenCalled();

    // _tokens deleted last (after verification)
    expect(mockDeleteD1TokenRecord).toHaveBeenCalledWith(
      expect.anything(),
      "acct-123",
      "d1-uuid-abc",
      "test-proj",
    );

    // Local cleanup called (not --keep-local)
    expect(mockCleanLocalFiles).toHaveBeenCalled();
  });

  // (b) Deployed project missing worker_url → failure
  it("fails (does not skip) when deployed project has no worker_url", async () => {
    mockFindConfig.mockReturnValue({
      project_id: "test-proj",
      cloudflare: { account_id: "acct-123" },
      // no worker_url
    });

    await expect(invokeProjectDestroy()).rejects.toThrow("process.exit(1)");

    // Should NOT silently skip and continue
    expect(mockCleanD1ProjectRecords).not.toHaveBeenCalled();
    expect(mockCleanLocalFiles).not.toHaveBeenCalled();
  });

  // (b) Deployed project missing TILA_API_TOKEN → failure
  it("fails when deployed project has worker_url but no TILA_API_TOKEN", async () => {
    // .env file does not exist
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("");

    await expect(invokeProjectDestroy()).rejects.toThrow("process.exit(1)");

    expect(mockWipeProjectViaWorker).not.toHaveBeenCalled();
    expect(mockCleanD1ProjectRecords).not.toHaveBeenCalled();
  });

  // (c) Genuine local-mode project → skip with warning
  it("skips worker wipe with warning for genuine local-mode project", async () => {
    mockFindConfig.mockReturnValue(LOCAL_CONFIG);
    mockLoadInfraConfig.mockImplementation(() => {
      throw new Error("No infra.toml found");
    });

    // Should not exit 1 — local mode just skips worker step
    // D1 cleanup also skipped (no D1 ID for local mode)
    await invokeProjectDestroy();

    // Worker wipe must NOT be called
    expect(mockWipeProjectViaWorker).not.toHaveBeenCalled();
    // Warning about skipping (note: "Local-mode" with capital L)
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("Local-mode"),
    );
  });

  // (d) Non-empty store on read-back → exit non-zero, .tila/ kept
  it("exits 1 and does not remove .tila/ when store verification fails", async () => {
    mockVerifyStoresEmpty.mockResolvedValue({
      ok: false,
      failures: ["DO store fences still has 2 row(s)"],
    });

    await expect(invokeProjectDestroy()).rejects.toThrow("process.exit(1)");

    // .tila/ must NOT be removed when verification fails
    expect(mockCleanLocalFiles).not.toHaveBeenCalled();
  });

  // (e) --json emits structured output
  it("--json flag outputs structured result", async () => {
    const consoleSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await invokeProjectDestroy({ json: true });

    // Some write to stdout with JSON
    const writes = consoleSpy.mock.calls
      .map((call) => String(call[0]))
      .join("");
    const parsed = JSON.parse(writes) as { ok: boolean; stores: unknown };
    expect(parsed.ok).toBe(true);
    expect(parsed.stores).toBeDefined();

    consoleSpy.mockRestore();
  });

  // (f) --keep-local honored
  it("skips local cleanup when --keep-local", async () => {
    await invokeProjectDestroy({ "keep-local": true });

    expect(mockCleanLocalFiles).not.toHaveBeenCalled();
    // But worker wipe and D1 still run
    expect(mockWipeProjectViaWorker).toHaveBeenCalled();
    expect(mockCleanD1NonTokenRecords).toHaveBeenCalled();
  });

  // (g) Idempotent re-run on partially-destroyed project succeeds
  it("idempotent: succeeds if worker wipe reports doWiped=false (already clean)", async () => {
    mockWipeProjectViaWorker.mockResolvedValue({
      ok: true,
      doWiped: false, // already wiped
      journalDeleted: 0,
      r2Deleted: 0,
      r2Kept: 0,
      r2Failed: 0,
      r2GcSkipped: false,
    });
    mockVerifyStoresEmpty.mockResolvedValue({ ok: true, failures: [] });

    // Should not throw
    await invokeProjectDestroy();

    expect(mockCleanD1NonTokenRecords).toHaveBeenCalled();
    expect(mockCleanLocalFiles).toHaveBeenCalled();
  });

  // r2GcSkipped surfaced as note
  it("surfaces r2GcSkipped as a note in output", async () => {
    mockWipeProjectViaWorker.mockResolvedValue({
      ok: true,
      doWiped: true,
      journalDeleted: 0,
      r2Deleted: 0,
      r2Kept: 5,
      r2Failed: 0,
      r2GcSkipped: true,
    });

    await invokeProjectDestroy();

    // Should complete without error and log a warning about skipped GC
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("artifact"),
    );
  });

  it("exits 1 when CF token is missing", async () => {
    mockResolveCfApiToken.mockReturnValue(null);

    await expect(invokeProjectDestroy()).rejects.toThrow("process.exit(1)");
  });

  it("resolves D1 ID from infra.toml", async () => {
    mockLoadInfraConfig.mockReturnValue({
      account_id: "acct-123",
      account_name: "Test Account",
      d1_database_id: "d1-from-infra",
    });

    await invokeProjectDestroy();

    expect(mockCleanD1NonTokenRecords).toHaveBeenCalledWith(
      expect.anything(),
      "acct-123",
      "d1-from-infra",
      "test-proj",
    );
  });

  it("falls back to D1 ID from wrangler.toml when infra.toml missing", async () => {
    mockLoadInfraConfig.mockImplementation(() => {
      throw new Error("No infra.toml found");
    });

    // wrangler.toml exists
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("wrangler.toml"))
        return true;
      if (typeof path === "string" && path.endsWith(".env")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".env")) {
        return "TILA_API_TOKEN=tila_test-api-token\n";
      }
      return "wrangler-toml-content";
    });
    mockSmolTomlParse.mockReturnValue({
      d1_databases: [
        {
          binding: "DB",
          database_name: "tila-global",
          database_id: "d1-from-wrangler",
        },
      ],
    });

    await invokeProjectDestroy();

    expect(mockCleanD1NonTokenRecords).toHaveBeenCalledWith(
      expect.anything(),
      "acct-123",
      "d1-from-wrangler",
      "test-proj",
    );
  });

  it("warns and skips D1 cleanup when no D1 ID found", async () => {
    mockLoadInfraConfig.mockImplementation(() => {
      throw new Error("No infra.toml found");
    });
    mockExistsSync.mockImplementation((path: unknown) => {
      // .env exists but not wrangler.toml
      if (typeof path === "string" && path.endsWith(".env")) return true;
      return false;
    });

    await invokeProjectDestroy();

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("D1 database ID"),
    );
    expect(mockCleanD1ProjectRecords).not.toHaveBeenCalled();
  });

  it("does not call legacy deleteWorker or deleteR2Bucket (infra-level teardown)", async () => {
    await invokeProjectDestroy();

    expect(mockDeleteWorker).not.toHaveBeenCalled();
    expect(mockDeleteR2Bucket).not.toHaveBeenCalled();
    expect(mockDeleteGitHubApp).not.toHaveBeenCalled();
  });
});

// --- Project List Tests ---

async function invokeProjectList(): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  await (listCmd.run as (opts: any) => Promise<void>)({
    args: {},
  });
}

describe("tila project list", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;
  let mockCfQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    mockHomedir.mockReturnValue("/home/testuser");

    // Default infra config
    mockLoadInfraConfig.mockReturnValue({
      account_id: "acct-123",
      account_name: "Test Account",
      d1_database_id: "d1-uuid-abc",
    });

    // Default CF token
    mockResolveCfApiToken.mockReturnValue("test-cf-token");

    // Default CF client with D1 query method
    mockCfQuery = vi.fn();
    mockCreateCloudflareClient.mockReturnValue({
      d1: { database: { query: mockCfQuery } },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 1 when infra.toml is missing", async () => {
    mockLoadInfraConfig.mockImplementation(() => {
      throw new Error("No infra.toml found");
    });

    await expect(invokeProjectList()).rejects.toThrow("process.exit(1)");
  });

  it("exits 1 when CF token is missing", async () => {
    mockResolveCfApiToken.mockReturnValue(null);

    await expect(invokeProjectList()).rejects.toThrow("process.exit(1)");
  });

  it("queries D1 with correct SQL", async () => {
    mockQueryD1.mockResolvedValueOnce([]);

    await invokeProjectList();

    expect(mockQueryD1).toHaveBeenCalledWith(
      expect.anything(),
      "acct-123",
      "d1-uuid-abc",
      "SELECT project_id, display_name, created_at FROM _projects ORDER BY created_at DESC",
    );
  });

  it("prints results when projects exist", async () => {
    mockQueryD1.mockResolvedValueOnce([
      {
        project_id: "my-proj",
        display_name: "My Project",
        created_at: "2025-01-15T12:00:00Z",
      },
      {
        project_id: "other-proj",
        display_name: "Other Project",
        created_at: "2025-01-10T12:00:00Z",
      },
    ]);

    await invokeProjectList();

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("my-proj"),
      expect.stringContaining("2 project(s)"),
    );
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("other-proj"),
      expect.anything(),
    );
  });

  it("prints message when no projects found", async () => {
    mockQueryD1.mockResolvedValueOnce([]);

    await invokeProjectList();

    expect(mockLogInfo).toHaveBeenCalledWith("No projects found.");
  });
});

// --- Project Configure Tests ---

async function invokeProjectConfigure(
  args: Record<string, unknown> = {},
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  await (configureCmd.run as (opts: any) => Promise<void>)({
    args: {
      domain: "tila.acme.com",
      ...args,
    },
  });
}

describe("tila project configure", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  const CLOUDFLARE_CONFIG = {
    project_id: "my-project",
    worker_url: "https://tila.workers.dev",
    schema_version: 1,
    tila_version: "0.1.0",
    created_at: "2025-01-01T00:00:00.000Z",
    cloudflare: { account_id: "acct-123" },
    backends: {
      entity: "do-sqlite",
      coordination: "do-sqlite",
      artifact: "r2",
      auth: "d1",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    mockHomedir.mockReturnValue("/home/testuser");

    // Default: Cloudflare-backed project config
    mockFindConfig.mockReturnValue(CLOUDFLARE_CONFIG);

    // Default: CF token present
    mockResolveCfApiToken.mockReturnValue("test-cf-token");

    // Default: infra config present
    mockLoadInfraConfig.mockReturnValue({
      account_id: "acct-123",
      account_name: "Test Account",
      d1_database_id: "d1-uuid-abc",
      worker_url: "https://tila.workers.dev",
    });

    // Default: zone resolution succeeds
    mockResolveZoneId.mockResolvedValue("zone-id-abc");

    // Default: domain creation succeeds
    mockCreateCustomDomain.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: verifies zone, creates domain, updates config", async () => {
    await invokeProjectConfigure({ domain: "tila.acme.com" });

    expect(mockResolveZoneId).toHaveBeenCalledWith(
      "test-cf-token",
      "acct-123",
      "tila.acme.com",
    );
    expect(mockCreateCustomDomain).toHaveBeenCalledWith({
      apiToken: "test-cf-token",
      accountId: "acct-123",
      zoneId: "zone-id-abc",
      hostname: "tila.acme.com",
      service: "tila",
    });
    expect(mockWriteConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        custom_domain: "tila.acme.com",
        worker_url: "https://tila.acme.com",
      }),
      expect.stringContaining(".tila"),
    );
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("https://tila.acme.com"),
      expect.any(String),
    );
  });

  it("exits 1 when no project config found", async () => {
    mockFindConfig.mockReturnValue(null);

    await expect(invokeProjectConfigure()).rejects.toThrow("process.exit(1)");
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("tila project create"),
    );
  });

  it("exits 1 for local backend project", async () => {
    mockFindConfig.mockReturnValue({
      ...CLOUDFLARE_CONFIG,
      backend: "local",
    });

    await expect(invokeProjectConfigure()).rejects.toThrow("process.exit(1)");
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("Cloudflare"),
    );
  });

  it("exits 1 when CF API token is missing", async () => {
    mockResolveCfApiToken.mockReturnValue(null);

    await expect(invokeProjectConfigure()).rejects.toThrow("process.exit(1)");
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("CLOUDFLARE_API_TOKEN"),
    );
  });

  it("exits 1 when infra.toml is missing", async () => {
    mockLoadInfraConfig.mockImplementation(() => {
      throw new Error("No infra.toml found");
    });

    await expect(invokeProjectConfigure()).rejects.toThrow("process.exit(1)");
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("tila infra provision"),
    );
  });

  it("exits 1 when zone resolution fails", async () => {
    mockResolveZoneId.mockRejectedValue(
      new Error("No Cloudflare zone found for 'tila.acme.com'"),
    );

    await expect(invokeProjectConfigure()).rejects.toThrow("process.exit(1)");
    expect(mockCancel).toHaveBeenCalledWith(
      expect.stringContaining("tila.acme.com"),
    );
  });

  it("logs info and succeeds when domain already configured (409)", async () => {
    // createCustomDomain handles 409 internally and returns without throwing
    mockCreateCustomDomain.mockResolvedValue(undefined);

    await invokeProjectConfigure();

    // Should still write config and show note
    expect(mockWriteConfigFile).toHaveBeenCalled();
    expect(mockNote).toHaveBeenCalled();
  });
});
