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
 * Subject-level bulk kill-switch (WI-C, #126):
 *   - Driven through the worker's REAL per-isolate subject cache via the
 *     re-exported revokeSubjectInCache() — the production hot path (cache hit,
 *     no D1). The D1-query branch + fail-closed behavior are covered by the
 *     worker's co-located unit tests (see the cross-package mock limitation above).
 */
import {
  _resetMiddlewareStateForTest,
  authFixtures,
  createAuthTestApp,
  makeAuthEnv,
  revokeJtiInCache,
  revokeSubjectInCache,
} from "@tila/worker/test-support";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal empty-read D1 stub. auth-revocation.test.ts uses the REAL backend-d1
// stores (no @tila/backend-d1 vi.mock — see header). The WI-C subject gate, unlike
// the jti gate, ALWAYS queries D1 on a subject-cache miss, so the env's DB must be
// able to serve a read that returns "no tombstone" (empty result → getRevokedBefore
// returns null → request proceeds). Returns empty for every query; tombstone-present
// cases in this file are driven through the in-isolate cache via revokeSubjectInCache.
const emptyD1 = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: [], success: true, meta: {} }),
      first: async () => null,
      run: async () => ({ success: true, meta: {} }),
      raw: async () => [],
    }),
  }),
} as unknown as D1Database;

const env = makeAuthEnv({ DB: emptyD1 });

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
// WI-C (#126): subject-level bulk kill-switch — subject-revoked (auth.ts gate)
// Driven through the worker's REAL per-isolate subject cache (production hot
// path). Fixture defaults: project_id "proj-1", github_host "github.com",
// github_user_id 12345, issued_at ~now.
// ---------------------------------------------------------------------------

describe("subject-level bulk revocation — subject-revoked", () => {
  it("rejects a session token whose principal was revoked with a future cutoff (401 subject-revoked)", async () => {
    // Arm the in-isolate tombstone for the default principal with a cutoff in the
    // future, so a token issued now is strictly before it and must be rejected.
    revokeSubjectInCache("proj-1", "github.com", 12345, Date.now() + 3_600_000);

    const app = createAuthTestApp(env);
    const token = await authFixtures.mintSessionToken();
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
    // Exact lowercase-kebab code from source — coordinate with WI-Q.
    expect(body.error.code).toBe("subject-revoked");
  });

  it("allows a token issued at/after the cutoff (strict <, positive counterpart)", async () => {
    // Same principal, but the tombstone cutoff is in the past, so a token issued
    // now is NOT before it — the kill-switch must not fire (guards against a
    // blanket-reject bug). Cache hit → no D1 needed.
    revokeSubjectInCache("proj-1", "github.com", 12345, Date.now() - 3_600_000);

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
});
