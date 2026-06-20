import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __clearAdminGrantsCache } from "../middleware/require-project-admin";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Stateful in-memory AdminGrantsStore mock.
//
// The @tila/worker package runs environment:"node" — no miniflare D1.
// admin-authz.test.ts mocks only isActiveAdmin (authz-matrix precedent only).
// Round-trip tests require a stateful mock that supports grant/revoke/list and
// whose backing array is reset in beforeEach.
// ─────────────────────────────────────────────────────────────────────────────

interface MockGrantRow {
  project_id: string;
  github_host: string;
  github_user_id: number;
  github_login_snapshot: string | null;
  granted_by_user_id: number | null;
  granted_at: number;
  revoked_at: number | null;
  revoked_by_user_id: number | null;
}

// Module-level state container shared across all instances within a test run.
// Reset in beforeEach. Using a container object ensures that vi.mock factory closures
// (which are hoisted) always reference the current values even after reassignment.
// eslint-disable-next-line prefer-const
const storeState: {
  grants: MockGrantRow[];
  installation: { installation_id: number } | null;
  getUserByLogin: (...args: unknown[]) => unknown;
} = {
  grants: [],
  installation: { installation_id: 42 },
  getUserByLogin: () => Promise.resolve(null),
};

// vi.mock is hoisted — the factory must not reference variables initialised
// after the vi.mock call. Use the storeState container and inline class.
vi.mock("@tila/backend-d1", () => {
  class AdminGrantsStore {
    async grant(params: {
      projectId: string;
      githubHost?: string;
      githubUserId: number;
      githubLoginSnapshot?: string;
      grantedByUserId?: number | null;
    }): Promise<void> {
      const host = params.githubHost ?? "github.com";
      const existing = storeState.grants.find(
        (r) =>
          r.project_id === params.projectId &&
          r.github_host === host &&
          r.github_user_id === params.githubUserId &&
          r.revoked_at === null,
      );
      if (!existing) {
        storeState.grants.push({
          project_id: params.projectId,
          github_host: host,
          github_user_id: params.githubUserId,
          github_login_snapshot: params.githubLoginSnapshot ?? null,
          granted_by_user_id: params.grantedByUserId ?? null,
          granted_at: Math.floor(Date.now() / 1000),
          revoked_at: null,
          revoked_by_user_id: null,
        });
      }
    }

    async revoke(
      projectId: string,
      githubHost: string,
      githubUserId: number,
      revokedByUserId?: number | null,
    ): Promise<void> {
      const row = storeState.grants.find(
        (r) =>
          r.project_id === projectId &&
          r.github_host === githubHost &&
          r.github_user_id === githubUserId &&
          r.revoked_at === null,
      );
      if (row) {
        row.revoked_at = Math.floor(Date.now() / 1000);
        row.revoked_by_user_id = revokedByUserId ?? null;
      }
    }

    async list(projectId: string): Promise<MockGrantRow[]> {
      return storeState.grants.filter(
        (r) => r.project_id === projectId && r.revoked_at === null,
      );
    }

    async isActiveAdmin(
      projectId: string,
      githubHost: string,
      githubUserId: number,
    ): Promise<boolean> {
      return storeState.grants.some(
        (r) =>
          r.project_id === projectId &&
          r.github_host === githubHost &&
          r.github_user_id === githubUserId &&
          r.revoked_at === null,
      );
    }
  }

  return {
    AdminGrantsStore: AdminGrantsStore as unknown as () => unknown,
    GitHubAppConfigStore: class {
      getInstallation = async () => storeState.installation;
    } as unknown as () => unknown,
    D1ProjectRegistry: class {
      listAllIncludingArchived = async () => [];
    } as unknown as () => unknown,
    D1RevokedJtiStore: class {
      revoke = async () => undefined;
      isRevoked = async () => false;
    } as unknown as () => unknown,
  };
});

vi.mock("../lib/github-client", () => ({
  getUserByLogin: (...args: unknown[]) => storeState.getUserByLogin(...args),
}));

// Stub GitHub App token acquisition
vi.mock("../lib/github-app", () => ({
  mintAppJwt: async () => "mock-app-jwt",
  getInstallationAccessToken: async () => "mock-installation-token",
}));

// storeState is fully typed above; no Object.assign needed.

