import { Hono } from "hono";
import { SignJWT, importJWK } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMIT_MAX_FAILURES, RATE_LIMIT_WINDOW_MS } from "../config";
import { base64UrlDecode, base64UrlEncode } from "../lib/base64url";
import type { Env, HonoVariables } from "../types";

// Mock GitHub API client -- must be declared before imports
const mockGetAuthenticatedUser = vi.fn();
const mockGetRepoPermission = vi.fn();
const mockExchangeOAuthCode = vi.fn();

vi.mock("../lib/github-client", () => ({
  getAuthenticatedUser: mockGetAuthenticatedUser,
  getRepoPermission: mockGetRepoPermission,
  exchangeOAuthCode: mockExchangeOAuthCode,
}));

// Mock github-app module
const mockMintAppJwt = vi.fn();
const mockGetInstallationAccessToken = vi.fn();
const mockCheckUserMembership = vi.fn();

vi.mock("../lib/github-app", () => ({
  mintAppJwt: mockMintAppJwt,
  getInstallationAccessToken: mockGetInstallationAccessToken,
  checkUserMembership: mockCheckUserMembership,
}));

// Mock oidc-verify module
const mockVerifyOidcToken = vi.fn();

vi.mock("../lib/oidc-verify", () => ({
  verifyOidcToken: mockVerifyOidcToken,
  OidcVerificationError: class OidcVerificationError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
      this.name = "OidcVerificationError";
    }
  },
}));

// Mock deployment-instance module (per-isolate cache + resolver)
const mockEnsureDeploymentInstanceId = vi
  .fn()
  .mockResolvedValue("test-deployment-instance-id");

vi.mock("../lib/deployment-instance", () => ({
  ensureDeploymentInstanceId: (...args: unknown[]) =>
    mockEnsureDeploymentInstanceId(...args),
  __resetInstanceCache: vi.fn(),
}));

// Mock backend-d1 stores
const mockRateLimitCheck = vi.fn().mockResolvedValue(false);
const mockRateLimitRecordFailure = vi.fn().mockResolvedValue(undefined);
const mockIdempotencyCheck = vi.fn().mockResolvedValue(null);
const mockIdempotencyStore = vi.fn().mockResolvedValue(undefined);
const mockListForProject = vi.fn().mockResolvedValue([]);
const mockIsRegistered = vi.fn().mockResolvedValue(null);
const mockGitHubAppConfigSetInstallation = vi.fn().mockResolvedValue(undefined);
const mockGitHubAppConfigGetInstallation = vi.fn().mockResolvedValue(null);
const mockD1TokenValidate = vi.fn().mockResolvedValue(null);
const mockD1TokenUpdateLastUsedAt = vi.fn().mockResolvedValue(undefined);
const mockD1SessionCreate = vi.fn().mockResolvedValue(undefined);

