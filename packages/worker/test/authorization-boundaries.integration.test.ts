import {
  type CredentialPolicy,
  GitHubExchangeResponseSchema,
  ROOT_CAPABILITIES,
} from "@tila/schemas";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GitHubAppConfigStore,
  ProjectMembershipStore,
  RepoAllowlistStore,
} from "../../backend-d1/src/index";
import { createCredentialFixture } from "../../backend-d1/test/helpers/credential-fixture";
import { generateToken, hashToken } from "../src/lib/hash";
import {
  _resetMiddlewareStateForTest,
  createAuthMiddleware,
} from "../src/middleware/auth";
import { capabilityMiddleware } from "../src/middleware/capability";
import { projectMembershipMiddleware } from "../src/middleware/membership";
import { requirePermission } from "../src/middleware/permission";
import { projectMiddleware } from "../src/middleware/project";
import { protectedOperationMiddleware } from "../src/middleware/protected-operation";
import { requestIdentityMiddleware } from "../src/middleware/request-identity";
import { requireD1Token } from "../src/routes/admin";
import { authSessionExchange } from "../src/routes/auth-session";
import { memberships } from "../src/routes/memberships";
import { serviceAccountRoutes } from "../src/routes/service-accounts";
import { tokens } from "../src/routes/tokens";
import type { Env, HonoVariables } from "../src/types";

vi.mock("../src/lib/oidc-verify", () => ({
  verifyOidcToken: async () => ({
    repository_id: 42,
    actor: "owner",
    actor_id: 7,
    sub: "repo:org/repo:ref:refs/heads/main",
    event_name: "push",
    ref: "refs/heads/main",
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 600,
  }),
  OidcVerificationError: class extends Error {},
}));
vi.mock("../src/lib/github-client", () => ({
  getAuthenticatedUser: async () => ({ id: 7, login: "owner" }),
  getRepoPermission: async () => "admin",
  exchangeOAuthCode: vi.fn(),
}));
vi.mock("../src/lib/github-app", () => ({
  mintAppJwt: async () => "app",
  getInstallationAccessToken: async () => "install",
  checkUserMembership: async () => "admin",
  checkUserMembershipStatus: async () => ({
    status: "ok",
    permission: "admin",
  }),
  GitHubAppTokenError: class extends Error {},
}));

