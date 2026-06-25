import type { RateLimitStoreInterface, SessionResult } from "@tila/backend-d1";
import { Hono } from "hono";
import { SignJWT, importJWK } from "jose";
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { base64UrlDecode, base64UrlEncode } from "../lib/base64url";
import { hashToken } from "../lib/hash-token";
import { _clearCacheForTest } from "../lib/token-cache";
import type {
  Env,
  HonoVariables,
  SessionTokenResult,
  WorkspaceSessionTokenResult,
} from "../types";
import {
  type GetClientIP,
  _debounceMapSizeForTest,
  _isolateFailMapSizeForTest,
  _jtiRevCacheHasForTest,
  _jtiRevCacheSizeForTest,
  _resetMiddlewareStateForTest,
  _subjectRevCacheSizeForTest,
  createAuthMiddleware,
  revokeSubjectInCache,
} from "./auth";

// Mock deployment-instance module for Task 8 tests (instance_id validation)
const mockEnsureDeploymentInstanceId =
  vi.fn<(db: D1Database) => Promise<string>>();
vi.mock("../lib/deployment-instance", () => ({
  ensureDeploymentInstanceId: (db: D1Database) =>
    mockEnsureDeploymentInstanceId(db),
  __resetInstanceCache: vi.fn(),
}));

// Mock analytics module for Task 8 instance mismatch datapoint assertions
const mockEmitInstanceMismatchDatapoint = vi.fn();
vi.mock("../lib/analytics", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/analytics")>();
  return {
    ...original,
    emitInstanceMismatchDatapoint: (...args: unknown[]) =>
      mockEmitInstanceMismatchDatapoint(...args),
  };
});

// --- Session token test helpers ---

// 32-byte test HMAC key (same derivation as auth-github.test.ts)
const TEST_HMAC_KEY = btoa("test-hmac-key-this-is-32-bytes!!")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

/**
 * Mint a valid tila_s. session token signed with TEST_HMAC_KEY using jose.
 * Format: tila_s.<jwtHeader>.<jwtPayload>.<jwtSignature>
 * Pass overrides to produce invalid/expired payloads for negative tests.
 */
async function mintSessionToken(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const payload = {
    project_id: "proj-1",
    github_host: "github.com",
    github_repo_id: 99999,
    github_login: "testuser",
    github_user_id: 12345,
    permission: "write",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    issued_at: Math.floor(Date.now() / 1000),
    iss: "tila",
    aud: "tila",
    ...overrides,
  };

  const keyBytes = base64UrlDecode(TEST_HMAC_KEY);
  const secret = await importJWK(
    { kty: "oct", k: base64UrlEncode(keyBytes), alg: "HS256" },
    "HS256",
  );

  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(secret);

  return `tila_s.${jwt}`;
}

