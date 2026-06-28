import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "../middleware/auth";
import type { Env, HonoVariables } from "../types";

// Mock @tila/backend-d1 stores
const mockRateLimitCheck = vi.fn().mockResolvedValue(false);
const mockRateLimitRecordFailure = vi.fn().mockResolvedValue(undefined);
const mockTokenValidate = vi.fn();
const mockSessionCreate = vi.fn().mockResolvedValue(undefined);
const mockSessionValidate = vi.fn();
const mockSessionRevoke = vi.fn().mockResolvedValue(undefined);
const mockTokenRevoke = vi
  .fn()
  .mockResolvedValue({ revoked: true, tokenHash: "tok-hash" });
const mockDeleteByTokenHash = vi.fn().mockResolvedValue({ deleted: 0 });

vi.mock("@tila/backend-d1", () => ({
  D1RateLimitStore: vi.fn().mockImplementation(
    class {
      check = mockRateLimitCheck;
      recordFailure = mockRateLimitRecordFailure;
    } as unknown as () => unknown,
  ),
  D1TokenStore: vi.fn().mockImplementation(
    class {
      validate = mockTokenValidate;
      updateLastUsedAt = vi.fn().mockResolvedValue(undefined);
      revoke = mockTokenRevoke;
    } as unknown as () => unknown,
  ),
  D1SessionStore: vi.fn().mockImplementation(
    class {
      validate = mockSessionValidate;
      create = mockSessionCreate;
      revoke = mockSessionRevoke;
      deleteByTokenHash = mockDeleteByTokenHash;
    } as unknown as () => unknown,
  ),
}));

// Self-logout dependencies (WI-D): revokeSession (jti revoke) + token-cache invalidate.
const mockRevokeSession = vi.fn().mockResolvedValue({
  ok: true,
  jti: "j",
  revoked_at: 0,
});
vi.mock("../lib/admin-ops", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    revokeSession: (...args: unknown[]) => mockRevokeSession(...args),
  };
});
const mockInvalidate = vi.fn();
vi.mock("../lib/token-cache", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    invalidate: (...args: unknown[]) => mockInvalidate(...args),
  };
});

// Import after mocks are set up
const { authSessionExchange, authSessionProtected } = await import(
  "./auth-session"
);

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const testEnv = {
  DB: {} as D1Database,
  PROJECT: {} as DurableObjectNamespace,
  ARTIFACTS: {} as R2Bucket,
  ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
  ASSETS: {} as Fetcher,
};

const mockCtx = {
  waitUntil: vi.fn((p: Promise<unknown>) => p),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// Build the exchange app (no auth middleware)
function makeExchangeApp() {
  const app = new Hono<AppEnv>();
  app.route("/auth/session", authSessionExchange);
  return app;
}

// Build the protected app (with auth middleware)
function makeProtectedApp() {
  const app = new Hono<AppEnv>();
  app.use("/*", createAuthMiddleware());
  app.route("/auth/session", authSessionProtected);
  app.route("/auth", authSessionProtected);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimitCheck.mockResolvedValue(false);
  mockRateLimitRecordFailure.mockResolvedValue(undefined);
  mockSessionCreate.mockResolvedValue(undefined);
  mockSessionRevoke.mockResolvedValue(undefined);
});

