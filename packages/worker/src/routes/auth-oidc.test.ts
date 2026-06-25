/**
 * Tests for POST /api/auth/oidc/exchange
 *
 * Uses mocked verifyOidcJwt, resolveJwksUri, OidcPrincipalsStore,
 * a D1 stub for project config lookup, and an ANALYTICS stub.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode } from "../lib/base64url";
import type { Env, HonoVariables } from "../types";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

// Mock oidc-verify
const mockVerifyOidcJwt = vi.fn();

vi.mock("../lib/oidc-verify", () => {
  class OidcVerificationError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "OidcVerificationError";
    }
  }
  return {
    verifyOidcJwt: (...args: unknown[]) => mockVerifyOidcJwt(...args),
    OidcVerificationError,
  };
});

// Mock oidc-discovery
const mockResolveJwksUri = vi.fn();

vi.mock("../lib/oidc-discovery", () => {
  class OidcDiscoveryError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "OidcDiscoveryError";
    }
  }
  return {
    resolveJwksUri: (...args: unknown[]) => mockResolveJwksUri(...args),
    OidcDiscoveryError,
  };
});

// Mock backend-d1
const mockRateLimitCheck = vi.fn().mockResolvedValue(false);
const mockRateLimitRecordFailure = vi.fn().mockResolvedValue(undefined);
const mockIdempotencyCheck = vi.fn().mockResolvedValue(null);
const mockIdempotencyStoreMethod = vi.fn().mockResolvedValue(undefined);
const mockIsAllowed = vi.fn();

vi.mock("@tila/backend-d1", () => ({
  D1RateLimitStore: vi.fn().mockImplementation(
    class {
      check = mockRateLimitCheck;
      recordFailure = mockRateLimitRecordFailure;
    } as unknown as () => unknown,
  ),
  D1IdempotencyStore: vi.fn().mockImplementation(
    class {
      check = mockIdempotencyCheck;
      store = mockIdempotencyStoreMethod;
    } as unknown as () => unknown,
  ),
  OidcPrincipalsStore: vi.fn().mockImplementation(
    class {
      isAllowed = mockIsAllowed;
    } as unknown as () => unknown,
  ),
  // Provide stubs for anything else imported by auth-github (it's shared)
  D1TokenStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  D1SessionStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  RepoAllowlistStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  GitHubAppConfigStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  D1DeploymentMetaStore: vi.fn().mockImplementation(
    class {
      ensure = vi.fn().mockResolvedValue("test-instance-id");
      get = vi.fn().mockResolvedValue("test-instance-id");
    } as unknown as () => unknown,
  ),
  D1RevokedJtiStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  D1RevokedSubjectsStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  AdminGrantsStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  D1ProjectRegistry: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  canonicalizePrincipal: vi.fn(),
}));

// Mock deployment-instance
vi.mock("../lib/deployment-instance", () => ({
  ensureDeploymentInstanceId: vi.fn().mockResolvedValue("test-instance-id"),
  __resetInstanceCache: vi.fn(),
}));

// Mock github-related libs (auth-github re-exports may transitively import them)
vi.mock("../lib/github-client", () => ({
  getAuthenticatedUser: vi.fn(),
  getRepoPermission: vi.fn(),
  exchangeOAuthCode: vi.fn(),
}));
vi.mock("../lib/github-app", () => ({
  mintAppJwt: vi.fn(),
  getInstallationAccessToken: vi.fn(),
  checkUserMembership: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const { authOidc } = await import("./auth-oidc");
import { OidcDiscoveryError } from "../lib/oidc-discovery";
import { OidcVerificationError } from "../lib/oidc-verify";

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/** Minimum HMAC key: 32 bytes, base64url-encoded. */
const TEST_HMAC_KEY = base64UrlEncode(
  new TextEncoder().encode("test-hmac-key-this-is-32-bytes!!"),
);

const TEST_PROJECT_ID = "proj-test-123";
const TEST_ISSUER = "https://idp.example.com";
const TEST_AUDIENCE = "tila-test-audience";
const TEST_JWKS_URI = "https://idp.example.com/.well-known/jwks.json";
const TEST_SUBJECT = "sub:user@example.com";

/**
 * Build a D1 stub that returns a specific project row when queried.
 * Uses the `.prepare().bind().first()` call pattern used by the route's
 * raw D1 lookup.
 */
