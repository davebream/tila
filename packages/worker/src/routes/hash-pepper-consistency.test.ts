/**
 * SEC-1 — HASH_PEPPER consistency across mint↔lookup pairs.
 *
 * `hashToken(raw, pepper?)` is keyed HMAC-SHA-256 when a pepper is supplied,
 * else bare SHA-256. If a credential is MINTED with one peppering and LOOKED UP
 * with the other, validation can never match. These tests assert mint and lookup
 * compute an identical digest for the same raw secret, with HASH_PEPPER both set
 * and unset, plus a negative test proving the pair is coupled.
 *
 * Strategy: drive the real route handlers (no mock of `hashToken`) through mocked
 * D1 stores. The mint route stores a `tokenHash`/`sessionHash` via the store; we
 * capture that value, then feed the SAME raw secret to each lookup route and
 * assert the lookup-side store receives the identical hash. Identical hash ⇒
 * `D1*Store.validate(hash)` would resolve the row ⇒ the credential validates.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "../middleware/auth";
import type { Env, HonoVariables } from "../types";

// --- Mock @tila/backend-d1: capture hashes at the store boundary ---------------

// D1TokenStore.issue receives { tokenHash } at mint (tokens.ts).
// D1TokenStore.validate receives the hash at lookup (auth.ts, auth-github app-config, auth-session exchange).
const mockTokenIssue = vi.fn().mockResolvedValue({ tokenId: "tok-id-1" });
const mockTokenValidate = vi.fn();
const mockTokenUpdateLastUsedAt = vi.fn().mockResolvedValue(undefined);

// D1SessionStore.create receives { sessionHash } at mint (auth-session exchange).
// D1SessionStore.validate receives the hash at lookup (auth.ts cookie path).
const mockSessionCreate = vi.fn().mockResolvedValue(undefined);
const mockSessionValidate = vi.fn();

const mockRateLimitCheck = vi.fn().mockResolvedValue(false);
const mockRateLimitRecordFailure = vi.fn().mockResolvedValue(undefined);

vi.mock("@tila/backend-d1", () => ({
  D1TokenStore: vi.fn().mockImplementation(
    class {
      issue = mockTokenIssue;
      validate = mockTokenValidate;
      updateLastUsedAt = mockTokenUpdateLastUsedAt;
    } as unknown as () => unknown,
  ),
  D1SessionStore: vi.fn().mockImplementation(
    class {
      create = mockSessionCreate;
      validate = mockSessionValidate;
    } as unknown as () => unknown,
  ),
  D1RateLimitStore: vi.fn().mockImplementation(
    class {
      check = mockRateLimitCheck;
      recordFailure = mockRateLimitRecordFailure;
    } as unknown as () => unknown,
  ),
  D1RevokedJtiStore: vi.fn().mockImplementation(
    class {
      isRevoked = vi.fn().mockResolvedValue(false);
      revoke = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
}));

// session-cache must not short-circuit the cookie lookup path
vi.mock("../lib/session-cache", () => ({
  getSessionFromCache: vi.fn().mockReturnValue(undefined),
  setSessionInCache: vi.fn(),
  invalidateSession: vi.fn(),
}));

// token-cache must not short-circuit the D1-token lookup path
vi.mock("../lib/token-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/token-cache")>();
  return { ...actual };
});

const { tokens } = await import("./tokens");
const { authSessionExchange } = await import("./auth-session");
const { _clearCacheForTest } = await import("../lib/token-cache");
const { _resetMiddlewareStateForTest } = await import("../middleware/auth");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function baseEnv(pepper?: string): Env {
  return {
    DB: {} as D1Database,
    PROJECT: {} as DurableObjectNamespace,
    ARTIFACTS: {} as R2Bucket,
    ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
    ...(pepper ? { HASH_PEPPER: pepper } : {}),
  } as Env;
}

const mockCtx = {
  waitUntil: vi.fn((p: Promise<unknown>) => p),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// --- App builders --------------------------------------------------------------

/** D1-token mint: POST /api/tokens (auth middleware pre-set with a full-scope d1-token). */
function makeTokenMintApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", {
      kind: "d1-token" as const,
      projectId: "proj-1",
      name: "admin-token",
      scopes: "full",
      tokenId: "admin-id",
    });
    await next();
  });
  app.route("/api/tokens", tokens);
  return app;
}