vi.mock("@tila/backend-d1", () => ({
  D1DeploymentMetaStore: vi.fn().mockImplementation(
    class {
      ensure = vi.fn().mockResolvedValue("test-deployment-instance-id");
      get = vi.fn().mockResolvedValue("test-deployment-instance-id");
      seed = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  D1RateLimitStore: vi.fn().mockImplementation(
    class {
      check = mockRateLimitCheck;
      recordFailure = mockRateLimitRecordFailure;
    } as unknown as () => unknown,
  ),
  D1IdempotencyStore: vi.fn().mockImplementation(
    class {
      check = mockIdempotencyCheck;
      store = mockIdempotencyStore;
    } as unknown as () => unknown,
  ),
  RepoAllowlistStore: vi.fn().mockImplementation(
    class {
      listForProject = mockListForProject;
      isRegistered = mockIsRegistered;
    } as unknown as () => unknown,
  ),
  GitHubAppConfigStore: vi.fn().mockImplementation(
    class {
      setInstallation = mockGitHubAppConfigSetInstallation;
      getInstallation = mockGitHubAppConfigGetInstallation;
    } as unknown as () => unknown,
  ),
  D1TokenStore: vi.fn().mockImplementation(
    class {
      validate = mockD1TokenValidate;
      updateLastUsedAt = mockD1TokenUpdateLastUsedAt;
    } as unknown as () => unknown,
  ),
  D1SessionStore: vi.fn().mockImplementation(
    class {
      create = mockD1SessionCreate;
    } as unknown as () => unknown,
  ),
}));

// Import after mocks are set up
const { authGithub } = await import("./auth-github");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

// Test HMAC key (32 bytes, base64url-encoded)
// "test-hmac-key-this-is-32-bytes!!" = 32 chars
const TEST_HMAC_KEY = btoa("test-hmac-key-this-is-32-bytes!!")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

const mockDb = {
  prepare: () => ({
    bind: () => ({ run: vi.fn().mockResolvedValue(undefined) }),
  }),
};

// Test GitHub App keys (for App exchange tests)
const TEST_APP_ID = "12345";
// gitleaks:allow - Truncated invalid test fixture
const TEST_APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj
MzEfYyjiWA4R4/M2bS1+fWIcPm15j9mJzKQ7j0fJ9lW6m3VnYWTz6vADC0Rv
-----END PRIVATE KEY-----`;

// Env is passed as third arg to app.request
const testEnv = {
  GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
  DB: mockDb,
  PROJECT: {} as DurableObjectNamespace,
  ARTIFACTS: {} as R2Bucket,
  ANALYTICS: {
    writeDataPoint: vi.fn(),
  } as unknown as AnalyticsEngineDataset,
  ASSETS: {} as Fetcher,
} as unknown as Env;

function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route("/api/auth/github", authGithub);
  return app;
}

const MOCK_REPO = {
  project_id: "test-project",
  github_host: "github.com",
  github_owner: "test-org",
  github_repo: "test-repo",
  github_repo_id: 99999,
  min_read_permission: "read",
  min_write_permission: "write",
  enabled: 1,
  created_at: 1000000,
  created_by: "admin",
};

describe("POST /api/auth/github/exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue(false);
    mockIdempotencyCheck.mockResolvedValue(null);
    mockListForProject.mockResolvedValue([]);
    mockRateLimitRecordFailure.mockResolvedValue(undefined);
    mockGitHubAppConfigGetInstallation.mockResolvedValue(null);
  });

  it("returns 400 on missing fields", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      testEnv,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 400 on invalid JSON", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      },
      testEnv,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 403 when GitHub auth fails", async () => {
    const app = createApp();
    mockGetAuthenticatedUser.mockRejectedValue(
      new Error("GitHub API returned 401"),
    );

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_fake",
        }),
      },
      testEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("github-auth-failed");
  });

  it("returns 403 when no repos are registered for project", async () => {
    const app = createApp();
    mockGetAuthenticatedUser.mockResolvedValue({
      login: "testuser",
      id: 12345,
    });
    mockListForProject.mockResolvedValue([]);

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "nonexistent-project",
          github_token: "ghp_fake",
        }),
      },
      testEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("repo-not-allowed");
  });

  it("returns 403 when user has insufficient permissions", async () => {
    const app = createApp();
    mockGetAuthenticatedUser.mockResolvedValue({
      login: "testuser",
      id: 12345,
    });
    mockListForProject.mockResolvedValue([MOCK_REPO]);
    mockGetRepoPermission.mockResolvedValue("none");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_fake",
        }),
      },
      testEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("repo-not-allowed");
  });

  it("returns 200 with session token for valid registered repo", async () => {
    const app = createApp();
    mockGetAuthenticatedUser.mockResolvedValue({
      login: "testuser",
      id: 12345,
    });
    mockListForProject.mockResolvedValue([MOCK_REPO]);
    mockGetRepoPermission.mockResolvedValue("write");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_valid",
        }),
      },
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      session_token: string;
      expires_at: number;
      project_id: string;
      github_login: string;
      permission: string;
    };
    expect(body.ok).toBe(true);
    expect(body.session_token).toMatch(/^tila_s\./);
    expect(body.project_id).toBe("test-project");
    expect(body.github_login).toBe("testuser");
    expect(body.permission).toBe("write");
    expect(body.expires_at).toBeGreaterThan(Date.now() / 1000);
  });

  it("returns 429 when rate limited", async () => {
    const app = createApp();
    mockRateLimitCheck.mockResolvedValue(true);

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "1.2.3.4",
        },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_fake",
        }),
      },
      testEnv,
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate-limited");
  });

  it("session token has correct tila_s. format with 3 parts", async () => {
    const app = createApp();
    mockGetAuthenticatedUser.mockResolvedValue({ login: "adminuser", id: 99 });
    mockListForProject.mockResolvedValue([MOCK_REPO]);
    mockGetRepoPermission.mockResolvedValue("admin");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_admin",
        }),
      },
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session_token: string;
      permission: string;
    };

    // Verify session token format: tila_s.<jwtHeader>.<jwtPayload>.<jwtSig>
    const parts = body.session_token.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("tila_s");
    expect(body.permission).toBe("admin");

    // Decode and verify JWT payload (index 2: header.payload.sig, prefix at 0)
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadStr) as {
      project_id: string;
      github_login: string;
      permission: string;
    };
    expect(payload.project_id).toBe("test-project");
    expect(payload.github_login).toBe("adminuser");
    expect(payload.permission).toBe("admin");
  });
});

describe("POST /api/auth/github/exchange (App path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue(false);
    mockIdempotencyCheck.mockResolvedValue(null);
    mockListForProject.mockResolvedValue([]);
    mockGitHubAppConfigGetInstallation.mockResolvedValue(null);
    mockMintAppJwt.mockResolvedValue("app-jwt-fake");
    mockGetInstallationAccessToken.mockResolvedValue("ghs_install_token_fake");
    mockCheckUserMembership.mockResolvedValue(null);
  });

  it("returns 200 with session token for valid App exchange", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
    } as unknown as Env;

    mockGetAuthenticatedUser.mockResolvedValue({
      login: "appuser",
      id: 54321,
    });
    mockGitHubAppConfigGetInstallation.mockResolvedValue({
      project_id: "test-project",
      installation_id: 12345,
      created_at: 1000000,
      created_by: "admin",
    });
    mockListForProject.mockResolvedValue([MOCK_REPO]);
    mockCheckUserMembership.mockResolvedValue("write");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          user_token: "ghu_user_token_fake",
          auth_method: "user_token",
        }),
      },
      envWithApp,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      session_token: string;
      expires_at: number;
      project_id: string;
      github_login: string;
      permission: string;
    };
    expect(body.ok).toBe(true);
    expect(body.session_token).toMatch(/^tila_s\./);
    expect(body.project_id).toBe("test-project");
    expect(body.github_login).toBe("appuser");
    expect(body.permission).toBe("write");

    // Verify App auth flow was called
    expect(mockMintAppJwt).toHaveBeenCalledWith(
      Number(TEST_APP_ID),
      TEST_APP_PRIVATE_KEY,
    );
    expect(mockGetInstallationAccessToken).toHaveBeenCalledWith(
      "app-jwt-fake",
      12345,
    );
    expect(mockCheckUserMembership).toHaveBeenCalledWith(
      "ghs_install_token_fake",
      MOCK_REPO.github_owner,
      MOCK_REPO.github_repo,
      "appuser",
    );
  });

  it("returns 500 when GITHUB_APP_ID is missing", async () => {
    const app = createApp();
    const envWithoutAppId = {
      ...testEnv,
      GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
    } as unknown as Env;

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          user_token: "ghu_fake",
          auth_method: "user_token",
        }),
      },
      envWithoutAppId,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("app-not-configured");
  });

  it("returns 500 when GITHUB_APP_PRIVATE_KEY is missing", async () => {
    const app = createApp();
    const envWithoutKey = {
      ...testEnv,
      GITHUB_APP_ID: TEST_APP_ID,
    } as unknown as Env;

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          user_token: "ghu_fake",
          auth_method: "user_token",
        }),
      },
      envWithoutKey,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("app-not-configured");
  });

  it("returns 403 when installation is not configured for project", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
    } as unknown as Env;

    mockGetAuthenticatedUser.mockResolvedValue({
      login: "appuser",
      id: 54321,
    });
    mockGitHubAppConfigGetInstallation.mockResolvedValue(null);

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          user_token: "ghu_fake",
          auth_method: "user_token",
        }),
      },
      envWithApp,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("app-not-configured");
  });

  it("returns 403 when user token is invalid", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
    } as unknown as Env;

    mockGetAuthenticatedUser.mockRejectedValue(
      new Error("GitHub API returned 401"),
    );

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          user_token: "ghu_invalid",
          auth_method: "user_token",
        }),
      },
      envWithApp,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("github-auth-failed");
  });

  it("returns 403 when user has insufficient permissions on all repos", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
    } as unknown as Env;

    mockGetAuthenticatedUser.mockResolvedValue({
      login: "appuser",
      id: 54321,
    });
    mockGitHubAppConfigGetInstallation.mockResolvedValue({
      project_id: "test-project",
      installation_id: 12345,
      created_at: 1000000,
      created_by: "admin",
    });
    mockListForProject.mockResolvedValue([MOCK_REPO]);
    mockCheckUserMembership.mockResolvedValue("none");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          user_token: "ghu_fake",
          auth_method: "user_token",
        }),
      },
      envWithApp,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("repo-not-allowed");
  });

  it("returns 502 when mintAppJwt fails", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
    } as unknown as Env;

    mockGetAuthenticatedUser.mockResolvedValue({
      login: "appuser",
      id: 54321,
    });
    mockGitHubAppConfigGetInstallation.mockResolvedValue({
      project_id: "test-project",
      installation_id: 12345,
      created_at: 1000000,
      created_by: "admin",
    });
    mockMintAppJwt.mockRejectedValue(new Error("Key parsing failed"));

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          user_token: "ghu_fake",
          auth_method: "user_token",
        }),
      },
      envWithApp,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("github-api-error");
    expect(body.error.retryable).toBe(true);
  });

  it("returns 502 when getInstallationAccessToken fails", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
    } as unknown as Env;

    mockGetAuthenticatedUser.mockResolvedValue({
      login: "appuser",
      id: 54321,
    });
    mockGitHubAppConfigGetInstallation.mockResolvedValue({
      project_id: "test-project",
      installation_id: 12345,
      created_at: 1000000,
      created_by: "admin",
    });
    mockGetInstallationAccessToken.mockRejectedValue(
      new Error("GitHub API returned 500"),
    );

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          user_token: "ghu_fake",
          auth_method: "user_token",
        }),
      },
      envWithApp,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("github-api-error");
    expect(body.error.retryable).toBe(true);
  });

  it("backward compatible: legacy PAT exchange still works when App is configured", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
    } as unknown as Env;

    mockGetAuthenticatedUser.mockResolvedValue({
      login: "legacyuser",
      id: 99999,
    });
    mockListForProject.mockResolvedValue([MOCK_REPO]);
    mockGetRepoPermission.mockResolvedValue("write");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_legacy",
        }),
      },
      envWithApp,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      github_login: string;
    };
    expect(body.ok).toBe(true);
    expect(body.github_login).toBe("legacyuser");

    // Verify PAT flow was used (not App flow)
    expect(mockGetRepoPermission).toHaveBeenCalled();
    expect(mockMintAppJwt).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/github/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 302 with Location pointing to GitHub authorize URL", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_CLIENT_ID: "Iv1.abc123def456",
    } as unknown as Env;

    const res = await app.request(
      "/api/auth/github/login",
      { method: "GET" },
      envWithApp,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location");
    expect(location).toBeTruthy();
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=Iv1.abc123def456");
  });

  it("sets tila_oauth_state cookie with SameSite=Lax", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_CLIENT_ID: "Iv1.abc123def456",
    } as unknown as Env;

    const res = await app.request(
      "/api/auth/github/login",
      { method: "GET" },
      envWithApp,
    );

    expect(res.status).toBe(302);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("tila_oauth_state=");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("HttpOnly");
  });

  it("returns 500 with NOT_CONFIGURED when GITHUB_APP_CLIENT_ID is missing", async () => {
    const app = createApp();
    // testEnv does not have GITHUB_APP_CLIENT_ID

    const res = await app.request(
      "/api/auth/github/login",
      { method: "GET" },
      testEnv,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not-configured");
  });

  it("returns 500 with NOT_CONFIGURED when GITHUB_SESSION_HMAC_KEY is missing", async () => {
    const app = createApp();
    const envWithoutHmac = {
      ...testEnv,
      GITHUB_APP_CLIENT_ID: "Iv1.abc123def456",
      GITHUB_SESSION_HMAC_KEY: undefined,
    } as unknown as Env;

    const res = await app.request(
      "/api/auth/github/login",
      { method: "GET" },
      envWithoutHmac,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not-configured");
  });
});

describe("GET /api/auth/github/app-info", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with app_id and client_id when configured", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_CLIENT_ID: "Iv1.abc123def456",
    } as unknown as Env;

    const res = await app.request(
      "/api/auth/github/app-info",
      { method: "GET" },
      envWithApp,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      app_id: number;
      client_id: string;
    };
    expect(body.ok).toBe(true);
    expect(body.app_id).toBe(12345);
    expect(body.client_id).toBe("Iv1.abc123def456");
  });

  it("returns 503 when GITHUB_APP_ID is missing", async () => {
    const app = createApp();
    const envWithoutAppId = {
      ...testEnv,
      GITHUB_APP_CLIENT_ID: "Iv1.abc123def456",
    } as unknown as Env;

    const res = await app.request(
      "/api/auth/github/app-info",
      { method: "GET" },
      envWithoutAppId,
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("app-not-configured");
  });

  it("returns 503 when GITHUB_APP_CLIENT_ID is missing", async () => {
    const app = createApp();
    const envWithoutClientId = {
      ...testEnv,
      GITHUB_APP_ID: "12345",
    } as unknown as Env;

    const res = await app.request(
      "/api/auth/github/app-info",
      { method: "GET" },
      envWithoutClientId,
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("app-not-configured");
  });
});

describe("POST /api/auth/github/app-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockD1TokenValidate.mockResolvedValue(null);
    mockRateLimitCheck.mockResolvedValue(false);
    mockRateLimitRecordFailure.mockResolvedValue(undefined);
  });

  it("returns 401 when no auth token provided", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/auth/github/app-config",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          installation_id: 99999,
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 403 when token does not have full scope", async () => {
    const app = createApp();
    mockD1TokenValidate.mockResolvedValue({
      projectId: "test-project",
      name: "read-only-token",
      scopes: "read",
      tokenId: "token-123",
    });

    const res = await app.request(
      "/api/auth/github/app-config",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tila_t.fake-token",
        },
        body: JSON.stringify({
          project_id: "test-project",
          installation_id: 99999,
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 400 on invalid body", async () => {
    const app = createApp();
    mockD1TokenValidate.mockResolvedValue({
      projectId: "test-project",
      name: "admin-token",
      scopes: "full",
      tokenId: "token-123",
    });

    const res = await app.request(
      "/api/auth/github/app-config",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tila_t.fake-token",
        },
        body: JSON.stringify({
          project_id: "test-project",
          // Missing installation_id
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 200 when authenticated with full scope token", async () => {
    const app = createApp();
    mockD1TokenValidate.mockResolvedValue({
      projectId: "test-project",
      name: "admin-token",
      scopes: "full",
      tokenId: "token-123",
    });

    const res = await app.request(
      "/api/auth/github/app-config",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tila_t.fake-token",
        },
        body: JSON.stringify({
          project_id: "test-project",
          installation_id: 99999,
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      installation_id: number;
      project_id: string;
    };
    expect(body.ok).toBe(true);
    expect(body.installation_id).toBe(99999);
    expect(body.project_id).toBe("test-project");

    // Verify setInstallation was called with correct params
    expect(mockGitHubAppConfigSetInstallation).toHaveBeenCalledWith(
      "test-project",
      99999,
      "admin-token",
    );
  });

  it("updates last_used_at for the token", async () => {
    const app = createApp();
    mockD1TokenValidate.mockResolvedValue({
      projectId: "test-project",
      name: "admin-token",
      scopes: "full",
      tokenId: "token-123",
    });

    await app.request(
      "/api/auth/github/app-config",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tila_t.fake-token",
        },
        body: JSON.stringify({
          project_id: "test-project",
          installation_id: 99999,
        }),
      },
      testEnv,
    );

    expect(mockD1TokenUpdateLastUsedAt).toHaveBeenCalled();
  });

  it("returns 429 when rate limited (upfront, before token validation)", async () => {
    // SEC-5: this pre-auth route must perform the same upfront IP rate-limit
    // check as /exchange. When the IP is over the threshold, reject with 429
    // before ever touching the token store.
    const app = createApp();
    mockRateLimitCheck.mockResolvedValue(true);

    const res = await app.request(
      "/api/auth/github/app-config",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "1.2.3.4",
          Authorization: "Bearer tila_t.fake-token",
        },
        body: JSON.stringify({
          project_id: "test-project",
          installation_id: 99999,
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate-limited");
    // Must short-circuit before token validation.
    expect(mockD1TokenValidate).not.toHaveBeenCalled();
  });

  it("records an exchange failure on an invalid token (SEC-5)", async () => {
    // SEC-5: a failed tokenStore.validate(...) must record a rate-limit failure,
    // exactly like the /exchange and /exchange-oidc auth-failure branches. This
    // is what makes brute-force attempts against this endpoint accumulate toward
    // the IP rate limit.
    const app = createApp();
    mockD1TokenValidate.mockResolvedValue(null); // invalid / revoked token

    const res = await app.request(
      "/api/auth/github/app-config",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "9.8.7.6",
          Authorization: "Bearer tila_t.bad-token",
        },
        body: JSON.stringify({
          project_id: "test-project",
          installation_id: 99999,
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
    // The failure must be recorded against the IP (mirrors /exchange).
    expect(mockRateLimitRecordFailure).toHaveBeenCalledWith(
      "exchange:9.8.7.6",
      RATE_LIMIT_WINDOW_MS,
    );
  });

  it("does not record a failure on the successful path", async () => {
    // SEC-5 guard: a valid full-scope token must still succeed and must NOT
    // record a rate-limit failure (the success path is unchanged).
    const app = createApp();
    mockD1TokenValidate.mockResolvedValue({
      projectId: "test-project",
      name: "admin-token",
      scopes: "full",
      tokenId: "token-123",
    });

    const res = await app.request(
      "/api/auth/github/app-config",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "5.5.5.5",
          Authorization: "Bearer tila_t.valid-token",
        },
        body: JSON.stringify({
          project_id: "test-project",
          installation_id: 99999,
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    expect(mockRateLimitRecordFailure).not.toHaveBeenCalled();
    // Upfront rate-limit check still runs on the happy path (parity with /exchange).
    expect(mockRateLimitCheck).toHaveBeenCalledWith(
      "exchange:5.5.5.5",
      RATE_LIMIT_MAX_FAILURES,
      RATE_LIMIT_WINDOW_MS,
    );
  });
});

// Purpose-binding claims for the OAuth-state JWT (SEC-2). Must match the values
// the mint/verify sites in auth-github.ts use, otherwise valid state is rejected.
const OAUTH_STATE_ISSUER = "tila-oauth-state";
const OAUTH_STATE_AUDIENCE = "tila-oauth-callback";

// Helper to build a valid HMAC-signed OAuth state JWT for tests.
// Mirrors the mint site: includes the purpose-binding iss/aud claims so the
// callback's jwtVerify({ issuer, audience }) accepts it. Pass `issuer`/`audience`
// overrides to simulate a JWT minted for a different purpose (e.g. a session token).
async function buildOAuthState(
  hmacKeyB64: string,
  overrides?: {
    iat?: number;
    nonce?: string;
    issuer?: string | null;
    audience?: string | null;
  },
): Promise<string> {
  const iat = overrides?.iat ?? Math.floor(Date.now() / 1000);
  const nonce = overrides?.nonce ?? "test-nonce-uuid";

  const keyBytes = base64UrlDecode(hmacKeyB64);
  const secret = await importJWK(
    { kty: "oct", k: base64UrlEncode(keyBytes), alg: "HS256" },
    "HS256",
  );

  let builder = new SignJWT({ nonce, iat }).setProtectedHeader({
    alg: "HS256",
    typ: "JWT",
  });
  // Omitted/undefined override -> use the correct purpose value; explicit `null`
  // -> omit the claim (to simulate a JWT minted for a different/no purpose).
  const issuer: string | null =
    overrides?.issuer === undefined ? OAUTH_STATE_ISSUER : overrides.issuer;
  const audience: string | null =
    overrides?.audience === undefined
      ? OAUTH_STATE_AUDIENCE
      : overrides.audience;
  if (issuer !== null) builder = builder.setIssuer(issuer);
  if (audience !== null) builder = builder.setAudience(audience);

  return builder.sign(secret);
}

describe("GET /api/auth/github/oauth/callback", () => {
  const envWithOAuth = {
    ...testEnv,
    GITHUB_APP_CLIENT_ID: "Iv1.abc123",
    GITHUB_APP_CLIENT_SECRET: "secret123",
  } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExchangeOAuthCode.mockResolvedValue({
      accessToken: "ghu_test_access_token",
    });
    mockGetAuthenticatedUser.mockResolvedValue({ login: "testuser", id: 42 });
    mockD1SessionCreate.mockResolvedValue(undefined);
  });

  it("redirects to / with tila_session cookie on valid code + state", async () => {
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY);

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${state}` },
      },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");

    // Should have two Set-Cookie headers
    const setCookieHeaders = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [res.headers.get("Set-Cookie") ?? ""];
    const allCookies = setCookieHeaders.join("; ");
    expect(allCookies).toContain("tila_session=");
    expect(allCookies).toContain("tila_oauth_state=;");
    expect(allCookies).toContain("Max-Age=0");

    // Session was created in D1
    expect(mockD1SessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "",
        tokenHash: "",
        actorName: "testuser",
        scopes: "",
      }),
    );
  });

  it("redirects with error (not JSON) when state cookie is missing", async () => {
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY);

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      { method: "GET" },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=error");
    expect(location).not.toContain('"error"');
  });

  it("returns HTML error when state cookie does not match query param", async () => {
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY);
    const tamperedState = `${state}tampered`;

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${tamperedState}` },
      },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=error");
    expect(location).toContain("Invalid+State");
  });

  it("redirects with error when HMAC signature is tampered", async () => {
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY);
    // Tamper with the signature part
    const parts = state.split(".");
    const tamperedState = `${parts[0]}.invalidsignaturehere`;

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(tamperedState)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${tamperedState}` },
      },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=error");
    expect(location).toContain("Invalid+State");
  });

  it("rejects a state JWT minted for a different purpose (wrong iss/aud) even when the cookie matches", async () => {
    // SEC-2: simulate a JWT signed by the SHARED GITHUB_SESSION_HMAC_KEY but for a
    // different purpose (e.g. a tila session token, iss/aud "tila"/"tila"). The
    // cookie matches the state param exactly, so the nonce/cookie CSRF check passes;
    // rejection must come from purpose-binding (iss/aud) verification.
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY, {
      issuer: "tila",
      audience: "tila",
    });

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${state}` },
      },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=error");
    expect(location).toContain("Invalid+State");
    // Must not have proceeded to the code exchange.
    expect(mockExchangeOAuthCode).not.toHaveBeenCalled();
  });

  it("rejects a state JWT with missing iss/aud claims even when the cookie matches", async () => {
    // SEC-2: a JWT with no purpose claims at all (the pre-fix mint shape) must be
    // rejected once the verifier enforces issuer/audience. Cookie matches the param.
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY, {
      issuer: null,
      audience: null,
    });

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${state}` },
      },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=error");
    expect(location).toContain("Invalid+State");
    expect(mockExchangeOAuthCode).not.toHaveBeenCalled();
  });

  it("still enforces the nonce/cookie CSRF check independently of iss/aud (valid purpose, missing cookie)", async () => {
    // SEC-2 regression guard: even a correctly purpose-bound state JWT must be
    // rejected when the cookie binding is absent — iss/aud is additive, not a
    // replacement for the primary CSRF defense.
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY);

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      { method: "GET" }, // no Cookie header
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=error");
    expect(location).toContain("Invalid+State");
    expect(mockExchangeOAuthCode).not.toHaveBeenCalled();
  });

  it("redirects with error when state is expired (iat > 300s ago)", async () => {
    const app = createApp();
    const expiredIat = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago
    const state = await buildOAuthState(TEST_HMAC_KEY, { iat: expiredIat });

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${state}` },
      },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=error");
    expect(location).toContain("Expired");
  });

  it("redirects with error when state payload missing iat (Zod catches it)", async () => {
    const app = createApp();
    // Build state JWT with missing iat manually (nonce only, no iat)
    const keyBytes = base64UrlDecode(TEST_HMAC_KEY);
    const secret = await importJWK(
      { kty: "oct", k: base64UrlEncode(keyBytes), alg: "HS256" },
      "HS256",
    );
    const state = await new SignJWT({ nonce: "test-nonce" }) // no iat
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(secret);

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${state}` },
      },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=error");
    expect(location).toContain("Invalid+State");
  });

  it("redirects with error when exchangeOAuthCode throws", async () => {
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY);
    mockExchangeOAuthCode.mockRejectedValue(
      new Error("GitHub OAuth error: bad_verification_code"),
    );

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=bad_code&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${state}` },
      },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=error");
    expect(location).toContain("Authentication+Failed");
    expect(location).not.toContain("bad_verification_code");
  });

  it("redirects with error when getAuthenticatedUser throws", async () => {
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY);
    mockGetAuthenticatedUser.mockRejectedValue(
      new Error("GitHub API returned 401"),
    );

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${state}` },
      },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=error");
    expect(location).toContain("Authentication+Failed");
    expect(location).not.toContain("401");
  });

  it("handles setup_action=install without touching OAuth flow (regression)", async () => {
    const app = createApp();

    const res = await app.request(
      "/api/auth/github/oauth/callback?setup_action=install&installation_id=12345&code=unused",
      { method: "GET" },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("auth_status=success");
    expect(location).toContain("GitHub+App+Installed");
    // Should not have called exchange
    expect(mockExchangeOAuthCode).not.toHaveBeenCalled();
  });

  it("redirects to UI_ORIGIN when configured", async () => {
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY);

    const envWithUiOrigin = {
      ...envWithOAuth,
      UI_ORIGIN: "https://my-ui.pages.dev",
    } as unknown as Env;

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${state}` },
      },
      envWithUiOrigin,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://my-ui.pages.dev/");
  });

  it("falls back to same-origin redirect when UI_ORIGIN is not set", async () => {
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY);

    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: { Cookie: `tila_oauth_state=${state}` },
      },
      envWithOAuth,
    );

    expect(res.status).toBe(302);
    // Without UI_ORIGIN, location is "/" (same-origin)
    expect(res.headers.get("Location")).toBe("/");
  });

  it("error redirects use UI_ORIGIN when configured", async () => {
    const app = createApp();
    const state = await buildOAuthState(TEST_HMAC_KEY);

    const envWithUiOrigin = {
      ...envWithOAuth,
      UI_ORIGIN: "https://my-ui.pages.dev",
    } as unknown as Env;

    // Trigger an error by omitting state cookie
    const res = await app.request(
      `/api/auth/github/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
      { method: "GET" },
      envWithUiOrigin,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith("https://my-ui.pages.dev/")).toBe(true);
    expect(location).toContain("auth_status=error");
  });
});

