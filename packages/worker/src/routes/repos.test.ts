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

// Mock GitHub API client
const mockGetRepoMetadata = vi.fn();

vi.mock("../lib/github-client", () => ({
  getRepoMetadata: mockGetRepoMetadata,
}));

// Mock RepoAllowlistStore
const mockRegister = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);

vi.mock("@tila/backend-d1", () => ({
  RepoAllowlistStore: vi.fn().mockImplementation(
    class {
      register = mockRegister;
      remove = mockRemove;
    } as unknown as () => unknown,
  ),
}));

// Mock require-project-admin so we can control requireProjectAdminHttp.
const mockRequireProjectAdminHttp = vi.fn<() => Promise<Response | null>>();

vi.mock("../middleware/require-project-admin", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../middleware/require-project-admin")
    >();
  return {
    ...actual,
    requireProjectAdminHttp: mockRequireProjectAdminHttp,
  };
});

// Import after mocks
const { repos } = await import("./repos");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const mockEnv = { DB: {} } as unknown as Env;

function makeD1Token(scopes: string): D1TokenResult {
  return {
    kind: "d1-token",
    projectId: "proj-1",
    name: "admin-agent",
    scopes,
    tokenId: "tid_test",
  };
}

function makeSessionToken(permission = "admin"): SessionTokenResult {
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
    githubUserId: 4242,
    githubHost: "github.com",
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

function createApp(
  tokenResult:
    | D1TokenResult
    | SessionTokenResult
    | CookieSessionTokenResult
    | WorkspaceSessionTokenResult = makeD1Token("full"),
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    await next();
  });
  app.route("/api/repos", repos);
  return app;
}

const deny403 = () =>
  new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: "token-authz-denied",
        message:
          "Repo/token management requires full scope or an admin session",
        retryable: false,
      },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );

const successMetadata = {
  ok: true,
  status: 200,
  id: 12345,
  full_name: "test-org/test-repo",
};

describe("POST /api/repos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes
    mockRequireProjectAdminHttp.mockResolvedValue(null);
  });

  it("registers a repo successfully (201)", async () => {
    mockGetRepoMetadata.mockResolvedValue(successMetadata);

    const app = createApp();
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "test-repo" }),
      },
      mockEnv,
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      github_repo_id: number;
      full_name: string;
    };
    expect(body.ok).toBe(true);
    expect(body.github_repo_id).toBe(12345);
    expect(body.full_name).toBe("test-org/test-repo");

    expect(mockRegister).toHaveBeenCalledOnce();
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        githubHost: "github.com",
        githubOwner: "test-org",
        githubRepo: "test-repo",
        githubRepoId: 12345,
        createdBy: "admin-agent",
      }),
    );
  });

  it("returns 400 on invalid body (missing owner)", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "test-repo" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 403 for non-full scope d1-token (gate denies)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(deny403());
    const app = createApp(makeD1Token("read"));
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "test-repo" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("returns 404 when GitHub repo not found", async () => {
    mockGetRepoMetadata.mockResolvedValue({ ok: false, status: 404 });

    const app = createApp();
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "nonexistent" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("repo-not-found");
  });

  it("returns 403 when GitHub access denied", async () => {
    mockGetRepoMetadata.mockResolvedValue({ ok: false, status: 403 });

    const app = createApp();
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "private-repo" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("repo-access-denied");
  });

  it("returns 502 on other GitHub API errors", async () => {
    mockGetRepoMetadata.mockResolvedValue({ ok: false, status: 500 });

    const app = createApp();
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "test-repo" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("github-api-error");
  });

  it("handles idempotent re-registration (201)", async () => {
    mockGetRepoMetadata.mockResolvedValue(successMetadata);
    // register() is a no-op on duplicate (onConflictDoNothing)
    mockRegister.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "test-repo" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(201);
    expect(mockRegister).toHaveBeenCalledOnce();
  });

  it("passes github_token to getRepoMetadata when provided", async () => {
    mockGetRepoMetadata.mockResolvedValue({
      ok: true,
      status: 200,
      id: 99999,
      full_name: "org/private-repo",
    });

    const app = createApp();
    await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: "org",
          repo: "private-repo",
          github_token: "test-github-token-value",
        }),
      },
      mockEnv,
    );

    expect(mockGetRepoMetadata).toHaveBeenCalledWith(
      "test-github-token-value",
      "org",
      "private-repo",
      "https://api.github.com",
    );
  });
});

describe("DELETE /api/repos/:repoId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes
    mockRequireProjectAdminHttp.mockResolvedValue(null);
  });

  it("removes a repo successfully (200)", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/repos/12345",
      { method: "DELETE" },
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      github_repo_id: number;
    };
    expect(body.ok).toBe(true);
    expect(body.github_repo_id).toBe(12345);
    expect(mockRemove).toHaveBeenCalledWith("proj-1", "github.com", 12345);
  });

  it("returns 403 for non-full scope d1-token (gate denies)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(deny403());
    const app = createApp(makeD1Token("admin"));
    const res = await app.request(
      "/api/repos/12345",
      { method: "DELETE" },
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("returns 400 for non-numeric repoId", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/repos/not-a-number",
      { method: "DELETE" },
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 200 even when repo not found (idempotent delete)", async () => {
    mockRemove.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request(
      "/api/repos/99999",
      { method: "DELETE" },
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ============================================================================
// Auto-admin gate on repo routes (design Testing-Strategy cases 10-12b)
// ============================================================================
describe("repo routes — auto-admin gate (cases 10-12b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRepoMetadata.mockResolvedValue(successMetadata);
  });

  // Case 10: flag off + admin session ⇒ 403; d1-token full-scope ⇒ allowed (AC-2 baseline)
  it("case 10a: flag off + admin session ⇒ 403 at POST /api/repos (AC-2)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(deny403());
    const app = createApp(makeSessionToken("admin"));
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "test-repo" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("case 10b: d1-token full-scope ⇒ allowed at POST /api/repos (AC-2 baseline regression)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(null); // gate passes
    const app = createApp(makeD1Token("full"));
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "test-repo" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(201);
  });

  // Case 11: flag on + admin BEARER session ⇒ allowed at POST /api/repos (closes docs/07:164)
  it("case 11: flag on + admin bearer session ⇒ allowed at POST /api/repos (AC-1 registration)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(null); // gate passes (flag on)
    const app = createApp(makeSessionToken("admin"));
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "test-repo" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(201);
  });

  // Case 12: flag on + non-admin session ⇒ 403
  it("case 12: flag on + non-admin session (write permission) ⇒ 403", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(deny403());
    const app = createApp(makeSessionToken("write"));
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "test-repo" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  // Case 12b: workspace-session / empty-projectId ⇒ 403 (fail-closed contract)
  it("case 12b: workspace-session ⇒ 403 (fail-closed contract)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(deny403());
    const app = createApp(makeWorkspaceSessionToken());
    const res = await app.request(
      "/api/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test-org", repo: "test-repo" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });
});