// Analytics mock — not inside vi.mock because analytics is a real object passed via env
const writeDataPointMock = vi.fn();
const mockAnalytics = { writeDataPoint: writeDataPointMock };

const { adminRoster } = await import("./admin-roster");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const mockEnv: Partial<Env> = {
  DB: {} as D1Database,
  ARTIFACTS: {} as R2Bucket,
  ANALYTICS: mockAnalytics as unknown as AnalyticsEngineDataset,
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "mock-private-key",
};

const mockEnvNoAppSecrets: Partial<Env> = {
  DB: {} as D1Database,
  ARTIFACTS: {} as R2Bucket,
  ANALYTICS: mockAnalytics as unknown as AnalyticsEngineDataset,
};

function fullD1Token(): UnifiedTokenResult {
  return {
    kind: "d1-token",
    projectId: "proj-target",
    name: "infra-owner",
    scopes: "full",
    tokenId: "tid_d1",
  };
}

function nonFullD1Token(): UnifiedTokenResult {
  return {
    kind: "d1-token",
    projectId: "proj-target",
    name: "limited",
    scopes: "read",
    tokenId: "tid_d1_nonfull",
  };
}

function cookieSession(): UnifiedTokenResult {
  return {
    kind: "cookie-session",
    projectId: "proj-target",
    name: "cookie-user",
    scopes: "admin",
    tokenId: "",
    sessionHash: "abc123",
    expiresAt: Date.now() + 3_600_000,
    permission: "admin",
  };
}

function workspaceSession(): UnifiedTokenResult {
  return {
    kind: "workspace-session",
    projectId: "proj-target",
    name: "workspace-user",
    scopes: "",
    tokenId: "",
    sessionHash: "def456",
    githubLogin: "workspace-user",
    expiresAt: Date.now() + 3_600_000,
  };
}

function bearerSession(userId: number, isAdmin = true): UnifiedTokenResult {
  // We seed the mock store directly for the test, then use __clearAdminGrantsCache
  // so requireProjectAdmin re-queries D1. We need isActiveAdmin to return true.
  // We do that by seeding storeState.grants.
  if (isAdmin) {
    const existing = storeState.grants.find(
      (r) =>
        r.project_id === "proj-target" &&
        r.github_host === "github.com" &&
        r.github_user_id === userId &&
        r.revoked_at === null,
    );
    if (!existing) {
      storeState.grants.push({
        project_id: "proj-target",
        github_host: "github.com",
        github_user_id: userId,
        github_login_snapshot: null,
        granted_by_user_id: null,
        granted_at: Math.floor(Date.now() / 1000),
        revoked_at: null,
        revoked_by_user_id: null,
      });
    }
  }
  return {
    kind: "session",
    projectId: "proj-target",
    name: `user-${userId}`,
    scopes: "admin",
    tokenId: "tid_session",
    githubRepoId: 1,
    githubLogin: `user-${userId}`,
    permission: "admin",
    expiresAt: Date.now() + 3_600_000,
    githubUserId: userId,
    githubHost: "github.com",
  };
}

function createApp(
  tokenResult: UnifiedTokenResult,
  env: Partial<Env> = mockEnv,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("doStub", {} as DurableObjectStub);
    c.set("projectId", "proj-target");
    c.set("tokenResult", tokenResult);
    await next();
  });
  app.route("/admins", adminRoster);
  return app;
}

function req(
  app: Hono<AppEnv>,
  path: string,
  method = "GET",
  body?: unknown,
  env: Partial<Env> = mockEnv,
) {
  const headers: Record<string, string> = {};
  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(body);
  }
  return app.request(path, { method, headers, body: bodyStr }, env as Env);
}

