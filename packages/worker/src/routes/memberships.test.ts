import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";

// ─── Store mocks ─────────────────────────────────────────────────────────────
const store = vi.hoisted(() => ({
  list: vi.fn(),
  grant: vi.fn(),
  getById: vi.fn(),
  countActiveOwners: vi.fn(),
  updateRole: vi.fn(),
  revoke: vi.fn(),
  getMode: vi.fn(),
  setMode: vi.fn(),
  listEvents: vi.fn(),
  listAccessPolicies: vi.fn(),
}));

vi.mock("@tila/backend-d1", () => ({
  ProjectMembershipStore: class {
    list = store.list;
    grant = store.grant;
    getById = store.getById;
    countActiveOwners = store.countActiveOwners;
    updateRole = store.updateRole;
    revoke = store.revoke;
    getMode = store.getMode;
    setMode = store.setMode;
    listEvents = store.listEvents;
  },
  RepoAllowlistStore: class {
    listAccessPolicies = store.listAccessPolicies;
  },
}));

const { memberships } = await import("./memberships");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const NOW = 1_700_000_000_000;
const env = { DB: {} as D1Database } as Env;

const MEMBERSHIP = {
  membership_id: "m-1",
  project_id: "proj-1",
  principal_id: "github:github.com:2",
  provider: "github",
  identity_host: "github.com",
  subject_id: "2",
  subject_kind: "human",
  role: "participant",
  display_name: "hubot",
  granted_by: "github:github.com:1",
  granted_at: NOW,
  revoked_by: null,
  revoked_at: null,
};

function ownerCookie(
  overrides: Partial<
    Extract<UnifiedTokenResult, { kind: "cookie-session" }>
  > = {},
): UnifiedTokenResult {
  return {
    kind: "cookie-session",
    projectId: "proj-1",
    name: "octocat",
    scopes: "admin",
    tokenId: "",
    sessionHash: "hash-1",
    expiresAt: NOW + 3_600_000,
    permission: "admin",
    principalId: "github:github.com:1",
    role: "owner",
    membershipSources: ["explicit"],
    authenticatedAt: NOW - 1_000,
    authMethod: "github",
    ...overrides,
  };
}

/** Mount the router behind the context the project middleware chain provides. */
function appFor(
  token: UnifiedTokenResult,
  roles: { effective?: string; explicit?: string } = {
    effective: "owner",
    explicit: "owner",
  },
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", token);
    c.set("projectId", "proj-1");
    c.set("principalId", "github:github.com:1");
    if (roles.effective) c.set("effectiveRole", roles.effective as never);
    if (roles.explicit) c.set("explicitRole", roles.explicit as never);
    await next();
  });
  app.route("/", memberships);
  return (path: string, init: RequestInit = {}) => app.request(path, init, env);
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const fn of Object.values(store)) fn.mockReset();
  store.list.mockResolvedValue([MEMBERSHIP]);
  store.grant.mockResolvedValue({ membership: MEMBERSHIP, created: true });
  store.getById.mockResolvedValue(MEMBERSHIP);
  store.countActiveOwners.mockResolvedValue(2);
  store.updateRole.mockResolvedValue({ ...MEMBERSHIP, role: "maintainer" });
  store.revoke.mockResolvedValue({
    membership: { ...MEMBERSHIP, revoked_at: NOW },
    revokedSessions: 1,
  });
  store.getMode.mockResolvedValue("explicit");
  store.setMode.mockResolvedValue(true);
  store.listEvents.mockResolvedValue([]);
  store.listAccessPolicies.mockResolvedValue([]);
});