const { authGithub, mintSessionToken } = await import(
  "../src/routes/auth-github"
);
const { workspace } = await import("../src/routes/workspace");
let f: ReturnType<typeof createCredentialFixture>;
let env: Env;
type TestEnv = { Bindings: Env; Variables: HonoVariables };
type ProjectList = { projects: { projectId: string; role: string }[] };
beforeEach(async () => {
  f = createCredentialFixture();
  _resetMiddlewareStateForTest();
  env = {
    DB: f.db,
    HASH_PEPPER: "pepper",
    GITHUB_SESSION_HMAC_KEY: btoa("test-hmac-key-this-is-32-bytes!!"),
    GITHUB_OIDC_AUDIENCE: "tila",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "fake",
    ARTIFACTS: {} as R2Bucket,
    ANALYTICS: { writeDataPoint() {} } as AnalyticsEngineDataset,
    PROJECT: {
      idFromName: (v: string) => v,
      get: () => ({ fetch: async () => new Response("{}") }),
    } as unknown as DurableObjectNamespace,
  };
  const repos = new RepoAllowlistStore(f.db);
  await repos.register({
    projectId: "p",
    githubHost: "github.com",
    githubOwner: "org",
    githubRepo: "repo",
    githubRepoId: 42,
    createdBy: "bootstrap",
    membershipEnabled: true,
    membershipRoleCap: "viewer",
    maxPermission: "admin",
  });
  f.sqlite.exec(`UPDATE _project_repos SET oidc_enabled=1, oidc_max_permission='read',
    oidc_allowed_events='["push"]', oidc_allowed_refs='["refs/heads/main"]',
    oidc_subject_pattern='repo:org/repo:ref:refs/heads/main'`);
});
afterEach(() => f.sqlite.close());
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
function app() {
  const app = new Hono<TestEnv>();
  app.route("/api/auth/github", authGithub);
  app.route("/auth/session", authSessionExchange);
  const api = new Hono<TestEnv>();
  api.use("*", createAuthMiddleware());
  api.route("/api/tokens", tokens);
  app.route("/", api);
  const project = new Hono<TestEnv>();
  project.use(
    "*",
    createAuthMiddleware(),
    requestIdentityMiddleware(),
    projectMiddleware,
    projectMembershipMiddleware(),
    capabilityMiddleware(),
    protectedOperationMiddleware(),
  );
  project.use("*", async (c, next) =>
    c.req.header("X-Test-Replay") ? c.json({ replayed: true }) : next(),
  );
  project.route("/", memberships);
  project.route("/service-accounts", serviceAccountRoutes);
  // Probe only the destructive authorization gate; never destroy resources.
  project.post(
    "/admin/destroy",
    requirePermission("admin"),
    requireD1Token,
    (c) => c.json({ destructiveGatePassed: true }),
  );
  project.get("/schema", (c) =>
    c.json({ ok: true, principal_id: c.get("principalId") }),
  );
  project.post("/tasks", (c) => c.json({ ok: true }));
  for (const [method, path] of [
    ["POST", "/admin/archive/journal"],
    ["GET", "/admin/store-counts"],
    ["POST", "/admin/sessions/revoke"],
    ["POST", "/admin/backup/d1/restore"],
    ["GET", "/admin/backup/d1"],
  ] as const)
    project.on(method, path, requirePermission("admin"), requireD1Token, (c) =>
      c.json({ rootGatePassed: true }),
    );
  app.route("/projects/:projectId", project);
  return app;
}
async function exchange(server: ReturnType<typeof app>) {
  const res = await server.request(
    "/api/auth/github/exchange-oidc",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "p",
        oidc_token: "verified-by-fixture",
      }),
    },
    env,
    ctx,
  );
  const body = GitHubExchangeResponseSchema.parse(await res.json());
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

it("does not admit an Actions workload through its actor membership", async () => {
  await new ProjectMembershipStore(f.db).grant({
    projectId: "p",
    principal: { provider: "github", host: "github.com", user_id: 7 },
    subjectKind: "human",
    role: "owner",
    actorPrincipalId: "bootstrap",
  });
  const server = app();
  const res = await server.request(
    "/api/auth/github/exchange-oidc",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p", oidc_token: "fixture" }),
    },
    env,
    ctx,
  );
  expect(res.status).toBe(403);
  expect(
    await new ProjectMembershipStore(f.db).resolve("p", "github:github.com:8"),
  ).toBeNull();
});

it("caps scoped Actions below both service membership and binding policy", async () => {
  const actor = { principalId: "bootstrap:test" };
  const service = await f.store.createService(
    "p",
    { name: "runner", display_name: "Runner", role: "owner" },
    actor,
  );
  await f.store.createBinding(
    "p",
    service.principal_id,
    {
      name: "github",
      provider: "github-actions",
      issuer: "https://token.actions.githubusercontent.com",
      subject: "repo:org/repo:ref:refs/heads/main",
      policy: { role: "owner", capabilities: ["memberships:manage"] },
    },
    actor,
  );
  const server = app();
  const issued = await exchange(server);
  expect(issued.role).toBe("viewer");
  const res = await grantAnotherOwner(server, issued.session_token);
  expect(res.status).toBe(403);
  expect(
    await new ProjectMembershipStore(f.db).resolve("p", "github:github.com:8"),
  ).toBeNull();
});

async function grantAnotherOwner(
  server: ReturnType<typeof app>,
  token: string,
) {
  return server.request(
    "/projects/p/memberships",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": "11111111-1111-4111-8111-111111111111",
      },
      body: JSON.stringify({
        principal: { provider: "github", host: "github.com", user_id: 8 },
        subject_kind: "human",
        role: "owner",
      }),
    },
    env,
    ctx,
  );
}

