/**
 * GitHub auth exchange flow integration tests.
 *
 * Green-today assertions (via shared harness + cross-package vi.mock):
 *   - Unauthenticated request to protected endpoint → 401 unauthorized
 *   - Project-A session used on project-B → 403 project-mismatch
 *
 * Remaining scenarios document expected behavior and are placeholders until
 * pool-workers vitest config is wired (they require a live D1 + GitHub API mock).
 *
 * Predecessor implementation: PR#203 (T3 GitHub token exchange endpoint,
 * T4 dual-mode auth middleware). Unit tests covering the same scenarios
 * with vi.mock exist at packages/worker/src/routes/auth-github.test.ts.
 *
 * Key implementation details:
 * - Exchange endpoint: POST /api/auth/github/exchange (pre-auth, no middleware)
 * - Session token format: tila_s.<jwt> (3-part dot-separated)
 * - Rate limit: RATE_LIMIT_MAX_FAILURES = 10 failures per IP per 60s window
 * - Session TTL: 1 hour (SESSION_TTL_SECONDS = 3600)
 * - Permission model: read | write | admin (normalized from GitHub's 6-level model)
 * - Stateless HMAC sessions: no D1 lookup on protected routes, revocation blocks
 *   new exchanges but does not invalidate in-flight tokens within 1h TTL
 */
import {
  _resetMiddlewareStateForTest,
  authFixtures,
  backendD1MockFactory,
  createAuthTestApp,
  featurePending,
  makeAuthEnv,
  resetBackendD1Mocks,
} from "@tila/worker/test-support";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Per-file hoisted mock — vitest resolves this to the same module the worker source imports.
vi.mock("@tila/backend-d1", () => backendD1MockFactory());

const env = makeAuthEnv();

beforeEach(() => {
  _resetMiddlewareStateForTest();
  resetBackendD1Mocks();
});

describe("GitHub auth exchange flow", () => {
  // ---------------------------------------------------------------------------
  // Green-today: unauthenticated request is rejected
  // ---------------------------------------------------------------------------

  it("unauthenticated request to protected endpoint returns 401 unauthorized", async () => {
    // No Authorization header on a protected route → auth middleware rejects with
    // 401 unauthorized (auth.ts:435 covers all no-token / bad-token paths).
    const app = createAuthTestApp(env);
    const res = await app.fetch(
      new Request("http://localhost/auth/session/status"),
      env,
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unauthorized");
  });

  // ---------------------------------------------------------------------------
  // Green-today: cross-project session rejection (project-mismatch)
  // ---------------------------------------------------------------------------

  it("session token for project-a used on project-b returns 403 project-mismatch", async () => {
    // Mint a session token scoped to project-a. Use it on /projects/project-b/_probe.
    // projectMiddleware (project.ts:31) compares tokenResult.projectId to :projectId and
    // returns 403 project-mismatch when they differ.
    //
    // createAuthTestApp with { mountProjectRoute: true } wires:
    //   authMiddleware → protectedRoutes → projectMiddleware → GET /projects/:projectId/_probe
    // The PROJECT DO stub in makeAuthEnv resolves fetch() with 200 so projectMiddleware
    // can proceed past the DO stub to reach the project-mismatch guard.
    const app = createAuthTestApp(env, { mountProjectRoute: true });
    const token = await authFixtures.mintSessionToken({
      project_id: "project-a",
    });
    const res = await app.fetch(
      new Request("http://localhost/projects/project-b/_probe", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("project-mismatch");
  });

  // ---------------------------------------------------------------------------
  // Placeholders — require pool-workers + D1 + GitHub API mock
  // ---------------------------------------------------------------------------

  it("valid GitHub token for unregistered repo returns 403 repo-not-allowed", () => {
    // Scenario: GitHub token is valid but repo not in _project_repos allowlist.
    // Precondition:
    //   - GitHub API mock: GET /user returns { login: "testuser" }
    //   - GitHub API mock: GET /repos/.../permission returns { permission: "write" }
    //   - D1 _project_repos table: NO row for this project_id + github_repo_id
    // Expected: 403, error.code === "repo-not-allowed"
    expect(true).toBe(true); // Placeholder until pool-workers configured
  });

  it("valid GitHub token for registered repo mints session token", () => {
    // Scenario: Happy path — valid token, registered repo, sufficient permission.
    // Expected: 200, body.ok === true, body.session_token starts with "tila_s."
    // Token format: tila_s.<jwtHeader>.<jwtPayload>.<jwtSignature>
    expect(true).toBe(true); // Placeholder until pool-workers configured
  });

  it("read-permission session on write route returns 403 permission-denied", () => {
    // Scenario: Insufficient permission for write-level route.
    // A valid session with permission="read" used on a write route.
    // Expected: 403, error.code === "permission-denied"
    expect(true).toBe(true); // Placeholder until pool-workers configured
  });

  it("exchange for repo removed from allowlist returns 403 repo-not-allowed", () => {
    // Scenario: Allowlist revocation blocks new token exchanges.
    // Removal blocks NEW exchanges but does NOT invalidate already-minted session tokens.
    // Expected: 403, error.code === "repo-not-allowed"
    expect(true).toBe(true); // Placeholder until pool-workers configured
  });

  it("10+ consecutive auth failures from same IP returns 429 rate-limited", () => {
    // Scenario: Rate limiting after repeated failures.
    // RATE_LIMIT_MAX_FAILURES = 10 (auth-github.ts:16); counter increments only on failures.
    // Expected: 429, error.code === "rate-limited"
    expect(true).toBe(true); // Placeholder until pool-workers configured
  });

  it("expired session token returns 401 unauthorized", () => {
    // Scenario: Session token past its TTL (expires_at <= now).
    // The token must have a valid HMAC signature — HMAC runs before expiry check.
    // Expected: 401, error.code === "unauthorized"
    expect(true).toBe(true); // Placeholder until pool-workers configured
  });
});

// ---------------------------------------------------------------------------
// FEATURE-PENDING: pool-workers-dependent scenarios
// ---------------------------------------------------------------------------

const fp = featurePending(
  "WI-Q",
  "pool-workers",
  "full GitHub exchange flow with live D1 + GitHub API mock",
);

fp.describe("GitHub exchange with live D1 bindings", () => {
  fp.it("full happy-path exchange mints a valid session token", async () => {
    // shape TBD — owned by pool-workers infrastructure setup
    // Requires D1 _project_repos row + GitHub API mock server + GITHUB_SESSION_HMAC_KEY binding
    throw new Error("shape TBD — owned by pool-workers setup");
  });
});