function makeD1Stub(
  projectRow: {
    oidc_issuer: string | null;
    oidc_audience: string | null;
  } | null,
  throws = false,
): D1Database {
  const firstFn = throws
    ? vi.fn().mockRejectedValue(new Error("D1 error"))
    : vi.fn().mockResolvedValue(projectRow);

  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: firstFn,
      }),
    }),
    exec: vi.fn(),
    dump: vi.fn(),
    batch: vi.fn(),
  } as unknown as D1Database;
}

function makeAnalyticsStub() {
  return {
    writeDataPoint: vi.fn(),
  } as unknown as AnalyticsEngineDataset;
}

function makeEnv(
  overrides: Partial<Env & { analyticsStub?: AnalyticsEngineDataset }> = {},
): Env {
  const analyticsStub = overrides.analyticsStub ?? makeAnalyticsStub();
  return {
    GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
    DB:
      overrides.DB ??
      makeD1Stub({ oidc_issuer: TEST_ISSUER, oidc_audience: TEST_AUDIENCE }),
    PROJECT: {} as DurableObjectNamespace,
    ARTIFACTS: {} as R2Bucket,
    ANALYTICS: analyticsStub,
    ...overrides,
  } as unknown as Env;
}

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route("/api/auth/oidc", authOidc);
  return app;
}

/** A valid-looking JWT payload for a generic OIDC token. */
function makeOidcPayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    sub: TEST_SUBJECT,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    ...overrides,
  };
}

function makeRequestBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    project_id: TEST_PROJECT_ID,
    oidc_token: "fake.oidc.token",
    ...overrides,
  };
}

