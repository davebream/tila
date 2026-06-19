import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// Mock node:fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock @clack/prompts
vi.mock("@clack/prompts", () => ({
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

// Mock the resolveAppUserToken import
vi.mock("../../lib/github-oauth-device", () => ({
  resolveAppUserToken: vi.fn(),
}));

import * as p from "@clack/prompts";
import {
  resolveGithubRepoToken,
  warnIfRemoteMismatch,
} from "../../lib/github-exchange";
import { resolveAppUserToken } from "../../lib/github-oauth-device";

const baseConfig = {
  project_id: "test-proj",
  worker_url: "https://test.workers.dev",
  github: { host: "github.com", owner: "testorg", repo: "testrepo" },
};

describe("resolveGithubRepoToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
  });

  it("returns cached session token when cache is valid (TTL > 10min)", async () => {
    const futureExpiry = Date.now() / 1000 + 7200; // 2 hours from now
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        session_token: "tila_s.cached_token",
        expires_at: futureExpiry,
        project_id: "test-proj",
      }),
    );

    const token = await resolveGithubRepoToken(baseConfig, "/tmp/tila");

    expect(token).toBe("tila_s.cached_token");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(resolveAppUserToken).not.toHaveBeenCalled();
  });

  it("re-exchanges when cache TTL is under 10 minutes (proactive refresh)", async () => {
    const nearExpiry = Date.now() / 1000 + 300; // 5 minutes from now
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        session_token: "tila_s.stale_token",
        expires_at: nearExpiry,
        project_id: "test-proj",
      }),
    );

    vi.mocked(resolveAppUserToken).mockResolvedValueOnce("ghu_test_app_token");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session_token: "tila_s.fresh_token",
        expires_at: Date.now() / 1000 + 3600,
        project_id: "test-proj",
      }),
    });

    const token = await resolveGithubRepoToken(baseConfig, "/tmp/tila");

    expect(token).toBe("tila_s.fresh_token");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://test.workers.dev/api/auth/github/exchange",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          auth_method: "user_token",
          project_id: "test-proj",
          user_token: "ghu_test_app_token",
        }),
      }),
    );
    expect(resolveAppUserToken).toHaveBeenCalledWith(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );
  });

  it("uses GITHUB_TOKEN env var when set", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // no cache
    process.env.GITHUB_TOKEN = "ghp_env_token";

    vi.mocked(resolveAppUserToken).mockResolvedValueOnce("ghp_env_token");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session_token: "tila_s.new_token",
        expires_at: Date.now() / 1000 + 3600,
        project_id: "test-proj",
      }),
    });

    const token = await resolveGithubRepoToken(baseConfig, "/tmp/tila");

    expect(token).toBe("tila_s.new_token");
    // Verify fetch was called with auth_method: "user_token"
    expect(mockFetch).toHaveBeenCalledWith(
      "https://test.workers.dev/api/auth/github/exchange",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          auth_method: "user_token",
          project_id: "test-proj",
          user_token: "ghp_env_token",
        }),
      }),
    );
    // resolveAppUserToken should have been called
    expect(resolveAppUserToken).toHaveBeenCalledWith(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );
  });

  it("calls resolveAppUserToken when no cache or env token", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    vi.mocked(resolveAppUserToken).mockResolvedValueOnce("ghu_device_token");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session_token: "tila_s.device_token",
        expires_at: Date.now() / 1000 + 3600,
        project_id: "test-proj",
      }),
    });

    const token = await resolveGithubRepoToken(baseConfig, "/tmp/tila");

    expect(token).toBe("tila_s.device_token");
    expect(resolveAppUserToken).toHaveBeenCalledWith(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://test.workers.dev/api/auth/github/exchange",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          auth_method: "user_token",
          project_id: "test-proj",
          user_token: "ghu_device_token",
        }),
      }),
    );
  });

  it("throws on 403 with 'not registered' message", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(resolveAppUserToken).mockResolvedValueOnce("ghu_test");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: { message: "Repository not registered for this project" },
      }),
    });

    await expect(
      resolveGithubRepoToken(baseConfig, "/tmp/tila"),
    ).rejects.toThrow(/not registered/i);
  });

  // AC-3 regression (#103): the 403 auth-failure message must name the real
  // recovery command `tila repos register`, never the phantom "tila admin CLI".
  // This drives resolveGithubRepoToken's res.status === 403 branch directly
  // (the reachable behavioral seam for the github-exchange message bug).
  it("names `tila repos register` and not 'tila admin CLI' in the 403 message", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(resolveAppUserToken).mockResolvedValueOnce("ghu_test");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: { message: "Repository not registered for this project" },
      }),
    });

    let thrown: unknown;
    try {
      await resolveGithubRepoToken(baseConfig, "/tmp/tila");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("tila repos register");
    expect(message).not.toContain("tila admin CLI");
  });

  it("throws on 500 with status code", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(resolveAppUserToken).mockResolvedValueOnce("ghu_test");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(
      resolveGithubRepoToken(baseConfig, "/tmp/tila"),
    ).rejects.toThrow(/token exchange failed \(500\)/i);
  });

  it("writes session cache after successful exchange", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(resolveAppUserToken).mockResolvedValueOnce("ghu_test");

    const expiresAt = Date.now() / 1000 + 3600;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session_token: "tila_s.new",
        expires_at: expiresAt,
        project_id: "test-proj",
      }),
    });

    await resolveGithubRepoToken(baseConfig, "/tmp/tila");

    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/tila/.session",
      expect.stringContaining("tila_s.new"),
      expect.objectContaining({ mode: 0o600 }),
    );
  });

  it("verifies requireTokenAsync chain compiles and resolves", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(resolveAppUserToken).mockResolvedValueOnce("ghu_chain_test");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session_token: "tila_s.chain_token",
        expires_at: Date.now() / 1000 + 3600,
        project_id: "test-proj",
      }),
    });

    const token = await resolveGithubRepoToken(baseConfig, "/tmp/tila");

    expect(token).toBe("tila_s.chain_token");
    expect(resolveAppUserToken).toHaveBeenCalledWith(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );
  });
});

describe("warnIfRemoteMismatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not warn when remote matches config", () => {
    vi.mocked(execSync).mockReturnValue(
      "https://github.com/testorg/testrepo.git\n",
    );

    warnIfRemoteMismatch(
      { github: { owner: "testorg", repo: "testrepo" } },
      "/tmp/project",
    );

    expect(vi.mocked(p.log.warn)).not.toHaveBeenCalled();
  });

  it("warns when remote does not match config", () => {
    vi.mocked(execSync).mockReturnValue(
      "https://github.com/otherorg/otherrepo.git\n",
    );

    warnIfRemoteMismatch(
      { github: { owner: "testorg", repo: "testrepo" } },
      "/tmp/project",
    );

    expect(vi.mocked(p.log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("does not match"),
    );
  });

  it("does not throw when git command fails", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not a git repository");
    });

    expect(() =>
      warnIfRemoteMismatch(
        { github: { owner: "testorg", repo: "testrepo" } },
        "/tmp/project",
      ),
    ).not.toThrow();
  });

  it("handles SSH remote URLs", () => {
    vi.mocked(execSync).mockReturnValue(
      "git@github.com:testorg/testrepo.git\n",
    );

    warnIfRemoteMismatch(
      { github: { owner: "testorg", repo: "testrepo" } },
      "/tmp/project",
    );

    expect(vi.mocked(p.log.warn)).not.toHaveBeenCalled();
  });

  it("skips when github config is missing", () => {
    warnIfRemoteMismatch({}, "/tmp/project");

    expect(execSync).not.toHaveBeenCalled();
  });
});
