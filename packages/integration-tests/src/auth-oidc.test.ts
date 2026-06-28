import {
  _resetMiddlewareStateForTest,
  authFixtures,
  makeAuthEnv,
} from "@tila/worker/test-support";
/**
 * auth-oidc.test.ts — end-to-end integration tests for the generic OIDC exchange
 * route (`POST /api/auth/oidc/exchange`) and the load-bearing trust-boundary
 * negative tests (security R-4 + design §9).
 *
 * ## Scope
 *
 * 1. Happy-path exchange: mints an `oidc-session` token, exercising the route
 *    end-to-end through the real auth and permission middleware (no GitHub fields).
 * 2. Deny-path coverage: `principal-not-allowed`, `oidc-not-configured`, idempotent
 *    replay.
 * 3. **Trust-boundary negative tests (REQUIRED — security R-4 + critic Finding 4):**
 *    An `oidc-session` is structurally denied by BOTH:
 *    (i)  `requireProjectAdmin` middleware (admin route — `POST /admin/restart`).
 *    (ii) `requireProjectAdminHttp` function call (repo management route).
 *    For each: HTTP status === 403, `error.code` matches the gate's deny code, and
 *    no `_admin_grants` row is written (the structural deny fires before the roster
 *    lookup even begins).
 *
 * ## Cross-package mock strategy
 *
 * The `vi.mock("@tila/backend-d1", ...)` pattern does NOT reliably intercept the
 * worker's internal imports of `@tila/backend-d1` when running in vitest node mode
 * (different module resolution contexts). See `auth-harness.README.md`.
 *
 * Instead we use a **smart D1 stub** passed via `env.DB`:
 * - `prepare(sql).bind(...).first()` — raw SQL calls (project config, revoked
 *   subjects). Routes by table name in the SQL string.
 * - `prepare(sql).bind(...).raw()` — Drizzle typed SELECT queries (all stores that
 *   use `db.select({fields}).from(table)...`). Returns column-value arrays in the
 *   correct schema order for the matched table; empty array for other tables
 *   (causes the store to behave as "not found" / "not rate limited" / etc.).
 * - `prepare(sql).bind(...).run()` — Drizzle INSERT/UPDATE/DELETE. Always succeeds.
 * - `prepare(sql).bind(...).all()` — Not used by Drizzle typed SELECTs (those go
 *   through raw()); kept for completeness. Returns empty results.
 *
 * `resolveJwksUri` and `verifyOidcJwt` are mocked at the module level so the test
 * is not dependent on network access or a real OIDC IdP.
 *
 * `ensureDeploymentInstanceId` is mocked to return a fixed instance id.
 *
 * ## Trust boundary mechanism
 *
 * `oidc-session` tokens are structurally denied by `requireProjectAdmin` and
 * `requireProjectAdminHttp` before any `_admin_grants` roster lookup. The deny fires
 * because `oidc-session` is neither `session`, `cookie-session`, nor `d1-token`:
 * - `requireProjectAdmin`: kind falls to the final `deny(c)` arm → "permission-denied"
 * - `requireProjectAdminHttp`: autoAdminGrants rejects non-session kinds → "token-authz-denied"
 *
 * The test confirms the deny is structural by showing that an oidc-session is
 * denied (403) even when an _admin_grants row exists in D1 — the deny fires before
 * any roster lookup, so D1 content is irrelevant. (The positive control — a GitHub
 * roster bearer being admitted at /admin/restart — is covered by
 * worker/src/routes/admin-authz.test.ts:112.)
 *
 * ## Note on error codes
 *
 * All error codes use lowercase-kebab form (AC-4). Never SCREAMING_CASE.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "../../worker/src/middleware/auth";
import {
  requireProjectAdmin,
  requireProjectAdminHttp,
} from "../../worker/src/middleware/require-project-admin";
import { authOidc } from "../../worker/src/routes/auth-oidc";
import type { Env, HonoVariables } from "../../worker/src/types";

// ---------------------------------------------------------------------------
// Mocks — declared before any module-graph imports
// ---------------------------------------------------------------------------

// Mock oidc-verify (the route imports this via the worker module graph)
const mockVerifyOidcJwt = vi.fn();
vi.mock("../../worker/src/lib/oidc-verify", () => {
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

// Mock oidc-discovery (the route imports this via the worker module graph)
const mockResolveJwksUri = vi.fn();
vi.mock("../../worker/src/lib/oidc-discovery", () => {
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
    clearDiscoveryCacheForTesting: vi.fn(),
  };
});

// Mock deployment-instance (the route imports this to resolve the instance id)
vi.mock("../../worker/src/lib/deployment-instance", () => ({
  ensureDeploymentInstanceId: vi.fn().mockResolvedValue("test-instance-id"),
  __resetInstanceCache: vi.fn(),
}));

// Mock github-related libs (auth-github re-exports may transitively import these)
vi.mock("../../worker/src/lib/github-client", () => ({
  getAuthenticatedUser: vi.fn(),
  getRepoPermission: vi.fn(),
  exchangeOAuthCode: vi.fn(),
}));
vi.mock("../../worker/src/lib/github-app", () => ({
  mintAppJwt: vi.fn(),
  getInstallationAccessToken: vi.fn(),
  checkUserMembership: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PROJECT_ID = "proj-oidc-integration";
const TEST_ISSUER = "https://idp.example.com";
const TEST_AUDIENCE = "tila-oidc-audience";
const TEST_JWKS_URI = "https://idp.example.com/.well-known/jwks.json";
const TEST_SUBJECT = "oidc-subject:ci-machine@example.com";

// Default GitHub session fields (from mintSessionToken defaults in fixtures.ts)
const GITHUB_USER_ID = 12345;
const GITHUB_HOST = "github.com";

// ---------------------------------------------------------------------------
// Smart D1 stub
//
// Routes calls based on the SQL table name. Drizzle typed SELECT queries use
// .raw() (returns column-value arrays); raw SQL uses .first() or .run().
//
// Column orders match the Drizzle schema in packages/backend-d1/src/schema.ts:
//
//   _oidc_principals: project_id, issuer, subject, permission, enabled,
//                     created_at, created_by
//   _admin_grants: project_id, github_host, github_user_id,
//                  github_login_snapshot, granted_by_user_id, granted_at,
//                  revoked_at, revoked_by_user_id, identity_host, subject_id
//   _idempotency (select): status_code, response_json, request_hash
//   _rate_limits (select): count, window_start  (Drizzle partial select)
// ---------------------------------------------------------------------------

interface OidcPrincipalRow {
  project_id: string;
  issuer: string;
  subject: string;
  permission: string;
  enabled: number;
  created_at: number;
  created_by: string;
}

interface AdminGrantRow {
  project_id: string;
  github_host: string;
  github_user_id: number;
  github_login_snapshot: string | null;
  granted_by_user_id: number | null;
  granted_at: number;
  revoked_at: number | null;
  revoked_by_user_id: number | null;
  identity_host: string;
  subject_id: string;
}

interface SmartD1Options {
  /** Row returned by `SELECT oidc_issuer, oidc_audience FROM _projects` */
  projectRow?: {
    oidc_issuer: string | null;
    oidc_audience: string | null;
  } | null;
  /** Row returned by OidcPrincipalsStore.isAllowed (Drizzle typed select → raw()) */
  oidcPrincipalRow?: OidcPrincipalRow | null;
  /** Row returned by AdminGrantsStore.isActiveAdmin (Drizzle typed select → raw()) */
  adminGrantRow?: AdminGrantRow | null;
  /** Pre-populated idempotency cache entry (D1IdempotencyStore.check → raw()) */
  idempotencyCached?: { statusCode: number; responseJson: string } | null;
}