/** D1-token lookup via the auth middleware (auth.ts:614). */
function makeBearerLookupApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/*", createAuthMiddleware());
  app.get("/protected", (c) => c.json({ ok: true }));
  return app;
}

/** Session-cookie mint: POST /auth/session (auth-session.ts:149). */
function makeSessionMintApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route("/auth/session", authSessionExchange);
  return app;
}

/** Cookie-session lookup via the auth middleware (auth.ts:302). */
function makeCookieLookupApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/*", createAuthMiddleware());
  app.get("/protected", (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearCacheForTest();
  _resetMiddlewareStateForTest();
  mockTokenIssue.mockResolvedValue({ tokenId: "tok-id-1" });
  mockTokenUpdateLastUsedAt.mockResolvedValue(undefined);
  mockSessionCreate.mockResolvedValue(undefined);
  mockRateLimitCheck.mockResolvedValue(false);
  mockSessionValidate.mockReset();
  mockTokenValidate.mockReset();
});

// Run a full mint→lookup cycle and return whether the lookup-side store received
// the exact same hash the mint side stored.
async function mintD1Token(env: Env): Promise<string> {
  const app = makeTokenMintApp();
  const res = await app.request(
    "/api/tokens",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ci-token" }),
    },
    env,
    mockCtx,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { ok: boolean; token: string };
  expect(body.ok).toBe(true);
  // The plaintext returned to the caller — what a real client would present.
  return body.token;
}

function storedTokenHash(): string {
  expect(mockTokenIssue).toHaveBeenCalledTimes(1);
  return mockTokenIssue.mock.calls[0][0].tokenHash as string;
}

// Run the bearer lookup with a raw token; capture the hash the lookup computed.
async function bearerLookupHash(env: Env, rawToken: string): Promise<string> {
  // validate resolves a row → 200; capture the hash it was called with.
  mockTokenValidate.mockResolvedValue({
    projectId: "proj-1",
    name: "ci-token",
    scopes: "full",
    tokenId: "tok-id-1",
  });
  const app = makeBearerLookupApp();
  const res = await app.request(
    "/protected",
    { headers: { Authorization: `Bearer ${rawToken}` } },
    env,
    mockCtx,
  );
  expect(res.status).toBe(200);
  expect(mockTokenValidate).toHaveBeenCalled();
  return mockTokenValidate.mock.calls[0][0] as string;
}

async function mintSession(env: Env): Promise<string> {
  // Token validation inside the exchange must pass so a session is created.
  mockTokenValidate.mockResolvedValue({
    projectId: "proj-1",
    name: "ci-token",
    scopes: "full",
    tokenId: "tok-id-1",
  });
  const app = makeSessionMintApp();
  const res = await app.request(
    "/auth/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "tila_raw_token", project_id: "proj-1" }),
    },
    env,
    mockCtx,
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const m = setCookie.match(/tila_session=([^;]+)/);
  expect(m).not.toBeNull();
  return decodeURIComponent((m as RegExpMatchArray)[1]);
}

function storedSessionHash(): string {
  expect(mockSessionCreate).toHaveBeenCalledTimes(1);
  return mockSessionCreate.mock.calls[0][0].sessionHash as string;
}

async function cookieLookupHash(env: Env, rawCookie: string): Promise<string> {
  mockSessionValidate.mockResolvedValue({
    projectId: "proj-1",
    tokenHash: "tok-hash",
    name: "ci-token",
    scopes: "full",
    expiresAt: Date.now() + 3_600_000,
  });
  const app = makeCookieLookupApp();
  const res = await app.request(
    "/protected",
    { headers: { Cookie: `tila_session=${rawCookie}` } },
    env,
    mockCtx,
  );
  expect(res.status).toBe(200);
  expect(mockSessionValidate).toHaveBeenCalled();
  return mockSessionValidate.mock.calls[0][0] as string;
}

describe("SEC-1: D1 token mint↔lookup hash consistency", () => {
  for (const pepper of [undefined, "operator-pepper-secret"] as const) {
    const label = pepper ? "HASH_PEPPER set" : "HASH_PEPPER unset";

    it(`mint (tokens.ts) and bearer lookup (auth.ts) agree — ${label}`, async () => {
      const env = baseEnv(pepper);
      const raw = await mintD1Token(env);
      const mintHash = storedTokenHash();

      vi.clearAllMocks();
      const lookupHash = await bearerLookupHash(env, raw);

      expect(lookupHash).toBe(mintHash);
    });

    it(`mint (tokens.ts) and app-config lookup (auth-github.ts) agree — ${label}`, async () => {
      const env = baseEnv(pepper);
      const raw = await mintD1Token(env);
      const mintHash = storedTokenHash();

      vi.clearAllMocks();
      // app-config validates the bearer directly against D1TokenStore.validate.
      mockTokenValidate.mockResolvedValue({
        projectId: "proj-1",
        name: "ci-token",
        scopes: "full",
        tokenId: "tok-id-1",
      });
      const { authGithub } = await import("./auth-github");
      const app = new Hono<AppEnv>();
      app.route("/api/auth/github", authGithub);
      const res = await app.request(
        "/api/auth/github/app-config",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            project_id: "proj-1",
            installation_id: "123",
          }),
        },
        env,
        mockCtx,
      );
      // 200 (validated) — regardless, validate was called with a hash.
      expect(mockTokenValidate).toHaveBeenCalled();
      const lookupHash = mockTokenValidate.mock.calls[0][0] as string;
      expect(lookupHash).toBe(mintHash);
      void res;
    });

    it(`mint (tokens.ts) and session-exchange lookup (auth-session.ts) agree — ${label}`, async () => {
      const env = baseEnv(pepper);
      const raw = await mintD1Token(env);
      const mintHash = storedTokenHash();

      vi.clearAllMocks();
      // The session-exchange endpoint validates the presented token against D1.
      mockTokenValidate.mockResolvedValue({
        projectId: "proj-1",
        name: "ci-token",
        scopes: "full",
        tokenId: "tok-id-1",
      });
      const app = makeSessionMintApp();
      const res = await app.request(
        "/auth/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: raw, project_id: "proj-1" }),
        },
        env,
        mockCtx,
      );
      expect(res.status).toBe(200);
      expect(mockTokenValidate).toHaveBeenCalled();
      const lookupHash = mockTokenValidate.mock.calls[0][0] as string;
      expect(lookupHash).toBe(mintHash);
    });
  }
});

describe("SEC-1: session cookie mint↔lookup hash consistency", () => {
  for (const pepper of [undefined, "operator-pepper-secret"] as const) {
    const label = pepper ? "HASH_PEPPER set" : "HASH_PEPPER unset";

    it(`mint (auth-session.ts) and cookie lookup (auth.ts) agree — ${label}`, async () => {
      const env = baseEnv(pepper);
      const cookie = await mintSession(env);
      const mintHash = storedSessionHash();

      vi.clearAllMocks();
      const lookupHash = await cookieLookupHash(env, cookie);

      expect(lookupHash).toBe(mintHash);
    });
  }
});

describe("SEC-1: negative — enabling HASH_PEPPER must break a token minted while unset", () => {
  it("D1 token minted with pepper UNSET fails lookup once pepper is SET (mint/lookup coupled)", async () => {
    const unsetEnv = baseEnv(undefined);
    const raw = await mintD1Token(unsetEnv);
    const bareMintHash = storedTokenHash();

    vi.clearAllMocks();
    const setEnv = baseEnv("operator-pepper-secret");
    const pepperedLookupHash = await bearerLookupHash(setEnv, raw);

    // The peppered lookup computes a DIFFERENT digest than the bare-minted one,
    // so D1TokenStore.validate(pepperedHash) would miss the bare-stored row.
    expect(pepperedLookupHash).not.toBe(bareMintHash);
  });

  it("session minted with pepper UNSET fails cookie lookup once pepper is SET", async () => {
    const unsetEnv = baseEnv(undefined);
    const cookie = await mintSession(unsetEnv);
    const bareMintHash = storedSessionHash();

    vi.clearAllMocks();
    const setEnv = baseEnv("operator-pepper-secret");
    const pepperedLookupHash = await cookieLookupHash(setEnv, cookie);

    expect(pepperedLookupHash).not.toBe(bareMintHash);
  });
});
