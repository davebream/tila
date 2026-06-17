import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables, WorkspaceSessionTokenResult } from "../types";

// Mock github-app module -- must be declared before imports
const mockMintAppJwt = vi.fn();
const mockGetInstallationAccessToken = vi.fn();
const mockListInstallationRepositories = vi.fn();
const mockCheckUserMembership = vi.fn();

vi.mock("../lib/github-app", () => ({
  mintAppJwt: mockMintAppJwt,
  getInstallationAccessToken: mockGetInstallationAccessToken,
  listInstallationRepositories: mockListInstallationRepositories,
  checkUserMembership: mockCheckUserMembership,
}));

// Mock backend-d1 stores
const mockRegistryListAll = vi.fn();
const mockRegistryGet = vi.fn();
const mockConfigGetInstallation = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionRevoke = vi.fn();
const mockRateLimitCheck = vi.fn();
const mockAllowlistListForProject = vi.fn();

vi.mock("@tila/backend-d1", () => ({
  D1ProjectRegistry: vi.fn().mockImplementation(
    class {
      listAll = mockRegistryListAll;
      get = mockRegistryGet;
    } as unknown as () => unknown,
  ),
  GitHubAppConfigStore: vi.fn().mockImplementation(
    class {
      getInstallation = mockConfigGetInstallation;
    } as unknown as () => unknown,
  ),
  D1SessionStore: vi.fn().mockImplementation(
    class {
      create = mockSessionCreate;
      revoke = mockSessionRevoke;
    } as unknown as () => unknown,
  ),
  D1RateLimitStore: vi.fn().mockImplementation(
    class {
      check = mockRateLimitCheck;
      recordFailure = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  RepoAllowlistStore: vi.fn().mockImplementation(
    class {
      listForProject = mockAllowlistListForProject;
    } as unknown as () => unknown,
  ),
}));

// Mock session-cache
const mockInvalidateSession = vi.fn();
vi.mock("../lib/session-cache", () => ({
  invalidateSession: mockInvalidateSession,
  getSessionFromCache: vi.fn(),
  setSessionInCache: vi.fn(),
  _clearSessionCacheForTest: vi.fn(),
  _sessionCacheSizeForTest: vi.fn(),
}));

// Import after mocks
const { workspace } = await import("./workspace");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const mockDb = {
  prepare: () => ({
    bind: () => ({ run: vi.fn().mockResolvedValue(undefined) }),
  }),
};

const testEnv = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  DB: mockDb,
  PROJECT: {} as DurableObjectNamespace,
  ARTIFACTS: {} as R2Bucket,
  ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
  ASSETS: {} as Fetcher,
} as unknown as Env;

const workspaceSession: WorkspaceSessionTokenResult = {
  kind: "workspace-session",
  projectId: "",
  name: "octocat",
  scopes: "",
  tokenId: "",
  sessionHash: "abc123",
  githubLogin: "octocat",
  expiresAt: Date.now() + 3600_000,
};

function createApp(tokenResult = workspaceSession as unknown): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Inject tokenResult via middleware
  app.use("/*", async (c, next) => {
    c.set("tokenResult", tokenResult as WorkspaceSessionTokenResult);
    await next();
  });
  app.route("/api/workspace", workspace);
  return app;
}

