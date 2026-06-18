import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";

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

// Import after mocks
const { repos } = await import("./repos");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const mockEnv = { DB: {} } as unknown as Env;

function createApp(scopes = "full"): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", {
      kind: "d1-token" as const,
      projectId: "proj-1",
      name: "admin-agent",
      scopes,
      tokenId: "tid_test",
    });
    await next();
  });
  app.route("/api/repos", repos);
  return app;
}

describe("POST /api/repos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers a repo successfully (201)", async () => {
    mockGetRepoMetadata.mockResolvedValue({
      ok: true,
      status: 200,
      id: 12345,
      full_name: "test-org/test-repo",
    });

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

  it("returns 403 for non-full scope token", async () => {
    const app = createApp("read");
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
    mockGetRepoMetadata.mockResolvedValue({
      ok: true,
      status: 200,
      id: 12345,
      full_name: "test-org/test-repo",
    });
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

  it("returns 403 for non-full scope token", async () => {
    const app = createApp("admin");
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