// gitleaks:allow - Fake OIDC JWT tokens for testing
describe("POST /api/auth/github/exchange-oidc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue(false);
    mockIdempotencyCheck.mockResolvedValue(null);
    mockIsRegistered.mockResolvedValue(null);
    mockVerifyOidcToken.mockResolvedValue({
      iss: "https://token.actions.githubusercontent.com",
      aud: "https://tila.example.com",
      sub: "repo:test-org/test-repo:ref:refs/heads/main",
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000),
      jti: "unique-jwt-id-123",
      repository: "test-org/test-repo",
      repository_id: 99999,
      repository_owner: "test-org",
      repository_owner_id: 12345,
      actor: "testuser",
      actor_id: 54321,
      ref: "refs/heads/main",
      sha: "abc123",
      workflow: "CI",
      run_id: 111,
      run_number: 42,
      run_attempt: 1,
      environment: "production",
      event_name: "push",
      repository_visibility: "private",
      job_workflow_ref:
        "test-org/test-repo/.github/workflows/ci.yml@refs/heads/main",
    });
  });

  it("returns 200 with session token for valid OIDC token", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    mockIsRegistered.mockResolvedValue({
      ...MOCK_REPO,
      oidc_permission: "write",
    });

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      session_token: string;
      expires_at: number;
      project_id: string;
      github_login: string;
      github_repo_id: number;
      permission: string;
    };
    expect(body.ok).toBe(true);
    expect(body.session_token).toMatch(/^tila_s\./);
    expect(body.project_id).toBe("test-project");
    expect(body.github_login).toBe("testuser");
    expect(body.github_repo_id).toBe(99999);
    expect(body.permission).toBe("write");
  });

  it("returns 500 when GITHUB_OIDC_AUDIENCE is missing", async () => {
    const app = createApp();

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oidc-not-configured");
  });

  it("returns 500 when GITHUB_SESSION_HMAC_KEY is missing", async () => {
    const app = createApp();
    const envWithOidcOnly = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
      GITHUB_SESSION_HMAC_KEY: undefined,
    } as unknown as Env;

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidcOnly,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("hmac-not-configured");
  });

  it("returns 400 on invalid body (missing fields)", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "test-project" }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 401 when OIDC token is expired", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    const { OidcVerificationError } = await import("../lib/oidc-verify");
    mockVerifyOidcToken.mockRejectedValue(
      new OidcVerificationError("oidc-token-expired", "Token expired"),
    );

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oidc-token-expired");
  });

  it("returns 401 when OIDC signature is invalid", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    const { OidcVerificationError } = await import("../lib/oidc-verify");
    mockVerifyOidcToken.mockRejectedValue(
      new OidcVerificationError("oidc-signature-invalid", "Signature invalid"),
    );

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oidc-signature-invalid");
  });

  it("returns 401 when OIDC audience is wrong", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    const { OidcVerificationError } = await import("../lib/oidc-verify");
    mockVerifyOidcToken.mockRejectedValue(
      new OidcVerificationError("oidc-invalid-audience", "Audience mismatch"),
    );

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oidc-invalid-audience");
  });

  it("returns 502 when JWKS is unavailable", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    const { OidcVerificationError } = await import("../lib/oidc-verify");
    mockVerifyOidcToken.mockRejectedValue(
      new OidcVerificationError("oidc-jwks-unavailable", "JWKS fetch failed"),
    );

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oidc-jwks-unavailable");
  });

  it("returns 403 when repo is not in allowlist", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    mockIsRegistered.mockResolvedValue(null);

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("repo-not-allowed");
  });

  it("returns cached response on replay (same jti)", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    const cachedResponse = {
      ok: true,
      session_token: "tila_s.cached.token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      project_id: "test-project",
      github_login: "testuser",
      github_repo_id: 99999,
      permission: "write",
    };

    // Mock verifyOidcToken to return valid claims (needed to construct idempotency key)
    mockVerifyOidcToken.mockResolvedValue({
      iss: "https://token.actions.githubusercontent.com",
      aud: "https://tila.example.com",
      sub: "repo:test-org/test-repo:ref:refs/heads/main",
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000),
      jti: "unique-jwt-id-123",
      repository: "test-org/test-repo",
      repository_id: 99999,
      repository_owner: "test-org",
      repository_owner_id: 12345,
      actor: "testuser",
      actor_id: 54321,
      ref: "refs/heads/main",
      sha: "abc123",
      workflow: "CI",
      run_id: 111,
      run_number: 42,
      run_attempt: 1,
      environment: "production",
      event_name: "push",
      repository_visibility: "private",
      job_workflow_ref:
        "test-org/test-repo/.github/workflows/ci.yml@refs/heads/main",
    });

    mockIdempotencyCheck.mockResolvedValue({
      body: JSON.stringify(cachedResponse),
      statusCode: 200,
    });

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof cachedResponse;
    expect(body.session_token).toBe("tila_s.cached.token");
    // Verify no new session was minted (no call to isRegistered)
    expect(mockIsRegistered).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    mockRateLimitCheck.mockResolvedValue(true);

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "1.2.3.4",
        },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate-limited");
  });

  it("maps invalid oidc_permission to session permission 'read' (least privilege)", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    mockIsRegistered.mockResolvedValue({
      ...MOCK_REPO,
      oidc_permission: "invalid-value-not-a-valid-permission",
    });

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { permission: string };
    expect(body.permission).toBe("read");
  });

  it("maps oidc_permission 'read' to session permission 'read'", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    mockIsRegistered.mockResolvedValue({
      ...MOCK_REPO,
      oidc_permission: "read",
    });

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { permission: string };
    expect(body.permission).toBe("read");
  });
});

