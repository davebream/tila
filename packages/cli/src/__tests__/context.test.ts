import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @tila/backend-local before importing the module under test
vi.mock("@tila/backend-local", () => ({
  LocalProject: {
    open: vi.fn().mockReturnValue({ close: vi.fn(), getDb: vi.fn() }),
  },
  LocalArtifactBackend: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  LocalFilesystemError: class LocalFilesystemError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "LocalFilesystemError";
    }
  },
}));

const mockResolveCfApiToken = vi.fn().mockReturnValue(null);
vi.mock("../lib/provisioning", () => ({
  deriveOrg: vi.fn().mockReturnValue("testorg"),
  resolveCfApiToken: (...args: unknown[]) => mockResolveCfApiToken(...args),
}));

// Mock all dependencies before importing
vi.mock("../lib/wrangler", () => ({
  verifyCloudflareAuth: vi.fn(async () => ({
    account_id: "acc-123",
    account_name: "Test",
  })),
  checkAccountMatch: vi.fn(),
}));

vi.mock("../config", () => ({
  findConfig: vi.fn(() => ({
    project_id: "test-proj",
    worker_url: "https://test.workers.dev",
    schema_version: 1,
    tila_version: "0.1.0",
    created_at: "2026-01-01T00:00:00Z",
    cloudflare: { account_id: "acc-123" },
    backends: {
      entity: "do-sqlite",
      coordination: "do-sqlite",
      artifact: "r2",
      auth: "d1",
    },
  })),
}));

vi.mock("../auth", () => ({
  requireTokenAsync: vi.fn(async () => "tok_test123"),
  resolveToken: vi.fn(() => "tok_test123"),
}));

vi.mock("../lib/client-factory", () => ({
  createCliClientFromConfig: vi.fn(() => ({})),
}));

import os from "node:os";
import { requireTokenAsync } from "../auth";
import { findConfig } from "../config";
import { runStartupChecks } from "../context";
import { checkAccountMatch, verifyCloudflareAuth } from "../lib/wrangler";

const defaultConfig = {
  project_id: "test-proj",
  worker_url: "https://test.workers.dev",
  schema_version: 1,
  tila_version: "0.1.0",
  created_at: "2026-01-01T00:00:00Z",
  cloudflare: { account_id: "acc-123" },
  backends: {
    entity: "do-sqlite",
    coordination: "do-sqlite",
    artifact: "r2",
    auth: "d1",
  },
};