function makeSmartD1(opts: SmartD1Options = {}): D1Database {
  const db: D1Database = {
    prepare(sql: string) {
      const s = sql.trim();
      const isProject = s.includes("_projects");
      const isOidcPrincipal = s.includes("_oidc_principals");
      const isAdminGrant = s.includes("_admin_grants");
      const isIdempotency = s.includes("_idempotency");

      const boundStmt = {
        /** Used by raw SQL paths (e.g. project config, revoked-subjects lookups) */
        first<T = unknown>(): Promise<T | null> {
          if (isProject)
            return Promise.resolve(
              opts.projectRow ?? null,
            ) as Promise<T | null>;
          return Promise.resolve(null);
        },
        /**
         * Used by Drizzle typed SELECT queries (slow path: has fields map).
         * Returns column-value arrays in schema column order for the matched table.
         * Empty array means "no rows found" → store returns null / false / [].
         *
         * Column orders:
         *   _oidc_principals: project_id, issuer, subject, permission, enabled,
         *                     created_at, created_by
         *   _admin_grants: project_id, github_host, github_user_id,
         *                  github_login_snapshot, granted_by_user_id, granted_at,
         *                  revoked_at, revoked_by_user_id, identity_host, subject_id
         *   _idempotency (partial select): status_code, response_json, request_hash
         *   _rate_limits (partial select): count, window_start
         */
        raw(): Promise<unknown[][]> {
          if (isOidcPrincipal && opts.oidcPrincipalRow) {
            const r = opts.oidcPrincipalRow;
            return Promise.resolve([
              [
                r.project_id,
                r.issuer,
                r.subject,
                r.permission,
                r.enabled,
                r.created_at,
                r.created_by,
              ],
            ]);
          }
          if (isAdminGrant && opts.adminGrantRow) {
            const g = opts.adminGrantRow;
            return Promise.resolve([
              [
                g.project_id,
                g.github_host,
                g.github_user_id,
                g.github_login_snapshot,
                g.granted_by_user_id,
                g.granted_at,
                g.revoked_at,
                g.revoked_by_user_id,
                g.identity_host,
                g.subject_id,
              ],
            ]);
          }
          if (isIdempotency && opts.idempotencyCached) {
            const ic = opts.idempotencyCached;
            return Promise.resolve([[ic.statusCode, ic.responseJson, null]]);
          }
          return Promise.resolve([]);
        },
        /** Drizzle INSERT/UPDATE/DELETE — always succeeds */
        run(): Promise<{ success: boolean; meta: object }> {
          return Promise.resolve({ success: true, meta: {} });
        },
        /** Non-Drizzle typed SELECTs (rarely used by these stores) */
        all(): Promise<{ results: object[]; success: boolean; meta: object }> {
          return Promise.resolve({ results: [], success: true, meta: {} });
        },
      };

      // Self-referential `bind` so the returned statement satisfies
      // D1PreparedStatement (whose `bind()` must itself return a D1PreparedStatement).
      const prepared = {
        bind: (..._params: unknown[]) => prepared,
        first: boundStmt.first,
        all: boundStmt.all,
        run: boundStmt.run,
        raw: boundStmt.raw,
      } as unknown as D1PreparedStatement;
      return prepared;
    },
    exec: vi.fn() as unknown as typeof db.exec,
    dump: vi.fn() as unknown as typeof db.dump,
    batch: vi.fn() as unknown as typeof db.batch,
    withSession: vi.fn() as unknown as typeof db.withSession,
  };
  return db;
}

