import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CookieSessionTokenResult,
  D1TokenResult,
  Env,
  HonoVariables,
  SessionTokenResult,
  UnifiedTokenResult,
  WorkspaceSessionTokenResult,
} from "../types";

// --- Test seam (committed) -------------------------------------------------
// The middleware constructs `new AdminGrantsStore(c.env.DB)` and
// `new D1ProjectRegistry(c.env.DB)` directly, so the module boundary is the
// seam. Every constructed instance shares the same stubbable mock.
const mockIsActiveAdmin = vi.fn();
const mockGetRepoAdminAutoAdmin = vi.fn();
vi.mock("@tila/backend-d1", () => ({
  AdminGrantsStore: class {
    isActiveAdmin = mockIsActiveAdmin;
  },
  D1ProjectRegistry: class {
    getRepoAdminAutoAdmin = mockGetRepoAdminAutoAdmin;
  },
}));

import {
  __clearAdminGrantsCache,
  __clearProjectAutoAdminCache,
  autoAdminGrants,
  requireD1TokenHttp,
  requireProjectAdmin,
  requireProjectAdminHttp,
  revokeAdminGrantInCache,
} from "./require-project-admin";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const mockEnv = {
  DB: {} as D1Database,
  PROJECT: {} as DurableObjectNamespace,
  ARTIFACTS: {} as R2Bucket,
  ANALYTICS: {} as AnalyticsEngineDataset,
} as unknown as Env;

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function makeD1Token(scopes: string): D1TokenResult {
  return {
    kind: "d1-token",
    projectId: "proj-1",
    name: "test-token",
    scopes,
    tokenId: "tok-uuid",
  };
}

function makeSessionToken(
  opts: {
    projectId?: string;
    githubUserId?: number | undefined;
    githubHost?: string | undefined;
    permission?: string;
  } = {},
): SessionTokenResult {
  const permission = opts.permission ?? "admin";
  return {
    kind: "session",
    projectId: opts.projectId ?? "proj-1",
    name: "testuser",
    scopes: permission,
    tokenId: "",
    githubRepoId: 99999,
    githubLogin: "testuser",
    permission,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    githubUserId: "githubUserId" in opts ? opts.githubUserId : 4242,
    githubHost: "githubHost" in opts ? opts.githubHost : "github.com",
  };
}

function makeCookieSessionToken(
  permission = "admin",
): CookieSessionTokenResult {
  return {
    kind: "cookie-session",
    projectId: "proj-1",
    name: "test-actor",
    scopes: "full",
    tokenId: "",
    sessionHash: "test-hash",
    expiresAt: Date.now() + 3600_000,
    permission,
  };
}

function makeWorkspaceSessionToken(): WorkspaceSessionTokenResult {
  return {
    kind: "workspace-session",
    projectId: "",
    name: "gh-alice",
    scopes: "",
    tokenId: "",
    sessionHash: "ws-hash",
    githubLogin: "gh-alice",
    expiresAt: Date.now() + 3600_000,
  };
}

/**
 * Build an app whose pre-middleware injects the given tokenResult and projectId
 * (mirroring the live auth + project middleware), then mounts requireProjectAdmin.
 */
function createTestApp(
  tokenResult:
    | D1TokenResult
    | SessionTokenResult
    | CookieSessionTokenResult
    | WorkspaceSessionTokenResult
    | undefined,
  projectId: string | undefined = "proj-1",
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    if (tokenResult !== undefined) {
      c.set("tokenResult", tokenResult);
    }
    if (projectId !== undefined) {
      c.set("projectId", projectId);
    }
    return next();
  });
  app.use("/*", requireProjectAdmin);
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

async function fetchStatus(
  app: Hono<AppEnv>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.fetch(
    new Request("http://localhost/test"),
    mockEnv,
    mockCtx,
  );
  const body = await res.json();
  return { status: res.status, body };
}

