import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CookieSessionTokenResult,
  D1TokenResult,
  Env,
  HonoVariables,
  SessionTokenResult,
  WorkspaceSessionTokenResult,
} from "../types";

// ---------------------------------------------------------------------------
// Module-level mocks for the re-verify (Layer B) test cases.
// These mocks target the same seam as permission-recheck.test.ts:
//   - @tila/backend-d1 store methods (getInstallation, isRegistered)
//   - global.fetch (used transitively by githubFetch → checkUserMembershipStatus)
//   - ./github-app (mintAppJwt, getInstallationAccessToken, GitHubAppTokenError)
// Hoisted so factories are available inside vi.mock() closures.
// ---------------------------------------------------------------------------
const {
  mockGetInstallation,
  mockIsRegistered,
  mockMintAppJwt,
  mockGetInstallationAccessToken,
} = vi.hoisted(() => ({
  mockGetInstallation: vi.fn(),
  mockIsRegistered: vi.fn(),
  mockMintAppJwt: vi.fn(),
  mockGetInstallationAccessToken: vi.fn(),
}));

vi.mock("@tila/backend-d1", () => ({
  GitHubAppConfigStore: vi.fn().mockImplementation(
    class {
      getInstallation = mockGetInstallation;
    } as unknown as () => unknown,
  ),
  RepoAllowlistStore: vi.fn().mockImplementation(
    class {
      isRegistered = mockIsRegistered;
    } as unknown as () => unknown,
  ),
  // Existing tests also need AdminGrantsStore / D1ProjectRegistry (via project.ts import in the
  // project-middleware tests at the bottom of this file)
  AdminGrantsStore: class {
    isActiveAdmin = vi.fn();
  },
  D1ProjectRegistry: class {
    getRepoAdminAutoAdmin = vi.fn();
  },
}));

vi.mock("../lib/github-app", () => ({
  mintAppJwt: mockMintAppJwt,
  getInstallationAccessToken: mockGetInstallationAccessToken,
  GitHubAppTokenError: class GitHubAppTokenError extends Error {
    readonly status: number;
    constructor(status: number, message?: string) {
      super(message ?? `GitHub API returned ${status}`);
      this.name = "GitHubAppTokenError";
      this.status = status;
    }
  },
  checkUserMembershipStatus: async (
    installationToken: string,
    owner: string,
    repo: string,
    login: string,
    apiBase = "https://api.github.com",
  ) => {
    try {
      const res = await fetch(
        `${apiBase}/repos/${owner}/${repo}/collaborators/${login}/permission`,
        { headers: { Authorization: `Bearer ${installationToken}` } },
      );
      if (res.status === 200) {
        const data = (await res.json()) as { permission: string };
        return { kind: "permission" as const, value: data.permission };
      }
      if (res.status === 404) {
        return { kind: "absent" as const };
      }
      return { kind: "error" as const };
    } catch {
      return { kind: "error" as const };
    }
  },
}));

import { _resetPermissionRecheckCacheForTest } from "../lib/permission-recheck";
import { ADMIN_PERMISSION, requirePermission } from "./permission";

