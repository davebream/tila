import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock fs before importing github-auth
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createGithubTokenProvider } from "../github-auth";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

const TEST_CONFIG = {
  project_id: "proj-test-123",
  worker_url: "https://tila.example.com",
};
const TEST_TILA_DIR = "/home/user/.tila";

describe("createGithubTokenProvider", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("");
    mockWriteFileSync.mockImplementation(() => undefined);
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "");
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("cache hit", () => {
    it("returns cached session token when TTL is greater than 10 minutes", async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const sessionCache = {
        session_token: "cached-session-token",
        expires_at: futureExpiry,
        project_id: TEST_CONFIG.project_id,
      };

      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).endsWith(".session");
      });
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith(".session")) {
          return JSON.stringify(sessionCache);
        }
        return "";
      });

      const getToken = createGithubTokenProvider(TEST_CONFIG, TEST_TILA_DIR);
      const token = await getToken();

      expect(token).toBe("cached-session-token");
    });

    it("does NOT return cached token when within 10-minute proactive refresh window", async () => {
      const nearExpiry = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now
      const sessionCache = {
        session_token: "about-to-expire-token",
        expires_at: nearExpiry,
        project_id: TEST_CONFIG.project_id,
      };

      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).endsWith(".session");
      });
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith(".session")) {
          return JSON.stringify(sessionCache);
        }
        return "";
      });

      // No OIDC env vars and no device flow → should throw error
      const getToken = createGithubTokenProvider(TEST_CONFIG, TEST_TILA_DIR);
      await expect(getToken()).rejects.toThrow("tila auth login");
    });

    it("does NOT use cached token when project_id does not match", async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
      const sessionCache = {
        session_token: "other-project-token",
        expires_at: futureExpiry,
        project_id: "different-project-id",
      };

      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).endsWith(".session");
      });
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith(".session")) {
          return JSON.stringify(sessionCache);
        }
        return "";
      });

      const getToken = createGithubTokenProvider(TEST_CONFIG, TEST_TILA_DIR);
      await expect(getToken()).rejects.toThrow("tila auth login");
    });
  });

  describe("OIDC exchange", () => {
    it("exchanges OIDC token when ACTIONS_ID_TOKEN_REQUEST_URL is set", async () => {
      // No cached session
      mockExistsSync.mockReturnValue(false);

      // Set OIDC env vars
      vi.stubEnv(
        "ACTIONS_ID_TOKEN_REQUEST_URL",
        "https://token.actions.githubusercontent.com/oidc",
      );
      vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "gha-token-request-token");

      const oidcToken = "oidc-jwt-token-value";
      const sessionToken = "exchanged-session-token";
      const expiresAt = Math.floor(Date.now() / 1000) + 7200;

      // Mock fetch
      const mockFetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url: RequestInfo | URL) => {
          const urlStr = String(url);
          if (urlStr.includes("token.actions.githubusercontent.com")) {
            return new Response(JSON.stringify({ value: oidcToken }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (urlStr.includes("/api/auth/github/exchange-oidc")) {
            return new Response(
              JSON.stringify({
                session_token: sessionToken,
                expires_at: expiresAt,
                project_id: TEST_CONFIG.project_id,
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          throw new Error(`Unexpected fetch call: ${urlStr}`);
        });

      const getToken = createGithubTokenProvider(TEST_CONFIG, TEST_TILA_DIR);
      const token = await getToken();

      expect(token).toBe(sessionToken);

      // Verify OIDC endpoint was called with correct audience
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent(TEST_CONFIG.worker_url)),
        expect.objectContaining({
          headers: { Authorization: "bearer gha-token-request-token" },
        }),
      );

      // Verify exchange endpoint was called with project_id and oidc_token
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_CONFIG.worker_url}/api/auth/github/exchange-oidc`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            project_id: TEST_CONFIG.project_id,
            oidc_token: oidcToken,
          }),
        }),
      );

      // Verify session was cached
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".session"),
        JSON.stringify({
          session_token: sessionToken,
          expires_at: expiresAt,
          project_id: TEST_CONFIG.project_id,
        }),
        expect.objectContaining({ mode: 0o600 }),
      );

      mockFetch.mockRestore();
    });

    it("throws actionable error when OIDC token request fails", async () => {
      mockExistsSync.mockReturnValue(false);

      vi.stubEnv(
        "ACTIONS_ID_TOKEN_REQUEST_URL",
        "https://token.actions.githubusercontent.com/oidc",
      );
      vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "gha-token-request-token");

      const mockFetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("Unauthorized", { status: 401 }));

      const getToken = createGithubTokenProvider(TEST_CONFIG, TEST_TILA_DIR);
      await expect(getToken()).rejects.toThrow(
        "Failed to request OIDC token from GitHub (401)",
      );

      mockFetch.mockRestore();
    });

    it("throws actionable error when OIDC exchange fails", async () => {
      mockExistsSync.mockReturnValue(false);

      vi.stubEnv(
        "ACTIONS_ID_TOKEN_REQUEST_URL",
        "https://token.actions.githubusercontent.com/oidc",
      );
      vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "gha-token-request-token");

      const mockFetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url: RequestInfo | URL) => {
          const urlStr = String(url);
          if (urlStr.includes("token.actions.githubusercontent.com")) {
            return new Response(JSON.stringify({ value: "oidc-token" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (urlStr.includes("/api/auth/github/exchange-oidc")) {
            return new Response(
              JSON.stringify({
                error: { message: "Repo not registered" },
              }),
              {
                status: 403,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          throw new Error(`Unexpected fetch: ${urlStr}`);
        });

      const getToken = createGithubTokenProvider(TEST_CONFIG, TEST_TILA_DIR);
      await expect(getToken()).rejects.toThrow("OIDC token exchange failed");

      mockFetch.mockRestore();
    });
  });

  describe("no session and no OIDC", () => {
    it("throws actionable error when no session cache and no OIDC env vars", async () => {
      // No cached session
      mockExistsSync.mockReturnValue(false);

      // No OIDC env vars (already cleared in beforeEach)

      const getToken = createGithubTokenProvider(TEST_CONFIG, TEST_TILA_DIR);

      await expect(getToken()).rejects.toThrow(
        "No valid GitHub session. Run `tila auth login` to authenticate.",
      );
    });

    it("throws actionable error when session cache is corrupted", async () => {
      mockExistsSync.mockImplementation((path: unknown) =>
        String(path).endsWith(".session"),
      );
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith(".session")) {
          return "not-valid-json{{{";
        }
        return "";
      });

      const getToken = createGithubTokenProvider(TEST_CONFIG, TEST_TILA_DIR);
      await expect(getToken()).rejects.toThrow("tila auth login");
    });
  });
});