describe("POST /auth/session", () => {
  const VALID_TOKEN_RESULT = {
    projectId: "test-project",
    name: "test-token",
    scopes: "full",
    tokenId: "uuid-123",
  };

  it("valid token returns 200 with Set-Cookie header", async () => {
    mockTokenValidate.mockResolvedValue(VALID_TOKEN_RESULT);
    const app = makeExchangeApp();

    const res = await app.request(
      "/auth/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "tila_test_token_123",
          project_id: "test-project",
        }),
      },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("tila_session=");
    expect(setCookie).toContain("HttpOnly");
    // localhost = local dev → SameSite=Lax (SameSite=None requires Secure/HTTPS)
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=28800");

    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("invalid token returns 401", async () => {
    mockTokenValidate.mockResolvedValue(null);
    const app = makeExchangeApp();

    const res = await app.request(
      "/auth/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "invalid_token",
          project_id: "test-project",
        }),
      },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(401);
  });

  it("missing body fields returns 400", async () => {
    const app = makeExchangeApp();

    const res = await app.request(
      "/auth/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(400);
  });

  it("token for wrong project returns 401", async () => {
    mockTokenValidate.mockResolvedValue({
      ...VALID_TOKEN_RESULT,
      projectId: "other-project",
    });
    const app = makeExchangeApp();

    const res = await app.request(
      "/auth/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "tila_token",
          project_id: "test-project",
        }),
      },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(401);
  });

  it("rate limited IP returns 429", async () => {
    mockRateLimitCheck.mockResolvedValue(true);
    const app = makeExchangeApp();

    const res = await app.request(
      "/auth/session",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "1.2.3.4",
        },
        body: JSON.stringify({
          token: "tila_token",
          project_id: "test-project",
        }),
      },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(429);
  });

  it("WI-I: session exchange checks the shared exchange:${ip} counter (not bare ip)", async () => {
    const app = makeExchangeApp();

    await app.request(
      "/auth/session",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "1.2.3.4",
        },
        body: JSON.stringify({
          token: "tila_token",
          project_id: "test-project",
        }),
      },
      testEnv,
      mockCtx,
    );

    expect(mockRateLimitCheck).toHaveBeenCalledWith(
      "exchange:1.2.3.4",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("WI-I: failed session exchange records a failure on the shared exchange:${ip} counter", async () => {
    mockTokenValidate.mockResolvedValue(null); // invalid token → 401 + recordFailure
    const app = makeExchangeApp();

    const res = await app.request(
      "/auth/session",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "1.2.3.4",
        },
        body: JSON.stringify({
          token: "tila_bad",
          project_id: "test-project",
        }),
      },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(401);
    expect(mockRateLimitRecordFailure).toHaveBeenCalledWith(
      "exchange:1.2.3.4",
      expect.any(Number),
    );
  });
});