// Prove ADMIN_PERMISSION is the single source of truth for the admin tier —
// a rename of the bare "admin" literal without updating this constant would
// make PERMISSION_LEVELS["admin"] === undefined (0), breaking admin routing.
describe("ADMIN_PERMISSION constant", () => {
  it("is the key used for the top-tier level in PERMISSION_LEVELS", () => {
    // Import is module-private; we verify via the exported constant's behavior
    // by asserting that requirePermission("admin") admits a session token whose
    // permission equals ADMIN_PERMISSION — and that ADMIN_PERMISSION is "admin".
    expect(ADMIN_PERMISSION).toBe("admin");
  });

  it("PERMISSION_LEVELS[ADMIN_PERMISSION] === 3 (admin is the highest level)", async () => {
    // Drive a real middleware invocation: a session with permission=ADMIN_PERMISSION
    // on an admin-level route must pass. If PERMISSION_LEVELS used a bare "admin"
    // literal instead of [ADMIN_PERMISSION], a rename of ADMIN_PERMISSION would
    // silently break this assertion.
    const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", {
        kind: "session",
        projectId: "proj-1",
        name: "u",
        scopes: ADMIN_PERMISSION,
        tokenId: "",
        githubRepoId: 1,
        githubLogin: "u",
        permission: ADMIN_PERMISSION,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      return next();
    });
    app.use("/*", requirePermission("admin"));
    app.get("/test", (c) => c.json({ ok: true }));
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
    const res = await app.fetch(
      new Request("http://localhost/test"),
      mockEnv,
      mockCtx,
    );
    expect(res.status).toBe(200);
  });
});

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
  permission: string,
  jti?: string,
): SessionTokenResult {
  return {
    kind: "session",
    projectId: "proj-1",
    name: "testuser",
    scopes: permission,
    tokenId: "",
    githubRepoId: 99999,
    githubLogin: "testuser",
    permission,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    githubHost: "github.com",
    ...(jti !== undefined ? { jti } : {}),
  };
}