function post(
  app: Hono<AppEnv>,
  env: Env,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
) {
  return app.request(
    "/api/auth/oidc/exchange",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "1.2.3.4", // needed for rate limit tracking
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /api/auth/oidc/exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue(false);
    mockIdempotencyCheck.mockResolvedValue(null);
    mockResolveJwksUri.mockResolvedValue(TEST_JWKS_URI);
    mockIsAllowed.mockResolvedValue({
      project_id: TEST_PROJECT_ID,
      issuer: TEST_ISSUER,
      subject: TEST_SUBJECT,
      permission: "read",
      enabled: 1,
      created_at: 1000000,
      created_by: "admin",
    });
    mockVerifyOidcJwt.mockResolvedValue({
      header: { alg: "RS256", kid: "key1" },
      payload: makeOidcPayload(),
    });
  });

  // (a) Happy path
  it("(a) happy path: returns 200 with OidcExchangeResponseSchema-shaped body and tila_s. token", async () => {
    const app = makeApp();
    const res = await post(app, makeEnv(), makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.session_token).toBe("string");
    expect((body.session_token as string).startsWith("tila_s.")).toBe(true);
    expect(body.oidc_issuer).toBe(TEST_ISSUER);
    expect(body.oidc_subject).toBe(TEST_SUBJECT);
    expect(body.project_id).toBe(TEST_PROJECT_ID);
    expect(body.permission).toBe("read");
    expect(typeof body.expires_at).toBe("number");
  });

  // (a2) instance_id binding — minted oidc-session token must carry instance_id (WI-E B2 replay protection)
  it("(a2) minted session JWT payload carries instance_id equal to resolved deployment id", async () => {
    const app = makeApp();
    const res = await post(app, makeEnv(), makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(typeof body.session_token).toBe("string");

    // Decode the JWT payload (tila_s.<header>.<payload>.<sig> — parts[2] is payload)
    const token = body.session_token as string;
    // Strip the "tila_s." prefix to get the raw JWT
    const rawJwt = token.replace(/^tila_s\./, "");
    const parts = rawJwt.split(".");
    expect(parts.length).toBe(3);
    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const jwtPayload = JSON.parse(payloadJson) as Record<string, unknown>;

    // instance_id must be present and equal to the mock-resolved deployment id
    expect(jwtPayload.instance_id).toBe("test-instance-id");
  });

  // (b) Project has null oidc_issuer/oidc_audience → 404 oidc-not-configured
  it("(b) returns 404 oidc-not-configured when project has null oidc_issuer", async () => {
    const app = makeApp();
    const env = makeEnv({
      DB: makeD1Stub({ oidc_issuer: null, oidc_audience: TEST_AUDIENCE }),
    });
    const res = await post(app, env, makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect((body.error as Record<string, unknown>).code).toBe(
      "oidc-not-configured",
    );
    expect(mockVerifyOidcJwt).not.toHaveBeenCalled();
  });

  it("(b) returns 404 oidc-not-configured when project has null oidc_audience", async () => {
    const app = makeApp();
    const env = makeEnv({
      DB: makeD1Stub({ oidc_issuer: TEST_ISSUER, oidc_audience: null }),
    });
    const res = await post(app, env, makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect((body.error as Record<string, unknown>).code).toBe(
      "oidc-not-configured",
    );
  });

  // (b2) Non-existent project → also 404 oidc-not-configured (security A-5)
  it("(b2) returns 404 oidc-not-configured for non-existent project (security A-5)", async () => {
    const app = makeApp();
    const env = makeEnv({
      DB: makeD1Stub(null), // row doesn't exist
    });
    const res = await post(app, env, makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect((body.error as Record<string, unknown>).code).toBe(
      "oidc-not-configured",
    );
    expect(mockVerifyOidcJwt).not.toHaveBeenCalled();
  });

  // (c) resolveJwksUri throws → 502 issuer-discovery-failed + analytics + recordExchangeFailure
  it("(c) returns 502 issuer-discovery-failed when resolveJwksUri throws", async () => {
    const analytics = makeAnalyticsStub();
    const app = makeApp();
    const env = makeEnv({ analyticsStub: analytics });

    mockResolveJwksUri.mockRejectedValue(
      new OidcDiscoveryError("discovery-unreachable", "unreachable"),
    );

    const res = await post(app, env, makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect((body.error as Record<string, unknown>).code).toBe(
      "issuer-discovery-failed",
    );
    // issuer-rejected analytics datapoint should be emitted with correct blobs
    expect(analytics.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining(["issuer_rejected"]),
      }),
    );
    // recordExchangeFailure should have been called (rate limit store)
    expect(mockRateLimitRecordFailure).toHaveBeenCalled();
  });

  // (d) verifyOidcJwt throws non-JWKS error → 401 + issuer-rejected analytics
  it("(d) returns 401 for oidc-invalid-issuer + emits issuer-rejected analytics", async () => {
    const analytics = makeAnalyticsStub();
    const app = makeApp();
    const env = makeEnv({ analyticsStub: analytics });

    mockVerifyOidcJwt.mockRejectedValue(
      new OidcVerificationError("oidc-invalid-issuer", "bad issuer"),
    );

    const res = await post(app, env, makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(401);
    // issuer-rejected analytics must carry the correct blob
    expect(analytics.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining(["issuer_rejected"]),
      }),
    );
    expect(mockRateLimitRecordFailure).toHaveBeenCalled();
    void body;
  });

  it("(d) returns 401 for oidc-signature-invalid", async () => {
    const app = makeApp();
    mockVerifyOidcJwt.mockRejectedValue(
      new OidcVerificationError("oidc-signature-invalid", "bad sig"),
    );
    const res = await post(app, makeEnv(), makeRequestBody());
    expect(res.status).toBe(401);
  });

  // (e) oidc-jwks-unavailable → 502 + issuer-rejected analytics with jwks-empty sub-label (security A-1)
  it("(e) returns 502 for oidc-jwks-unavailable + emits issuer-rejected analytics with jwks-empty sub-label (A-1)", async () => {
    const analytics = makeAnalyticsStub();
    const app = makeApp();
    const env = makeEnv({ analyticsStub: analytics });

    mockVerifyOidcJwt.mockRejectedValue(
      new OidcVerificationError(
        "oidc-jwks-unavailable",
        "JWKS endpoint unavailable",
      ),
    );

    const res = await post(app, env, makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    // Should be retryable
    expect((body.error as Record<string, unknown>).retryable).toBe(true);
    // Analytics should be emitted with jwks-empty sub-label
    expect(analytics.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining(["jwks-empty"]),
      }),
    );
  });

  // (f) Verified token but isAllowed returns null → 403 principal-not-allowed + analytics
  it("(f) returns 403 principal-not-allowed when isAllowed returns null", async () => {
    const analytics = makeAnalyticsStub();
    const app = makeApp();
    const env = makeEnv({ analyticsStub: analytics });

    mockIsAllowed.mockResolvedValue(null);

    const res = await post(app, env, makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(403);
    expect((body.error as Record<string, unknown>).code).toBe(
      "principal-not-allowed",
    );
    // principal-not-allowed analytics must carry the correct blob
    expect(analytics.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining(["principal_not_allowed"]),
      }),
    );
    // recordExchangeFailure
    expect(mockRateLimitRecordFailure).toHaveBeenCalled();
  });

  // (g) payload.sub missing/empty → 401
  it("(g) returns 401 when payload.sub is missing", async () => {
    const app = makeApp();
    mockVerifyOidcJwt.mockResolvedValue({
      header: { alg: "RS256" },
      payload: { ...makeOidcPayload(), sub: undefined },
    });
    const res = await post(app, makeEnv(), makeRequestBody());
    expect(res.status).toBe(401);
  });

  it("(g) returns 401 when payload.sub is empty string", async () => {
    const app = makeApp();
    mockVerifyOidcJwt.mockResolvedValue({
      header: { alg: "RS256" },
      payload: { ...makeOidcPayload(), sub: "" },
    });
    const res = await post(app, makeEnv(), makeRequestBody());
    expect(res.status).toBe(401);
  });

  it("(g) returns 401 when payload.sub exceeds 255 chars", async () => {
    const app = makeApp();
    mockVerifyOidcJwt.mockResolvedValue({
      header: { alg: "RS256" },
      payload: { ...makeOidcPayload(), sub: "x".repeat(256) },
    });
    const res = await post(app, makeEnv(), makeRequestBody());
    expect(res.status).toBe(401);
  });

  // (g2) Token lacking both jti and numeric iat → 401 oidc-invalid-token (security R-3)
  it("(g2) returns 401 oidc-invalid-token when payload lacks both jti and numeric iat (security R-3)", async () => {
    const app = makeApp();
    mockVerifyOidcJwt.mockResolvedValue({
      header: { alg: "RS256" },
      payload: {
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        sub: TEST_SUBJECT,
        exp: Math.floor(Date.now() / 1000) + 3600,
        // No jti, no iat
      },
    });
    const res = await post(app, makeEnv(), makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(401);
    expect((body.error as Record<string, unknown>).code).toBe(
      "oidc-invalid-token",
    );
  });

  it("(g2) accepts a token with numeric iat but no jti (R-3: iat is sufficient)", async () => {
    const app = makeApp();
    mockVerifyOidcJwt.mockResolvedValue({
      header: { alg: "RS256" },
      payload: {
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        sub: TEST_SUBJECT,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        // No jti
      },
    });
    const res = await post(app, makeEnv(), makeRequestBody());
    expect(res.status).toBe(200);
  });

  // (h) Idempotent replay returns cached body
  it("(h) returns cached body on idempotent replay", async () => {
    const app = makeApp();
    const cachedResponse = {
      ok: true,
      session_token: "tila_s.cached.token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      project_id: TEST_PROJECT_ID,
      oidc_issuer: TEST_ISSUER,
      oidc_subject: TEST_SUBJECT,
      permission: "read",
    };
    mockIdempotencyCheck.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify(cachedResponse),
      requestHash: null,
    });

    const res = await post(app, makeEnv(), makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.session_token).toBe("tila_s.cached.token");
    // isAllowed should NOT be called (we short-circuit after idempotency hit)
    expect(mockIsAllowed).not.toHaveBeenCalled();
  });

  // (i) permission from garbage value defaults to read
  it("(i) defaults permission to read when allowlist row has invalid permission value", async () => {
    const app = makeApp();
    mockIsAllowed.mockResolvedValue({
      project_id: TEST_PROJECT_ID,
      issuer: TEST_ISSUER,
      subject: TEST_SUBJECT,
      permission: "super-admin-extreme", // garbage value
      enabled: 1,
      created_at: 1000000,
      created_by: "admin",
    });

    const res = await post(app, makeEnv(), makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.permission).toBe("read");
  });

  // (j) D1 project lookup throws → fail-closed 502 (security item 7)
  it("(j) returns 502 and does not mint when D1 project lookup throws (security item 7)", async () => {
    const app = makeApp();
    const env = makeEnv({
      DB: makeD1Stub(null, true), // throws
    });

    const res = await post(app, env, makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    // verify was never called (we never got past the project lookup)
    expect(mockVerifyOidcJwt).not.toHaveBeenCalled();
    // no session token minted
    expect(body.ok).toBe(false);
  });

  // Validation errors
  it("returns 400 on invalid JSON body", async () => {
    const app = makeApp();
    const res = await app.request(
      "/api/auth/oidc/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on missing required fields", async () => {
    const app = makeApp();
    const res = await post(app, makeEnv(), { project_id: TEST_PROJECT_ID }); // missing oidc_token
    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited", async () => {
    const app = makeApp();
    mockRateLimitCheck.mockResolvedValue(true);
    const res = await post(app, makeEnv(), makeRequestBody());
    expect(res.status).toBe(429);
  });

  it("returns 500 when GITHUB_SESSION_HMAC_KEY is not configured", async () => {
    const app = makeApp();
    const env = makeEnv({ GITHUB_SESSION_HMAC_KEY: undefined });
    const res = await post(app, env, makeRequestBody());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(500);
    expect((body.error as Record<string, unknown>).code).toBe(
      "hmac-not-configured",
    );
  });
});