describe("instance_id binding in minted session JWT and login response", () => {
  const KNOWN_INSTANCE_ID = "known-deployment-uuid-abc123";

  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue(false);
    mockIdempotencyCheck.mockResolvedValue(null);
    mockListForProject.mockResolvedValue([MOCK_REPO]);
    mockGetAuthenticatedUser.mockResolvedValue({ login: "alice", id: 42 });
    mockGetRepoPermission.mockResolvedValue("write");
    mockEnsureDeploymentInstanceId.mockResolvedValue(KNOWN_INSTANCE_ID);
  });

  it("/exchange response body includes instance_id matching the deployment singleton", async () => {
    const app = createApp();

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_test",
        }),
      },
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session_token: string;
      instance_id: string;
    };
    // Assert the response body carries instance_id
    expect(body.instance_id).toBe(KNOWN_INSTANCE_ID);

    // Assert the minted JWT payload also carries instance_id
    // JWT format: tila_s.<header>.<payload>.<signature>
    const parts = body.session_token.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("tila_s");
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const jwtPayload = JSON.parse(payloadStr) as { instance_id?: string };
    expect(jwtPayload.instance_id).toBe(KNOWN_INSTANCE_ID);
  });

  it("/exchange-oidc response body and JWT also carry instance_id", async () => {
    const app = createApp();
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    // Mirror the full claims setup from the passing OIDC "returns 200" test so
    // the exchange reaches 200 rather than 403 (repo not in allowlist).
    mockVerifyOidcToken.mockResolvedValue({
      iss: "https://token.actions.githubusercontent.com",
      aud: "https://tila.example.com",
      sub: "repo:test-org/test-repo:ref:refs/heads/main",
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000),
      jti: "unique-jwt-id-oidc-instance-test",
      repository: "test-org/test-repo",
      repository_id: 99999,
      repository_owner: "test-org",
      repository_owner_id: 12345,
      actor: "actions-bot",
      actor_id: 7777,
      ref: "refs/heads/main",
      sha: "abc123",
      workflow: "CI",
      run_id: 222,
      run_number: 7,
      run_attempt: 1,
      environment: "production",
      event_name: "push",
      repository_visibility: "private",
      job_workflow_ref:
        "test-org/test-repo/.github/workflows/ci.yml@refs/heads/main",
    });

    // OIDC path uses isRegistered (not listForProject) to look up by repository_id.
    mockIsRegistered.mockResolvedValue({
      ...MOCK_REPO,
      oidc_permission: "read",
    });

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session_token: string;
      instance_id: string;
    };
    // Assert the response body carries instance_id
    expect(body.instance_id).toBe(KNOWN_INSTANCE_ID);
    // Assert the minted JWT payload also carries instance_id
    const parts = body.session_token.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("tila_s");
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const jwtPayload = JSON.parse(payloadStr) as { instance_id?: string };
    expect(jwtPayload.instance_id).toBe(KNOWN_INSTANCE_ID);
  });

  it("/exchange App path response body and JWT also carry instance_id", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
    } as unknown as Env;

    // Mirror the App exchange mock setup from the passing "returns 200 with session
    // token for valid App exchange" test so the request reaches 200.
    mockGetAuthenticatedUser.mockResolvedValue({ login: "appuser", id: 54321 });
    mockGitHubAppConfigGetInstallation.mockResolvedValue({
      project_id: "test-project",
      installation_id: 12345,
      created_at: 1000000,
      created_by: "admin",
    });
    mockMintAppJwt.mockResolvedValue("app-jwt-fake");
    mockGetInstallationAccessToken.mockResolvedValue("ghs_install_token_fake");
    mockCheckUserMembership.mockResolvedValue("write");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          user_token: "ghu_user_token_fake",
          auth_method: "user_token",
        }),
      },
      envWithApp,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session_token: string;
      instance_id: string;
    };
    // Assert the response body carries instance_id
    expect(body.instance_id).toBe(KNOWN_INSTANCE_ID);
    // Assert the minted JWT payload also carries instance_id
    const parts = body.session_token.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("tila_s");
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const jwtPayload = JSON.parse(payloadStr) as { instance_id?: string };
    expect(jwtPayload.instance_id).toBe(KNOWN_INSTANCE_ID);
  });
});

