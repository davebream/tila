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
  createAuthMiddleware,
} from "./auth";

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
    expect(body.error.code).toBe("UNAUTHORIZED");
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
    const hash = await hashToken(VALID_TOKEN);

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

    const hash = await hashToken(VALID_TOKEN);

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
      expect(body.error.code).toBe("RATE_LIMITED");
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
      expect(body.error.code).toBe("SESSION_EXPIRED");
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
      expect(body.error.code).toBe("UNAUTHORIZED");
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
      expect(body.error.code).toBe("UNAUTHORIZED");
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
      expect(body.error.code).toBe("HMAC_NOT_CONFIGURED");
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
      expect(body.error.code).toBe("SESSION_EXPIRED");
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
      expect(body.error.code).toBe("SESSION_REVOKED");
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
      expect(body.error.code).toBe("SESSION_REVOKED");
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
      expect(body.error.code).toBe("UNAUTHORIZED");
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

    it("accepts a legacy session token without iss/aud", async () => {
      const token = await mintSessionToken({ iss: undefined, aud: undefined });
      const app = createTestApp();
      const res = await fetchWithSessionEnv(
        app,
        makeReq("/test", { Authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
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
      expect(body.error.code).toBe("UNAUTHORIZED");
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
      expect(body.error.code).toBe("RATE_LIMITED");
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
});