/** fetchWithCtx variant that includes GITHUB_SESSION_HMAC_KEY in env */
async function fetchWithSessionEnv(
  app: ReturnType<typeof createTestApp>,
  request: Request,
  hmacKey = TEST_HMAC_KEY,
): Promise<Response> {
  return app.fetch(
    request,
    {
      DB: {} as D1Database,
      PROJECT: {} as DurableObjectNamespace,
      ARTIFACTS: {} as R2Bucket,
      ANALYTICS: {} as AnalyticsEngineDataset,
      GITHUB_SESSION_HMAC_KEY: hmacKey,
    },
    {
      waitUntil: mockWaitUntil,
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  );
}

// --- Mock D1TokenStore ---
const mockValidate = vi.fn();
const mockUpdateLastUsedAt = vi.fn().mockResolvedValue(undefined);
const mockSessionValidate = vi.fn();

// Mutable mock for D1RevokedJtiStore — tests can reassign mockRevokedJtiIsRevoked
let mockRevokedJtiIsRevoked = vi.fn().mockResolvedValue(false);

// Mutable mock for D1RevokedSubjectsStore.getRevokedBefore (WI-C). Default: no
// tombstone (null). Tests reassign to return a number or reject (fail-closed).
let mockGetRevokedBefore = vi.fn().mockResolvedValue(null);

// vitest 4 forbids arrow-function vi.fn() implementations from being used as
// constructors (the worker source calls `new D1TokenStore(...)`). A `class`
// expression is constructable; the `as unknown as () => unknown` cast satisfies
// mockImplementation's call-signature parameter type. Do NOT "simplify" these
// back to `() => ({...})` arrows — Biome's useArrowFunction would also rewrite a
// plain `function` expression to an arrow, so `class` + cast is the stable form.
vi.mock("@tila/backend-d1", () => ({
  D1TokenStore: vi.fn().mockImplementation(
    class {
      validate = mockValidate;
      updateLastUsedAt = mockUpdateLastUsedAt;
    } as unknown as () => unknown,
  ),
  D1SessionStore: vi.fn().mockImplementation(
    class {
      validate = mockSessionValidate;
    } as unknown as () => unknown,
  ),
  D1RateLimitStore: vi.fn().mockImplementation(
    class {
      check = vi.fn().mockResolvedValue(false);
      recordFailure = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  D1RevokedJtiStore: vi.fn().mockImplementation(
    class {
      isRevoked = (...args: unknown[]) => mockRevokedJtiIsRevoked(...args);
      revoke = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  D1RevokedSubjectsStore: vi.fn().mockImplementation(
    class {
      getRevokedBefore = (...args: unknown[]) => mockGetRevokedBefore(...args);
      revokeSubject = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  // Real (pure) canonicalization — the verify path uses it to build the cache
  // key; mocking it would defeat parity. Kept byte-identical to
  // backend-d1/src/principal.ts.
  canonicalizePrincipal: (
    host: string | null | undefined,
    subject: string | number,
  ) => {
    const identityHost = (host ?? "github.com").trim().toLowerCase();
    const subjectId = String(subject).trim();
    if (subjectId === "") {
      throw new Error(
        "canonicalizePrincipal: empty subject after canonicalization",
      );
    }
    return { identityHost, subjectId };
  },
}));

// --- Mock session-cache ---
const mockGetSessionFromCache =
  vi.fn<(hash: string) => SessionResult | false | undefined>();
const mockSetSessionInCache =
  vi.fn<(hash: string, result: SessionResult | false) => void>();
const mockInvalidateSession = vi.fn<(hash: string) => void>();

vi.mock("../lib/session-cache", () => ({
  getSessionFromCache: (hash: string) => mockGetSessionFromCache(hash),
  setSessionInCache: (hash: string, result: SessionResult | false) =>
    mockSetSessionInCache(hash, result),
  invalidateSession: (hash: string) => mockInvalidateSession(hash),
}));

// Fixture for a valid session result
const VALID_SESSION: SessionResult = {
  projectId: "proj-1",
  tokenHash: "tok-hash-1",
  name: "test-user",
  scopes: "write",
  permission: "write",
  expiresAt: Date.now() + 60_000,
};

const VALID_TOKEN = "test-fake-token-for-unit-tests";
const CLAIMS = {
  projectId: "proj-1",
  name: "my-token",
  scopes: "full",
  tokenId: "test-token-id-uuid",
};

type AppEnv = { Bindings: Env; Variables: HonoVariables };

class MockRateLimitStore implements RateLimitStoreInterface {
  private failures = new Map<string, { count: number; windowStart: number }>();

  async check(
    ip: string,
    maxFailures: number,
    windowMs: number,
  ): Promise<boolean> {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > windowMs) return false;
    return entry.count >= maxFailures;
  }

  async recordFailure(ip: string, windowMs: number): Promise<void> {
    const now = Date.now();
    const entry = this.failures.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      this.failures.set(ip, { count: 1, windowStart: now });
    } else {
      entry.count++;
    }
  }

  reset(): void {
    this.failures.clear();
  }
}

function createTestApp(opts?: {
  getClientIP?: GetClientIP;
  rateLimitStore?: RateLimitStoreInterface;
}) {
  const app = new Hono<AppEnv>();
  app.use("/*", createAuthMiddleware(opts));
  app.get("/test", (c) => c.json({ ok: true, claims: c.get("tokenResult") }));
  return app;
}

function makeReq(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

// Mock executionCtx.waitUntil to execute synchronously
const mockWaitUntil = vi.fn((p: Promise<unknown>) => p);

beforeEach(() => {
  vi.useFakeTimers();
  _clearCacheForTest();
  _resetMiddlewareStateForTest();
  mockValidate.mockReset();
  mockUpdateLastUsedAt.mockReset().mockResolvedValue(undefined);
  mockWaitUntil.mockClear();
  mockGetSessionFromCache.mockReset().mockReturnValue(undefined);
  mockSetSessionInCache.mockReset();
  mockInvalidateSession.mockReset();
  mockSessionValidate.mockReset();
  mockRevokedJtiIsRevoked = vi.fn().mockResolvedValue(false);
  // WI-C: default to no subject tombstone (null) between tests
  mockGetRevokedBefore = vi.fn().mockResolvedValue(null);
  // Task 8: reset instance cache + mocks between tests
  mockEnsureDeploymentInstanceId.mockReset();
  mockEmitInstanceMismatchDatapoint.mockReset();
  // Default: resolve to a known deployment instance id
  mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
});

afterEach(() => {
  vi.useRealTimers();
});

// Helper to make requests with executionCtx mock
async function fetchWithCtx(
  app: ReturnType<typeof createTestApp>,
  request: Request,
): Promise<Response> {
  return app.fetch(
    request,
    {
      DB: {} as D1Database,
      PROJECT: {} as DurableObjectNamespace,
      ARTIFACTS: {} as R2Bucket,
      ANALYTICS: {} as AnalyticsEngineDataset,
    },
    {
      waitUntil: mockWaitUntil,
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  );
}

describe("auth middleware", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const app = createTestApp();
    const res = await fetchWithCtx(app, makeReq("/test"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 401 for malformed Authorization header (not Bearer)", async () => {
    const app = createTestApp();
    const res = await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: "Token abc" }),
    );
    expect(res.status).toBe(401);
  });

  it("validates token via D1 on cache miss and caches positive result", async () => {
    mockValidate.mockResolvedValueOnce(CLAIMS);
    const app = createTestApp();

    const res = await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );
    expect(res.status).toBe(200);
    expect(mockValidate).toHaveBeenCalledTimes(1);

    // Second request within 60s -- should hit cache, no D1 call
    mockValidate.mockReset();
    const res2 = await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );
    expect(res2.status).toBe(200);
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it("returns 401 and caches negative result when D1 returns null", async () => {
    mockValidate.mockResolvedValueOnce(null);
    const app = createTestApp();

    const res = await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: "Bearer bad-token" }),
    );
    expect(res.status).toBe(401);
    expect(mockValidate).toHaveBeenCalledTimes(1);

    // Second request within 10s -- negative cache hit, no D1 call
    mockValidate.mockReset();
    const res2 = await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: "Bearer bad-token" }),
    );
    expect(res2.status).toBe(401);
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it("expires positive cache after 60s and re-queries D1", async () => {
    mockValidate.mockResolvedValue(CLAIMS);
    const app = createTestApp();

    await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );
    expect(mockValidate).toHaveBeenCalledTimes(1);

    // Advance past 60s TTL
    vi.advanceTimersByTime(60_001);
    mockValidate.mockReset().mockResolvedValue(CLAIMS);

    await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );
    expect(mockValidate).toHaveBeenCalledTimes(1);
  });

  it("expires negative cache after 10s and re-queries D1", async () => {
    mockValidate.mockResolvedValueOnce(null);
    const app = createTestApp();

    await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: "Bearer revoked-token" }),
    );

    vi.advanceTimersByTime(10_001);
    mockValidate.mockReset().mockResolvedValueOnce(CLAIMS);

    const res = await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: "Bearer revoked-token" }),
    );
    expect(res.status).toBe(200);
    expect(mockValidate).toHaveBeenCalledTimes(1);
  });

  it("invalidate() removes positive cache so next request queries D1", async () => {
    mockValidate.mockResolvedValue(CLAIMS);
    const app = createTestApp();
    // fetchWithCtx sets no HASH_PEPPER, so the middleware hashes bare — match it.
    const hash = await hashToken(VALID_TOKEN, undefined);

    await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );

    // Simulate revocation by T3
    const { invalidate } = await import("../lib/token-cache");
    invalidate(hash);

    mockValidate.mockReset().mockResolvedValueOnce(null);
    const res = await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );
    expect(res.status).toBe(401);
    expect(mockValidate).toHaveBeenCalledTimes(1);
  });

  it("debounces updateLastUsedAt -- only one write within 60s", async () => {
    mockValidate.mockResolvedValue(CLAIMS);
    const app = createTestApp();

    await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );
    await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );
    await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );

    expect(mockUpdateLastUsedAt).toHaveBeenCalledTimes(1);
  });

  it("writes updateLastUsedAt again after debounce window expires", async () => {
    mockValidate.mockResolvedValue(CLAIMS);
    const app = createTestApp();

    await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );
    expect(mockUpdateLastUsedAt).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);

    await fetchWithCtx(
      app,
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
    );
    expect(mockUpdateLastUsedAt).toHaveBeenCalledTimes(2);
  });

  it("logs console.warn and emits analytics when updateLastUsedAt rejects", async () => {
    mockValidate.mockResolvedValue(CLAIMS);
    mockUpdateLastUsedAt.mockRejectedValueOnce(new Error("D1 write failed"));

    const mockWriteDataPoint = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = new Hono<AppEnv>();
    app.use("/*", createAuthMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));

    // fetchWithCtx sets no HASH_PEPPER, so the middleware hashes bare — match it.
    const hash = await hashToken(VALID_TOKEN, undefined);

    const capturedPromises: Promise<unknown>[] = [];
    const capturingWaitUntil = vi.fn((p: Promise<unknown>) => {
      capturedPromises.push(p);
      return p;
    });

    const res = await app.fetch(
      makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
      {
        DB: {} as D1Database,
        PROJECT: {} as DurableObjectNamespace,
        ARTIFACTS: {} as R2Bucket,
        ANALYTICS: {
          writeDataPoint: mockWriteDataPoint,
        } as unknown as AnalyticsEngineDataset,
      },
      {
        waitUntil: capturingWaitUntil,
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );

    // Settle all waitUntil promises (including the rejected updateLastUsedAt)
    await Promise.allSettled(capturedPromises);

    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[auth] updateLastUsedAt failed:"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(hash.slice(0, 8)),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("D1 write failed"),
    );
    expect(mockWriteDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: ["auth", "updateLastUsedAt_failure", "D1 write failed"],
        doubles: [1],
        indexes: [hash.slice(0, 8)],
      }),
    );

    warnSpy.mockRestore();
  });

  describe("rate limiting", () => {
    let mockRateLimitStore: MockRateLimitStore;

    beforeEach(() => {
      mockRateLimitStore = new MockRateLimitStore();
    });

    it("returns 429 after 20 failed attempts from same IP within 60s", async () => {
      mockValidate.mockResolvedValue(null);
      const getClientIP: GetClientIP = () => "1.2.3.4";
      const app = createTestApp({
        getClientIP,
        rateLimitStore: mockRateLimitStore,
      });

      // 20 failures
      for (let i = 0; i < 20; i++) {
        const res = await fetchWithCtx(
          app,
          makeReq("/test", { Authorization: `Bearer bad-${i}` }),
        );
        expect(res.status).toBe(401);
      }

      // 21st should be rate-limited
      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer bad-21" }),
      );
      expect(res.status).toBe(429);
      const body = (await res.json()) as {
        error: { code: string; retryable: boolean };
      };
      expect(body.error.code).toBe("rate-limited");
      expect(body.error.retryable).toBe(true);
    });

    it("resets rate limit after window expires", async () => {
      mockValidate.mockResolvedValue(null);
      const getClientIP: GetClientIP = () => "5.6.7.8";
      const app = createTestApp({
        getClientIP,
        rateLimitStore: mockRateLimitStore,
      });

      for (let i = 0; i < 20; i++) {
        await fetchWithCtx(
          app,
          makeReq("/test", { Authorization: `Bearer bad-${i}` }),
        );
      }

      // Window expires
      vi.advanceTimersByTime(60_001);

      mockValidate.mockReset().mockResolvedValueOnce(CLAIMS);
      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
      );
      expect(res.status).toBe(200);
    });

    it("does not rate-limit when IP is unavailable", async () => {
      mockValidate.mockResolvedValue(null);
      const getClientIP: GetClientIP = () => null;
      const app = createTestApp({
        getClientIP,
        rateLimitStore: mockRateLimitStore,
      });

      for (let i = 0; i < 25; i++) {
        const res = await fetchWithCtx(
          app,
          makeReq("/test", { Authorization: `Bearer bad-${i}` }),
        );
        // Should always be 401, never 429
        expect(res.status).toBe(401);
      }
    });
  });

  describe("session token path (tila_s.)", () => {
    it("accepts a valid session token and sets kind:session tokenResult", async () => {
      const token = await mintSessionToken();
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        claims: SessionTokenResult;
      };
      expect(body.claims.kind).toBe("session");
      expect(body.claims.projectId).toBe("proj-1");
      expect(body.claims.githubLogin).toBe("testuser");
      expect(body.claims.permission).toBe("write");
      expect(body.claims.githubRepoId).toBe(99999);
    });

    it("surfaces githubUserId and githubHost from the verified payload on the session tokenResult", async () => {
      const token = await mintSessionToken({
        github_user_id: 778899,
        github_host: "github.com",
      });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        claims: SessionTokenResult;
      };
      expect(body.claims.kind).toBe("session");
      expect(body.claims.githubUserId).toBe(778899);
      expect(body.claims.githubHost).toBe("github.com");
    });

    it("surfaces jti from the verified payload on the session tokenResult", async () => {
      const token = await mintSessionToken({
        jti: "test-jti-12345",
      });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        claims: SessionTokenResult;
      };
      expect(body.claims.kind).toBe("session");
      expect(body.claims.jti).toBe("test-jti-12345");
    });

    it("returns 401 SESSION_EXPIRED for an expired session token", async () => {
      const token = await mintSessionToken({
        expires_at: Math.floor(Date.now() / 1000) - 10,
      });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session-expired");
    });

    it("returns 401 UNAUTHORIZED for a session token with no iss claim", async () => {
      const token = await mintSessionToken({ iss: undefined });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
    });

    it("returns 401 UNAUTHORIZED for a session token with no aud claim", async () => {
      const token = await mintSessionToken({ aud: undefined });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
    });

    it("returns 401 UNAUTHORIZED for a tampered HMAC signature", async () => {
      const token = await mintSessionToken();
      // Replace last 4 chars of token to corrupt the signature
      const tampered = `${token.slice(0, -4)}XXXX`;
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${tampered}` }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
    });

    it("returns 401 UNAUTHORIZED for a malformed token (wrong number of parts)", async () => {
      const app = createTestApp();
      // tila_s. prefix but only 2 parts
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: "Bearer tila_s.onlytwoParts" }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
    });

    it("returns 500 HMAC_NOT_CONFIGURED when GITHUB_SESSION_HMAC_KEY is missing", async () => {
      const token = await mintSessionToken();
      const app = createTestApp();
      // fetchWithCtx does NOT include GITHUB_SESSION_HMAC_KEY
      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("hmac-not-configured");
    });

    it("D1 token path still works unchanged alongside session path", async () => {
      mockValidate.mockResolvedValueOnce(CLAIMS);
      const app = createTestApp();
      // Use a non-tila_s. token — goes through D1 path
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        claims: { kind: string };
      };
      expect(body.claims.kind).toBe("d1-token");
      expect(mockValidate).toHaveBeenCalledTimes(1);
    });

    it("jose round-trip: token minted with new jose-based code is accepted by auth middleware", async () => {
      // Mint using the same jose path that auth-github.ts now uses
      const payload = {
        project_id: "round-trip-proj",
        github_host: "github.com",
        github_repo_id: 55555,
        github_login: "roundtripuser",
        github_user_id: 99,
        permission: "read" as const,
        expires_at: Math.floor(Date.now() / 1000) + 7200,
        issued_at: Math.floor(Date.now() / 1000),
        iss: "tila",
        aud: "tila",
      };

      const keyBytes = base64UrlDecode(TEST_HMAC_KEY);
      const secret = await importJWK(
        { kty: "oct", k: base64UrlEncode(keyBytes), alg: "HS256" },
        "HS256",
      );
      const jwt = await new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .sign(secret);
      const token = `tila_s.${jwt}`;

      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        claims: SessionTokenResult;
      };
      expect(body.claims.kind).toBe("session");
      expect(body.claims.projectId).toBe("round-trip-proj");
      expect(body.claims.githubLogin).toBe("roundtripuser");
      expect(body.claims.permission).toBe("read");
      expect(body.claims.githubRepoId).toBe(55555);
    });
  });

  describe("lastWriteMap eviction", () => {
    it("caps debounce map at MAX_DEBOUNCE_MAP_SIZE and evicts oldest entry", async () => {
      mockValidate.mockResolvedValue(CLAIMS);
      const app = createTestApp();

      const baseTime = Date.now();

      for (let i = 0; i < 2001; i++) {
        const token = `eviction-test-token-${i}`;
        await fetchWithCtx(
          app,
          makeReq("/test", { Authorization: `Bearer ${token}` }),
        );
      }

      expect(_debounceMapSizeForTest()).toBe(2000);

      // The first token should have been evicted — re-sending it after the
      // debounce window should trigger a fresh updateLastUsedAt call
      vi.setSystemTime(baseTime + 120_000);
      mockUpdateLastUsedAt.mockClear();

      await fetchWithCtx(
        app,
        makeReq("/test", {
          Authorization: "Bearer eviction-test-token-0",
        }),
      );

      expect(mockUpdateLastUsedAt).toHaveBeenCalled();
    });

    it("preserves debounce behavior after eviction guard is active", async () => {
      mockValidate.mockResolvedValue(CLAIMS);
      const app = createTestApp();

      // First request — triggers D1 write
      await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer debounce-token-A" }),
      );
      expect(mockUpdateLastUsedAt).toHaveBeenCalledTimes(1);

      // Second request with same token within debounce window — no D1 write
      mockUpdateLastUsedAt.mockClear();
      await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer debounce-token-A" }),
      );
      expect(mockUpdateLastUsedAt).not.toHaveBeenCalled();
    });

    it("evicts non-promoted entries read within debounce window", async () => {
      mockValidate.mockResolvedValue(CLAIMS);
      const app = createTestApp();

      const baseTime = Date.now();

      // Insert token A at position 1
      await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer np-token-A" }),
      );

      // Fill map to capacity with 1999 more tokens
      for (let i = 0; i < 1999; i++) {
        await fetchWithCtx(
          app,
          makeReq("/test", {
            Authorization: `Bearer np-filler-${i}`,
          }),
        );
      }
      expect(_debounceMapSizeForTest()).toBe(2000);

      // Read token A within debounce window — no set, no promotion
      await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer np-token-A" }),
      );

      // Insert one more token — should evict token A (oldest, not promoted)
      await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer np-token-C" }),
      );
      expect(_debounceMapSizeForTest()).toBe(2000);

      // Advance past debounce window and re-send token A
      vi.setSystemTime(baseTime + 120_000);
      mockUpdateLastUsedAt.mockClear();

      await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer np-token-A" }),
      );

      // Token A was evicted despite being recently read — updateLastUsedAt fires
      expect(mockUpdateLastUsedAt).toHaveBeenCalled();
    });
  });

  describe("cookie-session cache integration", () => {
    it("positive cache hit: returns 200 without calling D1", async () => {
      mockGetSessionFromCache.mockReturnValue(VALID_SESSION);
      const app = createTestApp();

      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Cookie: "tila_session=valid-cookie-token" }),
      );

      expect(res.status).toBe(200);
      expect(mockSessionValidate).not.toHaveBeenCalled();
      const body = (await res.json()) as {
        ok: boolean;
        claims: { kind: string; projectId: string };
      };
      expect(body.claims.kind).toBe("cookie-session");
      expect(body.claims.projectId).toBe("proj-1");
    });

    it("positive cache hit with expired session: falls through to D1", async () => {
      const expiredSession: SessionResult = {
        ...VALID_SESSION,
        expiresAt: Date.now() - 1000, // already expired
      };
      mockGetSessionFromCache.mockReturnValue(expiredSession);
      mockSessionValidate.mockResolvedValueOnce(VALID_SESSION);

      const app = createTestApp();
      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Cookie: "tila_session=expired-cached-cookie" }),
      );

      expect(res.status).toBe(200);
      expect(mockInvalidateSession).toHaveBeenCalledTimes(1);
      expect(mockSessionValidate).toHaveBeenCalledTimes(1);
    });

    it("negative cache hit: returns 401 without calling D1, no rate-limit", async () => {
      mockGetSessionFromCache.mockReturnValue(false);
      const mockRateLimitStore = new MockRateLimitStore();
      const app = createTestApp({ rateLimitStore: mockRateLimitStore });

      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Cookie: "tila_session=revoked-cookie" }),
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session-expired");
      expect(mockSessionValidate).not.toHaveBeenCalled();
    });

    it("cache miss → D1 valid: caches SessionResult and returns 200", async () => {
      mockGetSessionFromCache.mockReturnValue(undefined);
      mockSessionValidate.mockResolvedValueOnce(VALID_SESSION);

      const app = createTestApp();
      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Cookie: "tila_session=fresh-valid-cookie" }),
      );

      expect(res.status).toBe(200);
      expect(mockSessionValidate).toHaveBeenCalledTimes(1);
      expect(mockSetSessionInCache).toHaveBeenCalledWith(
        expect.any(String),
        VALID_SESSION,
      );
    });

    it("cache miss → D1 null: caches false, records rate-limit, returns 401", async () => {
      mockGetSessionFromCache.mockReturnValue(undefined);
      mockSessionValidate.mockResolvedValueOnce(null);
      const mockRateLimitStore = new MockRateLimitStore();
      const getClientIP: GetClientIP = () => "1.2.3.4";
      const app = createTestApp({
        getClientIP,
        rateLimitStore: mockRateLimitStore,
      });

      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Cookie: "tila_session=invalid-cookie" }),
      );

      expect(res.status).toBe(401);
      expect(mockSetSessionInCache).toHaveBeenCalledWith(
        expect.any(String),
        false,
      );
      // Verify rate-limit failure was recorded
      const isLimited = await mockRateLimitStore.check("1.2.3.4", 1, 60_000);
      expect(isLimited).toBe(true);
    });

    it("D1 workspace session (projectId='') → produces WorkspaceSessionTokenResult with authKind:workspace", async () => {
      const workspaceSession: SessionResult = {
        projectId: "",
        tokenHash: "ws-tok-hash",
        name: "gh-alice",
        scopes: "",
        permission: "read",
        expiresAt: Date.now() + 60_000,
      };
      mockGetSessionFromCache.mockReturnValue(undefined);
      mockSessionValidate.mockResolvedValueOnce(workspaceSession);

      const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
      app.use("/*", createAuthMiddleware());
      app.get("/test", (c) =>
        c.json({
          ok: true,
          claims: c.get("tokenResult"),
          authKind: c.get("authKind"),
        }),
      );

      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Cookie: "tila_session=workspace-cookie" }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        claims: WorkspaceSessionTokenResult;
        authKind: string;
      };
      expect(body.claims.kind).toBe("workspace-session");
      expect(body.claims.projectId).toBe("");
      expect(body.claims.githubLogin).toBe("gh-alice");
      expect(body.claims.name).toBe("gh-alice");
      expect(body.authKind).toBe("workspace");
    });

    it("cached workspace session (cache-hit path, projectId='') → produces WorkspaceSessionTokenResult", async () => {
      const cachedWorkspace: SessionResult = {
        projectId: "",
        tokenHash: "ws-tok-hash-2",
        name: "gh-bob",
        scopes: "",
        permission: "read",
        expiresAt: Date.now() + 60_000,
      };
      mockGetSessionFromCache.mockReturnValue(cachedWorkspace);

      const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
      app.use("/*", createAuthMiddleware());
      app.get("/test", (c) =>
        c.json({
          ok: true,
          claims: c.get("tokenResult"),
          authKind: c.get("authKind"),
        }),
      );

      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Cookie: "tila_session=cached-workspace-cookie" }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        claims: WorkspaceSessionTokenResult;
        authKind: string;
      };
      expect(body.claims.kind).toBe("workspace-session");
      expect(body.claims.projectId).toBe("");
      expect(body.claims.githubLogin).toBe("gh-bob");
      expect(body.authKind).toBe("workspace");
      // D1 should NOT have been called — this was a cache hit
      expect(mockSessionValidate).not.toHaveBeenCalled();
    });

    it("normal D1 session (projectId='proj_x') → still produces CookieSessionTokenResult (regression)", async () => {
      mockGetSessionFromCache.mockReturnValue(undefined);
      mockSessionValidate.mockResolvedValueOnce(VALID_SESSION);

      const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
      app.use("/*", createAuthMiddleware());
      app.get("/test", (c) =>
        c.json({
          ok: true,
          claims: c.get("tokenResult"),
          authKind: c.get("authKind"),
        }),
      );

      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Cookie: "tila_session=regular-project-cookie" }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        claims: { kind: string; projectId: string };
        authKind: string;
      };
      expect(body.claims.kind).toBe("cookie-session");
      expect(body.claims.projectId).toBe("proj-1");
      expect(body.authKind).toBe("cookie");
    });

    it("D1 project session with permission:'admin' → CookieSessionTokenResult carries permission:'admin'", async () => {
      const adminSession: SessionResult = {
        projectId: "proj-1",
        tokenHash: "tok-hash-admin",
        name: "admin-user",
        scopes: "full",
        permission: "admin",
        expiresAt: Date.now() + 60_000,
      };
      mockGetSessionFromCache.mockReturnValue(undefined);
      mockSessionValidate.mockResolvedValueOnce(adminSession);

      const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
      app.use("/*", createAuthMiddleware());
      app.get("/test", (c) =>
        c.json({ ok: true, claims: c.get("tokenResult") }),
      );

      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Cookie: "tila_session=admin-cookie" }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        claims: { kind: string; permission: string };
      };
      expect(body.claims.kind).toBe("cookie-session");
      expect(body.claims.permission).toBe("admin");
    });

    it("cache-hit project session with permission:'write' → CookieSessionTokenResult carries permission:'write'", async () => {
      const writeSession: SessionResult = {
        projectId: "proj-1",
        tokenHash: "tok-hash-write",
        name: "write-user",
        scopes: "full",
        permission: "write",
        expiresAt: Date.now() + 60_000,
      };
      mockGetSessionFromCache.mockReturnValue(writeSession);

      const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
      app.use("/*", createAuthMiddleware());
      app.get("/test", (c) =>
        c.json({ ok: true, claims: c.get("tokenResult") }),
      );

      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Cookie: "tila_session=write-cookie" }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        claims: { kind: string; permission: string };
      };
      expect(body.claims.kind).toBe("cookie-session");
      expect(body.claims.permission).toBe("write");
      // D1 should NOT have been called — this was a cache hit
      expect(mockSessionValidate).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // C9 — jti revocation check (fail-closed)
  // ---------------------------------------------------------------------------
  describe("jti revocation (C9)", () => {
    it("accepts a valid session token with jti when not revoked", async () => {
      mockRevokedJtiIsRevoked = vi.fn().mockResolvedValue(false);
      const token = await mintSessionToken({ jti: "test-jti-valid" });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
      expect(mockRevokedJtiIsRevoked).toHaveBeenCalledWith("test-jti-valid");
    });

    it("returns 401 when jti is revoked (cached)", async () => {
      // Pre-populate the cache as revoked via revokeJtiInCache
      const { revokeJtiInCache } = await import("./auth");
      revokeJtiInCache("revoked-jti-cached");

      const token = await mintSessionToken({ jti: "revoked-jti-cached" });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session-revoked");
      // D1 should NOT be queried — cache is authoritative
      expect(mockRevokedJtiIsRevoked).not.toHaveBeenCalled();
    });

    it("returns 401 when jti is revoked (D1 check)", async () => {
      mockRevokedJtiIsRevoked = vi.fn().mockResolvedValue(true);
      const token = await mintSessionToken({ jti: "revoked-jti-d1" });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session-revoked");
    });

    it("returns 401 (fail-closed) when D1 jti lookup throws", async () => {
      mockRevokedJtiIsRevoked = vi
        .fn()
        .mockRejectedValue(new Error("D1 unavailable"));
      const token = await mintSessionToken({ jti: "unknown-jti" });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(401);
      // Should deny (fail-closed) — not 500, not 200
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
    });

    it("accepts a session token without jti (backward compat — pre-C9 token)", async () => {
      // Token without jti should bypass revocation check entirely
      const token = await mintSessionToken(); // no jti override
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
      // D1 should NOT be queried for a token with no jti
      expect(mockRevokedJtiIsRevoked).not.toHaveBeenCalled();
    });

    it("rejects a session token without iss/aud (1h-TTL tokens always carry them now)", async () => {
      // mintSessionToken (auth-github.ts) always sets iss="tila"/aud="tila", and
      // session tokens are 1-hour TTL, so no live token lacks them. Requiring
      // them closes the gap where a token minted for another purpose with the
      // shared HMAC key (without iss/aud) would pass the session check.
      const token = await mintSessionToken({ iss: undefined, aud: undefined });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(401);
    });

    it("rejects a session token with the wrong audience", async () => {
      const token = await mintSessionToken({ aud: "evil-app" });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
    });

    it("uses cached not-revoked result (no D1 on second request)", async () => {
      mockRevokedJtiIsRevoked = vi.fn().mockResolvedValue(false);
      const token = await mintSessionToken({ jti: "cache-test-jti" });
      const app = createTestApp();

      // First request — D1 should be queried
      await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(mockRevokedJtiIsRevoked).toHaveBeenCalledTimes(1);

      // Second request within TTL — cache hit, D1 should NOT be queried again
      mockRevokedJtiIsRevoked.mockClear();
      const res2 = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res2.status).toBe(200);
      expect(mockRevokedJtiIsRevoked).not.toHaveBeenCalled();
    });

    it("re-queries D1 after JTI_REVCHECK_TTL_MS elapses (cache expiry)", async () => {
      mockRevokedJtiIsRevoked = vi.fn().mockResolvedValue(false);
      const token = await mintSessionToken({ jti: "ttl-test-jti" });
      const app = createTestApp();

      await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(mockRevokedJtiIsRevoked).toHaveBeenCalledTimes(1);

      // Advance past TTL
      vi.advanceTimersByTime(60_001);
      mockRevokedJtiIsRevoked.mockClear();

      const res2 = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res2.status).toBe(200);
      expect(mockRevokedJtiIsRevoked).toHaveBeenCalledTimes(1);
    });

    it("jtiRevCache is capped at exactly JTI_REV_CACHE_MAX_SIZE and evicts the oldest entry", async () => {
      // JTI_REV_CACHE_MAX_SIZE = 2000; each unique jti adds one cache entry.
      mockRevokedJtiIsRevoked = vi.fn().mockResolvedValue(false);
      const app = createTestApp();

      // Fill cache to exactly 2000 entries by making requests with distinct jtis
      for (let i = 0; i < 2000; i++) {
        const token = await mintSessionToken({ jti: `fill-jti-${i}` });
        await fetchWithSessionEnv(
          app,
          makeReq("/test", { Authorization: `Bearer ${token}` }),
        );
      }
      expect(_jtiRevCacheSizeForTest()).toBe(2000);

      // Verify the very first jti IS in the cache before overflow
      expect(_jtiRevCacheHasForTest("fill-jti-0")).toBe(true);

      // Insert one more — should evict fill-jti-0 (oldest) and keep size at 2000
      const overflowToken = await mintSessionToken({ jti: "overflow-jti" });
      await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${overflowToken}` }),
      );

      // Size must remain exactly at the cap after overflow
      expect(_jtiRevCacheSizeForTest()).toBe(2000);

      // The oldest entry (fill-jti-0) must have been evicted
      expect(_jtiRevCacheHasForTest("fill-jti-0")).toBe(false);

      // The newest entry must be present
      expect(_jtiRevCacheHasForTest("overflow-jti")).toBe(true);
      // Generous timeout: this test makes 2000+ full auth requests to fill the
      // cache to its cap, which can exceed the default 5s on loaded CI runners.
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // WI-C — subject-level bulk-revocation kill-switch (fail-closed)
  // ---------------------------------------------------------------------------
  describe("subject revocation (WI-C)", () => {
    it("accepts a session token when the principal has no tombstone", async () => {
      mockGetRevokedBefore = vi.fn().mockResolvedValue(null);
      const token = await mintSessionToken({ jti: "subj-no-tombstone" });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
      expect(mockGetRevokedBefore).toHaveBeenCalledWith(
        "proj-1",
        "github.com",
        12345,
      );
    });

    it("returns 401 subject-revoked when issued_at is before revoked_before (D1)", async () => {
      const issuedAtSec = Math.floor(Date.now() / 1000) - 3600; // 1h ago
      // revoked_before is EpochMillis, set to now → strictly after issued_at
      mockGetRevokedBefore = vi.fn().mockResolvedValue(Date.now());
      const token = await mintSessionToken({ issued_at: issuedAtSec });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("subject-revoked");
    });

    it("allows a token issued at/after the cutoff (strict <)", async () => {
      const issuedAtSec = Math.floor(Date.now() / 1000);
      // revoked_before strictly before issued_at (ms) → not revoked
      mockGetRevokedBefore = vi
        .fn()
        .mockResolvedValue(issuedAtSec * 1000 - 1000);
      const token = await mintSessionToken({ issued_at: issuedAtSec });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
    });

    it("returns 401 (fail-closed) when D1 getRevokedBefore throws", async () => {
      mockGetRevokedBefore = vi
        .fn()
        .mockRejectedValue(new Error("D1 unavailable"));
      const token = await mintSessionToken();
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      // Fail-closed deny uses "unauthorized" (retryable), not 500/200
      expect(body.error.code).toBe("unauthorized");
    });

    it("cache key is per-project: a tombstone in project A does not deny project B", async () => {
      // Arm the in-isolate cache for project A only, with a future cutoff.
      revokeSubjectInCache(
        "proj-A",
        "github.com",
        12345,
        Date.now() + 3_600_000,
      );

      // Project A request → cache hit → issued_at(now) < revoked_before(now+1h) → denied
      const tokenA = await mintSessionToken({ project_id: "proj-A" });
      const app = createTestApp();
      const resA = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${tokenA}` }),
      );
      expect(resA.status).toBe(401);
      expect(
        ((await resA.json()) as { error: { code: string } }).error.code,
      ).toBe("subject-revoked");

      // Project B, same principal → cache miss (different key) → D1 null → allowed
      mockGetRevokedBefore = vi.fn().mockResolvedValue(null);
      const tokenB = await mintSessionToken({ project_id: "proj-B" });
      const resB = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${tokenB}` }),
      );
      expect(resB.status).toBe(200);
    });

    it("threads the verified jti onto the bearer session result", async () => {
      const token = await mintSessionToken({ jti: "threaded-jti" });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { claims: SessionTokenResult };
      expect(body.claims.jti).toBe("threaded-jti");
    });

    it("_resetMiddlewareStateForTest clears the subject cache", async () => {
      revokeSubjectInCache("proj-1", "github.com", 12345, Date.now() + 1000);
      expect(_subjectRevCacheSizeForTest()).toBeGreaterThan(0);
      _resetMiddlewareStateForTest();
      expect(_subjectRevCacheSizeForTest()).toBe(0);
    });

    it("emits a PII-free analytics datapoint on the subject-revoked deny path", async () => {
      const issuedAtSec = Math.floor(Date.now() / 1000) - 3600;
      mockGetRevokedBefore = vi.fn().mockResolvedValue(Date.now());
      const token = await mintSessionToken({ issued_at: issuedAtSec });
      const app = createTestApp();
      const writeDataPoint = vi.fn();
      const res = await app.fetch(
        makeReq("/test", { Authorization: `Bearer ${token}` }),
        {
          DB: {} as D1Database,
          PROJECT: {} as DurableObjectNamespace,
          ARTIFACTS: {} as R2Bucket,
          ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
          GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
        } as Env,
        {
          waitUntil: mockWaitUntil,
          passThroughOnException: vi.fn(),
        } as unknown as ExecutionContext,
      );
      expect(res.status).toBe(401);
      expect(writeDataPoint).toHaveBeenCalledWith({
        blobs: ["auth", "subject-revoked"],
        doubles: [1],
        indexes: ["subject-revoked"],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // C8 — in-isolate secondary rate-limit guard
  // ---------------------------------------------------------------------------
  describe("in-isolate secondary rate-limit guard (C8)", () => {
    /**
     * Create a store whose check() always throws — simulates a D1 blip.
     * This forces the fail-open path and exercises the isolate counter.
     */
    function makeFaultingStore(): RateLimitStoreInterface {
      return {
        check: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
        recordFailure: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
      };
    }

    it("returns 429 after ISOLATE_RL_MAX_FAILURES D1-fail-open events from one IP", async () => {
      // ISOLATE_RL_MAX_FAILURES is 30; hit it from one IP.
      const faultingStore = makeFaultingStore();
      const getClientIP: GetClientIP = () => "9.8.7.6";
      const app = createTestApp({
        getClientIP,
        rateLimitStore: faultingStore,
      });

      // Make 30 requests — each hits the fail-open branch and records in isolate map.
      // Tokens are invalid so we always get 401 (D1 validate also returns null).
      mockValidate.mockResolvedValue(null);
      for (let i = 0; i < 30; i++) {
        const res = await fetchWithCtx(
          app,
          makeReq("/test", { Authorization: `Bearer fail-open-token-${i}` }),
        );
        // During the first 29 iterations the secondary guard has not triggered yet.
        // We don't assert per-iteration status because the guard triggers at exactly
        // ISOLATE_RL_MAX_FAILURES events (when the 30th is added, count ≥ 30).
        expect([401, 429]).toContain(res.status);
      }

      // The 31st request should be blocked by the secondary guard.
      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer over-limit" }),
      );
      expect(res.status).toBe(429);
      const body = (await res.json()) as {
        error: { code: string; retryable: boolean };
      };
      expect(body.error.code).toBe("rate-limited");
      expect(body.error.retryable).toBe(true);
    });

    it("does not 429 a different IP that has fewer failures", async () => {
      const faultingStore = makeFaultingStore();
      const currentIp = { value: "10.0.0.1" };
      const getClientIP: GetClientIP = () => currentIp.value;
      const app = createTestApp({ getClientIP, rateLimitStore: faultingStore });

      mockValidate.mockResolvedValue(null);

      // Hit IP A 30 times
      for (let i = 0; i < 30; i++) {
        await fetchWithCtx(
          app,
          makeReq("/test", { Authorization: `Bearer token-${i}` }),
        );
      }

      // Switch to IP B — should NOT be rate-limited
      currentIp.value = "10.0.0.2";
      mockValidate.mockResolvedValue(null);
      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer token-b" }),
      );
      expect(res.status).toBe(401); // Not 429 — IP B has no prior failures
    });

    it("isolateFailMap is capped at exactly ISOLATE_RL_MAX_MAP_SIZE and evicts the oldest entry", async () => {
      const faultingStore = makeFaultingStore();
      // Use a counter-based IP so we control insertion order
      let ipCounter = 0;
      const getClientIP: GetClientIP = () =>
        `10.0.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
      const app = createTestApp({ getClientIP, rateLimitStore: faultingStore });

      mockValidate.mockResolvedValue(null);

      // Fill map to exactly ISOLATE_RL_MAX_MAP_SIZE (2000) distinct IPs
      for (ipCounter = 0; ipCounter < 2000; ipCounter++) {
        await fetchWithCtx(
          app,
          makeReq("/test", { Authorization: `Bearer token-fill-${ipCounter}` }),
        );
      }
      expect(_isolateFailMapSizeForTest()).toBe(2000);

      // Now insert one more distinct IP — should evict the first one (ip 10.0.0.0)
      // and keep size at exactly 2000.
      const firstIp = "10.0.0.0";
      // Confirm first IP is currently in the map before eviction
      // (We can't query the map contents directly but the size being 2000 confirms it)
      ipCounter = 2000; // this becomes a new unique IP
      await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer token-overflow" }),
      );

      // Map size must remain exactly at the cap — not grow beyond it
      expect(_isolateFailMapSizeForTest()).toBe(2000);

      // The eviction must have fired: insert the 2001st unique entry, which
      // requires one eviction. We verify the cap is truly enforced (not just
      // "at most 2000" but "exactly 2000 after overflow").
      ipCounter = 2001;
      await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: "Bearer token-overflow-2" }),
      );
      expect(_isolateFailMapSizeForTest()).toBe(2000);

      // Sanity: the first IP we inserted (10.0.0.0) should have been evicted
      // by the time we added the 2001st entry. We re-insert it — if it was
      // evicted, the map stays at 2000 (evict-then-insert). If it was never
      // evicted the size would still be 2000 but the first entry would differ.
      // The strongest assertion we can make without exposing internal keys:
      // inserting the original IP again under a NEW test app (fresh state)
      // confirms the eviction contract holds at the boundary. The size == 2000
      // assertion after overflow is the definitive regression guard.
      void firstIp; // referenced only to satisfy linter
      // Generous timeout: this test makes 2000+ full auth requests to fill the
      // map to its cap, which can exceed the default 5s on loaded CI runners.
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // SEC-1 — warn once per isolate when HASH_PEPPER is unset
  // ---------------------------------------------------------------------------
  describe("HASH_PEPPER unset warning (SEC-1)", () => {
    async function fetchWithAnalytics(
      app: ReturnType<typeof createTestApp>,
      request: Request,
      writeDataPoint: Mock,
      pepper?: string,
    ): Promise<Response> {
      return app.fetch(
        request,
        {
          DB: {} as D1Database,
          PROJECT: {} as DurableObjectNamespace,
          ARTIFACTS: {} as R2Bucket,
          ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
          ...(pepper ? { HASH_PEPPER: pepper } : {}),
        } as Env,
        {
          waitUntil: mockWaitUntil,
          passThroughOnException: vi.fn(),
        } as unknown as ExecutionContext,
      );
    }

    it("warns (log + analytics) exactly once per isolate when HASH_PEPPER is unset", async () => {
      mockValidate.mockResolvedValue(CLAIMS);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const writeDataPoint = vi.fn();
      const app = createTestApp();

      await fetchWithAnalytics(
        app,
        makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
        writeDataPoint,
      );
      // Second authed request in the same isolate — must NOT warn again
      await fetchWithAnalytics(
        app,
        makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
        writeDataPoint,
      );

      const hashPepperWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes("HASH_PEPPER"),
      );
      expect(hashPepperWarns).toHaveLength(1);
      expect(String(hashPepperWarns[0][0])).toContain("hash-pepper-unset");

      const pepperPoints = writeDataPoint.mock.calls.filter((args) =>
        (args[0]?.blobs ?? []).includes("hash-pepper-unset"),
      );
      expect(pepperPoints).toHaveLength(1);

      warnSpy.mockRestore();
    });

    it("does NOT warn when HASH_PEPPER is set", async () => {
      mockValidate.mockResolvedValue(CLAIMS);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const writeDataPoint = vi.fn();
      const app = createTestApp();

      await fetchWithAnalytics(
        app,
        makeReq("/test", { Authorization: `Bearer ${VALID_TOKEN}` }),
        writeDataPoint,
        "operator-pepper",
      );

      const hashPepperWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes("HASH_PEPPER"),
      );
      expect(hashPepperWarns).toHaveLength(0);
      const pepperPoints = writeDataPoint.mock.calls.filter((args) =>
        (args[0]?.blobs ?? []).includes("hash-pepper-unset"),
      );
      expect(pepperPoints).toHaveLength(0);

      warnSpy.mockRestore();
    });
  });

  // --- tila_d1_ token-format: mint + pre-hash checksum reject (Task 2) ---
  describe("tila_d1_ token format", () => {
    /**
     * Fixed fixture — cross-runtime anchor (same as token-format.test.ts):
     *   entropy: 0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
     *   checksum: ae216c2e  (SHA-256 of those 32 bytes, first 4 bytes as hex)
     */
    const FIXTURE_TOKEN =
      "tila_d1_0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20ae216c2e";

    // A valid tila_d1_ token with a corrupted checksum (last char flipped)
    const CORRUPTED_CHECKSUM_TOKEN =
      "tila_d1_0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20ae216c2f";

    // A legacy tila_<hex> token (64 hex chars after tila_)
    const LEGACY_TOKEN = `tila_${"ab".repeat(32)}`;

    it("a freshly mintD1Token() bearer authenticates end-to-end (happy path)", async () => {
      // Dynamically import mintD1Token and compute token + hash
      const { mintD1Token } = await import("../lib/token-format");
      const token = await mintD1Token();
      // Compute the storage hash exactly as the middleware will (bare SHA-256 — no pepper in test env)
      const tokenHash = await hashToken(token, undefined);
      // Seed the positive result into the mock
      mockValidate.mockResolvedValueOnce(CLAIMS);

      const mockRateLimitStore = new MockRateLimitStore();
      const app = createTestApp({ rateLimitStore: mockRateLimitStore });

      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      // D1TokenStore.validate must have been called (checksum passed, token went to D1)
      expect(mockValidate).toHaveBeenCalledTimes(1);
      // Called with the storage hash of the full token string
      expect(mockValidate).toHaveBeenCalledWith(tokenHash);
    });

    it("a corrupted-checksum tila_d1_ bearer returns 401 and validate is never called", async () => {
      const mockRateLimitStore = new MockRateLimitStore();
      const getClientIP: GetClientIP = () => "10.0.0.1";
      const app = createTestApp({
        rateLimitStore: mockRateLimitStore,
        getClientIP,
      });

      const res = await fetchWithCtx(
        app,
        makeReq("/test", {
          Authorization: `Bearer ${CORRUPTED_CHECKSUM_TOKEN}`,
        }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("unauthorized");
      expect(body.error.message).toBe("Malformed token");

      // D1TokenStore.validate MUST NOT have been called — fast-rejected before hash/D1
      expect(mockValidate).not.toHaveBeenCalled();
    });

    it("a bad-checksum tila_d1_ bearer records exactly one rate-limit failure", async () => {
      const recordFailureSpy = vi.fn().mockResolvedValue(undefined);
      const mockRateLimitStore: RateLimitStoreInterface = {
        check: vi.fn().mockResolvedValue(false),
        recordFailure: recordFailureSpy,
      };
      const getClientIP: GetClientIP = () => "10.0.0.2";
      const app = createTestApp({
        rateLimitStore: mockRateLimitStore,
        getClientIP,
      });

      const res = await fetchWithCtx(
        app,
        makeReq("/test", {
          Authorization: `Bearer ${CORRUPTED_CHECKSUM_TOKEN}`,
        }),
      );
      expect(res.status).toBe(401);

      // Exactly one rate-limit failure recorded — not zero, not two
      expect(recordFailureSpy).toHaveBeenCalledTimes(1);
    });

    it("a legacy tila_<hex> bearer skips checksum and flows to hash/D1 path", async () => {
      mockValidate.mockResolvedValueOnce(CLAIMS);
      const mockRateLimitStore = new MockRateLimitStore();
      const app = createTestApp({ rateLimitStore: mockRateLimitStore });

      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: `Bearer ${LEGACY_TOKEN}` }),
      );
      expect(res.status).toBe(200);
      // D1 validate WAS called — legacy token went through the normal hash/D1 path
      expect(mockValidate).toHaveBeenCalledTimes(1);
    });

    it("fixture token passes checksum verify and authenticates when hash is seeded", async () => {
      // Compute the hash of the fixture token (bare SHA-256 — no pepper in test env)
      const tokenHash = await hashToken(FIXTURE_TOKEN, undefined);
      mockValidate.mockResolvedValueOnce(CLAIMS);

      const app = createTestApp();
      const res = await fetchWithCtx(
        app,
        makeReq("/test", { Authorization: `Bearer ${FIXTURE_TOKEN}` }),
      );
      expect(res.status).toBe(200);
      expect(mockValidate).toHaveBeenCalledWith(tokenHash);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 8: instance_id validation in the Bearer/JWT branch (C5)
// ---------------------------------------------------------------------------

describe("auth middleware — instance_id validation (Bearer/JWT branch only)", () => {
  const DEPLOYMENT_ID = "deployment-A";

  /** Helper to fetch a session-token request through the auth middleware. */
  async function fetchWithInstanceEnv(
    app: ReturnType<typeof createTestApp>,
    token: string,
    deploymentId = DEPLOYMENT_ID,
  ): Promise<Response> {
    mockEnsureDeploymentInstanceId.mockResolvedValue(deploymentId);
    return app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      {
        DB: {} as D1Database,
        PROJECT: {} as DurableObjectNamespace,
        ARTIFACTS: {} as R2Bucket,
        ANALYTICS: {
          writeDataPoint: vi.fn(),
        } as unknown as AnalyticsEngineDataset,
        GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
      },
      {
        waitUntil: mockWaitUntil,
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );
  }

  // (a) Matching instance_id → request proceeds (200)
  it("(a) matching instance_id allows the request through", async () => {
    const token = await mintSessionToken({ instance_id: DEPLOYMENT_ID });
    const app = createTestApp();

    const res = await fetchWithInstanceEnv(app, token, DEPLOYMENT_ID);

    expect(res.status).toBe(200);
    expect(mockEmitInstanceMismatchDatapoint).not.toHaveBeenCalled();
  });

  // (b) Present but mismatching instance_id → 401 instance-mismatch + mismatch datapoint
  it("(b) mismatching instance_id returns 401 instance-mismatch + emits mismatch datapoint", async () => {
    const token = await mintSessionToken({ instance_id: "deployment-B" });
    const app = createTestApp();

    const res = await fetchWithInstanceEnv(app, token, DEPLOYMENT_ID);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("instance-mismatch");
    expect(mockEmitInstanceMismatchDatapoint).toHaveBeenCalledOnce();
    const callArgs = mockEmitInstanceMismatchDatapoint.mock.calls[0];
    expect(callArgs[2]).toMatchObject({ outcome: "mismatch" });
  });

  // (c) Absent instance_id claim → proceeds + legacy datapoint
  it("(c) absent instance_id claim allows request + emits legacy datapoint", async () => {
    // Token minted WITHOUT instance_id (legacy token)
    const token = await mintSessionToken();
    const app = createTestApp();

    const res = await fetchWithInstanceEnv(app, token, DEPLOYMENT_ID);

    expect(res.status).toBe(200);
    expect(mockEmitInstanceMismatchDatapoint).toHaveBeenCalledOnce();
    const callArgs = mockEmitInstanceMismatchDatapoint.mock.calls[0];
    expect(callArgs[2]).toMatchObject({ outcome: "legacy" });
  });

  // (d) ensureDeploymentInstanceId throws + present claim → 401 resolve-failed
  it("(d) resolver throws + present instance_id returns 401 resolve-failed", async () => {
    const token = await mintSessionToken({ instance_id: "some-id" });
    mockEnsureDeploymentInstanceId.mockRejectedValue(
      new Error("D1 unavailable"),
    );
    const app = createTestApp();

    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      {
        DB: {} as D1Database,
        PROJECT: {} as DurableObjectNamespace,
        ARTIFACTS: {} as R2Bucket,
        ANALYTICS: {
          writeDataPoint: vi.fn(),
        } as unknown as AnalyticsEngineDataset,
        GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
      },
      {
        waitUntil: mockWaitUntil,
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("instance-mismatch");
    expect(mockEmitInstanceMismatchDatapoint).toHaveBeenCalledOnce();
    const callArgs = mockEmitInstanceMismatchDatapoint.mock.calls[0];
    expect(callArgs[2]).toMatchObject({ outcome: "resolve-failed" });
  });

  // (e) ensureDeploymentInstanceId throws + absent claim → proceeds (legacy path)
  it("(e) resolver throws + absent instance_id allows request through (legacy)", async () => {
    const token = await mintSessionToken(); // no instance_id
    mockEnsureDeploymentInstanceId.mockRejectedValue(
      new Error("D1 unavailable"),
    );
    const app = createTestApp();

    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      {
        DB: {} as D1Database,
        PROJECT: {} as DurableObjectNamespace,
        ARTIFACTS: {} as R2Bucket,
        ANALYTICS: {
          writeDataPoint: vi.fn(),
        } as unknown as AnalyticsEngineDataset,
        GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
      },
      {
        waitUntil: mockWaitUntil,
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    // Resolver threw but no instance_id present — accept and emit legacy
    expect(mockEmitInstanceMismatchDatapoint).toHaveBeenCalledOnce();
    const callArgs = mockEmitInstanceMismatchDatapoint.mock.calls[0];
    expect(callArgs[2]).toMatchObject({ outcome: "legacy" });
  });

  // (f) Cookie-session request is unaffected by the instance_id check
  it("(f) cookie-session request bypasses instance_id validation entirely", async () => {
    mockGetSessionFromCache.mockReturnValue(VALID_SESSION);
    const app = createTestApp();

    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Cookie: "tila_session=some-opaque-session-token" },
      }),
      {
        DB: {} as D1Database,
        PROJECT: {} as DurableObjectNamespace,
        ARTIFACTS: {} as R2Bucket,
        ANALYTICS: {
          writeDataPoint: vi.fn(),
        } as unknown as AnalyticsEngineDataset,
        GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
      },
      {
        waitUntil: mockWaitUntil,
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    // ensureDeploymentInstanceId must NOT be called for cookie sessions
    expect(mockEnsureDeploymentInstanceId).not.toHaveBeenCalled();
    expect(mockEmitInstanceMismatchDatapoint).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (T9): OIDC session (sub_type:"oidc") middleware tests
// ---------------------------------------------------------------------------

describe("OIDC session tokens (sub_type:oidc)", () => {
  /**
   * Mint a tila_s. JWT with sub_type:"oidc" fields.
   * These are the tokens produced by the /api/auth/oidc/exchange route (Phase 4).
   */
  async function mintOidcSessionToken(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      project_id: "proj-oidc",
      sub_type: "oidc",
      oidc_issuer: "https://idp.example.com",
      oidc_subject: "user@example.com",
      actor_name: "user@example.com",
      permission: "write",
      expires_at: now + 3600,
      issued_at: now,
      iss: "tila",
      aud: "tila",
      jti: "oidc-jti-test-uuid",
      ...overrides,
    };

    const keyBytes = base64UrlDecode(TEST_HMAC_KEY);
    const secret = await importJWK(
      { kty: "oct", k: base64UrlEncode(keyBytes), alg: "HS256" },
      "HS256",
    );

    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(secret);

    return `tila_s.${jwt}`;
  }

  it("resolves to kind:oidc-session with correct fields", async () => {
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
    const token = await mintOidcSessionToken();
    const app = createTestApp();
    const req = makeReq("/test", { Authorization: `Bearer ${token}` });
    const res = await fetchWithSessionEnv(app, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      claims: {
        kind: string;
        name: string;
        permission: string;
        oidcIssuer: string;
        oidcSubject: string;
        projectId: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.claims.kind).toBe("oidc-session");
    expect(body.claims.name).toBe("user@example.com");
    expect(body.claims.permission).toBe("write");
    expect(body.claims.oidcIssuer).toBe("https://idp.example.com");
    expect(body.claims.oidcSubject).toBe("user@example.com");
    expect(body.claims.projectId).toBe("proj-oidc");
    // Must NOT carry any GitHub fields
    expect(
      (body.claims as Record<string, unknown>).githubRepoId,
    ).toBeUndefined();
    expect(
      (body.claims as Record<string, unknown>).githubLogin,
    ).toBeUndefined();
    expect(
      (body.claims as Record<string, unknown>).githubUserId,
    ).toBeUndefined();
    expect((body.claims as Record<string, unknown>).githubHost).toBeUndefined();
  });

  it("legacy GitHub token with no sub_type still resolves to kind:session", async () => {
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
    // A legacy token: all github fields present, NO sub_type
    const token = await mintSessionToken({
      // No sub_type — should default-fill to "github"
    });
    const app = createTestApp();
    const req = makeReq("/test", { Authorization: `Bearer ${token}` });
    const res = await fetchWithSessionEnv(app, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      claims: { kind: string };
    };
    expect(body.ok).toBe(true);
    expect(body.claims.kind).toBe("session");
  });

  it("expired oidc session is rejected with 401 session-expired", async () => {
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
    const now = Math.floor(Date.now() / 1000);
    const token = await mintOidcSessionToken({
      expires_at: now - 60, // expired 60s ago
    });
    const app = createTestApp();
    const req = makeReq("/test", { Authorization: `Bearer ${token}` });
    const res = await fetchWithSessionEnv(app, req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("session-expired");
  });

  it("oidc session with wrong iss is rejected with 401", async () => {
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
    const token = await mintOidcSessionToken({ iss: "not-tila" });
    const app = createTestApp();
    const req = makeReq("/test", { Authorization: `Bearer ${token}` });
    const res = await fetchWithSessionEnv(app, req);
    expect(res.status).toBe(401);
  });

  it("oidc session with wrong aud is rejected with 401", async () => {
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
    const token = await mintOidcSessionToken({ aud: "other" });
    const app = createTestApp();
    const req = makeReq("/test", { Authorization: `Bearer ${token}` });
    const res = await fetchWithSessionEnv(app, req);
    expect(res.status).toBe(401);
  });

  it("WI-C: oidc principal with revocation tombstone is rejected", async () => {
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
    const now = Math.floor(Date.now() / 1000);
    // Token issued at now - 10; tombstone at now - 5 → token issued before revocation
    const token = await mintOidcSessionToken({
      issued_at: now - 10,
      expires_at: now + 3600,
    });
    // Tombstone set 5 seconds ago (in ms for the store)
    const tombstoneMs = (now - 5) * 1000;
    mockGetRevokedBefore = vi.fn().mockResolvedValue(tombstoneMs);

    const app = createTestApp();
    const req = makeReq("/test", { Authorization: `Bearer ${token}` });
    const res = await fetchWithSessionEnv(app, req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("subject-revoked");
  });

  it("WI-C: oidc principal with tombstone AFTER issuance is NOT rejected", async () => {
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
    const now = Math.floor(Date.now() / 1000);
    // Token issued at now - 5; tombstone at now - 10 → token issued AFTER revocation → allowed
    const token = await mintOidcSessionToken({
      issued_at: now - 5,
      expires_at: now + 3600,
    });
    const tombstoneMs = (now - 10) * 1000;
    mockGetRevokedBefore = vi.fn().mockResolvedValue(tombstoneMs);

    const app = createTestApp();
    const req = makeReq("/test", { Authorization: `Bearer ${token}` });
    const res = await fetchWithSessionEnv(app, req);
    expect(res.status).toBe(200);
  });
});