function workspaceApp() {
  const server = new Hono<TestEnv>();
  server.use("*", async (c, next) => {
    c.set("tokenResult", {
      kind: "workspace-session",
      name: "owner",
      scopes: "",
      tokenId: "",
      expiresAt: Date.now() + 600000,
      projectId: "",
      githubLogin: "owner",
      principalId: "github:github.com:7",
      sessionHash: "old",
      authenticatedAt: Date.now(),
    });
    return next();
  });
  server.route("/api/workspace", workspace);
  return server;
}

it("denies workspace selection for an explicit-project nonmember", async () => {
  await new GitHubAppConfigStore(f.db).setInstallation("p", 123, "bootstrap");
  const server = workspaceApp();
  const res = await server.request(
    "/api/workspace/select",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p" }),
    },
    env,
    ctx,
  );
  const body = await res.json();
  expect(res.status).toBe(403);
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM _sessions").get()).toEqual(
    { n: 0 },
  );
});

it("does not disclose explicit nonmember project metadata", async () => {
  await new GitHubAppConfigStore(f.db).setInstallation("p", 123, "bootstrap");
  f.sqlite.exec("UPDATE _projects SET display_name='Private planning'");
  const res = await workspaceApp().request(
    "/api/workspace/projects",
    {},
    env,
    ctx,
  );
  const body = (await res.json()) as ProjectList;
  expect(body.projects).toEqual([]);
  expect(
    await new ProjectMembershipStore(f.db).resolve("p", "github:github.com:7"),
  ).toBeNull();
});

it("lists explicit projects independently of App installation", async () => {
  await new ProjectMembershipStore(f.db).grant({
    projectId: "p",
    principal: { provider: "github", host: "github.com", user_id: 7 },
    subjectKind: "human",
    role: "owner",
    actorPrincipalId: "bootstrap",
  });
  const res = await workspaceApp().request(
    "/api/workspace/projects",
    {},
    env,
    ctx,
  );
  const body = (await res.json()) as ProjectList;
  expect(body.projects).toMatchObject([{ projectId: "p", role: "owner" }]);
});

it("allows owner service management but denies destructive credential delegation", async () => {
  await new ProjectMembershipStore(f.db).grant({
    projectId: "p",
    principal: { provider: "github", host: "github.com", user_id: 7 },
    subjectKind: "human",
    role: "owner",
    actorPrincipalId: "bootstrap",
  });
  const server = app();
  const issued = { session_token: await humanToken() };
  const post = (path: string, token: string, body: unknown) =>
    server.request(
      path,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Tila-Participant-Id": "11111111-1111-4111-8111-111111111111",
        },
        body: JSON.stringify(body),
      },
      env,
      ctx,
    );
  expect(
    (await post("/projects/p/admin/destroy", issued.session_token, {})).status,
  ).toBe(403);
  const serviceRes = await post(
    "/projects/p/service-accounts",
    issued.session_token,
    { name: "root-probe", display_name: "Root probe", role: "owner" },
  );
  expect(serviceRes.status).toBe(201);
  const service = (await serviceRes.json()) as {
    service_account: { principal_id: string };
  };
  const keyRes = await post("/api/tokens", issued.session_token, {
    name: "root-probe",
    principal_id: service.service_account.principal_id,
    policy: { role: "owner", capabilities: ["project:destroy"] },
  });
  expect(keyRes.status).toBe(403);
});

it("allows bounded mirrored workload reads without human membership", async () => {
  f.sqlite.exec("UPDATE _projects SET membership_mode='hybrid'");
  const server = app();
  const issued = await exchange(server);
  expect((await grantAnotherOwner(server, issued.session_token)).status).toBe(
    403,
  );
  expect(issued.principal_id).toBe(
    "oidc:https://token.actions.githubusercontent.com:repo:org/repo:ref:refs/heads/main",
  );
  expect(
    (
      await server.request(
        "/projects/p/schema",
        { headers: { Authorization: `Bearer ${issued.session_token}` } },
        env,
        ctx,
      )
    ).status,
  ).toBe(200);
});