describe("POST /auth/logout", () => {
  it("WI-I: logout returns 429 when the shared exchange:${ip} counter is over the limit", async () => {
    mockRateLimitCheck.mockResolvedValue(true);
    mockSessionValidate.mockResolvedValue({
      projectId: "test-project",
      tokenHash: "tok-hash",
      name: "actor",
      scopes: "full",
      expiresAt: Date.now() + 3_600_000,
    });
    const app = makeProtectedApp();

    const res = await app.request(
      "/auth/logout",
      {
        method: "POST",
        headers: {
          Cookie: "tila_session=some-session-uuid",
          "CF-Connecting-IP": "1.2.3.4",
        },
      },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(429);
    // Check-only guard: logout never records a failure.
    expect(mockRateLimitRecordFailure).not.toHaveBeenCalled();
  });

  it("clears session cookie with Max-Age=0", async () => {
    mockSessionValidate.mockResolvedValue({
      projectId: "test-project",
      tokenHash: "tok-hash",
      name: "actor",
      scopes: "full",
      expiresAt: Date.now() + 3_600_000,
    });
    const app = makeProtectedApp();

    const res = await app.request(
      "/auth/logout",
      {
        method: "POST",
        headers: { Cookie: "tila_session=some-session-uuid" },
      },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("tila_session=");
  });

  it("production (non-localhost) logout uses Secure + SameSite=Lax and not SameSite=None", async () => {
    mockSessionValidate.mockResolvedValue({
      projectId: "test-project",
      tokenHash: "tok-hash",
      name: "actor",
      scopes: "full",
      expiresAt: Date.now() + 3_600_000,
    });
    const app = makeProtectedApp();

    // Use a full HTTPS non-localhost URL so isLocalhost() returns false → production branch
    const res = await app.request(
      "https://tila.example.workers.dev/auth/logout",
      {
        method: "POST",
        headers: { Cookie: "tila_session=some-session-uuid" },
      },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("tila_session=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("SameSite=None");
  });
});

describe("POST /auth/logout — credential-kind branches (WI-D)", () => {
  // Inject tokenResult directly to isolate the logout branch logic from the
  // real auth middleware (which would require minting JWTs / D1 tokens).
  function makeLogoutApp(tokenResult: unknown) {
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: test injection
      c.set("tokenResult", tokenResult as any);
      await next();
    });
    app.route("/auth", authSessionProtected);
    return app;
  }

  function post(app: Hono<AppEnv>) {
    return app.request("/auth/logout", { method: "POST" }, testEnv, mockCtx);
  }

  it("bearer session revokes its own jti and returns 200", async () => {
    const app = makeLogoutApp({
      kind: "session",
      projectId: "p1",
      name: "u",
      scopes: "admin",
      tokenId: "",
      githubRepoId: 1,
      githubLogin: "u",
      permission: "admin",
      expiresAt: Date.now() + 3_600_000,
      jti: "11111111-1111-1111-1111-111111111111",
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockRevokeSession).toHaveBeenCalledWith(
      expect.anything(),
      "11111111-1111-1111-1111-111111111111",
      "p1",
    );
  });

  it("bearer session without jti is a no-op (legacy token)", async () => {
    const app = makeLogoutApp({
      kind: "session",
      projectId: "p1",
      name: "u",
      scopes: "admin",
      tokenId: "",
      githubRepoId: 1,
      githubLogin: "u",
      permission: "admin",
      expiresAt: Date.now() + 3_600_000,
      // no jti
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it("d1-token revokes its own token + invalidates cache + cascades sessions", async () => {
    mockTokenRevoke.mockResolvedValue({ revoked: true, tokenHash: "th-1" });
    const app = makeLogoutApp({
      kind: "d1-token",
      projectId: "p1",
      name: "ci-bot",
      scopes: "full",
      tokenId: "tid",
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(mockTokenRevoke).toHaveBeenCalledWith("p1", "ci-bot", "self-logout");
    expect(mockInvalidate).toHaveBeenCalledWith("th-1");
    expect(mockDeleteByTokenHash).toHaveBeenCalledWith("th-1");
  });

  it("workspace-session is a no-op and still returns 200", async () => {
    const app = makeLogoutApp({
      kind: "workspace-session",
      projectId: "p1",
      name: "ws",
      scopes: "read",
      tokenId: "",
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(mockRevokeSession).not.toHaveBeenCalled();
    expect(mockTokenRevoke).not.toHaveBeenCalled();
  });

  it("is idempotent: a second bearer logout still returns 200", async () => {
    const tr = {
      kind: "session",
      projectId: "p1",
      name: "u",
      scopes: "admin",
      tokenId: "",
      githubRepoId: 1,
      githubLogin: "u",
      permission: "admin",
      expiresAt: Date.now() + 3_600_000,
      jti: "22222222-2222-2222-2222-222222222222",
    };
    expect((await post(makeLogoutApp(tr))).status).toBe(200);
    expect((await post(makeLogoutApp(tr))).status).toBe(200);
  });
});

describe("GET /auth/session/status", () => {
  it("returns 401 without auth", async () => {
    mockSessionValidate.mockResolvedValue(null);
    const app = makeProtectedApp();

    const res = await app.request("/auth/session/status", {}, testEnv, mockCtx);
    expect(res.status).toBe(401);
  });

  it("returns 200 with projectId when authenticated via cookie", async () => {
    mockSessionValidate.mockResolvedValue({
      projectId: "test-project",
      tokenHash: "tok-hash",
      name: "actor",
      scopes: "full",
      expiresAt: Date.now() + 3_600_000,
      permission: "admin",
    });
    const app = makeProtectedApp();

    const res = await app.request(
      "/auth/session/status",
      { headers: { Cookie: "tila_session=some-uuid" } },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; projectId: string };
    expect(body.ok).toBe(true);
    expect(body.projectId).toBe("test-project");
  });

  it("returns canManageTokens=true for admin cookie session", async () => {
    mockSessionValidate.mockResolvedValue({
      projectId: "test-project",
      tokenHash: "tok-hash",
      name: "actor",
      scopes: "full",
      expiresAt: Date.now() + 3_600_000,
      permission: "admin",
    });
    const app = makeProtectedApp();

    const res = await app.request(
      "/auth/session/status",
      { headers: { Cookie: "tila_session=some-uuid" } },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      projectId: string;
      permission: string;
      canManageTokens: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.projectId).toBe("test-project");
    expect(body.permission).toBe("admin");
    expect(body.canManageTokens).toBe(true);
  });

  it("returns canManageTokens=false for write cookie session", async () => {
    mockSessionValidate.mockResolvedValue({
      projectId: "test-project",
      tokenHash: "tok-hash-write",
      name: "actor",
      scopes: "read",
      expiresAt: Date.now() + 3_600_000,
      permission: "write",
    });
    const app = makeProtectedApp();

    // Use a different cookie value to avoid hitting the session cache from a prior test
    const res = await app.request(
      "/auth/session/status",
      { headers: { Cookie: "tila_session=write-uuid" } },
      testEnv,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      projectId: string;
      permission: string;
      canManageTokens: boolean;
    };
    expect(body.permission).toBe("write");
    expect(body.canManageTokens).toBe(false);
  });
});