// ── WI-H: Tiered TTL tests ────────────────────────────────────────────────────
// Coverage: ≥5 assertions proving both per-path wiring and the full tier map.
// PAT path covers all three tiers; App and OIDC paths cover one tier each.
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-H tiered TTL: PAT /exchange path (all three tiers)", () => {
  const envWithOidc = {
    ...testEnv,
    GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
  } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue(false);
    mockIdempotencyCheck.mockResolvedValue(null);
    mockListForProject.mockResolvedValue([MOCK_REPO]);
    mockGitHubAppConfigGetInstallation.mockResolvedValue(null);
    mockGetAuthenticatedUser.mockResolvedValue({ login: "testuser", id: 1 });
  });

  it("PAT: read permission → expires_at - issued_at == 3600", async () => {
    const app = createApp();
    mockGetRepoPermission.mockResolvedValue("read");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_read",
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      expires_at: number;
      issued_at?: number;
      session_token: string;
    };
    // Decode JWT payload to get issued_at
    const parts = body.session_token.split(".");
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadStr) as {
      issued_at: number;
      expires_at: number;
    };
    expect(body.expires_at - payload.issued_at).toBe(3600);
  });

  it("PAT: write permission → expires_at - issued_at == 900", async () => {
    const app = createApp();
    mockGetRepoPermission.mockResolvedValue("write");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_write",
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      expires_at: number;
      session_token: string;
    };
    const parts = body.session_token.split(".");
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadStr) as { issued_at: number };
    expect(body.expires_at - payload.issued_at).toBe(900);
  });

  it("PAT: admin permission → expires_at - issued_at == 300", async () => {
    const app = createApp();
    mockGetRepoPermission.mockResolvedValue("admin");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_admin",
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      expires_at: number;
      session_token: string;
    };
    const parts = body.session_token.split(".");
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadStr) as { issued_at: number };
    expect(body.expires_at - payload.issued_at).toBe(300);
  });
});