async function humanToken(version: number | null = 2) {
  return mintSessionToken(
    {
      sub_type: "github",
      ...(version === null ? {} : { authorization_version: version }),
      project_id: "p",
      github_host: "github.com",
      github_repo_id: 42,
      github_login: "owner",
      github_user_id: 7,
      permission: "admin",
      role: "owner",
      issued_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + 600,
      jti: crypto.randomUUID(),
    },
    env.GITHUB_SESSION_HMAC_KEY ?? "",
  );
}

const actor = { principalId: "bootstrap:test" };
const workloadSubject = "repo:org/repo:ref:refs/heads/main";
const issuer = "https://token.actions.githubusercontent.com";
const participant = "11111111-1111-4111-8111-111111111111";
function authorized(
  server: ReturnType<typeof app>,
  token: string,
  path = "/projects/p/schema",
  method = "GET",
  body?: unknown,
  extra = {},
) {
  return server.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tila-Participant-Id": participant,
        "Content-Type": "application/json",
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    ctx,
  );
}
async function boundWorkload() {
  const service = await f.store.createService(
    "p",
    { name: "runner", display_name: "Runner", role: "owner" },
    actor,
  );
  const binding = await f.store.createBinding(
    "p",
    service.principal_id,
    {
      name: "ci",
      provider: "github-actions",
      issuer,
      subject: workloadSubject,
      policy: {
        role: "owner",
        capabilities: ["schema:read", "tasks:write", "memberships:manage"],
      },
    },
    actor,
  );
  return { service, binding };
}
async function grantHuman() {
  return new ProjectMembershipStore(f.db).grant({
    projectId: "p",
    principal: { provider: "github", host: "github.com", user_id: 7 },
    subjectKind: "human",
    role: "owner",
    actorPrincipalId: actor.principalId,
  });
}

it.each(["unbound", "scoped"] as const)(
  "%s workload is narrowed after issuance and never gains from policy loosening",
  async (kind) => {
    f.sqlite.exec(
      "UPDATE _projects SET membership_mode='hybrid'; UPDATE _project_repos SET oidc_max_permission='write',membership_role_cap='participant'",
    );
    if (kind === "scoped") await boundWorkload();
    const server = app();
    const issued = await exchange(server);
    expect(issued.role).toBe("participant");
    expect(
      (
        await authorized(
          server,
          issued.session_token,
          "/projects/p/tasks",
          "POST",
          {},
        )
      ).status,
    ).toBe(200);
    f.sqlite.exec("UPDATE _project_repos SET oidc_max_permission='read'");
    expect(
      (
        await authorized(
          server,
          issued.session_token,
          "/projects/p/tasks",
          "POST",
          {},
          { "X-Test-Replay": "1" },
        )
      ).status,
    ).toBe(403);
    expect((await authorized(server, issued.session_token)).status).toBe(200);
    f.sqlite.exec(
      "UPDATE _project_repos SET oidc_max_permission='admin',membership_role_cap='maintainer'",
    );
    expect((await grantAnotherOwner(server, issued.session_token)).status).toBe(
      403,
    );
  },
);

it.each(["unbound", "scoped"] as const)(
  "%s rechecks every policy condition after cache warming",
  async (kind) => {
    f.sqlite.exec("UPDATE _projects SET membership_mode='hybrid'");
    if (kind === "scoped") await boundWorkload();
    const server = app();
    const issued = await exchange(server);
    expect((await authorized(server, issued.session_token)).status).toBe(200);
    for (const sql of [
      "oidc_enabled=0",
      "oidc_allowed_events='[\"pull_request\"]'",
      "oidc_subject_pattern='other:*'",
      "oidc_allowed_refs='[\"refs/heads/other\"]'",
      "oidc_allowed_workflows='[\"other/workflow\"]'",
    ]) {
      f.sqlite.exec("SAVEPOINT changed_policy");
      f.sqlite.exec(`UPDATE _project_repos SET ${sql}`);
      expect([401, 403]).toContain(
        (
          await authorized(
            server,
            issued.session_token,
            "/projects/p/schema",
            "GET",
            undefined,
            { "X-Test-Replay": "1" },
          )
        ).status,
      );
      f.sqlite.exec("ROLLBACK TO changed_policy; RELEASE changed_policy");
    }
    f.sqlite.exec("DELETE FROM _project_repos");
    expect([401, 403]).toContain(
      (await authorized(server, issued.session_token)).status,
    );
  },
);

