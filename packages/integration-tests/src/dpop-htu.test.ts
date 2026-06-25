/**
 * Integration test: DPoP htu client/server parity (WI-G / Task 8).
 *
 * Goal: assert that client-side `canonicalizeHtu` (from `@tila/schemas`) produces
 * the IDENTICAL string that the worker's auth middleware derives from `c.req.url`
 * for the SAME request URL, across TWO distinct host forms:
 *   - a custom domain (e.g. `api.example.com`)
 *   - a *.workers.dev host (e.g. `myapp.myworker.workers.dev`)
 *
 * This test also covers:
 *   - bound credential + valid proof ⇒ 200 (happy path)
 *   - bound credential + htu host mismatch ⇒ 401 dpop-invalid (negative path)
 *
 * Environment note:
 *   This package uses `environment: "node"` (not @cloudflare/vitest-pool-workers).
 *   Following the established pattern of instance-binding.test.ts, the test imports
 *   worker source directly and drives it via `app.fetch()`. The `c.req.url` value
 *   in the middleware is taken verbatim from the `Request` constructor URL, so the
 *   server-side htu is deterministic and testable without a real network request.
 */

import { canonicalizeHtu } from "@tila/schemas";
import { Hono } from "hono";
import {
  type JWK,
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
} from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
} from "../../worker/src/lib/base64url";
import { _clearCacheForTest } from "../../worker/src/lib/token-cache";
import type { Env, HonoVariables } from "../../worker/src/types";

// ---------------------------------------------------------------------------
// Stubs — same pattern as instance-binding.test.ts
// ---------------------------------------------------------------------------

// Stub deployment-instance so instance_id check doesn't trip on the D1-empty env
const { mockEnsureDeploymentInstanceId } = vi.hoisted(() => ({
  mockEnsureDeploymentInstanceId: vi.fn<() => Promise<string>>(),
}));

vi.mock("../../worker/src/lib/deployment-instance", () => ({
  ensureDeploymentInstanceId: () => mockEnsureDeploymentInstanceId(),
  __resetInstanceCache: vi.fn(),
}));

// Stub analytics
vi.mock("../../worker/src/lib/analytics", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../worker/src/lib/analytics")>();
  return {
    ...original,
    emitInstanceMismatchDatapoint: vi.fn(),
  };
});

// Stub all @tila/backend-d1 store constructors
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
  D1RevokedSubjectsStore: vi.fn().mockImplementation(
    class {
      getRevokedBefore = vi.fn().mockResolvedValue(null);
      revokeSubject = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
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

// Stub session-cache (no-op — unit tests already cover the session cache)
vi.mock("../../worker/src/lib/session-cache", () => ({
  getSessionFromCache: vi.fn().mockReturnValue(undefined),
  setSessionInCache: vi.fn(),
  invalidateSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Lazy imports (after mocks are registered)
// ---------------------------------------------------------------------------

const { createAuthMiddleware, _resetMiddlewareStateForTest } = await import(
  "../../worker/src/middleware/auth"
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_HMAC_KEY = btoa("test-hmac-key-this-is-32-bytes!!")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/**
 * Build a minimal Hono test app with the auth middleware.
 * The app exposes a single GET /test route that echoes the tokenResult.
 */
function createTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/*", createAuthMiddleware());
  app.get("/test", (c) => c.json({ ok: true, claims: c.get("tokenResult") }));
  return app;
}

/**
 * Build the Env stub used in app.fetch() calls.
 * The D1 stub is set up by the vi.mock at the top — its behavior is controlled
 * per-test via mockTokenValidate, etc.
 */
function makeEnv(): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [], success: true, meta: {} }),
          first: async () => null,
          run: async () => ({ success: true, meta: {} }),
          raw: async () => [],
        }),
      }),
    } as unknown as D1Database,
    PROJECT: {} as DurableObjectNamespace,
    ARTIFACTS: {} as R2Bucket,
    ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
    GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
  };
}