function expectDenied(result: { status: number; body: unknown }): void {
  expect(result.status).toBe(403);
  expect((result.body as { error: { code: string } }).error.code).toBe(
    "permission-denied",
  );
}

describe("requireProjectAdmin middleware", () => {
  beforeEach(() => {
    mockIsActiveAdmin.mockReset();
    mockGetRepoAdminAutoAdmin.mockReset();
    // Fixtures reuse proj-1/4242; a leaked positive entry would false-green a
    // later deny case before isActiveAdmin is consulted.
    __clearAdminGrantsCache();
    __clearProjectAutoAdminCache();
  });

  describe("d1-token", () => {
    it("passes full-scope d1-token WITHOUT calling the roster store", async () => {
      const app = createTestApp(makeD1Token("full"));
      const { status } = await fetchStatus(app);
      expect(status).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it('denies non-full-scope d1-token (e.g. "read")', async () => {
      const app = createTestApp(makeD1Token("read"));
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });
  });

  describe("bearer session — roster lookup", () => {
    it("passes a roster member (isActiveAdmin → true)", async () => {
      mockIsActiveAdmin.mockResolvedValueOnce(true);
      const app = createTestApp(makeSessionToken());
      const { status } = await fetchStatus(app);
      expect(status).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledWith(
        "proj-1",
        "github.com",
        4242,
      );
    });

    it("denies a non-member (isActiveAdmin → false)", async () => {
      mockIsActiveAdmin.mockResolvedValueOnce(false);
      const app = createTestApp(makeSessionToken());
      expectDenied(await fetchStatus(app));
    });

    it("denies when githubUserId is null and does NOT call the lookup", async () => {
      const app = createTestApp(makeSessionToken({ githubUserId: undefined }));
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("denies when githubHost is null and does NOT call the lookup", async () => {
      const app = createTestApp(makeSessionToken({ githubHost: undefined }));
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("denies when projectId is missing/empty and does NOT call the lookup", async () => {
      const app = createTestApp(makeSessionToken(), "");
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("fails closed on D1 throw AND does not cache the error (re-queries within TTL)", async () => {
      mockIsActiveAdmin.mockRejectedValueOnce(new Error("D1 down"));
      const app1 = createTestApp(makeSessionToken());
      expectDenied(await fetchStatus(app1));

      // Second call within TTL: if the error were cached, isActiveAdmin would
      // not be invoked again. It MUST be re-invoked → call count == 2.
      mockIsActiveAdmin.mockResolvedValueOnce(true);
      const app2 = createTestApp(makeSessionToken());
      const { status } = await fetchStatus(app2);
      expect(status).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(2);
    });
  });

  describe("non-bearer / unknown kinds", () => {
    it("denies cookie-session when auto-admin flag is off", async () => {
      const app = createTestApp(makeCookieSessionToken("admin"));
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("denies workspace-session", async () => {
      const app = createTestApp(makeWorkspaceSessionToken());
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("denies an unknown token kind", async () => {
      const app = createTestApp({
        kind: "mystery",
      } as unknown as D1TokenResult);
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("denies when tokenResult is missing", async () => {
      const app = createTestApp(undefined);
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });
  });

  describe("cache semantics", () => {
    it("cross-project isolation: a positive entry for projA does NOT satisfy projB", async () => {
      // Prime projA → true (cached positive).
      mockIsActiveAdmin.mockResolvedValueOnce(true);
      const appA = createTestApp(
        makeSessionToken({ projectId: "projA" }),
        "projA",
      );
      expect((await fetchStatus(appA)).status).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(1);

      // projB with the same host/user must NOT hit projA's cache entry.
      mockIsActiveAdmin.mockResolvedValueOnce(false);
      const appB = createTestApp(
        makeSessionToken({ projectId: "projB" }),
        "projB",
      );
      expectDenied(await fetchStatus(appB));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(2);
      expect(mockIsActiveAdmin).toHaveBeenLastCalledWith(
        "projB",
        "github.com",
        4242,
      );
    });

    it("caches a positive result: a second call within TTL is served from cache", async () => {
      mockIsActiveAdmin.mockResolvedValueOnce(true);
      const app1 = createTestApp(makeSessionToken());
      expect((await fetchStatus(app1)).status).toBe(200);

      // No further mock setup; if the cache works, isActiveAdmin is not called again.
      const app2 = createTestApp(makeSessionToken());
      expect((await fetchStatus(app2)).status).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(1);
    });

    it("revokeAdminGrantInCache: DELETE semantics — post-purge allows when D1 flips to true", async () => {
      // Seed a positive cache entry by driving a passing admin request.
      mockIsActiveAdmin.mockResolvedValueOnce(true);
      const app1 = createTestApp(makeSessionToken());
      const { status: status1 } = await fetchStatus(app1);
      expect(status1).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(1);

      // Now purge the cache entry for this user.
      // cacheKey format: `${projectId}:${githubHost}:${githubUserId}` = "proj-1:github.com:4242"
      revokeAdminGrantInCache("proj-1:github.com:4242");

      // Flip the mock so D1 returns true on the NEXT lookup — proves the entry was
      // DELETED (not set to false): a set-to-false implementation would still deny.
      mockIsActiveAdmin.mockResolvedValueOnce(true);
      const app2 = createTestApp(makeSessionToken());
      const { status: status2 } = await fetchStatus(app2);
      // The cache was purged → D1 re-queried → returns true → ALLOWED.
      expect(status2).toBe(200);
      // isActiveAdmin must have been called again (fresh D1 round-trip), not served from cache.
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(2);
    });

    it("revocation observed once cached entry expires (distinct triples)", async () => {
      vi.useFakeTimers();
      try {
        const { ADMIN_GRANTS_CACHE_TTL_MS } = await import("../config");

        // Member granted → cached true.
        mockIsActiveAdmin.mockResolvedValueOnce(true);
        const app1 = createTestApp(makeSessionToken());
        expect((await fetchStatus(app1)).status).toBe(200);
        expect(mockIsActiveAdmin).toHaveBeenCalledTimes(1);

        // Advance past TTL → entry expires → re-query.
        vi.advanceTimersByTime(ADMIN_GRANTS_CACHE_TTL_MS + 1);

        mockIsActiveAdmin.mockResolvedValueOnce(false);
        const app2 = createTestApp(makeSessionToken());
        expectDenied(await fetchStatus(app2));
        expect(mockIsActiveAdmin).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// =============================================================================
// Auto-admin (repo_admin_auto_admin flag) — design Testing-Strategy cases 1-9
// =============================================================================
describe("requireProjectAdmin — auto-admin (cases 1-9)", () => {
  beforeEach(() => {
    mockIsActiveAdmin.mockReset();
    mockGetRepoAdminAutoAdmin.mockReset();
    __clearAdminGrantsCache();
    __clearProjectAutoAdminCache();
  });

  // Case 1: flag off + bearer admin + no roster ⇒ 403 (AC-2)
  it("case 1: flag off, bearer admin, no roster row ⇒ 403", async () => {
    mockIsActiveAdmin.mockResolvedValueOnce(false);
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(false); // flag off
    const app = createTestApp(makeSessionToken());
    expectDenied(await fetchStatus(app));
  });

  // Case 2: flag on + bearer admin + no roster row ⇒ next (AC-1 roster)
  it("case 2: flag on, bearer admin, no roster row ⇒ next (auto-admin)", async () => {
    mockIsActiveAdmin.mockResolvedValueOnce(false);
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true); // flag on
    const app = createTestApp(makeSessionToken());
    const { status } = await fetchStatus(app);
    expect(status).toBe(200);
  });

  // Case 3: flag on + bearer write/read ⇒ 403 (admin-only; non-admin tier never auto-admitted)
  it("case 3: flag on, bearer write permission ⇒ 403 (only admin tier auto-admitted)", async () => {
    mockIsActiveAdmin.mockResolvedValueOnce(false);
    // getRepoAdminAutoAdmin should NOT be called because permission is not "admin"
    const app = createTestApp(makeSessionToken({ permission: "write" }));
    expectDenied(await fetchStatus(app));
    // The auto-admin flag should never be read when permission != admin
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  it("case 3b: flag on, bearer read permission ⇒ 403", async () => {
    mockIsActiveAdmin.mockResolvedValueOnce(false);
    const app = createTestApp(makeSessionToken({ permission: "read" }));
    expectDenied(await fetchStatus(app));
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  // Case 4: flag on + cookie-session admin ⇒ next (Finding 5 — browser path)
  it("case 4: flag on, cookie-session admin ⇒ next (auto-admin for browser path)", async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true); // flag on
    const app = createTestApp(makeCookieSessionToken("admin"));
    const { status } = await fetchStatus(app);
    expect(status).toBe(200);
    // roster should NOT be consulted for cookie-session
    expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
  });

  // Case 5: flag off + cookie-session admin ⇒ 403 (AC-2 for cookie path)
  it("case 5: flag off, cookie-session admin ⇒ 403 (AC-2)", async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(false); // flag off
    const app = createTestApp(makeCookieSessionToken("admin"));
    expectDenied(await fetchStatus(app));
  });

  // Case 6: flag on + bearer rostered ⇒ next with NO flag read (roster short-circuits)
  it("case 6: flag on, bearer rostered ⇒ next, auto-admin flag NOT read (roster short-circuits)", async () => {
    mockIsActiveAdmin.mockResolvedValueOnce(true); // roster hit
    const app = createTestApp(makeSessionToken());
    const { status } = await fetchStatus(app);
    expect(status).toBe(200);
    // Flag must NOT be queried when roster already admits the user
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  // Case 7: D1 flag read throws ⇒ 403, not cached (re-query on 2nd call)
  it("case 7: D1 flag read throws ⇒ 403, error not cached (re-queries on 2nd call)", async () => {
    mockIsActiveAdmin.mockResolvedValue(false);
    mockGetRepoAdminAutoAdmin.mockRejectedValueOnce(new Error("D1 flag down"));
    const app1 = createTestApp(makeSessionToken());
    expectDenied(await fetchStatus(app1));
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(1);

    // 2nd call within TTL: if error were cached, getRepoAdminAutoAdmin would
    // NOT be called. It MUST be re-called → call count == 2.
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true);
    const app2 = createTestApp(makeSessionToken());
    const { status } = await fetchStatus(app2);
    expect(status).toBe(200);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(2);
  });

  // Case 8: cache hit avoids second D1 read within TTL
  it("case 8: cache hit — second auto-admin check within TTL avoids D1 re-read", async () => {
    mockIsActiveAdmin.mockResolvedValue(false);
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true); // only one D1 call expected
    const app1 = createTestApp(makeSessionToken());
    expect((await fetchStatus(app1)).status).toBe(200);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(1);

    // 2nd request: flag cached → no further D1 read
    const app2 = createTestApp(makeSessionToken());
    expect((await fetchStatus(app2)).status).toBe(200);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(1); // still 1
  });

  // Case 9: d1-token full-scope ⇒ next (regression — must not be affected by auto-admin)
  it("case 9: d1-token full-scope ⇒ next (regression, unaffected by auto-admin changes)", async () => {
    const app = createTestApp(makeD1Token("full"));
    const { status } = await fetchStatus(app);
    expect(status).toBe(200);
    expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });
});

// =============================================================================
// requireProjectAdminHttp — direct unit tests (the 9 cases from issue #101)
// =============================================================================
// Build a minimal Hono Context stub: requireProjectAdminHttp only accesses
//   c.get("tokenResult"), c.env.DB, and c.json(body, status).
// The real gate logic (including autoAdminGrants) runs without mocking it.
// =============================================================================
describe("requireProjectAdminHttp — direct gate unit tests", () => {
  beforeEach(() => {
    mockIsActiveAdmin.mockReset();
    mockGetRepoAdminAutoAdmin.mockReset();
    __clearAdminGrantsCache();
    __clearProjectAutoAdminCache();
  });

  /** Minimal Hono Context stub for requireProjectAdminHttp. */
  function makeHttpCtx(
    tokenResult: UnifiedTokenResult,
  ): import("hono").Context<{ Bindings: Env; Variables: HonoVariables }> {
    return {
      get: (key: string) => {
        if (key === "tokenResult") return tokenResult;
        return undefined;
      },
      env: mockEnv,
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { "Content-Type": "application/json" },
        }),
    } as unknown as import("hono").Context<{
      Bindings: Env;
      Variables: HonoVariables;
    }>;
  }

  function callGate(tokenResult: UnifiedTokenResult): Promise<Response | null> {
    return requireProjectAdminHttp(makeHttpCtx(tokenResult));
  }

  function expectAdmit(result: Response | null): void {
    expect(result).toBeNull();
  }

  async function expectDeny403(result: Response | null): Promise<void> {
    expect(result).not.toBeNull();
    if (result == null) return; // type narrowing guard (assertion above already fails if null)
    expect(result.status).toBe(403);
    const body = (await result.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("token-authz-denied");
  }

  // Case 1: d1-token with scopes:"full" ⇒ null (admit), NO flag read.
  it("case 1: d1-token full-scope ⇒ null (admit), auto-admin flag NOT read", async () => {
    const result = await callGate(makeD1Token("full"));
    expectAdmit(result);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  // Case 2: d1-token with scopes:"read" ⇒ 403.
  it("case 2: d1-token read-scope ⇒ 403 token-authz-denied", async () => {
    const result = await callGate(makeD1Token("read"));
    await expectDeny403(result);
  });

  // Case 3: bearer session, permission:"admin", flag ON ⇒ null (admit).
  it("case 3: bearer session admin + flag ON ⇒ null (admit)", async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true);
    const result = await callGate(makeSessionToken({ permission: "admin" }));
    expectAdmit(result);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(1);
  });

  // Case 4: bearer session, permission:"admin", flag OFF ⇒ 403.
  it("case 4: bearer session admin + flag OFF ⇒ 403", async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(false);
    const result = await callGate(makeSessionToken({ permission: "admin" }));
    await expectDeny403(result);
  });

  // Case 5: cookie-session, permission:"admin", flag ON ⇒ null (admit, browser→mint path).
  it("case 5: cookie-session admin + flag ON ⇒ null (admit, browser path)", async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true);
    const result = await callGate(makeCookieSessionToken("admin"));
    expectAdmit(result);
  });

  // Case 6: cookie-session, permission:"admin", flag OFF ⇒ 403.
  it("case 6: cookie-session admin + flag OFF ⇒ 403", async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(false);
    const result = await callGate(makeCookieSessionToken("admin"));
    await expectDeny403(result);
  });

  // Case 7: bearer session, permission:"write", flag ON ⇒ 403 (only admin tier).
  it("case 7: bearer session write + flag ON ⇒ 403 (non-admin tier never admitted)", async () => {
    // autoAdminGrants returns false for non-admin permission without querying D1.
    const result = await callGate(makeSessionToken({ permission: "write" }));
    await expectDeny403(result);
    // autoAdminGrants must short-circuit before reading the flag
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  // Case 8: workspace-session (empty projectId) ⇒ 403 (fail-closed).
  it("case 8: workspace-session ⇒ 403 (fail-closed)", async () => {
    const result = await callGate(makeWorkspaceSessionToken());
    await expectDeny403(result);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  // Case 9: regression-proof of kind-discriminated check.
  // A cookie-session whose `scopes` field happens to be "full" but has
  // `permission:"read"` and flag OFF must NOT be admitted — proves the gate
  // uses `kind === "d1-token" && scopes === "full"`, not a bare `scopes === "full"`.
  it('case 9 (regression): non-d1-token with scopes:"full" but permission:"read" + flag OFF ⇒ 403', async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(false);
    // makeCookieSessionToken already sets scopes:"full" internally (see factory above).
    const token = makeCookieSessionToken("read");
    // Verify the scopes field is indeed "full" to confirm the regression scenario.
    expect(token.scopes).toBe("full");
    const result = await callGate(token);
    await expectDeny403(result);
  });
});

// =============================================================================
// requireD1TokenHttp — direct gate unit tests (D1-token-only strict gate)
// =============================================================================
// Reuses the makeHttpCtx stub and factory functions from the
// requireProjectAdminHttp block above. The real gate logic runs without
// mocking it — only @tila/backend-d1 is mocked (module boundary seam).
// =============================================================================
describe("requireD1TokenHttp — direct gate unit tests", () => {
  beforeEach(() => {
    mockIsActiveAdmin.mockReset();
    mockGetRepoAdminAutoAdmin.mockReset();
    __clearAdminGrantsCache();
    __clearProjectAutoAdminCache();
  });

  /** Minimal Hono Context stub for requireD1TokenHttp (same shape as requireProjectAdminHttp). */
  function makeHttpCtx(
    tokenResult: UnifiedTokenResult | undefined,
  ): import("hono").Context<{ Bindings: Env; Variables: HonoVariables }> {
    return {
      get: (key: string) => {
        if (key === "tokenResult") return tokenResult;
        return undefined;
      },
      env: mockEnv,
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { "Content-Type": "application/json" },
        }),
    } as unknown as import("hono").Context<{
      Bindings: Env;
      Variables: HonoVariables;
    }>;
  }

  async function expectDeny403D1(result: Response | null): Promise<void> {
    expect(result).not.toBeNull();
    if (result == null) return;
    expect(result.status).toBe(403);
    const body = (await result.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  }

  // Case D1: d1-token scopes:"full" ⇒ null (pass).
  it("d1-token scopes:full ⇒ null (admit)", async () => {
    const result = await requireD1TokenHttp(makeHttpCtx(makeD1Token("full")));
    expect(result).toBeNull();
    // Gate must NOT read the auto-admin flag — pure principal-shape check.
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  // Case D2: d1-token scopes:"read" ⇒ 403.
  it("d1-token scopes:read ⇒ 403 token-authz-denied", async () => {
    const result = await requireD1TokenHttp(makeHttpCtx(makeD1Token("read")));
    await expectDeny403D1(result);
  });

  // Case D3: d1-token scopes:"" (empty) ⇒ 403 (pins strict === "full").
  it('d1-token scopes:"" ⇒ 403 token-authz-denied', async () => {
    const result = await requireD1TokenHttp(makeHttpCtx(makeD1Token("")));
    await expectDeny403D1(result);
  });

  // Case D4: bearer session permission:"admin" with flag ON ⇒ 403.
  it("bearer session admin + flag ON ⇒ 403 (closed escalation)", async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true);
    const result = await requireD1TokenHttp(
      makeHttpCtx(makeSessionToken({ permission: "admin" })),
    );
    await expectDeny403D1(result);
  });

  // Case D5: cookie-session permission:"admin" scopes:"full" + flag ON ⇒ 403.
  // Proves kind-ordering: cookie carries scopes:"full" yet is denied because
  // kind === "d1-token" is checked first.
  it("cookie-session admin scopes:full + flag ON ⇒ 403 (kind checked first)", async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true);
    const cookieToken = makeCookieSessionToken("admin");
    // Confirm the cookie token carries scopes:"full" (it does — see factory).
    expect(cookieToken.scopes).toBe("full");
    const result = await requireD1TokenHttp(makeHttpCtx(cookieToken));
    await expectDeny403D1(result);
  });

  // Case D6: workspace-session ⇒ 403.
  it("workspace-session ⇒ 403 token-authz-denied", async () => {
    const result = await requireD1TokenHttp(
      makeHttpCtx(makeWorkspaceSessionToken()),
    );
    await expectDeny403D1(result);
  });

  // Case D7: undefined tokenResult ⇒ 403 AND resolves without throwing.
  // The resolves assertion is load-bearing: a regression removing the defensive
  // guard would throw synchronously on undefined.kind and fail here.
  it("undefined tokenResult ⇒ resolves to 403 (no throw)", async () => {
    const ctx = makeHttpCtx(undefined as unknown as UnifiedTokenResult);
    await expect(requireD1TokenHttp(ctx)).resolves.toBeTruthy();
    const result = await requireD1TokenHttp(ctx);
    await expectDeny403D1(result);
  });

  // Split invariant: same admin-tier session with flag ON ⇒
  //   requireProjectAdminHttp returns null (admits) AND requireD1TokenHttp returns 403.
  it("SPLIT INVARIANT: flag-on admin session admitted by requireProjectAdminHttp but denied by requireD1TokenHttp", async () => {
    // requireProjectAdminHttp reads the flag — mock it to return true.
    mockGetRepoAdminAutoAdmin.mockResolvedValue(true);
    const sessionToken = makeSessionToken({ permission: "admin" });

    const adminResult = await requireProjectAdminHttp(
      makeHttpCtx(sessionToken),
    );
    expect(adminResult).toBeNull(); // admitted by the looser gate

    // Reset cache between calls (flag cache is per-projectId).
    __clearAdminGrantsCache();
    __clearProjectAutoAdminCache();
    mockGetRepoAdminAutoAdmin.mockResolvedValue(true);

    const d1Result = await requireD1TokenHttp(makeHttpCtx(sessionToken));
    await expectDeny403D1(d1Result); // denied by the strict gate
  });
});

// Standalone autoAdminGrants function tests
describe("autoAdminGrants helper", () => {
  beforeEach(() => {
    mockGetRepoAdminAutoAdmin.mockReset();
    __clearProjectAutoAdminCache();
  });

  it("returns false for non-session kind (d1-token)", async () => {
    const result = await autoAdminGrants(
      {} as D1Database,
      makeD1Token("full"),
      "proj-1",
    );
    expect(result).toBe(false);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  it("returns false for workspace-session kind", async () => {
    const result = await autoAdminGrants(
      {} as D1Database,
      makeWorkspaceSessionToken(),
      "proj-1",
    );
    expect(result).toBe(false);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  it("returns false for admin session when projectId is empty", async () => {
    const result = await autoAdminGrants(
      {} as D1Database,
      makeSessionToken(),
      "",
    );
    expect(result).toBe(false);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  it("returns false for session with non-admin permission (write)", async () => {
    const result = await autoAdminGrants(
      {} as D1Database,
      makeSessionToken({ permission: "write" }),
      "proj-1",
    );
    expect(result).toBe(false);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(0);
  });

  it("returns true for admin bearer session when flag is on", async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true);
    const result = await autoAdminGrants(
      {} as D1Database,
      makeSessionToken(),
      "proj-1",
    );
    expect(result).toBe(true);
  });

  it("returns true for admin cookie-session when flag is on", async () => {
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true);
    const result = await autoAdminGrants(
      {} as D1Database,
      makeCookieSessionToken("admin"),
      "proj-1",
    );
    expect(result).toBe(true);
  });

  it("returns false (fail-closed) on D1 error, without caching", async () => {
    mockGetRepoAdminAutoAdmin.mockRejectedValueOnce(new Error("D1 error"));
    const result = await autoAdminGrants(
      {} as D1Database,
      makeSessionToken(),
      "proj-1",
    );
    expect(result).toBe(false);

    // 2nd call — error must NOT have been cached
    mockGetRepoAdminAutoAdmin.mockResolvedValueOnce(true);
    const result2 = await autoAdminGrants(
      {} as D1Database,
      makeSessionToken(),
      "proj-1",
    );
    expect(result2).toBe(true);
    expect(mockGetRepoAdminAutoAdmin).toHaveBeenCalledTimes(2);
  });
});