it("keeps explicit workload membership separate from human ownership", async () => {
  await grantHuman();
  await new ProjectMembershipStore(f.db).grant({
    projectId: "p",
    principal: { provider: "oidc", issuer, subject: workloadSubject },
    subjectKind: "service",
    role: "owner",
    actorPrincipalId: actor.principalId,
  });
  const issued = await exchange(app());
  expect(issued.role).toBe("viewer");
  const response = await authorized(app(), issued.session_token);
  expect(await response.json()).toMatchObject({
    principal_id: `oidc:${issuer}:${workloadSubject}`,
  });
  expect((await grantAnotherOwner(app(), issued.session_token)).status).toBe(
    403,
  );
});

it("denies unbound workload membership when the adapter is disabled", async () => {
  f.sqlite.exec(
    "UPDATE _projects SET membership_mode='hybrid'; UPDATE _project_repos SET membership_enabled=0",
  );
  const response = await app().request(
    "/api/auth/github/exchange-oidc",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p", oidc_token: "fixture" }),
    },
    env,
    ctx,
  );
  expect(response.status).toBe(403);
});

it("enforces current Actions policy in cookies derived from scoped credentials", async () => {
  await boundWorkload();
  const server = app();
  const issued = await exchange(server);
  const converted = await server.request(
    "/auth/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: issued.session_token, project_id: "p" }),
    },
    env,
    ctx,
  );
  expect(converted.status, await converted.clone().text()).toBe(200);
  const cookie = cookieHeader(converted);
  const read = () =>
    server.request(
      "/projects/p/schema",
      { headers: { Cookie: cookie } },
      env,
      ctx,
    );
  expect((await read()).status).toBe(200);
  f.sqlite.exec("UPDATE _project_repos SET oidc_enabled=0");
  expect([401, 403]).toContain((await read()).status);
});

it("rejects old Actions credentials without revalidation context and revoked bindings", async () => {
  const { binding } = await boundWorkload();
  const server = app();
  const issued = await exchange(server);
  expect((await authorized(server, issued.session_token)).status).toBe(200);
  f.sqlite.exec("SAVEPOINT old_credential");
  f.sqlite.exec("UPDATE _credentials SET workload_context_json=NULL");
  expect((await authorized(server, issued.session_token)).status).toBe(401);
  f.sqlite.exec("ROLLBACK TO old_credential; RELEASE old_credential");
  await f.store.revokeBinding(
    "p",
    binding.principal_id,
    binding.binding_id,
    actor,
  );
  expect((await authorized(server, issued.session_token)).status).toBe(401);
});

it("rejects old human-shaped JWTs and accepts fresh interactive credentials", async () => {
  await grantHuman();
  const server = app();
  for (const version of [null, 1]) {
    const response = await authorized(server, await humanToken(version));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "session-reauth-required" },
    });
  }
  expect((await authorized(server, await humanToken())).status).toBe(200);
});

it.each([...ROOT_CAPABILITIES])(
  "rejects %s at scoped issuance and binding creation/update",
  async (capability) => {
    const service = await f.store.createService(
      "p",
      { name: "root", display_name: "Root", role: "owner" },
      actor,
    );
    const policy: CredentialPolicy = {
      role: "owner",
      capabilities: [capability],
    };
    await expect(
      f.store.issue(
        {
          projectId: "p",
          principalId: service.principal_id,
          name: "bad",
          tokenHash: "bad",
          policy,
        },
        actor,
      ),
    ).rejects.toThrow("not delegable");
    await expect(
      f.store.createBinding(
        "p",
        service.principal_id,
        {
          name: "bad",
          provider: "github-actions",
          issuer,
          subject: workloadSubject,
          policy,
        },
        actor,
      ),
    ).rejects.toThrow("not delegable");
    const binding = await f.store.createBinding(
      "p",
      service.principal_id,
      {
        name: "ok",
        provider: "github-actions",
        issuer,
        subject: workloadSubject,
        policy: { role: "owner", capabilities: ["schema:read"] },
      },
      actor,
    );
    await expect(
      f.store.updateBinding(
        "p",
        service.principal_id,
        binding.binding_id,
        policy,
        actor,
      ),
    ).rejects.toThrow("not delegable");
  },
);