/**
 * A D1 stub that returns null/empty for all queries. Used for trust-boundary
 * tests where the exchange route is not exercised (session is minted directly).
 */
function emptyReadD1(): D1Database {
  return makeSmartD1({
    projectRow: null,
    oidcPrincipalRow: null,
    adminGrantRow: null,
    idempotencyCached: null,
  });
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/**
 * Build a Hono test app that includes:
 * - The generic OIDC exchange route (pre-auth: POST /api/auth/oidc/exchange)
 * - Auth middleware on all protected paths
 * - A stub project admin route gated by `requireProjectAdmin` middleware
 *   (used for trust-boundary gate i: `code === "permission-denied"`)
 * - A stub repo management route gated by `requireProjectAdminHttp` function
 *   (used for trust-boundary gate ii: `code === "token-authz-denied"`)
 * - A protected read route for confirming the minted session is usable
 *
 * Project middleware is NOT mounted because:
 *   (a) requireProjectAdmin for oidc-session hits the deny(c) arm before
 *       any projectId read (kind falls through to "any other kind → deny").
 *   (b) requireProjectAdminHttp reads tokenResult.projectId (not context).
 *   (c) The session-status route is auth-only (no project scope).
 */
function makeApp(env: Env): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // OIDC exchange — pre-auth (no auth middleware on this path)
  app.route("/api/auth/oidc", authOidc);

  // Protected routes — auth middleware guards everything below
  const protectedApp = new Hono<AppEnv>();
  protectedApp.use("/*", createAuthMiddleware());

  // Read-only probe: confirms a session token is accepted
  protectedApp.get("/session/probe", (c) =>
    c.json({ ok: true, kind: c.get("tokenResult")?.kind }),
  );

  // Gate (i): requireProjectAdmin middleware (returns "permission-denied" on deny)
  protectedApp.post(
    "/projects/:projectId/admin/restart",
    requireProjectAdmin,
    (c) => c.json({ ok: true }),
  );

  // Gate (ii): requireProjectAdminHttp function call (returns "token-authz-denied" on deny)
  protectedApp.post("/api/repos/register", async (c) => {
    const authzResp = await requireProjectAdminHttp(c);
    if (authzResp) return authzResp;
    return c.json({ ok: true });
  });

  app.route("/", protectedApp);
  return app;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetMiddlewareStateForTest();
  vi.clearAllMocks();
  // Default verify: returns a valid OIDC payload
  mockVerifyOidcJwt.mockResolvedValue({
    header: { alg: "RS256", kid: "key1" },
    payload: {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: TEST_SUBJECT,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    },
  });
  // Default discovery: returns the configured JWKS URI
  mockResolveJwksUri.mockResolvedValue(TEST_JWKS_URI);
});

const execCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Helper: mint an oidc-session token directly (without going through the exchange)
//
// Used by trust-boundary tests — the exchange route is NOT exercised here.
// The token is minted with `sub_type: "oidc"` and the OIDC-specific claims;
// GitHub fields are absent (as required by the discriminated union).
// ---------------------------------------------------------------------------

async function mintOidcSessionToken(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return authFixtures.mintSessionToken({
    // Discriminator — selects the OIDC arm of the discriminated union
    sub_type: "oidc",
    // Required OIDC session fields
    oidc_issuer: TEST_ISSUER,
    oidc_subject: TEST_SUBJECT,
    actor_name: TEST_SUBJECT,
    // Base fields
    project_id: TEST_PROJECT_ID,
    permission: "read",
    // Clear GitHub-specific fields that mintSessionToken includes by default
    github_host: undefined,
    github_repo_id: undefined,
    github_login: undefined,
    github_user_id: undefined,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Happy-path exchange
// ---------------------------------------------------------------------------

describe("OIDC exchange — happy path", () => {
  it("returns 200 with an OidcExchangeResponseSchema-shaped body and tila_s. token", async () => {
    const env = makeAuthEnv({
      DB: makeSmartD1({
        projectRow: { oidc_issuer: TEST_ISSUER, oidc_audience: TEST_AUDIENCE },
        oidcPrincipalRow: {
          project_id: TEST_PROJECT_ID,
          issuer: TEST_ISSUER,
          subject: TEST_SUBJECT,
          permission: "read",
          enabled: 1,
          created_at: 1_700_000_000,
          created_by: "test-admin",
        },
      }),
    });
    const app = makeApp(env);

    const res = await app.fetch(
      new Request("http://localhost/api/auth/oidc/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.1",
        },
        body: JSON.stringify({
          project_id: TEST_PROJECT_ID,
          oidc_token: "fake.oidc.token",
        }),
      }),
      env,
      execCtx,
    );

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

  it("minted session token is usable on a protected read route (oidc-session kind accepted)", async () => {
    // Full round-trip: exchange → session token → protected read route
    const env = makeAuthEnv({
      DB: makeSmartD1({
        projectRow: { oidc_issuer: TEST_ISSUER, oidc_audience: TEST_AUDIENCE },
        oidcPrincipalRow: {
          project_id: TEST_PROJECT_ID,
          issuer: TEST_ISSUER,
          subject: TEST_SUBJECT,
          permission: "read",
          enabled: 1,
          created_at: 1_700_000_000,
          created_by: "test-admin",
        },
      }),
    });
    const app = makeApp(env);

    const exchangeRes = await app.fetch(
      new Request("http://localhost/api/auth/oidc/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.1",
        },
        body: JSON.stringify({
          project_id: TEST_PROJECT_ID,
          oidc_token: "fake.oidc.token",
        }),
      }),
      env,
      execCtx,
    );
    expect(exchangeRes.status).toBe(200);

    const exchangeBody = (await exchangeRes.json()) as Record<string, unknown>;
    const sessionToken = exchangeBody.session_token as string;

    // The minted oidc-session token must be accepted by the auth middleware
    const probeEnv = makeAuthEnv({ DB: emptyReadD1() });
    const probeRes = await app.fetch(
      new Request("http://localhost/session/probe", {
        headers: { Authorization: `Bearer ${sessionToken}` },
      }),
      probeEnv,
      execCtx,
    );
    expect(probeRes.status).toBe(200);
    const probeBody = (await probeRes.json()) as Record<string, unknown>;
    expect(probeBody.ok).toBe(true);
    // Confirm the session was parsed as the correct kind
    expect(probeBody.kind).toBe("oidc-session");
  });
});

// ---------------------------------------------------------------------------
// 2. Deny paths
// ---------------------------------------------------------------------------

describe("OIDC exchange — deny paths", () => {
  it("returns 403 principal-not-allowed when principal has no _oidc_principals row", async () => {
    const env = makeAuthEnv({
      DB: makeSmartD1({
        projectRow: { oidc_issuer: TEST_ISSUER, oidc_audience: TEST_AUDIENCE },
        oidcPrincipalRow: null, // no principal → OidcPrincipalsStore.isAllowed returns null
      }),
    });
    const app = makeApp(env);

    const res = await app.fetch(
      new Request("http://localhost/api/auth/oidc/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.2",
        },
        body: JSON.stringify({
          project_id: TEST_PROJECT_ID,
          oidc_token: "fake.oidc.token",
        }),
      }),
      env,
      execCtx,
    );

    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(403);
    expect((body.error as Record<string, unknown>).code).toBe(
      "principal-not-allowed",
    );
  });

  it("returns 404 oidc-not-configured when project has no OIDC config", async () => {
    const env = makeAuthEnv({
      DB: makeSmartD1({
        projectRow: { oidc_issuer: null, oidc_audience: null },
      }),
    });
    const app = makeApp(env);

    const res = await app.fetch(
      new Request("http://localhost/api/auth/oidc/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.3",
        },
        body: JSON.stringify({
          project_id: TEST_PROJECT_ID,
          oidc_token: "fake.oidc.token",
        }),
      }),
      env,
      execCtx,
    );

    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect((body.error as Record<string, unknown>).code).toBe(
      "oidc-not-configured",
    );
    // Verify was NOT called (short-circuit before verification)
    expect(mockVerifyOidcJwt).not.toHaveBeenCalled();
  });

  it("returns 404 oidc-not-configured for non-existent project (security A-5: indistinguishable)", async () => {
    const env = makeAuthEnv({
      DB: makeSmartD1({ projectRow: null }), // project row doesn't exist
    });
    const app = makeApp(env);

    const res = await app.fetch(
      new Request("http://localhost/api/auth/oidc/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.4",
        },
        body: JSON.stringify({
          project_id: "non-existent-project",
          oidc_token: "fake.oidc.token",
        }),
      }),
      env,
      execCtx,
    );

    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect((body.error as Record<string, unknown>).code).toBe(
      "oidc-not-configured",
    );
  });

  it("returns cached body on idempotent replay (same jti)", async () => {
    // First request: full exchange — succeeds, returns session token
    const exchangeEnv = makeAuthEnv({
      DB: makeSmartD1({
        projectRow: { oidc_issuer: TEST_ISSUER, oidc_audience: TEST_AUDIENCE },
        oidcPrincipalRow: {
          project_id: TEST_PROJECT_ID,
          issuer: TEST_ISSUER,
          subject: TEST_SUBJECT,
          permission: "read",
          enabled: 1,
          created_at: 1_700_000_000,
          created_by: "test-admin",
        },
      }),
    });
    const app = makeApp(exchangeEnv);

    const reqBody = JSON.stringify({
      project_id: TEST_PROJECT_ID,
      oidc_token: "fake.oidc.token",
    });

    const res1 = await app.fetch(
      new Request("http://localhost/api/auth/oidc/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.5",
        },
        body: reqBody,
      }),
      exchangeEnv,
      execCtx,
    );
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as Record<string, unknown>;

    // Second request: idempotency cache hit — D1 stub returns the cached response
    const replayEnv = makeAuthEnv({
      DB: makeSmartD1({
        projectRow: { oidc_issuer: TEST_ISSUER, oidc_audience: TEST_AUDIENCE },
        idempotencyCached: {
          statusCode: 200,
          responseJson: JSON.stringify(data1),
        },
      }),
    });
    const app2 = makeApp(replayEnv);

    const res2 = await app2.fetch(
      new Request("http://localhost/api/auth/oidc/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.5",
        },
        body: reqBody,
      }),
      replayEnv,
      execCtx,
    );
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as Record<string, unknown>;
    // Idempotent replay returns the cached session_token
    expect(data2.session_token).toBe(data1.session_token);
  });
});