describe("GET /api/workspace/projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMintAppJwt.mockResolvedValue("app-jwt-token");
    mockGetInstallationAccessToken.mockResolvedValue("install-token");
    mockListInstallationRepositories.mockResolvedValue([]);
    mockCheckUserMembership.mockResolvedValue("read");
    mockRegistryListAll.mockResolvedValue([]);
    mockRegistryGet.mockResolvedValue(null);
    mockConfigGetInstallation.mockResolvedValue(null);
    mockRateLimitCheck.mockResolvedValue(false);
    mockAllowlistListForProject.mockResolvedValue([]);
    mockSessionCreate.mockResolvedValue(undefined);
    mockSessionRevoke.mockResolvedValue(undefined);
    mockInvalidateSession.mockReturnValue(undefined);
  });

  it("returns projects the authenticated user has access to", async () => {
    mockRegistryListAll.mockResolvedValue([{ projectId: "proj-1" }]);
    mockConfigGetInstallation.mockResolvedValue({
      project_id: "proj-1",
      installation_id: 99,
      created_at: 0,
      created_by: "admin",
    });
    mockAllowlistListForProject.mockResolvedValue([
      {
        project_id: "proj-1",
        github_host: "github.com",
        github_owner: "org",
        github_repo: "repo",
        github_repo_id: 1,
        min_read_permission: "read",
        min_write_permission: "write",
        oidc_permission: "write",
        enabled: 1,
        created_at: 0,
        created_by: "admin",
      },
    ]);
    mockCheckUserMembership.mockResolvedValue("write");
    mockRegistryGet.mockResolvedValue({
      displayName: "Project One",
      cloudflareAccountId: "acc",
    });

    const app = createApp();
    const res = await app.request("/api/workspace/projects", {}, testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      projects: Array<{
        projectId: string;
        displayName: string;
        repos: Array<{ owner: string; repo: string; permission: string }>;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].projectId).toBe("proj-1");
    expect(body.projects[0].displayName).toBe("Project One");
    expect(body.projects[0].repos).toHaveLength(1);
    expect(body.projects[0].repos[0]).toMatchObject({
      owner: "org",
      repo: "repo",
      permission: "write",
    });
    // App JWT minted once
    expect(mockMintAppJwt).toHaveBeenCalledOnce();
    expect(mockMintAppJwt).toHaveBeenCalledWith(
      12345,
      testEnv.GITHUB_APP_PRIVATE_KEY,
    );
  });

  it("returns empty list when registry has no projects", async () => {
    mockRegistryListAll.mockResolvedValue([]);

    const app = createApp();
    const res = await app.request("/api/workspace/projects", {}, testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; projects: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.projects).toHaveLength(0);
    // No need to mint JWT when there are no projects to check
    expect(mockMintAppJwt).toHaveBeenCalledOnce();
  });

  it("does not leak the full registry when GitHub App is not configured (workspace session)", async () => {
    // SEC-4: with the App unconfigured, a workspace session (projectId "")
    // has no resolvable membership and must NOT receive the full registry.
    mockRegistryListAll.mockResolvedValue([
      { projectId: "proj-1" },
      { projectId: "proj-2" },
    ]);
    const envWithoutApp = {
      ...testEnv,
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
    } as unknown as Env;

    const app = createApp();
    const res = await app.request("/api/workspace/projects", {}, envWithoutApp);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      projects: Array<{ projectId: string }>;
    };
    expect(body.ok).toBe(true);
    // Empty: a workspace session carries no projectId, so nothing is accessible.
    expect(body.projects).toHaveLength(0);
    // The full registry must never be enumerated to the caller.
    expect(body.projects.map((p) => p.projectId)).not.toContain("proj-2");
  });

  it("returns only the token-scoped project when GitHub App is not configured", async () => {
    // SEC-4: a caller bearing a concrete projectId (e.g. a D1/bootstrap token)
    // is entitled to exactly that project — not the whole registry.
    mockRegistryListAll.mockResolvedValue([
      { projectId: "proj-1" },
      { projectId: "proj-2" },
      { projectId: "proj-3" },
    ]);
    mockRegistryGet.mockResolvedValue({
      displayName: "My Project",
      cloudflareAccountId: "acc",
    });
    const envWithoutApp = {
      ...testEnv,
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
    } as unknown as Env;

    const scopedToken = {
      kind: "d1-token",
      projectId: "proj-2",
      name: "ci-bot",
      scopes: "full",
      tokenId: "tok-1",
    };

    const app = createApp(scopedToken);
    const res = await app.request("/api/workspace/projects", {}, envWithoutApp);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      projects: Array<{
        projectId: string;
        displayName: string;
        repos: unknown[];
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].projectId).toBe("proj-2");
    expect(body.projects[0].displayName).toBe("My Project");
    expect(body.projects[0].repos).toHaveLength(0);
    // Other projects in the registry must not leak.
    expect(body.projects.map((p) => p.projectId)).not.toContain("proj-1");
    expect(body.projects.map((p) => p.projectId)).not.toContain("proj-3");
  });

  it("returns partial results when one project's GitHub API call fails", async () => {
    mockRegistryListAll.mockResolvedValue([
      { projectId: "proj-ok" },
      { projectId: "proj-fail" },
    ]);
    mockConfigGetInstallation.mockImplementation(async (projectId: string) => {
      if (projectId === "proj-ok") {
        return {
          project_id: "proj-ok",
          installation_id: 10,
          created_at: 0,
          created_by: "admin",
        };
      }
      return {
        project_id: "proj-fail",
        installation_id: 20,
        created_at: 0,
        created_by: "admin",
      };
    });
    mockGetInstallationAccessToken.mockImplementation(
      async (_jwt: string, installationId: number) => {
        if (installationId === 20) throw new Error("GitHub API error");
        return "install-token-ok";
      },
    );
    mockAllowlistListForProject.mockImplementation(
      async (projectId: string) => {
        if (projectId === "proj-ok") {
          return [
            {
              project_id: "proj-ok",
              github_host: "github.com",
              github_owner: "org",
              github_repo: "repo",
              github_repo_id: 1,
              min_read_permission: "read",
              min_write_permission: "write",
              oidc_permission: "write",
              enabled: 1,
              created_at: 0,
              created_by: "admin",
            },
          ];
        }
        return [
          {
            project_id: "proj-fail",
            github_host: "github.com",
            github_owner: "org",
            github_repo: "repo",
            github_repo_id: 2,
            min_read_permission: "read",
            min_write_permission: "write",
            oidc_permission: "write",
            enabled: 1,
            created_at: 0,
            created_by: "admin",
          },
        ];
      },
    );
    mockCheckUserMembership.mockResolvedValue("read");
    mockRegistryGet.mockResolvedValue({
      displayName: "OK Project",
      cloudflareAccountId: "acc",
    });

    const app = createApp();
    const res = await app.request("/api/workspace/projects", {}, testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      projects: Array<{ projectId: string }>;
    };
    expect(body.ok).toBe(true);
    // Only the working project is returned; failed one is skipped
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].projectId).toBe("proj-ok");
  });

  it("returns empty list when user has no access to any project", async () => {
    mockRegistryListAll.mockResolvedValue([{ projectId: "proj-1" }]);
    mockConfigGetInstallation.mockResolvedValue({
      project_id: "proj-1",
      installation_id: 99,
      created_at: 0,
      created_by: "admin",
    });
    mockListInstallationRepositories.mockResolvedValue([
      { id: 1, fullName: "org/repo", owner: "org", name: "repo" },
    ]);
    // User has "none" permission on all repos
    mockCheckUserMembership.mockResolvedValue("none");

    const app = createApp();
    const res = await app.request("/api/workspace/projects", {}, testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; projects: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.projects).toHaveLength(0);
  });

  it("skips projects without a GitHub App installation configured", async () => {
    mockRegistryListAll.mockResolvedValue([
      { projectId: "proj-no-install" },
      { projectId: "proj-with-install" },
    ]);
    mockConfigGetInstallation.mockImplementation(async (projectId: string) => {
      if (projectId === "proj-with-install") {
        return {
          project_id: "proj-with-install",
          installation_id: 50,
          created_at: 0,
          created_by: "admin",
        };
      }
      return null;
    });
    mockAllowlistListForProject.mockResolvedValue([
      {
        project_id: "proj-with-install",
        github_host: "github.com",
        github_owner: "org",
        github_repo: "repo",
        github_repo_id: 1,
        min_read_permission: "read",
        min_write_permission: "write",
        oidc_permission: "write",
        enabled: 1,
        created_at: 0,
        created_by: "admin",
      },
    ]);
    mockCheckUserMembership.mockResolvedValue("admin");
    mockRegistryGet.mockResolvedValue({
      displayName: "With Install",
      cloudflareAccountId: "acc",
    });

    const app = createApp();
    const res = await app.request("/api/workspace/projects", {}, testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      projects: Array<{ projectId: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].projectId).toBe("proj-with-install");
  });
});