it("blocks legacy scoped root authority before replay and after rotation while retaining bootstrap access", async () => {
  const service = await f.store.createService(
    "p",
    { name: "root", display_name: "Root", role: "owner" },
    actor,
  );
  const plaintext = await generateToken();
  const key = await f.store.issue(
    {
      projectId: "p",
      principalId: service.principal_id,
      name: "old-root",
      tokenHash: await hashToken(plaintext, env.HASH_PEPPER),
      policy: { role: "owner", capabilities: ["schema:read"] },
    },
    actor,
  );
  f.sqlite.prepare("UPDATE _credentials SET policy_json=?").run(
    JSON.stringify({
      role: "owner",
      capabilities: [...ROOT_CAPABILITIES, "project:inspect", "schema:read"],
    }),
  );
  const server = app();
  for (const [method, path] of [
    ["POST", "destroy"],
    ["POST", "archive/journal"],
    ["GET", "store-counts"],
    ["POST", "sessions/revoke"],
    ["POST", "backup/d1/restore"],
    ["GET", "backup/d1"],
  ]) {
    expect(
      (
        await authorized(
          server,
          plaintext,
          `/projects/p/admin/${path}`,
          method,
          method === "GET" ? undefined : {},
          { "X-Test-Replay": "1" },
        )
      ).status,
    ).toBe(403);
  }
  const rotated = await generateToken();
  await f.store.rotate(
    "p",
    "old-root",
    key.token_id,
    await hashToken(rotated, env.HASH_PEPPER),
    0,
    actor,
  );
  expect(
    (await authorized(server, rotated, "/projects/p/admin/destroy", "POST", {}))
      .status,
  ).toBe(403);
  expect((await authorized(server, rotated)).status).toBe(200);
  const bootstrap = await generateToken();
  await f.legacy.issue({
    projectId: "p",
    name: "bootstrap",
    tokenHash: await hashToken(bootstrap, env.HASH_PEPPER),
    createdAt: Math.floor(Date.now() / 1000),
    createdBy: "fixture",
  });
  expect(
    (
      await authorized(
        server,
        bootstrap,
        "/projects/p/admin/destroy",
        "POST",
        {},
      )
    ).status,
  ).toBe(200);
});

it.each(["explicit", "hybrid", "github-mirrored", "service-only"])(
  "uses canonical browser admission in %s mode",
  async (mode) => {
    f.sqlite.prepare("UPDATE _projects SET membership_mode=?").run(mode);
    await new GitHubAppConfigStore(f.db).setInstallation("p", 123, "bootstrap");
    const server = workspaceApp();
    const listed = await server.request(
      "/api/workspace/projects",
      {},
      env,
      ctx,
    );
    const selected = await server.request(
      "/api/workspace/select",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "p" }),
      },
      env,
      ctx,
    );
    const admitted = mode === "hybrid" || mode === "github-mirrored";
    expect(((await listed.json()) as ProjectList).projects).toHaveLength(
      admitted ? 1 : 0,
    );
    expect(selected.status).toBe(admitted ? 200 : 403);
    if (admitted) {
      expect(await selected.json()).toMatchObject({
        role: "viewer",
        scopes: "read",
      });
      const cookie = cookieHeader(selected);
      expect(
        (
          await app().request(
            "/projects/p/schema",
            { headers: { Cookie: cookie } },
            env,
            ctx,
          )
        ).status,
      ).toBe(200);
    } else expect(selected.headers.get("set-cookie")).toBeNull();
  },
);