// ---------------------------------------------------------------------------
// 3. TRUST BOUNDARY NEGATIVE TESTS — security R-4 + critic Finding 4
//
// These tests are the load-bearing security invariant: an `oidc-session` token
// MUST be denied by both admin gates BEFORE any `_admin_grants` lookup.
//
// Gate (i): `requireProjectAdmin` middleware.
//   - Deny code: "permission-denied" (require-project-admin.ts:437)
//   - Structural reason: oidc-session kind != "session" | "cookie-session" | "d1-token"
//     → falls through to deny(c).
//
// Gate (ii): `requireProjectAdminHttp` function call.
//   - Deny code: "token-authz-denied" (require-project-admin.ts:270)
//   - Structural reason: oidc-session is not d1-token + autoAdminGrants rejects it
//     (kind !== "session" | "cookie-session").
//
// Positive counterpart: GitHub session reaching `requireProjectAdmin` DOES proceed
// to the roster lookup. When an admin grant exists (smart D1 stub returns a
// non-empty _admin_grants row), the GitHub session is admitted (200 OK).
// oidc-session always returns 403, even with admin grants in the D1 stub.
// ---------------------------------------------------------------------------

describe("TRUST BOUNDARY: oidc-session denied by admin gates — structural deny before roster lookup", () => {
  it("(i) requireProjectAdmin gate: oidc-session → 403 permission-denied", async () => {
    // Mint an oidc-session directly (no exchange route involved)
    const oidcToken = await mintOidcSessionToken({ permission: "write" });

    const env = makeAuthEnv({ DB: emptyReadD1() });
    const app = makeApp(env);

    const res = await app.fetch(
      new Request(
        `http://localhost/projects/${TEST_PROJECT_ID}/admin/restart`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${oidcToken}` },
        },
      ),
      env,
      execCtx,
    );

    const body = (await res.json()) as Record<string, unknown>;

    // Status must be 403
    expect(res.status).toBe(403);
    // Code must be "permission-denied" — the requireProjectAdmin structural deny code,
    // NOT any other 403 (rate-limiter, project-mismatch, etc.)
    expect((body.error as Record<string, unknown>).code).toBe(
      "permission-denied",
    );
    expect(body.ok).toBe(false);
  });

  it("(ii) requireProjectAdminHttp gate: oidc-session → 403 token-authz-denied", async () => {
    // Mint an oidc-session directly (no exchange route involved)
    const oidcToken = await mintOidcSessionToken({ permission: "admin" });

    const env = makeAuthEnv({ DB: emptyReadD1() });
    const app = makeApp(env);

    const res = await app.fetch(
      new Request("http://localhost/api/repos/register", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oidcToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      execCtx,
    );

    const body = (await res.json()) as Record<string, unknown>;

    // Status must be 403
    expect(res.status).toBe(403);
    // Code must be "token-authz-denied" — the requireProjectAdminHttp deny code
    expect((body.error as Record<string, unknown>).code).toBe(
      "token-authz-denied",
    );
    expect(body.ok).toBe(false);
  });

  it("structural deny: oidc-session is denied at /admin/restart even when an admin grant row exists in D1 (deny fires regardless of roster state)", async () => {
    // Seed an active admin grant row in D1 for a GitHub principal. The
    // oidc-session's identity is (issuer, subject) and can never match a GitHub
    // roster entry; require-project-admin's null-identity guard denies an
    // oidc-session structurally BEFORE any roster lookup. So the deny holds even
    // with a grant present in D1 — proving the deny is structural, not a roster
    // miss. (The positive control — a GitHub roster bearer admitted at
    // /admin/restart — is covered by worker/src/routes/admin-authz.test.ts:112.)
    const adminGrantRow: AdminGrantRow = {
      project_id: TEST_PROJECT_ID,
      github_host: GITHUB_HOST,
      github_user_id: GITHUB_USER_ID,
      github_login_snapshot: "testuser",
      granted_by_user_id: null,
      granted_at: Math.floor(Date.now() / 1000) - 3600,
      revoked_at: null,
      revoked_by_user_id: null,
      identity_host: GITHUB_HOST,
      subject_id: String(GITHUB_USER_ID),
    };

    const oidcToken = await mintOidcSessionToken({ permission: "write" });
    const oidcEnv = makeAuthEnv({
      DB: makeSmartD1({ adminGrantRow }), // grant exists in D1 — must NOT matter
    });
    const oidcApp = makeApp(oidcEnv);

    const oidcRes = await oidcApp.fetch(
      new Request(
        `http://localhost/projects/${TEST_PROJECT_ID}/admin/restart`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${oidcToken}` },
        },
      ),
      oidcEnv,
      execCtx,
    );
    // oidc-session is STILL denied even with an admin grant in the D1 stub,
    // because the structural deny fires before any roster lookup.
    expect(oidcRes.status).toBe(403);
    const oidcBody = (await oidcRes.json()) as Record<string, unknown>;
    expect((oidcBody.error as Record<string, unknown>).code).toBe(
      "permission-denied",
    );
  });
});
