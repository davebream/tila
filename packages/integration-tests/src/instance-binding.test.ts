/**
 * Integration round-trip: cross-deployment replay rejection + legacy acceptance.
 *
 * Tests the B2 replay regression: a bearer session JWT minted against deployment A
 * must be rejected with "instance-mismatch" when validated against deployment B,
 * even if both share the same GITHUB_SESSION_HMAC_KEY.
 *
 * Seam choice (documented per plan requirement):
 *   The integration test infrastructure here is plain Node Vitest (vitest.config.ts
 *   uses `environment: "node"`), not @cloudflare/vitest-pool-workers. None of the
 *   existing sibling tests in this package use a real D1 binding either — they
 *   either use tila-sdk/local (embedded SQLite) or import worker source directly.
 *
 *   Given this, the "two deployments" scenario is modeled via option (i) from the
 *   plan: stub `ensureDeploymentInstanceId` to return id A during mint and id B
 *   during validate. This exercises the full middleware validation path using the
 *   real `createAuthMiddleware` code. The mock is the minimal seam that makes the
 *   test deterministic without requiring actual D1 infrastructure.
 *
 *   Alternative option (ii) — overwriting the `_deployment_meta` D1 row — would
 *   require a real D1 binding or a faithful in-memory D1 shim; neither is available
 *   in this test environment. Option (i) is equally valid because the middleware
 *   behaviour under test is the comparison logic itself, not the D1 read path.
 */

import { Hono } from "hono";
import { SignJWT, importJWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
} from "../../worker/src/lib/base64url";
import { _clearCacheForTest } from "../../worker/src/lib/token-cache";
import type { Env, HonoVariables } from "../../worker/src/types";

// --- Stub ensureDeploymentInstanceId so the test controls which instance_id
// the middleware "sees" — simulating two different deployments. ---
const { mockEnsureDeploymentInstanceId } = vi.hoisted(() => ({
  mockEnsureDeploymentInstanceId: vi.fn<() => Promise<string>>(),
}));

vi.mock("../../worker/src/lib/deployment-instance", () => ({
  ensureDeploymentInstanceId: () => mockEnsureDeploymentInstanceId(),
  __resetInstanceCache: vi.fn(),
}));

// Stub analytics so emitInstanceMismatchDatapoint doesn't throw with a null dataset
vi.mock("../../worker/src/lib/analytics", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../worker/src/lib/analytics")>();
  return {
    ...original,
    emitInstanceMismatchDatapoint: vi.fn(),
  };
});

// Stub backend-d1 stores (token + session + rate-limit + revocation)
vi.mock("@tila/backend-d1", () => ({
  D1TokenStore: vi.fn().mockImplementation(
    class {
      validate = vi.fn().mockResolvedValue(null);
      updateLastUsedAt = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  D1SessionStore: vi.fn().mockImplementation(
    class {
      validate = vi.fn().mockResolvedValue(null);
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
      isRevoked = vi.fn().mockResolvedValue(false);
      revoke = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
}));

// Stub session-cache
vi.mock("../../worker/src/lib/session-cache", () => ({
  getSessionFromCache: vi.fn().mockReturnValue(undefined),
  setSessionInCache: vi.fn(),
  invalidateSession: vi.fn(),
}));

// Import after mocks are registered
const { createAuthMiddleware, _resetMiddlewareStateForTest } = await import(
  "../../worker/src/middleware/auth"
);

// --- Test helpers ---

// 32-byte test HMAC key (base64url encoded)
const TEST_HMAC_KEY = btoa("test-hmac-key-this-is-32-bytes!!")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

/**
 * Mint a `tila_s.` bearer token with an optional `instance_id` claim.
 * If `instanceId` is undefined the claim is omitted (simulates a legacy token).
 */
async function mintTestToken(instanceId?: string): Promise<string> {
  const payload: Record<string, unknown> = {
    project_id: "proj-instance-test",
    github_host: "github.com",
    github_repo_id: 12345,
    github_login: "test-user",
    github_user_id: 9999,
    permission: "write",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    issued_at: Math.floor(Date.now() / 1000),
    iss: "tila",
    aud: "tila",
  };
  if (instanceId !== undefined) {
    payload.instance_id = instanceId;
  }

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

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function createTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/*", createAuthMiddleware({ getClientIP: () => null }));
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

const mockWaitUntil = vi.fn((p: Promise<unknown>) => p);

async function fetchWithAuth(token: string): Promise<Response> {
  const app = createTestApp();
  return app.fetch(
    new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    {
      DB: {} as D1Database,
      PROJECT: {} as DurableObjectNamespace,
      ARTIFACTS: {} as R2Bucket,
      ANALYTICS: {} as AnalyticsEngineDataset,
      GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
    },
    {
      waitUntil: mockWaitUntil,
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  _clearCacheForTest();
  _resetMiddlewareStateForTest();
  mockEnsureDeploymentInstanceId.mockReset();
  mockWaitUntil.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Tests ---

describe("instance-id binding: cross-deployment replay rejection + legacy acceptance", () => {
  it("(1) validates a token whose instance_id matches this deployment", async () => {
    // Mint a token bound to deployment A
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
    const token = await mintTestToken("deployment-A");

    // Validate against deployment A — should pass
    const res = await fetchWithAuth(token);
    expect(res.status).toBe(200);
  });

  it("(2) rejects with instance-mismatch when the token's instance_id differs from this deployment (B2 replay regression)", async () => {
    // Token was minted for deployment A, but we're now on deployment B
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-B");
    const token = await mintTestToken("deployment-A");

    const res = await fetchWithAuth(token);
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(body.ok).toBe(false);
    // The middleware emits error.code in a nested envelope (per the refactor commit)
    expect(body.error?.code).toBe("instance-mismatch");
  });

  it("(3) accepts a legacy token with no instance_id claim", async () => {
    // Deployment is on B, but the legacy token has no instance_id claim
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-B");
    const token = await mintTestToken(); // no instance_id

    const res = await fetchWithAuth(token);
    // Legacy tokens (absent claim) are accepted during the transition window
    expect(res.status).toBe(200);
  });

  it("(4) whoami returns instance_id equal to the deployment singleton id", async () => {
    // This is tested fully in packages/worker/src/routes/whoami.test.ts.
    // Here we verify that the field can be asserted in the integration context.
    //
    // We import the whoami handler directly and verify it resolves instance_id.
    // The ensureDeploymentInstanceId mock is already wired above.
    mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-instance-xyz");

    const { whoami } = await import("../../worker/src/routes/whoami");

    const app = new Hono<AppEnv>();
    app.use("*", (c, next) => {
      // Inject a minimal tokenResult so the whoami handler can run
      c.set("tokenResult", {
        kind: "d1-token",
        projectId: "proj-1",
        name: "test-token",
        scopes: "all",
        tokenId: "tok-1",
        // biome-ignore lint/suspicious/noExplicitAny: test stub
      } as any);
      return next();
    });
    app.route("/", whoami);

    const res = await app.fetch(
      new Request("http://localhost/whoami"),
      { DB: {} as D1Database } as unknown as Env,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; instance_id?: string };
    expect(body.instance_id).toBe("deployment-instance-xyz");
  });
});
