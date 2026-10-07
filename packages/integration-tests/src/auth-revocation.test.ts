/** Regression coverage for live D1 subject revocation and confirmed-revoked JTI hints. */
import {
  _resetMiddlewareStateForTest,
  authFixtures,
  createAuthTestApp,
  makeAuthEnv,
  revokeJtiInCache,
  revokeSubjectInCache,
} from "@tila/worker/test-support";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The subject tombstone is authoritative D1 state, never a positive cache grant.
let revokedBefore: number | null = null;
const emptyD1 = {
  prepare: (query: string) => ({
    bind: () => ({
      all: async () => ({ results: [], success: true, meta: {} }),
      first: async () =>
        query.includes("_revoked_subjects") && revokedBefore !== null
          ? { revoked_before: revokedBefore }
          : null,
      run: async () => ({ success: true, meta: {} }),
      raw: async () =>
        query.includes("_revoked_subjects") && revokedBefore !== null
          ? [[revokedBefore]]
          : [],
    }),
  }),
} as unknown as D1Database;

const env = makeAuthEnv({ DB: emptyD1 });

beforeEach(() => {
  // Clear the per-isolate jti revocation cache between tests so the positive
  // counterpart cannot see a prior test's revoked jti.
  _resetMiddlewareStateForTest();
  revokedBefore = null;
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
    // Set the authoritative database tombstone with a cutoff in the
    // future, so a token issued now is strictly before it and must be rejected.
    revokedBefore = Date.now() + 3_600_000;
    revokeSubjectInCache("proj-1", "github.com", 12345, revokedBefore);

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
    // blanket-reject bug). D1 is checked even with a warm cache.
    revokedBefore = Date.now() - 3_600_000;
    revokeSubjectInCache("proj-1", "github.com", 12345, revokedBefore);

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