function makeCookieSessionToken(
  scopes: string,
  permission = "read",
): CookieSessionTokenResult {
  return {
    kind: "cookie-session",
    projectId: "proj-1",
    name: "test-actor",
    scopes,
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

function createTestApp(
  requiredLevel: "read" | "write" | "admin",
  tokenResult:
    | D1TokenResult
    | SessionTokenResult
    | CookieSessionTokenResult
    | WorkspaceSessionTokenResult,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Inject tokenResult before the permission guard
  app.use("/*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    return next();
  });
  app.use("/*", requirePermission(requiredLevel));
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

async function fetch200or403(
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

describe("requirePermission middleware", () => {
  describe("D1 tokens", () => {
    it('allows D1 token with scopes="full" for read-level route', async () => {
      const app = createTestApp("read", makeD1Token("full"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('allows D1 token with scopes="full" for write-level route', async () => {
      const app = createTestApp("write", makeD1Token("full"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it("blocks D1 token with non-full scopes", async () => {
      const app = createTestApp("read", makeD1Token("read"));
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });
  });

  describe("session tokens", () => {
    it('allows session token with permission="read" for read-level route', async () => {
      const app = createTestApp("read", makeSessionToken("read"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('allows session token with permission="write" for read-level route', async () => {
      const app = createTestApp("read", makeSessionToken("write"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('allows session token with permission="write" for write-level route', async () => {
      const app = createTestApp("write", makeSessionToken("write"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('allows session token with permission="admin" for write-level route', async () => {
      const app = createTestApp("write", makeSessionToken("admin"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('blocks session token with permission="read" for write-level route', async () => {
      const app = createTestApp("write", makeSessionToken("read"));
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });
  });

  describe("cookie-session tokens", () => {
    it("allows cookie-session with permission=admin for read-level route", async () => {
      const app = createTestApp(
        "read",
        makeCookieSessionToken("full", "admin"),
      );
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it("allows cookie-session with permission=admin for write-level route", async () => {
      const app = createTestApp(
        "write",
        makeCookieSessionToken("full", "admin"),
      );
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it("allows cookie-session with permission=write for write-level route", async () => {
      const app = createTestApp(
        "write",
        makeCookieSessionToken("full", "write"),
      );
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it("blocks cookie-session with permission=write on admin-level route (AC-2)", async () => {
      // AC-2: a GitHub write user must NOT reach admin-gated routes via cookie
      const app = createTestApp(
        "admin",
        makeCookieSessionToken("full", "write"),
      );
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });

    it("blocks cookie-session with permission=read on write-level route", async () => {
      const app = createTestApp(
        "write",
        makeCookieSessionToken("read", "read"),
      );
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });

    it("parity: cookie write→write guard behaves same as bearer write→write (AC-1)", async () => {
      const cookieApp = createTestApp(
        "write",
        makeCookieSessionToken("full", "write"),
      );
      const bearerApp = createTestApp("write", makeSessionToken("write"));
      const cookieResult = await fetch200or403(cookieApp);
      const bearerResult = await fetch200or403(bearerApp);
      expect(cookieResult.status).toBe(bearerResult.status);
    });

    it("parity: cookie write→admin guard behaves same as bearer write→admin (AC-1, AC-2)", async () => {
      const cookieApp = createTestApp(
        "admin",
        makeCookieSessionToken("full", "write"),
      );
      const bearerApp = createTestApp("admin", makeSessionToken("write"));
      const cookieResult = await fetch200or403(cookieApp);
      const bearerResult = await fetch200or403(bearerApp);
      // Both should be 403 — write does not reach admin
      expect(cookieResult.status).toBe(403);
      expect(bearerResult.status).toBe(403);
      expect(cookieResult.status).toBe(bearerResult.status);
    });

    it("parity: cookie admin→admin guard behaves same as bearer admin→admin (AC-1)", async () => {
      const cookieApp = createTestApp(
        "admin",
        makeCookieSessionToken("full", "admin"),
      );
      const bearerApp = createTestApp("admin", makeSessionToken("admin"));
      const cookieResult = await fetch200or403(cookieApp);
      const bearerResult = await fetch200or403(bearerApp);
      // Both should be 200
      expect(cookieResult.status).toBe(200);
      expect(bearerResult.status).toBe(200);
    });
  });

  describe("workspace-session tokens", () => {
    it("blocks workspace-session on any project route with PROJECT_REQUIRED", async () => {
      const app = createTestApp("read", makeWorkspaceSessionToken());
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "project-required",
      );
    });

    it("blocks workspace-session on write-level route with PROJECT_REQUIRED", async () => {
      const app = createTestApp("write", makeWorkspaceSessionToken());
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "project-required",
      );
    });

    it("blocks workspace-session on admin-level route with PROJECT_REQUIRED", async () => {
      const app = createTestApp("admin", makeWorkspaceSessionToken());
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "project-required",
      );
    });
  });

  describe("admin level", () => {
    it('allows D1 token with scopes="full" for admin-level route', async () => {
      const app = createTestApp("admin", makeD1Token("full"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('allows session token with permission="admin" for admin-level route', async () => {
      const app = createTestApp("admin", makeSessionToken("admin"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('blocks session token with permission="write" on admin-level route', async () => {
      const app = createTestApp("admin", makeSessionToken("write"));
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });

    it('blocks session token with permission="read" on admin-level route', async () => {
      const app = createTestApp("admin", makeSessionToken("read"));
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });

    it("allows cookie-session with permission=admin for admin-level route", async () => {
      const app = createTestApp(
        "admin",
        makeCookieSessionToken("full", "admin"),
      );
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it("blocks cookie-session with permission=read on admin-level route", async () => {
      const app = createTestApp(
        "admin",
        makeCookieSessionToken("read", "read"),
      );
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });
  });
});

describe("project middleware — PROJECT_MISMATCH guard", () => {
  // Import and use projectMiddleware inline to test the mismatch guard
  it("returns 403 PROJECT_MISMATCH when session token projectId differs from route", async () => {
    const { projectMiddleware } = await import("./project");

    const mockProject = {
      idFromName: vi.fn().mockReturnValue("fake-id"),
      get: vi.fn().mockReturnValue({} as DurableObjectStub),
    } as unknown as DurableObjectNamespace;

    const projectEnv = {
      ...mockEnv,
      PROJECT: mockProject,
    } as unknown as Env;

    const tokenResult: SessionTokenResult = {
      kind: "session",
      projectId: "proj-OTHER",
      name: "testuser",
      scopes: "write",
      tokenId: "",
      githubRepoId: 99999,
      githubLogin: "testuser",
      permission: "write",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", tokenResult);
      return next();
    });
    app.use("/projects/:projectId/*", projectMiddleware);
    app.get("/projects/:projectId/entities", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/projects/proj-1/entities"),
      projectEnv,
      mockCtx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("project-mismatch");
  });

  it("passes through when session token projectId matches route", async () => {
    const { projectMiddleware } = await import("./project");

    const mockProject = {
      idFromName: vi.fn().mockReturnValue("fake-id"),
      get: vi.fn().mockReturnValue({} as DurableObjectStub),
    } as unknown as DurableObjectNamespace;

    const projectEnv = {
      ...mockEnv,
      PROJECT: mockProject,
    } as unknown as Env;

    const tokenResult: SessionTokenResult = {
      kind: "session",
      projectId: "proj-1",
      name: "testuser",
      scopes: "write",
      tokenId: "",
      githubRepoId: 99999,
      githubLogin: "testuser",
      permission: "write",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", tokenResult);
      return next();
    });
    app.use("/projects/:projectId/*", projectMiddleware);
    app.get("/projects/:projectId/entities", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/projects/proj-1/entities"),
      projectEnv,
      mockCtx,
    );
    expect(res.status).toBe(200);
  });

  it("returns 403 PROJECT_MISMATCH when D1 token projectId differs from route", async () => {
    const { projectMiddleware } = await import("./project");

    const mockProject = {
      idFromName: vi.fn().mockReturnValue("fake-id"),
      get: vi.fn().mockReturnValue({} as DurableObjectStub),
    } as unknown as DurableObjectNamespace;

    const projectEnv = {
      ...mockEnv,
      PROJECT: mockProject,
    } as unknown as Env;

    const tokenResult: D1TokenResult = {
      kind: "d1-token",
      projectId: "proj-DIFFERENT",
      name: "my-token",
      scopes: "full",
      tokenId: "tok-uuid",
    };

    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", tokenResult);
      return next();
    });
    app.use("/projects/:projectId/*", projectMiddleware);
    app.get("/projects/:projectId/entities", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/projects/proj-1/entities"),
      projectEnv,
      mockCtx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("project-mismatch");
  });
});

// =============================================================================
// requirePermission + Layer B re-verify integration (Task 7, WI-H)
// Seam: vi.mock("@tila/backend-d1") + vi.mock("../lib/github-app") + global.fetch
// Reset _resetPermissionRecheckCacheForTest between cases.
// =============================================================================

/**
 * Build a Hono app with the full re-verify env (includes GITHUB_APP_* secrets)
 * and a given token. Supports any HTTP method so DELETE routes can be exercised.
 */
function createRecheckApp(
  requiredLevel: "read" | "write" | "admin",
  tokenResult:
    | D1TokenResult
    | SessionTokenResult
    | CookieSessionTokenResult
    | WorkspaceSessionTokenResult,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    return next();
  });
  app.use("/*", requirePermission(requiredLevel));
  app.get("/test", (c) => c.json({ ok: true }));
  app.delete("/test", (c) => c.json({ ok: true }));
  app.post("/test", (c) => c.json({ ok: true }));
  return app;
}

/** Env that includes App secrets so re-verify can proceed */
const recheckEnv = {
  DB: {} as D1Database,
  PROJECT: {} as DurableObjectNamespace,
  ARTIFACTS: {} as R2Bucket,
  ANALYTICS: {} as AnalyticsEngineDataset,
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "FAKE_KEY",
} as unknown as Env;

async function fetchWithMethod(
  app: Hono<AppEnv>,
  method: "GET" | "DELETE" | "POST",
): Promise<{ status: number; body: unknown }> {
  const res = await app.fetch(
    new Request("http://localhost/test", { method }),
    recheckEnv,
    mockCtx,
  );
  const body = await res.json();
  return { status: res.status, body };
}

describe("requirePermission — Layer B re-verify (recheckInScope)", () => {
  beforeEach(() => {
    _resetPermissionRecheckCacheForTest();
    mockGetInstallation.mockReset();
    mockIsRegistered.mockReset();
    mockMintAppJwt.mockReset();
    mockGetInstallationAccessToken.mockReset();
    vi.restoreAllMocks();
  });

  // Helpers shared across cases
  function setupRevokedGitHubAccess(): void {
    // GitHub now returns 404 (user no longer a collaborator)
    mockGetInstallation.mockResolvedValue({ installation_id: 99 });
    mockIsRegistered.mockResolvedValue({
      github_owner: "myorg",
      github_repo: "myrepo",
    });
    mockMintAppJwt.mockResolvedValue("app-jwt");
    mockGetInstallationAccessToken.mockResolvedValue("install-token");
    // global.fetch returns 404 → checkUserMembershipStatus → {kind:"absent"}
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 404 }),
    );
  }

  function setupStillAdmin(): void {
    // GitHub returns 200 with admin permission
    mockGetInstallation.mockResolvedValue({ installation_id: 99 });
    mockIsRegistered.mockResolvedValue({
      github_owner: "myorg",
      github_repo: "myrepo",
    });
    mockMintAppJwt.mockResolvedValue("app-jwt");
    mockGetInstallationAccessToken.mockResolvedValue("install-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ permission: "admin" }), { status: 200 }),
    );
  }

  it("admin route + session with jti + revoked GitHub access → 403 permission-revoked", async () => {
    setupRevokedGitHubAccess();
    const session = makeSessionToken("admin", "jti-revoked-1");
    const app = createRecheckApp("admin", session);
    const { status, body } = await fetchWithMethod(app, "GET");
    expect(status).toBe(403);
    expect((body as { error: { code: string } }).error.code).toBe(
      "permission-revoked",
    );
  });

  it("admin route + session with jti + still admin on GitHub → 200 (next)", async () => {
    setupStillAdmin();
    const session = makeSessionToken("admin", "jti-still-admin-1");
    const app = createRecheckApp("admin", session);
    const { status } = await fetchWithMethod(app, "GET");
    expect(status).toBe(200);
  });

  it("write+DELETE route + session with jti + revoked GitHub access → 403 permission-revoked", async () => {
    setupRevokedGitHubAccess();
    const session = makeSessionToken("write", "jti-delete-revoked-1");
    const app = createRecheckApp("write", session);
    const { status, body } = await fetchWithMethod(app, "DELETE");
    expect(status).toBe(403);
    expect((body as { error: { code: string } }).error.code).toBe(
      "permission-revoked",
    );
  });

  it("write+POST route + session with jti → no re-verify, passes on snapshot alone", async () => {
    // No D1/GitHub mocks needed — re-verify must NOT fire for POST on write route
    const session = makeSessionToken("write", "jti-post-1");
    const app = createRecheckApp("write", session);
    const { status } = await fetchWithMethod(app, "POST");
    expect(status).toBe(200);
    // getInstallation must not be called (no re-verify)
    expect(mockGetInstallation).not.toHaveBeenCalled();
  });

  it("d1-token admin path: no re-verify (d1-token branch unchanged)", async () => {
    const app = createRecheckApp("admin", makeD1Token("full"));
    const { status } = await fetchWithMethod(app, "GET");
    expect(status).toBe(200);
    expect(mockGetInstallation).not.toHaveBeenCalled();
  });

  it("cookie-session admin path: no re-verify (cookie branch unchanged)", async () => {
    const app = createRecheckApp(
      "admin",
      makeCookieSessionToken("full", "admin"),
    );
    const { status } = await fetchWithMethod(app, "GET");
    expect(status).toBe(200);
    expect(mockGetInstallation).not.toHaveBeenCalled();
  });

  it("session without jti: no re-verify (pre-C9 token passes on snapshot)", async () => {
    // no jti set → reverifySessionPermission skips re-check
    const session = makeSessionToken("admin"); // no jti
    const app = createRecheckApp("admin", session);
    const { status } = await fetchWithMethod(app, "GET");
    expect(status).toBe(200);
    expect(mockGetInstallation).not.toHaveBeenCalled();
  });
});