describe("WI-H tiered TTL: App /exchange path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue(false);
    mockIdempotencyCheck.mockResolvedValue(null);
    mockListForProject.mockResolvedValue([MOCK_REPO]);
    mockGitHubAppConfigGetInstallation.mockResolvedValue({
      project_id: "test-project",
      installation_id: 12345,
      created_at: 1000000,
      created_by: "admin",
    });
    mockMintAppJwt.mockResolvedValue("app-jwt-fake");
    mockGetInstallationAccessToken.mockResolvedValue("ghs_install_token_fake");
    mockGetAuthenticatedUser.mockResolvedValue({ login: "appuser", id: 2 });
  });

  it("App path: write permission → expires_at - issued_at == 900", async () => {
    const app = createApp();
    const envWithApp = {
      ...testEnv,
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_APP_PRIVATE_KEY,
    } as unknown as Env;

    mockCheckUserMembership.mockResolvedValue("write");

    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          user_token: "ghu_user_token_fake",
          auth_method: "user_token",
        }),
      },
      envWithApp,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      expires_at: number;
      session_token: string;
    };
    const parts = body.session_token.split(".");
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadStr) as { issued_at: number };
    expect(body.expires_at - payload.issued_at).toBe(900);
  });
});

describe("WI-H tiered TTL: OIDC /exchange-oidc path", () => {
  const envWithOidc = {
    ...testEnv,
    GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
  } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue(false);
    mockIdempotencyCheck.mockResolvedValue(null);
    mockVerifyOidcToken.mockResolvedValue({
      iss: "https://token.actions.githubusercontent.com",
      aud: "https://tila.example.com",
      sub: "repo:test-org/test-repo:ref:refs/heads/main",
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000),
      jti: "oidc-jti-tier-test",
      repository: "test-org/test-repo",
      repository_id: 99999,
      repository_owner: "test-org",
      repository_owner_id: 12345,
      actor: "testuser",
      actor_id: 54321,
      ref: "refs/heads/main",
      sha: "abc123",
      workflow: "CI",
      run_id: 111,
      run_number: 42,
      run_attempt: 1,
      environment: "production",
      event_name: "push",
      repository_visibility: "private",
      job_workflow_ref:
        "test-org/test-repo/.github/workflows/ci.yml@refs/heads/main",
    });
  });

  it("OIDC path: admin permission → expires_at - issued_at == 300", async () => {
    const app = createApp();

    mockIsRegistered.mockResolvedValue({
      ...MOCK_REPO,
      oidc_permission: "admin",
    });

    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      expires_at: number;
      session_token: string;
    };
    const parts = body.session_token.split(".");
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadStr) as { issued_at: number };
    expect(body.expires_at - payload.issued_at).toBe(300);
  });
});