it.each([false, true])(
  "admits explicit owners through App bearer exchange without installation (App configured: %s)",
  async (configured) => {
    await grantHuman();
    if (!configured) {
      env.GITHUB_APP_ID = undefined;
      env.GITHUB_APP_PRIVATE_KEY = undefined;
    }
    const server = app();
    const response = await server.request(
      "/api/auth/github/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "p",
          auth_method: "user_token",
          user_token: "authenticated-human",
        }),
      },
      env,
      ctx,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = GitHubExchangeResponseSchema.parse(await response.json());
    expect(body.role).toBe("owner");
    expect((await authorized(server, body.session_token)).status).toBe(200);
    const selected = await workspaceApp().request(
      "/api/workspace/select",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "p" }),
      },
      env,
      ctx,
    );
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({
      role: "owner",
      membership_sources: ["explicit"],
    });
  },
);

it("chooses the strongest role after repository caps for both browser and bearer", async () => {
  f.sqlite.exec("UPDATE _projects SET membership_mode='hybrid'");
  await new GitHubAppConfigStore(f.db).setInstallation("p", 123, "bootstrap");
  await new RepoAllowlistStore(f.db).register({
    projectId: "p",
    githubHost: "github.com",
    githubOwner: "org",
    githubRepo: "other",
    githubRepoId: 43,
    createdBy: "bootstrap",
    membershipEnabled: true,
    membershipRoleCap: "participant",
    maxPermission: "write",
  });
  const selected = await workspaceApp().request(
    "/api/workspace/select",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p" }),
    },
    env,
    ctx,
  );
  expect(((await selected.json()) as { role: string }).role).toBe(
    "participant",
  );
  const bearer = await app().request(
    "/api/auth/github/exchange",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "p",
        github_token: "authenticated-human",
      }),
    },
    env,
    ctx,
  );
  expect(await bearer.json()).toMatchObject({
    role: "participant",
    github_repo_id: 43,
  });
});

it.each(["unbound", "scoped"] as const)(
  "%s fails closed if current policy storage becomes unavailable",
  async (kind) => {
    f.sqlite.exec("UPDATE _projects SET membership_mode='hybrid'");
    if (kind === "scoped") await boundWorkload();
    const server = app();
    const issued = await exchange(server);
    expect((await authorized(server, issued.session_token)).status).toBe(200);
    const original = f.db.prepare.bind(f.db);
    const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("_project_repos")) throw new Error("policy unavailable");
      return original(sql);
    });
    try {
      expect([401, 503]).toContain(
        (await authorized(server, issued.session_token)).status,
      );
    } finally {
      spy.mockRestore();
    }
  },
);

function cookieHeader(response: Response): string {
  const header = response.headers.get("set-cookie");
  expect(header).not.toBeNull();
  if (!header) throw new Error("Missing session cookie");
  return header.split(";")[0];
}

it("bounds Actions JWT expiry and preserves sender-constrained authentication", async () => {
  f.sqlite.exec("UPDATE _projects SET membership_mode='hybrid'");
  const issued = await exchange(app());
  expect(issued.expires_at).toBeLessThanOrEqual(
    Math.floor(Date.now() / 1000) + 600,
  );
  const payload = JSON.parse(
    atob(
      issued.session_token.split(".")[2].replace(/-/g, "+").replace(/_/g, "/"),
    ),
  );
  expect(payload).toMatchObject({
    sub_type: "github-actions",
    authorization_version: 2,
    actor_name: "owner",
    actor_id: 7,
  });
  expect(payload.github_user_id).toBeUndefined();
  const bound = await mintSessionToken(
    { ...payload, cnf: { jkt: "x".repeat(43) } },
    env.GITHUB_SESSION_HMAC_KEY ?? "",
  );
  const denied = await authorized(app(), bound);
  expect(denied.status).toBe(401);
  expect(await denied.json()).toMatchObject({
    error: { code: "dpop-required" },
  });
});
