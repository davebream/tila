import type {
  ProjectMembership,
  ProjectMembershipMode,
  ProjectRole,
} from "@tila/schemas";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPermissionRecheckCacheForTest } from "../lib/permission-recheck";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";
import { createIdempotencyMiddleware } from "./idempotency";
import { projectMembershipMiddleware } from "./membership";
import { requirePermission } from "./permission";
import { projectMiddleware } from "./project";
import { protectedOperationMiddleware } from "./protected-operation";
import { requestIdentityMiddleware } from "./request-identity";
import { requireProjectAdmin } from "./require-project-admin";
import {
  requireProjectOwner,
  requireProjectOwnerHttp,
} from "./require-project-owner";

const mocks = vi.hoisted(() => ({
  installation: vi.fn(),
  repo: vi.fn(),
  policy: vi.fn(),
}));
vi.mock("@tila/backend-d1", async (original) => ({
  ...(await original<typeof import("@tila/backend-d1")>()),
  GitHubAppConfigStore: class {
    getInstallation = mocks.installation;
  },
  RepoAllowlistStore: class {
    isRegistered = mocks.repo;
    getAccessPolicy = mocks.policy;
  },
}));
vi.mock("../lib/github-app", async (original) => ({
  ...(await original<typeof import("../lib/github-app")>()),
  mintAppJwt: vi.fn().mockResolvedValue("app-jwt"),
}));

type AppEnv = { Bindings: Env; Variables: HonoVariables };
let mode: ProjectMembershipMode;
let explicit: ProjectMembership | null;
let dbFails: boolean;
let env: Env;
let upstream: ReturnType<typeof vi.fn>;
const handler = vi.fn();
const maintenance = vi.fn();
const replay = vi.fn();
const stored = vi.fn();