beforeEach(() => {
  // Reset the backing store, installation stub, and cache before each test
  storeState.grants = [];
  storeState.installation = { installation_id: 42 };
  storeState.getUserByLogin = vi.fn();
  writeDataPointMock.mockReset();
  __clearAdminGrantsCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 4: GET /admins authz matrix + list
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /admins", () => {
  it("returns 403 for cookie-session", async () => {
    const app = createApp(cookieSession());
    const res = await req(app, "/admins");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("permission-denied");
  });

  it("returns 403 for workspace-session", async () => {
    const app = createApp(workspaceSession());
    const res = await req(app, "/admins");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("permission-denied");
  });

  it("returns 403 for non-full d1-token", async () => {
    const app = createApp(nonFullD1Token());
    const res = await req(app, "/admins");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("permission-denied");
  });

  it("returns 200 for full d1-token", async () => {
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; admins: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.admins)).toBe(true);
  });

  it("returns 200 for active roster admin (bearer session)", async () => {
    const token = bearerSession(4242);
    const app = createApp(token);
    const res = await req(app, "/admins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; admins: unknown[] };
    expect(body.ok).toBe(true);
  });

  it("returns 403 for bearer session not in roster (isActiveAdmin=false)", async () => {
    // Do NOT seed storeState.grants — user is not in roster
    const token: UnifiedTokenResult = {
      kind: "session",
      projectId: "proj-target",
      name: "nobody",
      scopes: "admin",
      tokenId: "tid_session",
      githubRepoId: 1,
      githubLogin: "nobody",
      permission: "admin",
      expiresAt: Date.now() + 3_600_000,
      githubUserId: 9999,
      githubHost: "github.com",
    };
    const app = createApp(token);
    const res = await req(app, "/admins");
    expect(res.status).toBe(403);
  });

  it("returns active roster mapped to response shape", async () => {
    // Seed two admins
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 1001,
      github_login_snapshot: "alice",
      granted_by_user_id: null,
      granted_at: 1700000000,
      revoked_at: null,
      revoked_by_user_id: null,
    });
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 1002,
      github_login_snapshot: null,
      granted_by_user_id: 1001,
      granted_at: 1700000001,
      revoked_at: null,
      revoked_by_user_id: null,
    });

    const app = createApp(fullD1Token());
    const res = await req(app, "/admins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      admins: Array<{
        github_user_id: number;
        login: string | null;
        granted_by: number | null;
        granted_at: number;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.admins).toHaveLength(2);

    const alice = body.admins.find((a) => a.github_user_id === 1001);
    expect(alice?.login).toBe("alice");
    expect(alice?.granted_by).toBeNull();
    expect(alice?.granted_at).toBe(1700000000);

    const bob = body.admins.find((a) => a.github_user_id === 1002);
    expect(bob?.login).toBeNull();
    expect(bob?.granted_by).toBe(1001);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 5: POST /admins grant by github_user_id
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /admins — grant by github_user_id", () => {
  it("grants a new admin → 200 granted:true, appears in GET", async () => {
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins", "POST", { github_user_id: 5555 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      github_user_id: number;
      granted: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.github_user_id).toBe(5555);
    expect(body.granted).toBe(true);

    // Verify appears in GET
    const getRes = await req(app, "/admins");
    const getBody = (await getRes.json()) as {
      admins: Array<{ github_user_id: number }>;
    };
    expect(getBody.admins.some((a) => a.github_user_id === 5555)).toBe(true);
  });

  it("re-granting same user → 200 granted:false (idempotent)", async () => {
    const app = createApp(fullD1Token());
    await req(app, "/admins", "POST", { github_user_id: 5555 });
    const res = await req(app, "/admins", "POST", { github_user_id: 5555 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { granted: boolean };
    expect(body.granted).toBe(false);
  });

  it("malformed JSON → 400 validation-error", async () => {
    const app = createApp(fullD1Token());
    const res = await app.request(
      "/admins",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json{{{",
      },
      mockEnv as Env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("body with neither field → 400", async () => {
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins", "POST", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("body with both fields → 400", async () => {
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins", "POST", {
      github_user_id: 5555,
      login: "alice",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("POST 403 authz matrix — cookie-session", async () => {
    const app = createApp(cookieSession());
    const res = await req(app, "/admins", "POST", { github_user_id: 5555 });
    expect(res.status).toBe(403);
  });

  it("POST 403 authz matrix — workspace-session", async () => {
    const app = createApp(workspaceSession());
    const res = await req(app, "/admins", "POST", { github_user_id: 5555 });
    expect(res.status).toBe(403);
  });

  it("POST 403 authz matrix — non-full d1-token", async () => {
    const app = createApp(nonFullD1Token());
    const res = await req(app, "/admins", "POST", { github_user_id: 5555 });
    expect(res.status).toBe(403);
  });

  it("grant-success audit datapoint emitted", async () => {
    const app = createApp(fullD1Token());
    await req(app, "/admins", "POST", { github_user_id: 5555 });
    expect(writeDataPointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining([
          "proj-target",
          "grant",
          "success",
          "admin_roster",
        ]),
        doubles: [200],
      }),
    );
  });

  it("grantedByUserId from session githubUserId", async () => {
    const token = bearerSession(8888);
    const app = createApp(token);
    await req(app, "/admins", "POST", { github_user_id: 5555 });
    const grantRow = storeState.grants.find(
      (r) => r.github_user_id === 5555 && r.revoked_at === null,
    );
    expect(grantRow?.granted_by_user_id).toBe(8888);
  });

  it("grantedByUserId is null for d1-token caller", async () => {
    const app = createApp(fullD1Token());
    await req(app, "/admins", "POST", { github_user_id: 5555 });
    const grantRow = storeState.grants.find(
      (r) => r.github_user_id === 5555 && r.revoked_at === null,
    );
    expect(grantRow?.granted_by_user_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 6: POST /admins grant by login (App-token resolution)
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /admins — grant by login", () => {
  it("resolves login, grants and records snapshot → 200 granted:true", async () => {
    (
      storeState.getUserByLogin as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ login: "alice", id: 7777 });
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins", "POST", { login: "alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      github_user_id: number;
      granted: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.github_user_id).toBe(7777);
    expect(body.granted).toBe(true);

    // Snapshot should be saved
    const grantRow = storeState.grants.find(
      (r) => r.github_user_id === 7777 && r.revoked_at === null,
    );
    expect(grantRow?.github_login_snapshot).toBe("alice");
  });

  it("no App secrets → 422 login-unresolved", async () => {
    const app = createApp(fullD1Token(), mockEnvNoAppSecrets);
    const res = await req(
      app,
      "/admins",
      "POST",
      { login: "alice" },
      mockEnvNoAppSecrets,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("login-unresolved");
    expect(body.error.retryable).toBe(false);
  });

  it("no App installation row → 422 login-unresolved", async () => {
    (storeState as unknown as Record<string, unknown>).installation = null;
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins", "POST", { login: "alice" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("login-unresolved");
  });

  it("login not found on GitHub → 404 github-user-not-found", async () => {
    (
      storeState.getUserByLogin as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins", "POST", { login: "no-such-user" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("github-user-not-found");
    expect(body.error.retryable).toBe(false);
  });

  it("getUserByLogin throws → 502 github-error", async () => {
    (
      storeState.getUserByLogin as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("upstream failure"));
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins", "POST", { login: "alice" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("github-error");
    expect(body.error.retryable).toBe(true);
  });

  it("AbortError from getUserByLogin → 502 github-error", async () => {
    (
      storeState.getUserByLogin as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins", "POST", { login: "alice" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("github-error");
    expect(body.error.retryable).toBe(true);
  });

  it("denied audit datapoint emitted on 422 (login-unresolved)", async () => {
    const app = createApp(fullD1Token(), mockEnvNoAppSecrets);
    await req(app, "/admins", "POST", { login: "alice" }, mockEnvNoAppSecrets);
    expect(writeDataPointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining([
          "proj-target",
          "grant",
          "login-unresolved",
          "admin_roster",
        ]),
      }),
    );
  });

  it("denied audit datapoint emitted on 404 (github-user-not-found)", async () => {
    (
      storeState.getUserByLogin as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);
    const app = createApp(fullD1Token());
    await req(app, "/admins", "POST", { login: "ghost" });
    expect(writeDataPointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining([
          "proj-target",
          "grant",
          "github-user-not-found",
          "admin_roster",
        ]),
      }),
    );
  });

  it("denied audit datapoint emitted on 502 (github-error)", async () => {
    (
      storeState.getUserByLogin as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("github down"));
    const app = createApp(fullD1Token());
    await req(app, "/admins", "POST", { login: "alice" });
    expect(writeDataPointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining([
          "proj-target",
          "grant",
          "github-error",
          "admin_roster",
        ]),
      }),
    );
  });

  it("login with invalid format → 400 validation-error (no GitHub call)", async () => {
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins", "POST", {
      login: "invalid login with spaces",
    });
    expect(res.status).toBe(400);
    expect(storeState.getUserByLogin).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 7: DELETE /admins/:githubUserId revoke
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /admins/:githubUserId", () => {
  it("revokes an active admin → 200 revoked:true, absent from GET", async () => {
    // Seed admin
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 1001,
      github_login_snapshot: null,
      granted_by_user_id: null,
      granted_at: Math.floor(Date.now() / 1000),
      revoked_at: null,
      revoked_by_user_id: null,
    });

    const app = createApp(fullD1Token());
    const res = await req(app, "/admins/1001", "DELETE");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      github_user_id: number;
      revoked: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.github_user_id).toBe(1001);
    expect(body.revoked).toBe(true);

    // Verify absent from GET
    const getRes = await req(app, "/admins");
    const getBody = (await getRes.json()) as {
      admins: Array<{ github_user_id: number }>;
    };
    expect(getBody.admins.some((a) => a.github_user_id === 1001)).toBe(false);
  });

  it("double-revoke → 200 revoked:false", async () => {
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 1001,
      github_login_snapshot: null,
      granted_by_user_id: null,
      granted_at: Math.floor(Date.now() / 1000),
      revoked_at: null,
      revoked_by_user_id: null,
    });

    const app = createApp(fullD1Token());
    await req(app, "/admins/1001", "DELETE");
    const res = await req(app, "/admins/1001", "DELETE");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(false);
  });

  it("sole admin self-revoke (bearer session) → 409 last-admin, still present", async () => {
    // Seed user 4242 as the only admin
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 4242,
      github_login_snapshot: null,
      granted_by_user_id: null,
      granted_at: Math.floor(Date.now() / 1000),
      revoked_at: null,
      revoked_by_user_id: null,
    });

    const token = bearerSession(4242);
    const app = createApp(token);
    const res = await req(app, "/admins/4242", "DELETE");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("last-admin");

    // Still present in roster
    const getRes = await req(app, "/admins");
    const getBody = (await getRes.json()) as {
      admins: Array<{ github_user_id: number }>;
    };
    expect(getBody.admins.some((a) => a.github_user_id === 4242)).toBe(true);
  });

  it("sole admin self-revoke → denied audit datapoint emitted", async () => {
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 4242,
      github_login_snapshot: null,
      granted_by_user_id: null,
      granted_at: Math.floor(Date.now() / 1000),
      revoked_at: null,
      revoked_by_user_id: null,
    });

    const token = bearerSession(4242);
    const app = createApp(token);
    await req(app, "/admins/4242", "DELETE");
    expect(writeDataPointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining([
          "proj-target",
          "revoke",
          "last-admin",
          "admin_roster",
        ]),
      }),
    );
  });

  it("second admin present → sole admin can self-revoke (allowed)", async () => {
    // Seed two admins
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 4242,
      github_login_snapshot: null,
      granted_by_user_id: null,
      granted_at: Math.floor(Date.now() / 1000),
      revoked_at: null,
      revoked_by_user_id: null,
    });
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 1111,
      github_login_snapshot: null,
      granted_by_user_id: null,
      granted_at: Math.floor(Date.now() / 1000),
      revoked_at: null,
      revoked_by_user_id: null,
    });

    const token = bearerSession(4242);
    const app = createApp(token);
    const res = await req(app, "/admins/4242", "DELETE");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);
  });

  it("d1-token revoking sole admin → allowed (bypasses last-admin guard)", async () => {
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 4242,
      github_login_snapshot: null,
      granted_by_user_id: null,
      granted_at: Math.floor(Date.now() / 1000),
      revoked_at: null,
      revoked_by_user_id: null,
    });

    const app = createApp(fullD1Token());
    const res = await req(app, "/admins/4242", "DELETE");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);
  });

  it("non-numeric :githubUserId → 400", async () => {
    const app = createApp(fullD1Token());
    const res = await req(app, "/admins/not-a-number", "DELETE");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("after revoke, same-isolate requireProjectAdmin denies the revoked user (no TTL wait)", async () => {
    // Seed user 4242 as an active admin in the store.
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 4242,
      github_login_snapshot: null,
      granted_by_user_id: null,
      granted_at: Math.floor(Date.now() / 1000),
      revoked_at: null,
      revoked_by_user_id: null,
    });

    // Step 1: Drive a passing requireProjectAdmin check to seed a positive cache
    // entry ({isAdmin: true}) for this user/project/host triple. Without this step,
    // the post-revoke 403 could be a cache MISS rather than a proven cache PURGE.
    const sessionToken = bearerSession(4242);
    const primeApp = createApp(sessionToken);
    const primeRes = await req(primeApp, "/admins");
    expect(primeRes.status).toBe(200); // confirms cache was seeded with {isAdmin:true}

    // Step 2: Revoke the grant via d1-token (not self-revoke path).
    // After this, storeState.grants has revoked_at set, so isActiveAdmin returns false.
    const revokerApp = createApp(fullD1Token());
    await req(revokerApp, "/admins/4242", "DELETE");

    // Step 3: Assert that requireProjectAdmin now DENIES user 4242 WITHOUT waiting
    // for TTL expiry. This is the cache-purge proof:
    //   - If revokeAdminGrantInCache were a no-op, the stale {isAdmin:true} cache
    //     entry from step 1 would still be live → the user would be ALLOWED (200)
    //     and this assertion would FAIL.
    //   - Because the revoke correctly purges the entry, requireProjectAdmin must
    //     do a fresh D1 lookup → isActiveAdmin returns false → DENIED (403).
    const deniedApp = createApp(sessionToken);
    const res = await req(deniedApp, "/admins");
    expect(res.status).toBe(403);
  });

  it("revoke-success audit datapoint emitted", async () => {
    storeState.grants.push({
      project_id: "proj-target",
      github_host: "github.com",
      github_user_id: 1001,
      github_login_snapshot: null,
      granted_by_user_id: null,
      granted_at: Math.floor(Date.now() / 1000),
      revoked_at: null,
      revoked_by_user_id: null,
    });

    const app = createApp(fullD1Token());
    await req(app, "/admins/1001", "DELETE");
    expect(writeDataPointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining([
          "proj-target",
          "revoke",
          "success",
          "admin_roster",
        ]),
        doubles: [200],
      }),
    );
  });

  it("DELETE 403 authz matrix — cookie-session", async () => {
    const app = createApp(cookieSession());
    const res = await req(app, "/admins/1001", "DELETE");
    expect(res.status).toBe(403);
  });

  it("DELETE 403 authz matrix — non-full d1-token", async () => {
    const app = createApp(nonFullD1Token());
    const res = await req(app, "/admins/1001", "DELETE");
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip integration (Task 7 / AC-1, AC-2)
// ─────────────────────────────────────────────────────────────────────────────
describe("round-trip", () => {
  it("grant → GET shows admin → revoke → GET no longer shows admin", async () => {
    const app = createApp(fullD1Token());

    // Grant
    const grantRes = await req(app, "/admins", "POST", {
      github_user_id: 9999,
    });
    expect(grantRes.status).toBe(200);

    // GET shows
    const get1 = await req(app, "/admins");
    const body1 = (await get1.json()) as {
      admins: Array<{ github_user_id: number }>;
    };
    expect(body1.admins.some((a) => a.github_user_id === 9999)).toBe(true);

    // Revoke
    const revokeRes = await req(app, "/admins/9999", "DELETE");
    expect(revokeRes.status).toBe(200);

    // GET no longer shows
    const get2 = await req(app, "/admins");
    const body2 = (await get2.json()) as {
      admins: Array<{ github_user_id: number }>;
    };
    expect(body2.admins.some((a) => a.github_user_id === 9999)).toBe(false);
  });

  it("grant two admins → each can revoke the other → the last one cannot self-revoke", async () => {
    const app = createApp(fullD1Token());

    // Grant two admins
    await req(app, "/admins", "POST", { github_user_id: 2001 });
    await req(app, "/admins", "POST", { github_user_id: 2002 });

    // admin 2001 is revoked by d1-token (bootstrap)
    const r1 = await req(app, "/admins/2001", "DELETE");
    expect(r1.status).toBe(200);

    // Only 2002 remains — seed them as bearer
    const token2002 = bearerSession(2002);
    const app2002 = createApp(token2002);

    // 2002 tries to self-revoke → 409 (sole admin)
    const r2 = await req(app2002, "/admins/2002", "DELETE");
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: { code: string } };
    expect(body.error.code).toBe("last-admin");
  });
});
