/**
 * Unit tests for applyAdminGrant shared helper.
 *
 * Covers: direct-id grant, idempotent re-grant, validation-error, login path
 * with GitHub App not configured (422), login path success, github-user-not-found
 * (404), github-error (502).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Stateful in-memory AdminGrantsStore mock ────────────────────────────────
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

const storeState: {
  grants: MockGrantRow[];
  installation: { installation_id: number } | null;
  getUserByLogin: (...args: unknown[]) => unknown;
} = {
  grants: [],
  installation: { installation_id: 42 },
  getUserByLogin: () => Promise.resolve(null),
};

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
  };
});

vi.mock("./github-client", () => ({
  getUserByLogin: (...args: unknown[]) => storeState.getUserByLogin(...args),
}));

vi.mock("./github-app", () => ({
  mintAppJwt: async () => "mock-app-jwt",
  getInstallationAccessToken: async () => "mock-installation-token",
}));

import type { Env } from "../types";
import { applyAdminGrant } from "./admin-grant";

const mockEnv: Partial<Env> = {
  DB: {} as D1Database,
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "mock-private-key",
};

const mockEnvNoApp: Partial<Env> = {
  DB: {} as D1Database,
};

beforeEach(() => {
  storeState.grants = [];
  storeState.installation = { installation_id: 42 };
  storeState.getUserByLogin = vi.fn();
});

// ─────────────────────────────────────────────────────────────────────────────
// Direct github_user_id path
// ─────────────────────────────────────────────────────────────────────────────
describe("applyAdminGrant — direct github_user_id path", () => {
  it("grants a new admin → ok:true, granted:true, outcome:success, status:200", async () => {
    const result = await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { github_user_id: 1001 },
      null,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.githubUserId).toBe(1001);
      expect(result.granted).toBe(true);
      expect(result.outcome).toBe("success");
      expect(result.status).toBe(200);
    }
  });

  it("idempotent re-grant → ok:true, granted:false, outcome:success", async () => {
    await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { github_user_id: 1001 },
      null,
    );
    const result = await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { github_user_id: 1001 },
      null,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.granted).toBe(false);
      expect(result.outcome).toBe("success");
    }
  });

  it("sets grantedByUserId on the store row when non-null", async () => {
    await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { github_user_id: 2002 },
      8888,
    );
    const row = storeState.grants.find((r) => r.github_user_id === 2002);
    expect(row?.granted_by_user_id).toBe(8888);
  });

  it("sets grantedByUserId to null when null is passed (infra-seeded)", async () => {
    await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { github_user_id: 3003 },
      null,
    );
    const row = storeState.grants.find((r) => r.github_user_id === 3003);
    expect(row?.granted_by_user_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation-error path
// ─────────────────────────────────────────────────────────────────────────────
describe("applyAdminGrant — validation-error", () => {
  it("missing both fields → ok:false, outcome:validation-error, status:400", async () => {
    const result = await applyAdminGrant(mockEnv as Env, "proj-a", {}, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("validation-error");
      expect(result.status).toBe(400);
    }
  });

  it("both fields present → ok:false, outcome:validation-error, status:400", async () => {
    const result = await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { github_user_id: 1, login: "alice" },
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("validation-error");
      expect(result.status).toBe(400);
    }
  });

  it("invalid login format → ok:false, outcome:validation-error, status:400 (no GitHub call)", async () => {
    const result = await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { login: "invalid login with spaces" },
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("validation-error");
      expect(result.status).toBe(400);
    }
    expect(storeState.getUserByLogin).not.toHaveBeenCalled();
  });

  it("login starting with hyphen → validation-error, no GitHub call", async () => {
    const result = await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { login: "-badlogin" },
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("validation-error");
    }
    expect(storeState.getUserByLogin).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Login path — GitHub App not configured
// ─────────────────────────────────────────────────────────────────────────────
describe("applyAdminGrant — login path, GitHub App not configured", () => {
  it("no App secrets → ok:false, outcome:login-unresolved, status:422", async () => {
    const result = await applyAdminGrant(
      mockEnvNoApp as Env,
      "proj-a",
      { login: "alice" },
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("login-unresolved");
      expect(result.status).toBe(422);
    }
  });

  it("no installation row → ok:false, outcome:login-unresolved, status:422", async () => {
    storeState.installation = null;
    const result = await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { login: "alice" },
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("login-unresolved");
      expect(result.status).toBe(422);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Login path — success
// ─────────────────────────────────────────────────────────────────────────────
describe("applyAdminGrant — login path, success", () => {
  it("resolves login, grants admin, stores snapshot", async () => {
    (
      storeState.getUserByLogin as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      login: "alice",
      id: 7777,
    });
    const result = await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { login: "alice" },
      null,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.githubUserId).toBe(7777);
      expect(result.granted).toBe(true);
      expect(result.outcome).toBe("success");
    }
    const row = storeState.grants.find((r) => r.github_user_id === 7777);
    expect(row?.github_login_snapshot).toBe("alice");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Login path — github-user-not-found (404)
// ─────────────────────────────────────────────────────────────────────────────
describe("applyAdminGrant — github-user-not-found", () => {
  it("getUserByLogin returns null → ok:false, outcome:github-user-not-found, status:404", async () => {
    (
      storeState.getUserByLogin as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);
    const result = await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { login: "ghost" },
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("github-user-not-found");
      expect(result.status).toBe(404);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Login path — github-error (502)
// ─────────────────────────────────────────────────────────────────────────────
describe("applyAdminGrant — github-error", () => {
  it("getUserByLogin throws → ok:false, outcome:github-error, status:502, retryable:true", async () => {
    (
      storeState.getUserByLogin as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("upstream failure"));
    const result = await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { login: "alice" },
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("github-error");
      expect(result.status).toBe(502);
    }
  });

  it("AbortError from getUserByLogin → ok:false, outcome:github-error, status:502", async () => {
    (
      storeState.getUserByLogin as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const result = await applyAdminGrant(
      mockEnv as Env,
      "proj-a",
      { login: "alice" },
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe("github-error");
      expect(result.status).toBe(502);
    }
  });
});