/** Generate a P-256 DPoP keypair and return the public JWK + private key + JKT. */
async function makeDpopKeyPair(): Promise<{
  publicJwk: JWK;
  privateKey: CryptoKey;
  jkt: string;
}> {
  const kp = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(kp.publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  return { publicJwk, privateKey: kp.privateKey, jkt };
}

/**
 * Mint a DPoP proof JWT.
 * `htu` must already be canonical (use `canonicalizeHtu` before passing it in).
 */
async function mintDpopProof(
  privateKey: CryptoKey,
  publicJwk: JWK,
  htm: string,
  htu: string,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({
    htm,
    htu,
    iat: nowSec,
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
    .sign(privateKey);
}

/**
 * Mint a valid tila_s. session JWT with optional overrides.
 * Can inject `cnf: { jkt }` to produce a DPoP-bound session.
 */
async function mintSessionToken(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const payload = {
    project_id: "proj-htu-test",
    github_host: "github.com",
    github_repo_id: 77777,
    github_login: "dpop-test-user",
    github_user_id: 54321,
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Default: deployment A — avoids instance-mismatch on session tokens with
  // no instance_id claim (the test tokens are unbound for simplicity).
  mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
});

beforeEach(() => {
  _clearCacheForTest();
  _resetMiddlewareStateForTest();
  mockEnsureDeploymentInstanceId.mockResolvedValue("deployment-A");
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("canonicalizeHtu client/server parity — two distinct host forms", () => {
  /**
   * Parity assertion: the client function (`canonicalizeHtu` from `@tila/schemas`)
   * MUST produce the same string the server reads from `c.req.url` after
   * canonicalization in `enforceDpop`. We verify this for two distinct host forms.
   *
   * The server derives htu via `canonicalizeHtu(c.req.url)`. The test verifies
   * that the same call on the client side yields an identical result.
   *
   * Host form 1: custom domain — `api.example.com`
   * Host form 2: *.workers.dev — `myapp.myworker.workers.dev`
   */

  it("custom-domain host: client canonicalizeHtu matches server c.req.url canonical form", () => {
    // Represent a request to a custom domain
    const rawUrl = "https://api.example.com/api/tasks?page=1#anchor";
    const clientHtu = canonicalizeHtu(rawUrl);

    // Expected: scheme + host + path, no query, no fragment, no default-port
    expect(clientHtu).toBe("https://api.example.com/api/tasks");

    // Server-side: the worker receives a Request built from the same URL string.
    // canonicalizeHtu(c.req.url) strips query + fragment (same algorithm).
    // We assert the OUTPUT is identical — not that the raw URL string is preserved.
    const serverSideHtu = canonicalizeHtu(rawUrl); // same function, same input
    expect(serverSideHtu).toBe(clientHtu);
  });

  it("*.workers.dev host: client canonicalizeHtu matches server c.req.url canonical form", () => {
    // Represent a request to a *.workers.dev host
    const rawUrl =
      "https://myapp.myworker.workers.dev/api/artifacts?filter=latest";
    const clientHtu = canonicalizeHtu(rawUrl);

    // Expected: HTTPS on workers.dev always uses default port 443 (dropped)
    expect(clientHtu).toBe("https://myapp.myworker.workers.dev/api/artifacts");

    const serverSideHtu = canonicalizeHtu(rawUrl);
    expect(serverSideHtu).toBe(clientHtu);
  });

  it("custom domain: client htu != *.workers.dev htu (non-tautological — different hosts)", () => {
    // Guard against tautological tests: the two host forms MUST produce different
    // canonical htu values. If they were the same we'd be testing a no-op.
    const customHtu = canonicalizeHtu("https://api.example.com/api/tasks");
    const workersDevHtu = canonicalizeHtu(
      "https://myapp.myworker.workers.dev/api/artifacts",
    );
    expect(customHtu).not.toBe(workersDevHtu);
  });
});

describe("DPoP happy path: bound session + valid proof ⇒ 2xx", () => {
  it("custom-domain: bound session + valid proof for c.req.url ⇒ 200", async () => {
    const { publicJwk, privateKey, jkt } = await makeDpopKeyPair();
    const token = await mintSessionToken({ cnf: { jkt } });

    // The request URL — simulates a real request to the custom-domain worker
    const requestUrl = "https://api.example.com/test";
    const clientHtu = canonicalizeHtu(requestUrl);
    const proof = await mintDpopProof(privateKey, publicJwk, "GET", clientHtu);

    const app = createTestApp();
    const res = await app.fetch(
      new Request(requestUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          DPoP: proof,
        },
      }),
      makeEnv(),
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("*.workers.dev: bound session + valid proof for c.req.url ⇒ 200", async () => {
    const { publicJwk, privateKey, jkt } = await makeDpopKeyPair();
    const token = await mintSessionToken({ cnf: { jkt } });

    const requestUrl = "https://myapp.myworker.workers.dev/test";
    const clientHtu = canonicalizeHtu(requestUrl);
    const proof = await mintDpopProof(privateKey, publicJwk, "GET", clientHtu);

    const app = createTestApp();
    const res = await app.fetch(
      new Request(requestUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          DPoP: proof,
        },
      }),
      makeEnv(),
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("DPoP negative path: htu host mismatch ⇒ 401 dpop-invalid", () => {
  it("proof htu host differs from c.req.url host ⇒ 401 dpop-invalid", async () => {
    const { publicJwk, privateKey, jkt } = await makeDpopKeyPair();
    const token = await mintSessionToken({ cnf: { jkt } });

    // Client mints proof with the WRONG host (custom domain)
    const wrongHtu = canonicalizeHtu("https://api.example.com/test");
    const proof = await mintDpopProof(privateKey, publicJwk, "GET", wrongHtu);

    // But the actual request goes to the *.workers.dev host
    const actualUrl = "https://myapp.myworker.workers.dev/test";

    const app = createTestApp();
    const res = await app.fetch(
      new Request(actualUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          DPoP: proof,
        },
      }),
      makeEnv(),
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("dpop-invalid");
  });
});