describe("runStartupChecks", () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedToken = process.env.CLOUDFLARE_API_TOKEN;
    Reflect.deleteProperty(process.env, "CLOUDFLARE_API_TOKEN");
    mockResolveCfApiToken.mockReturnValue("test-cf-token");
    // Restore default mock implementations after clearAllMocks
    vi.mocked(findConfig).mockReturnValue(
      defaultConfig as ReturnType<typeof findConfig>,
    );
    vi.mocked(requireTokenAsync).mockResolvedValue("tok_test123");
    vi.mocked(verifyCloudflareAuth).mockResolvedValue({
      account_id: "acc-123",
      account_name: "Test",
    });
  });

  afterEach(() => {
    if (savedToken !== undefined) {
      process.env.CLOUDFLARE_API_TOKEN = savedToken;
    } else {
      Reflect.deleteProperty(process.env, "CLOUDFLARE_API_TOKEN");
    }
  });

  it("runs all checks in order when skipAuth is false and CLOUDFLARE_API_TOKEN is set", async () => {
    const callOrder: string[] = [];
    vi.mocked(findConfig).mockImplementation(() => {
      callOrder.push("findConfig");
      return defaultConfig as ReturnType<typeof findConfig>;
    });
    vi.mocked(verifyCloudflareAuth).mockImplementation(async () => {
      callOrder.push("verifyCloudflareAuth");
      return { account_id: "acc-123", account_name: "Test" };
    });
    vi.mocked(checkAccountMatch).mockImplementation(() => {
      callOrder.push("accountMatch");
    });
    vi.mocked(requireTokenAsync).mockImplementation(async () => {
      callOrder.push("requireToken");
      return "tok_test123";
    });

    await runStartupChecks();

    expect(callOrder).toEqual([
      "findConfig",
      "requireToken",
      "verifyCloudflareAuth",
      "accountMatch",
    ]);
  });

  it("skips auth checks when skipAuth is true", async () => {
    await runStartupChecks({ skipAuth: true });

    expect(findConfig).toHaveBeenCalled();
    expect(requireTokenAsync).toHaveBeenCalled();
    expect(verifyCloudflareAuth).not.toHaveBeenCalled();
    expect(checkAccountMatch).not.toHaveBeenCalled();
  });

  it("when CLOUDFLARE_API_TOKEN is not set, verifyCloudflareAuth is not called and startup succeeds", async () => {
    mockResolveCfApiToken.mockReturnValue(null);

    const ctx = await runStartupChecks();

    expect(verifyCloudflareAuth).not.toHaveBeenCalled();
    expect(checkAccountMatch).not.toHaveBeenCalled();
    expect(ctx).toHaveProperty("config");
    expect(ctx.config.project_id).toBe("test-proj");
  });

  it("throws when no config found", async () => {
    vi.mocked(findConfig).mockReturnValue(null);

    await expect(runStartupChecks()).rejects.toThrow(/no tila project found/i);
  });

  it("throws when no token found", async () => {
    vi.mocked(requireTokenAsync).mockRejectedValue(
      new Error("No API token found."),
    );

    await expect(runStartupChecks()).rejects.toThrow(/no api token found/i);
  });

  it("returns CommandContext on success", async () => {
    const ctx = await runStartupChecks();
    expect(ctx).toHaveProperty("config");
    expect(ctx).toHaveProperty("client");
    expect(ctx).toHaveProperty("machine");
    expect(ctx.machine).toEqual(expect.any(String));
    expect(ctx).toHaveProperty("entity");
    expect(ctx).toHaveProperty("coordination");
    expect(ctx).toHaveProperty("artifact");
    expect(ctx.config.project_id).toBe("test-proj");
  });

  it("throws when backend is local but [local] section is missing", async () => {
    vi.mocked(findConfig).mockReturnValue({
      ...defaultConfig,
      backend: "local",
      // No local section — should throw with helpful message
    } as ReturnType<typeof findConfig>);

    await expect(runStartupChecks()).rejects.toThrow(
      /missing \[local\] section/i,
    );
  });

  it("returns local CommandContext when backend is local with [local] section", async () => {
    vi.mocked(findConfig).mockReturnValue({
      ...defaultConfig,
      backend: "local",
      local: {
        db_path: "/home/user/.tila/projects/test-proj/state.db",
        artifacts_path: "/home/user/.tila/artifacts/testorg/test-proj",
        org: "testorg",
      },
    } as ReturnType<typeof findConfig>);

    const ctx = await runStartupChecks();

    expect(ctx).toHaveProperty("entity");
    expect(ctx).toHaveProperty("coordination");
    expect(ctx).toHaveProperty("artifact");
    expect(ctx.machine).toEqual(expect.any(String));
  });

  describe("TILA_MACHINE env var", () => {
    afterEach(() => {
      Reflect.deleteProperty(process.env, "TILA_MACHINE");
    });

    it("uses TILA_MACHINE when set", async () => {
      process.env.TILA_MACHINE = "custom-machine";
      const ctx = await runStartupChecks();
      expect(ctx.machine).toBe("custom-machine");
    });

    it("falls back to os.hostname() when TILA_MACHINE is not set", async () => {
      Reflect.deleteProperty(process.env, "TILA_MACHINE");
      const ctx = await runStartupChecks();
      expect(ctx.machine).toBe(os.hostname());
    });

    it("falls back to os.hostname() when TILA_MACHINE is empty string", async () => {
      process.env.TILA_MACHINE = "";
      const ctx = await runStartupChecks();
      expect(ctx.machine).toBe(os.hostname());
    });
  });
});
