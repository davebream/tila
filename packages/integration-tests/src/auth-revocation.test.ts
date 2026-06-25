/**
 * auth-revocation.test.ts — negative-path tests for session token revocation.
 *
 * Green-today assertions (real, no D1 mock required):
 *   - jti-revocation fail-closed (C9 on main): a session whose jti is in the
 *     per-isolate revocation cache is rejected 401 session-revoked (auth.ts:608).
 *     This is driven through the worker's REAL in-process cache via the re-exported
 *     revokeJtiInCache() — no @tila/backend-d1 mock is involved, so it exercises the
 *     genuine cache-hit branch (auth.ts:584 → 608).
 *   - positive counterpart: a fresh session (no jti) passes — guards against a
 *     blanket-reject bug masquerading as correct.
 *   - token-hash equality sanity check.
 *
 * Cross-package mock limitation (deliberate scope boundary):
 *   The D1-query revocation branch (auth.ts:596-615) is NOT exercised here. Mocking
 *   a @tila/backend-d1 store *method* from this package does not reliably intercept
 *   the worker's internal `new D1RevokedJtiStore(c.env.DB)` call: vitest's vi.mock
 *   only intercepts when the specifier resolves in this file's own module graph, and
 *   wiring that across the package boundary re-introduces a mock→worker→mocked-package
 *   import cycle. The D1 fail-closed branch is already covered by the worker's own
 *   co-located unit tests (packages/worker/src/middleware/auth.test.ts). The cache
 *   branch tested here is the production hot path.
 *
 * Skip-gated (WI-C, #126):
 *   - Subject-level bulk kill-switch / principal-level revocation.
 */
import {
  _resetMiddlewareStateForTest,
  authFixtures,
  createAuthTestApp,
  featurePending,
  makeAuthEnv,
  revokeJtiInCache,
} from "@tila/worker/test-support";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = makeAuthEnv();

beforeEach(() => {
  // Clear the per-isolate jti revocation cache between tests so the positive
  // counterpart cannot see a prior test's revoked jti.
  _resetMiddlewareStateForTest();
});

const execCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Green-today: jti revocation (C9 — confirmed-revoked cache branch, auth.ts:608)
// ---------------------------------------------------------------------------

describe("jti revocation — session-revoked (auth.ts:608)", () => {
  it("fresh session token on a protected route succeeds (positive counterpart)", async () => {
    // A token without a jti bypasses the revocation check (pre-C9 compat). The
    // positive counterpart ensures a blanket-reject bug cannot pass for free.
    const app = createAuthTestApp(env);
    const token = await authFixtures.mintSessionToken();
    const res = await app.fetch(
      new Request("http://localhost/auth/session/status", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      execCtx,
    );
    expect(res.status).toBe(200);
  });

  it("revoked jti (cache path via revokeJtiInCache) is rejected with 401 session-revoked", async () => {
    // Pre-populate the worker's REAL per-isolate revocation cache — the C9 cache-hit
    // branch returns session-revoked before any D1 query (auth.ts:584 → 608).
    revokeJtiInCache("revoked-jti-cached-integration");

    const app = createAuthTestApp(env);
    const token = await authFixtures.mintSessionToken({
      jti: "revoked-jti-cached-integration",
    });
    const res = await app.fetch(
      new Request("http://localhost/auth/session/status", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      execCtx,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    // Exact lowercase-kebab code from source — NOT the issue's SCREAMING_CASE.
    expect(body.error.code).toBe("session-revoked");
  });
});

// ---------------------------------------------------------------------------
// Green-today: token hash equality (sanity check, no auth app needed)
// ---------------------------------------------------------------------------

describe("token hash equality", () => {
  it("SHA-256 of a token is 64 hex chars and is deterministic", async () => {
    const token = authFixtures.mintD1Token();
    const hash1 = await authFixtures.hashToken(token);
    const hash2 = await authFixtures.hashToken(token);
    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// FEATURE-PENDING(WI-C, #126): subject-level bulk kill-switch / principal revocation
// ---------------------------------------------------------------------------

const fp = featurePending(
  "WI-C",
  126,
  "bulk kill-switch / subject-level revocation",
);

fp.describe("subject-level bulk revocation", () => {
  fp.it(
    "revoking a principal rejects all its in-flight tokens within 60s",
    async () => {
      // shape TBD — owned by WI-C. When WI-C lands:
      //   1. Mint a session token for a principal.
      //   2. Call the kill-switch endpoint to revoke all tokens for that principal.
      //   3. Assert the token is rejected 401 (session-revoked or the new code).
      //   4. Assert a fresh session for a different principal still works.
      const _token = await authFixtures.mintSessionToken({
        github_login: "victim-user",
      });
      throw new Error("shape TBD — owned by WI-C");
    },
  );

  fp.it(
    "subject-level revocation propagates across isolates within TTL",
    async () => {
      // shape TBD — owned by WI-C.
      throw new Error("shape TBD — owned by WI-C");
    },
  );
});