function token(
  kind: "session" | "cookie-session" | "oidc-session" = "session",
): UnifiedTokenResult {
  const base = {
    projectId: "p1",
    name: "alice",
    scopes: "admin",
    tokenId: "" as const,
    permission: "admin",
    expiresAt: Date.now() + 600_000,
  };
  if (kind === "cookie-session")
    return {
      ...base,
      kind,
      principalId: "github:github.com:42",
      sessionHash: "cookie",
      sourceRepoId: 9,
    };
  if (kind === "oidc-session")
    return {
      ...base,
      kind,
      jti: "oidc-jti",
      oidcIssuer: "https://ci.example",
      oidcSubject: "runner",
    };
  return {
    ...base,
    kind,
    jti: "bearer-jti",
    githubHost: "github.com",
    githubUserId: 42,
    githubLogin: "alice",
    githubRepoId: 9,
  };
}
function grant(role: ProjectRole, subjectKind: "human" | "service" = "human") {
  explicit = {
    role,
    subject_kind: subjectKind,
    membership_id: "membership",
  } as ProjectMembership;
}
function appFor(credential = token()) {
  const app = new Hono<AppEnv>();
  const routes = new Hono<AppEnv>();
  // Authentication has already produced a verified principal at this seam.
  routes.use("/*", async (c, next) => {
    c.set("tokenResult", credential);
    return next();
  });
  routes.use("/*", requestIdentityMiddleware());
  routes.use("/*", projectMiddleware);
  routes.use("/*", projectMembershipMiddleware());
  routes.use("/*", protectedOperationMiddleware());
  routes.use("/*", async (_c, next) => {
    maintenance();
    return next();
  });
  routes.use(
    "/*",
    createIdempotencyMiddleware({
      makeStore: () => ({
        check: replay,
        store: stored,
        reserve: vi.fn(),
        finalize: vi.fn(),
        release: vi.fn(),
      }),
    }),
  );
  const done = (c: import("hono").Context<AppEnv>) => {
    handler();
    return c.json({ ok: true });
  };
  routes.get("/tasks", requirePermission("read"), done);
  routes.post("/schema/preview", requirePermission("write"), done);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    routes.on(method, "/tasks", requirePermission("write"), done);
  routes.get("/admin", requireProjectAdmin, done);
  routes.post("/admin", requirePermission("admin"), done);
  routes.get("/doctor", requirePermission("admin"), done);
  routes.get("/governance", requireProjectOwner, done);
  routes.put("/governance", requireProjectOwner, done);
  app.route("/projects/:projectId", routes);
  app.use("/api/governance", async (c, next) => {
    c.set("tokenResult", credential);
    return next();
  });
  app.put(
    "/api/governance",
    async (c) => (await requireProjectOwnerHttp(c)) ?? done(c),
  );
  return app;
}
async function request(
  method = "POST",
  path = "/projects/p1/tasks",
  credential = token(),
  idempotency = false,
) {
  return appFor(credential).request(
    path,
    {
      method,
      headers: {
        "X-Tila-Participant-Id": "test-participant",
        "Content-Type": "application/json",
        ...(idempotency ? { "Idempotency-Key": "key" } : {}),
      },
      ...(["GET", "HEAD"].includes(method) ? {} : { body: "{}" }),
    },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetPermissionRecheckCacheForTest();
  mode = "hybrid";
  explicit = null;
  dbFails = false;
  env = {
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "key",
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            if (dbFails) throw new Error("D1 down");
            return sql.includes("membership_mode")
              ? { membership_mode: mode }
              : explicit;
          },
        }),
      }),
    },
    PROJECT: { idFromName: (name: string) => name, get: () => ({}) },
  } as unknown as Env;
  mocks.installation.mockResolvedValue({ installation_id: 1 });
  mocks.repo.mockResolvedValue({
    github_owner: "org",
    github_repo: "repo",
    min_read_permission: "read",
    min_write_permission: "write",
    max_permission: "admin",
    membership_enabled: 1,
    membership_role_cap: "maintainer",
  });
  mocks.policy.mockResolvedValue({
    status: "ok",
    policy: {
      membership_enabled: true,
      membership_role_cap: "maintainer",
      max_permission: "admin",
    },
  });
  upstream = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("access_tokens")
            ? { token: "installation-token" }
            : { permission: "admin" },
        ),
      ),
  );
  vi.stubGlobal("fetch", upstream);
  replay.mockResolvedValue(null);
  stored.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("protected operations in production middleware order", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "denies mirrored %s before maintenance, replay and mutation on GitHub outage",
    async (method) => {
      upstream.mockRejectedValue(new Error("network down"));
      const res = await request(method, undefined, undefined, true);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        error: { code: "permission-recheck-unavailable", retryable: true },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(maintenance).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
    },
  );
  it.each(["session", "cookie-session"] as const)(
    "revalidates %s for both writes and admin reads",
    async (kind) => {
      upstream.mockImplementation(
        async () => new Response("{}", { status: 404 }),
      );
      for (const [method, path] of [
        ["POST", "tasks"],
        ["GET", "admin"],
        ["GET", "doctor"],
      ]) {
        expect(
          (await request(method, `/projects/p1/${path}`, token(kind))).status,
        ).toBe(503);
      }
      expect(handler).not.toHaveBeenCalled();
    },
  );
  it("ordinary reads and read-only preview do not require GitHub or jti", async () => {
    env.GITHUB_APP_ID = undefined;
    const legacy = { ...token("session"), jti: undefined };
    expect((await request("GET", undefined, legacy)).status).toBe(200);
    expect(
      (await request("POST", "/projects/p1/schema/preview", legacy)).status,
    ).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["explicit", "hybrid", "github-mirrored"] as const)(
    "explicit owners remain independent of GitHub in %s mode",
    async (value) => {
      mode = value;
      grant("owner");
      env.GITHUB_APP_ID = undefined;
      for (const path of ["/projects/p1/governance", "/api/governance"])
        expect((await request("PUT", path)).status).toBe(200);
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it("hybrid participant writes during outage but cannot borrow mirrored admin authority", async () => {
    grant("participant");
    env.GITHUB_APP_ID = undefined;
    expect((await request()).status).toBe(200);
    expect((await request("GET", "/projects/p1/admin")).status).toBe(503);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("an explicit viewer cannot bypass verification for a mirrored write", async () => {
    grant("viewer");
    env.GITHUB_APP_ID = undefined;
    expect((await request()).status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
  it("explicit maintainers and OIDC service principals never call GitHub", async () => {
    mode = "service-only";
    grant("maintainer", "service");
    env.GITHUB_APP_ID = undefined;
    expect(
      (await request("GET", "/projects/p1/admin", token("oidc-session")))
        .status,
    ).toBe(200);
    mode = "explicit";
    grant("maintainer");
    expect((await request("GET", "/projects/p1/admin")).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["session", "oidc-session"] as const)(
    "explicit authority cannot rescue a %s without jti",
    async (kind) => {
      mode = "explicit";
      grant("owner");
      const legacy = { ...token(kind), jti: undefined };
      expect((await request("POST", undefined, legacy)).status).toBe(401);
      expect(
        (await request("GET", "/projects/p1/governance", legacy)).status,
      ).toBe(401);
      expect((await request("PUT", "/api/governance", legacy)).status).toBe(
        401,
      );
      expect(handler).not.toHaveBeenCalled();
    },
  );
  it("rejects incomplete browser identities", async () => {
    const cookie = { ...token("cookie-session"), sourceRepoId: undefined };
    expect((await request("POST", undefined, cookie)).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
  it("does not accept the token's claimed explicit membership", async () => {
    env.GITHUB_APP_ID = undefined;
    const forgedSnapshot = {
      ...token(),
      membershipSources: ["explicit" as const],
      role: "owner" as const,
    };
    expect(
      (await request("GET", "/projects/p1/admin", forgedSnapshot)).status,
    ).toBe(503);
  });
  it("observes explicit revocation and downgrade on the next request", async () => {
    mode = "explicit";
    grant("maintainer");
    expect((await request("GET", "/projects/p1/admin")).status).toBe(200);
    grant("participant");
    expect((await request("GET", "/projects/p1/admin")).status).toBe(403);
    explicit = null;
    expect((await request()).status).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("D1 resolution failure denies explicit authority without using GitHub", async () => {
    grant("owner");
    dbFails = true;
    const res = await request();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: "membership-unavailable" },
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it("admin idempotency replay cannot bypass stronger route authorization", async () => {
    replay.mockResolvedValue({
      requestHash: null,
      statusCode: 200,
      body: '{"ok":true}',
    });
    grant("participant");
    env.GITHUB_APP_ID = undefined;
    expect(
      (await request("POST", "/projects/p1/admin", undefined, true)).status,
    ).toBe(503);
    expect(replay).not.toHaveBeenCalled();
    grant("maintainer");
    const res = await request("POST", "/projects/p1/admin", undefined, true);
    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replayed")).toBe("true");
    expect(handler).not.toHaveBeenCalled();
  });
  it("full-scope bootstrap tokens preserve their authority without GitHub", async () => {
    const bootstrap: UnifiedTokenResult = {
      kind: "d1-token",
      projectId: "p1",
      name: "bootstrap",
      tokenId: "token",
      scopes: "full",
    };
    expect(
      (await request("PUT", "/projects/p1/governance", bootstrap)).status,
    ).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });
});
