import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module-level mocks (must come before any imports of the SUT) ---

const mockFindConfig = vi.fn();
const mockFindTilaDir = vi.fn();
vi.mock("../../config", () => ({
  findConfig: (...args: unknown[]) => mockFindConfig(...args),
  findTilaDir: (...args: unknown[]) => mockFindTilaDir(...args),
}));

const mockWriteTokenFile = vi.fn();
vi.mock("../../auth", () => ({
  writeTokenFile: (...args: unknown[]) => mockWriteTokenFile(...args),
}));

const mockEnsureGitignored = vi.fn();
vi.mock("../../lib/provisioning", () => ({
  ensureGitignored: (...args: unknown[]) => mockEnsureGitignored(...args),
}));

const mockResolveGithubRepoToken = vi.fn();
vi.mock("../../lib/github-exchange", () => ({
  resolveGithubRepoToken: (...args: unknown[]) =>
    mockResolveGithubRepoToken(...args),
}));

const mockRunMcpInitPrompt = vi.fn();
vi.mock("../../lib/mcp-targets", () => ({
  runMcpInitPrompt: (...args: unknown[]) => mockRunMcpInitPrompt(...args),
}));

// @clack/prompts mock
const mockPassword = vi.fn();
const mockIsCancel = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
const mockLogSuccess = vi.fn();
vi.mock("@clack/prompts", () => ({
  password: (...args: unknown[]) => mockPassword(...args),
  isCancel: (...args: unknown[]) => mockIsCancel(...args),
  log: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
    success: (...args: unknown[]) => mockLogSuccess(...args),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

// Mock global fetch for Worker health checks
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// --- Static import AFTER all vi.mock calls ---
import initCmd from "../../commands/init";

// --- Helpers ---

const SAMPLE_CONFIG = {
  project_id: "my-project-abc123",
  worker_url: "https://my-worker.example.com",
  schema_version: 1,
  tila_version: "0.1.0",
  created_at: "2026-01-01T00:00:00Z",
};

async function invokeInit(args: Record<string, unknown> = {}): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
  await (initCmd.run as (opts: any) => Promise<void>)({
    args: { token: undefined, ...args },
  });
}

// --- Test suites ---

describe("tila init", () => {
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

    // Defaults
    mockIsCancel.mockReturnValue(false);
    mockFindTilaDir.mockReturnValue("/mock/project/.tila");
    mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);
    mockRunMcpInitPrompt.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 1 when no config found, mentions tila project create", async () => {
    mockFindConfig.mockReturnValue(null);

    await expect(invokeInit()).rejects.toThrow("process.exit(1)");

    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining("tila project create"),
    );
  });

  describe("tila-token mode", () => {
    beforeEach(() => {
      mockFindConfig.mockReturnValue({ ...SAMPLE_CONFIG });
    });

    it("prompts for token and writes via writeTokenFile", async () => {
      mockPassword.mockResolvedValue("tila_user_provided_token");

      await invokeInit();

      expect(mockPassword).toHaveBeenCalledWith(
        expect.objectContaining({ message: "API token:" }),
      );
      expect(mockWriteTokenFile).toHaveBeenCalledWith(
        "tila_user_provided_token",
        expect.stringContaining(".tila"),
      );
    });

    it("uses --token flag directly without prompting", async () => {
      await invokeInit({ token: "tila_flag_token" });

      expect(mockPassword).not.toHaveBeenCalled();
      expect(mockWriteTokenFile).toHaveBeenCalledWith(
        "tila_flag_token",
        expect.stringContaining(".tila"),
      );
    });

    it("exits 1 when user cancels password prompt", async () => {
      mockIsCancel.mockReturnValue(true);
      mockPassword.mockResolvedValue(Symbol("cancel"));

      await expect(invokeInit()).rejects.toThrow("process.exit(1)");

      expect(mockWriteTokenFile).not.toHaveBeenCalled();
    });

    it("exits 1 when token is empty", async () => {
      mockPassword.mockResolvedValue("   ");

      await expect(invokeInit()).rejects.toThrow("process.exit(1)");

      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("No token provided"),
      );
    });

    it("verifies Worker health when worker_url is set", async () => {
      mockPassword.mockResolvedValue("tila_test");

      await invokeInit();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://my-worker.example.com/health",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("skips Worker health check when no worker_url", async () => {
      mockFindConfig.mockReturnValue({
        ...SAMPLE_CONFIG,
        worker_url: undefined,
      });
      mockPassword.mockResolvedValue("tila_test");

      await invokeInit();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("warns but continues when Worker is unreachable", async () => {
      mockPassword.mockResolvedValue("tila_test");
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      await invokeInit();

      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("Worker unreachable"),
      );
      // Should still complete (no exit)
      expect(mockEnsureGitignored).toHaveBeenCalled();
    });
  });

  describe("github-repo mode", () => {
    const GITHUB_CONFIG = {
      ...SAMPLE_CONFIG,
      auth: { mode: "github-repo" as const },
      github: { host: "github.com", owner: "test-org", repo: "test-repo" },
    };

    beforeEach(() => {
      mockFindConfig.mockReturnValue(GITHUB_CONFIG);
      mockResolveGithubRepoToken.mockResolvedValue("session_token");
    });

    it("calls resolveGithubRepoToken on success", async () => {
      await invokeInit();

      expect(mockResolveGithubRepoToken).toHaveBeenCalledWith(
        expect.objectContaining({
          worker_url: "https://my-worker.example.com",
        }),
        expect.stringContaining(".tila"),
      );
      expect(mockWriteTokenFile).not.toHaveBeenCalled();
      expect(mockLogSuccess).toHaveBeenCalledWith(
        expect.stringContaining("GitHub"),
      );
    });

    it("exits 1 when config has no worker_url", async () => {
      mockFindConfig.mockReturnValue({
        ...GITHUB_CONFIG,
        worker_url: undefined,
      });

      await expect(invokeInit()).rejects.toThrow("process.exit(1)");

      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("no worker_url"),
      );
      expect(mockResolveGithubRepoToken).not.toHaveBeenCalled();
    });

    it("exits 1 when [github] section is missing", async () => {
      mockFindConfig.mockReturnValue({
        ...SAMPLE_CONFIG,
        auth: { mode: "github-repo" as const },
        // no github section
      });

      await expect(invokeInit()).rejects.toThrow("process.exit(1)");

      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("[github]"),
      );
      expect(mockResolveGithubRepoToken).not.toHaveBeenCalled();
    });

    it("verifies Worker health before resolving token", async () => {
      await invokeInit();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://my-worker.example.com/health",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("exits 1 when Worker health check fails", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 } as Response);

      await expect(invokeInit()).rejects.toThrow("process.exit(1)");

      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("Worker unreachable"),
      );
      expect(mockResolveGithubRepoToken).not.toHaveBeenCalled();
    });

    it("warns when --token flag is provided (ignored in github-repo mode)", async () => {
      await invokeInit({ token: "tila_ignored" });

      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("ignored"),
      );
      // resolveGithubRepoToken is still called
      expect(mockResolveGithubRepoToken).toHaveBeenCalled();
    });

    it("exits 1 with GitHub App hint when app not configured", async () => {
      mockResolveGithubRepoToken.mockRejectedValue(
        new Error("GitHub App not configured for repo"),
      );

      await expect(invokeInit()).rejects.toThrow("process.exit(1)");

      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("GitHub App not configured"),
      );
    });
  });

  describe("gitignore update", () => {
    it("calls ensureGitignored with correct entries including github-token-cache.json", async () => {
      mockFindConfig.mockReturnValue({ ...SAMPLE_CONFIG });
      mockPassword.mockResolvedValue("tila_test");

      await invokeInit();

      expect(mockEnsureGitignored).toHaveBeenCalledWith(
        [".tila/.env", ".tila/.session", ".tila/github-token-cache.json"],
        expect.any(String),
      );
    });
  });

  describe("MCP setup", () => {
    it("calls runMcpInitPrompt after auth is configured", async () => {
      mockFindConfig.mockReturnValue({ ...SAMPLE_CONFIG });
      mockPassword.mockResolvedValue("tila_test");

      await invokeInit();

      expect(mockRunMcpInitPrompt).toHaveBeenCalledWith(expect.any(String));
    });
  });
});