// ============================================================================
// Task 4: cnf.jkt DPoP binding — PAT exchange, App exchange, OIDC unaffected
// ============================================================================

const VALID_JKT_T4 = "A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U";

describe("cnf.jkt DPoP binding in session JWT (WI-G Task 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue(false);
    mockIdempotencyCheck.mockResolvedValue(null);
    mockListForProject.mockResolvedValue([MOCK_REPO]);
    mockGetAuthenticatedUser.mockResolvedValue({ login: "alice", id: 42 });
    mockGetRepoPermission.mockResolvedValue("write");
    mockEnsureDeploymentInstanceId.mockResolvedValue(
      "test-deployment-instance-id",
    );
  });

  it("SessionPayloadSchema accepts a payload with cnf.jkt", async () => {
    const { SessionPayloadSchema } = await import("@tila/schemas");
    const result = SessionPayloadSchema.safeParse({
      project_id: "proj-1",
      sub_type: "github",
      github_host: "github.com",
      github_repo_id: 123,
      github_login: "alice",
      github_user_id: 42,
      permission: "write",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      issued_at: Math.floor(Date.now() / 1000),
      cnf: { jkt: VALID_JKT_T4 },
    });
    expect(result.success).toBe(true);
  });

  it("SessionPayloadSchema accepts a payload without cnf", async () => {
    const { SessionPayloadSchema } = await import("@tila/schemas");
    const result = SessionPayloadSchema.safeParse({
      project_id: "proj-1",
      sub_type: "github",
      github_host: "github.com",
      github_repo_id: 123,
      github_login: "alice",
      github_user_id: 42,
      permission: "write",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      issued_at: Math.floor(Date.now() / 1000),
    });
    expect(result.success).toBe(true);
  });

  it("PAT /exchange with jkt mints a session JWT whose payload has cnf.jkt", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_test",
          jkt: VALID_JKT_T4,
        }),
      },
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_token: string };
    const parts = body.session_token.split(".");
    expect(parts).toHaveLength(4);
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const jwtPayload = JSON.parse(payloadStr) as { cnf?: { jkt?: string } };
    expect(jwtPayload.cnf?.jkt).toBe(VALID_JKT_T4);
  });

  it("PAT /exchange without jkt mints a session JWT with no cnf claim", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_test",
        }),
      },
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_token: string };
    const parts = body.session_token.split(".");
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const jwtPayload = JSON.parse(payloadStr) as { cnf?: { jkt?: string } };
    expect(jwtPayload.cnf).toBeUndefined();
  });

  it("two PAT exchanges with same token but different jkt use distinct idempotency keys", async () => {
    const app = createApp();
    const jktA = "A".repeat(43);
    const jktB = "B".repeat(43);

    await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_same",
          jkt: jktA,
        }),
      },
      testEnv,
    );
    await app.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          github_token: "ghp_same",
          jkt: jktB,
        }),
      },
      testEnv,
    );

    expect(mockIdempotencyStore).toHaveBeenCalledTimes(2);
    const firstKey = (mockIdempotencyStore.mock.calls[0] as [string])[0];
    const secondKey = (mockIdempotencyStore.mock.calls[1] as [string])[0];
    expect(firstKey).not.toBe(secondKey);
  });

  it("OIDC exchange ignores jkt — session JWT has no cnf claim", async () => {
    const envWithOidc = {
      ...testEnv,
      GITHUB_OIDC_AUDIENCE: "https://tila.example.com",
    } as unknown as Env;

    mockVerifyOidcToken.mockResolvedValue({
      iss: "https://token.actions.githubusercontent.com",
      aud: "https://tila.example.com",
      sub: "repo:test-org/test-repo:ref:refs/heads/main",
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000),
      jti: "unique-jti-cnf-test-t4",
      repository: "test-org/test-repo",
      repository_id: 99999,
      repository_owner: "test-org",
      repository_owner_id: 12345,
      actor: "actions-bot",
      actor_id: 7777,
      ref: "refs/heads/main",
      sha: "abc123",
      workflow: "CI",
      run_id: 333,
      run_number: 8,
      run_attempt: 1,
      environment: "production",
      event_name: "push",
      repository_visibility: "private",
      job_workflow_ref:
        "test-org/test-repo/.github/workflows/ci.yml@refs/heads/main",
    });
    mockIsRegistered.mockResolvedValue({
      ...MOCK_REPO,
      oidc_permission: "read",
    });

    const app = createApp();
    const res = await app.request(
      "/api/auth/github/exchange-oidc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "test-project",
          oidc_token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        }),
      },
      envWithOidc,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_token: string };
    const parts = body.session_token.split(".");
    const payloadStr = atob(parts[2].replace(/-/g, "+").replace(/_/g, "/"));
    const jwtPayload = JSON.parse(payloadStr) as { cnf?: unknown };
    expect(jwtPayload.cnf).toBeUndefined();
  });
});