describe("POST /api/workspace/select", () => {
  const installationRow = {
    project_id: "proj-1",
    installation_id: 99,
    created_at: 0,
    created_by: "admin",
  };

  const allowedRepos = [
    {
      project_id: "proj-1",
      github_host: "github.com",
      github_owner: "org",
      github_repo: "repo",
      github_repo_id: 42,
      min_read_permission: "read",
      min_write_permission: "write",
      oidc_permission: "write",
      enabled: 1,
      created_at: 0,
      created_by: "admin",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockMintAppJwt.mockResolvedValue("app-jwt-token");
    mockGetInstallationAccessToken.mockResolvedValue("install-token");
    mockListInstallationRepositories.mockResolvedValue([]);
    mockCheckUserMembership.mockResolvedValue("write");
    mockRegistryListAll.mockResolvedValue([]);
    mockRegistryGet.mockResolvedValue(null);
    mockConfigGetInstallation.mockResolvedValue(installationRow);
    mockRateLimitCheck.mockResolvedValue(false);
    mockAllowlistListForProject.mockResolvedValue(allowedRepos);
    mockSessionCreate.mockResolvedValue(undefined);
    mockSessionRevoke.mockResolvedValue(undefined);
    mockInvalidateSession.mockReturnValue(undefined);
  });

  it("returns 200 with new cookie and full scopes when user has write access", async () => {
    mockCheckUserMembership.mockResolvedValue("write");

    const app = createApp();
    const res = await app.request(
      "/api/workspace/select",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "proj-1" }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      projectId: string;
      scopes: string;
    };
    expect(body.ok).toBe(true);
    expect(body.projectId).toBe("proj-1");
    expect(body.scopes).toBe("full");

    // Cookie should be set
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("tila_session=");

    // Old session should be revoked and evicted
    expect(mockSessionRevoke).toHaveBeenCalledWith("abc123");
    expect(mockInvalidateSession).toHaveBeenCalledWith("abc123");

    // New session should be created with correct scopes and projectId
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        scopes: "full",
        actorName: "octocat",
      }),
    );
  });

  it("returns 400 when session is not a workspace-session", async () => {
    const nonWorkspaceToken = {
      kind: "cookie-session",
      projectId: "proj-1",
      name: "octocat",
      scopes: "full",
      tokenId: "",
      sessionHash: "abc123",
      expiresAt: Date.now() + 3600_000,
    };

    const app = createApp(nonWorkspaceToken);
    const res = await app.request(
      "/api/workspace/select",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "proj-1" }),
      },
      testEnv,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_SESSION");
  });

  it("returns 400 when project_id is missing", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/workspace/select",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      testEnv,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when project_id exceeds the size cap", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/workspace/select",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "p".repeat(129) }),
      },
      testEnv,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns read scopes when user has only read permission", async () => {
    mockCheckUserMembership.mockResolvedValue("read");

    const app = createApp();
    const res = await app.request(
      "/api/workspace/select",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "proj-1" }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      projectId: string;
      scopes: string;
    };
    expect(body.ok).toBe(true);
    expect(body.scopes).toBe("read");

    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: "read" }),
    );
  });

  it("returns 403 when user has no access to any repo", async () => {
    mockCheckUserMembership.mockResolvedValue("none");

    const app = createApp();
    const res = await app.request(
      "/api/workspace/select",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "proj-1" }),
      },
      testEnv,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 404 when project has no GitHub App installation", async () => {
    mockConfigGetInstallation.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "/api/workspace/select",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "proj-unknown" }),
      },
      testEnv,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("checks rate limit with correct key", async () => {
    const envWithIp = {
      ...testEnv,
    } as unknown as Env;

    // Build a custom app that injects CF-Connecting-IP header
    const appWithIp = new Hono<AppEnv>();
    appWithIp.use("/*", async (c, next) => {
      c.set(
        "tokenResult",
        workspaceSession as unknown as WorkspaceSessionTokenResult,
      );
      await next();
    });
    appWithIp.route("/api/workspace", workspace);

    mockCheckUserMembership.mockResolvedValue("write");

    // Mock rate limit to return true (limited)
    mockRateLimitCheck.mockResolvedValue(true);

    const res = await appWithIp.request(
      "/api/workspace/select",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "1.2.3.4",
        },
        body: JSON.stringify({ project_id: "proj-1" }),
      },
      envWithIp,
    );

    expect(res.status).toBe(429);
    expect(mockRateLimitCheck).toHaveBeenCalledWith(
      "workspace-select:1.2.3.4",
      20,
      60_000,
    );
  });
});