describe("memberships routes", () => {
  describe("owner with a fresh cookie session", () => {
    it("lists, grants, changes and revokes memberships", async () => {
      const call = appFor(ownerCookie());

      const list = await call("/memberships");
      expect(list.status).toBe(200);
      expect(
        ((await list.json()) as { memberships: unknown[] }).memberships,
      ).toHaveLength(1);

      const grant = await call(
        "/memberships",
        json({
          principal: { provider: "github", user_id: 2, login: "hubot" },
          subject_kind: "human",
          role: "participant",
          display_name: "hubot",
        }),
      );
      expect(grant.status).toBe(201);
      expect(store.grant).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "proj-1", role: "participant" }),
      );

      const patch = await call("/memberships/m-1", {
        ...json({ role: "maintainer" }),
        method: "PATCH",
      });
      expect(patch.status).toBe(200);

      const del = await call("/memberships/m-1", { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(
        ((await del.json()) as { revokedSessions: number }).revokedSessions,
      ).toBe(1);
    });

    it("rejects demoting or revoking the last owner with last-owner", async () => {
      store.getById.mockResolvedValue({ ...MEMBERSHIP, role: "owner" });
      store.countActiveOwners.mockResolvedValue(1);
      const call = appFor(ownerCookie());
      const res = await call("/memberships/m-1", { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("last-owner");
    });

    it("reads and updates the membership policy mode", async () => {
      const call = appFor(ownerCookie());
      expect((await call("/membership-policy")).status).toBe(200);
      const put = await call("/membership-policy", {
        ...json({ mode: "hybrid" }),
        method: "PUT",
      });
      expect(put.status).toBe(200);
      expect(store.setMode).toHaveBeenCalledWith(
        "proj-1",
        "hybrid",
        "github:github.com:1",
      );
    });
  });

  describe("step-up reauthentication", () => {
    const stale = () => ownerCookie({ authenticatedAt: NOW - 601_000 });

    it("blocks mutations from a stale cookie session but still serves reads", async () => {
      const call = appFor(stale());
      expect((await call("/memberships")).status).toBe(200);
      expect((await call("/membership-policy")).status).toBe(200);

      for (const [path, init] of [
        ["/memberships", json({})],
        ["/memberships/m-1", { ...json({ role: "viewer" }), method: "PATCH" }],
        ["/memberships/m-1", { method: "DELETE" }],
        [
          "/membership-policy",
          { ...json({ mode: "explicit" }), method: "PUT" },
        ],
      ] as const) {
        const res = await call(path, init as RequestInit);
        expect(res.status).toBe(403);
        const body = (await res.json()) as {
          error: { code: string; details: { max_age_seconds: number } };
        };
        expect(body.error.code).toBe("step-up-required");
        expect(body.error.details.max_age_seconds).toBe(600);
      }
      expect(store.grant).not.toHaveBeenCalled();
      expect(store.updateRole).not.toHaveBeenCalled();
      expect(store.revoke).not.toHaveBeenCalled();
      expect(store.setMode).not.toHaveBeenCalled();
    });

    it("denies a maintainer before revealing the step-up window", async () => {
      const call = appFor(
        ownerCookie({ role: "maintainer", authenticatedAt: 0 }),
        { effective: "maintainer", explicit: "maintainer" },
      );
      const res = await call("/memberships", { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("permission-denied");
    });

    it("exempts a full D1 bootstrap token", async () => {
      const call = appFor(
        {
          kind: "d1-token",
          projectId: "proj-1",
          name: "bootstrap",
          scopes: "full",
          tokenId: "tok-1",
        },
        {},
      );
      const res = await call("/memberships/m-1", { method: "DELETE" });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /membership-repos", () => {
    it("projects each linked repository's mirrored-membership policy", async () => {
      store.listAccessPolicies.mockResolvedValue([
        {
          repo: {
            github_host: "github.com",
            github_owner: "acme",
            github_repo: "widgets",
            github_repo_id: 12345,
          },
          policy: {
            min_read_permission: "read",
            min_write_permission: "write",
            max_permission: "admin",
            membership_enabled: true,
            membership_role_cap: "maintainer",
          },
        },
      ]);
      const call = appFor(ownerCookie());
      const res = await call("/membership-repos");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        repos: [
          {
            github_host: "github.com",
            github_repo_id: 12345,
            owner: "acme",
            repo: "widgets",
            membership_enabled: true,
            membership_role_cap: "maintainer",
          },
        ],
      });
      expect(store.listAccessPolicies).toHaveBeenCalledWith("proj-1");
    });

    it("requires owner authority", async () => {
      const call = appFor(ownerCookie({ role: "maintainer" }), {
        effective: "maintainer",
        explicit: "maintainer",
      });
      expect((await call("/membership-repos")).status).toBe(403);
    });
  });
});
