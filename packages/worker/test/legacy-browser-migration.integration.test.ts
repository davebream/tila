import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { D1SessionStore, ProjectMembershipStore } from "../src/d1";
import { hashToken } from "../src/lib/hash-token";
import {
  _resetMiddlewareStateForTest,
  createAuthMiddleware,
} from "../src/middleware/auth";
import { projectMembershipMiddleware } from "../src/middleware/membership";
import { projectMiddleware } from "../src/middleware/project";
import {
  authSessionExchange,
  authSessionProtected,
} from "../src/routes/auth-session";
import { whoami } from "../src/routes/whoami";
import type { Env, HonoVariables } from "../src/types";
import { createCredentialFixture } from "./d1/helpers/credential-fixture";

const rawToken = "tila_legacy_upgrade_fixture";
const rawCookie = "legacy-upgrade-cookie";
let f: ReturnType<typeof createCredentialFixture>;
let env: Env;
let sessionHash: string;
const effects = vi.fn();
function app() {
  const server = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  server.route("/auth/session", authSessionExchange);
  server.use("*", createAuthMiddleware());
  server.route("/auth/session", authSessionProtected);
  server.route("/auth", authSessionProtected);
  server.route("/api", whoami);
  server.use(
    "/projects/:projectId/*",
    projectMiddleware,
    projectMembershipMiddleware(),
  );
  server.all("/projects/:projectId/tasks", (c) => {
    effects();
    return c.json({ ok: true });
  });
  return server;
}
function request(path = "/auth/session/status", method = "GET") {
  return app().request(
    `https://worker${path}`,
    {
      method,
      headers: {
        Cookie: `tila_session=${rawCookie}`,
        Origin: "https://worker",
      },
    },
    env,
  );
}
beforeEach(async () => {
  _resetMiddlewareStateForTest();
  effects.mockClear();
  sessionHash = await hashToken(rawCookie, "pepper");
  const tokenHash = await hashToken(rawToken, "pepper");
  // v0.4.0 cookies had identity/scopes/permission, but no membership snapshot.
  // Seed before v0.5.0's account migration and apply every later migration.
  f = createCredentialFixture(undefined, undefined, (sqlite) => {
    sqlite
      .prepare(
        "INSERT INTO _projects (project_id,created_at,created_by,cloudflare_account_id) VALUES ('p',0,'fixture','local')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO _tokens (token_hash,project_id,name,scopes,created_at,created_by,token_id) VALUES (?,'p','bootstrap','full',0,'fixture','legacy-owner')",
      )
      .run(tokenHash);
    sqlite
      .prepare(`INSERT INTO _sessions (session_hash,project_id,token_hash,actor_name,principal_id,scopes,permission,created_at,expires_at)
      VALUES (?,'p',?,'bootstrap','token:legacy-owner','full','admin',?,?)`)
      .run(sessionHash, tokenHash, Date.now(), Date.now() + 3600_000);
  });
  env = {
    DB: f.db,
    HASH_PEPPER: "pepper",
    ANALYTICS: { writeDataPoint() {} },
    PROJECT: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: () => new Response("{}") }),
    },
  } as unknown as Env;
});
afterEach(() => {
  vi.restoreAllMocks();
  f.sqlite.close();
});
it("guides an upgraded bootstrap cookie into migration while retaining bearer ownership", async () => {
  for (const [path, method] of [
    ["/auth/session/status", "GET"],
    ["/projects/p/tasks", "GET"],
    ["/projects/p/tasks", "POST"],
  ]) {
    const response = await request(path, method);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "account-migration-required", retryable: false },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  const identity = await app().request(
    "https://worker/api/whoami",
    { headers: { Authorization: `Bearer ${rawToken}` } },
    env,
    {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
  expect(identity.status).toBe(200);
  expect(await identity.json()).toMatchObject({
    role: "owner",
    auth_kind: "d1-token",
    membership_sources: ["bootstrap"],
    legacy: true,
  });
  const exchange = await app().request(
    "https://worker/auth/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: rawToken, project_id: "p" }),
    },
    env,
  );
  expect(exchange.status).toBe(410);
  expect(await exchange.json()).toMatchObject({
    error: {
      code: "token-login-retired",
      message: expect.stringContaining("project membership"),
    },
  });
  expect(exchange.headers.get("set-cookie")).toBeNull();
  expect(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM _project_memberships").get(),
  ).toEqual({ n: 0 });
  expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM _sessions").get()).toEqual(
    { n: 1 },
  );
  expect(effects).not.toHaveBeenCalled();
});
it.each(["expired", "revoked-session", "revoked-token", "bound-token"])(
  "keeps %s rejection ahead of migration guidance",
  async (state) => {
    if (state === "expired")
      f.sqlite.exec("UPDATE _sessions SET expires_at = 0");
    if (state === "revoked-session")
      await new D1SessionStore(f.db).revoke(sessionHash);
    if (state === "revoked-token")
      await f.legacy.revoke("p", "bootstrap", "fixture");
    if (state === "bound-token")
      f.sqlite.exec("UPDATE _tokens SET cnf_jkt = 'bound'");
    const response = await request();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "session-expired" },
    });
  },
);
it.each(["/auth/logout", "/auth/session/logout"])(
  "allows %s without revoking the source bearer",
  async (path) => {
    expect((await request(path, "GET")).status).toBe(401);
    const response = await request(path, "POST");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await new D1SessionStore(f.db).validate(sessionHash)).toBeNull();
    expect(
      await f.legacy.validate(await hashToken(rawToken, "pepper")),
    ).not.toBeNull();
  },
);
it("preserves CSRF protection on legacy logout", async () => {
  const response = await app().request(
    "https://worker/auth/logout",
    {
      method: "POST",
      headers: {
        Cookie: `tila_session=${rawCookie}`,
        Origin: "https://other.example",
      },
    },
    env,
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: { code: "csrf-origin-mismatch" },
  });
  expect(await new D1SessionStore(f.db).validate(sessionHash)).not.toBeNull();
});
it("preserves live canonical membership and rechecks it on subsequent requests", async () => {
  // Historical token identities are not exposed as a new membership grant API.
  f.sqlite.exec(`INSERT INTO _project_memberships (membership_id,project_id,principal_id,provider,identity_host,subject_id,subject_kind,role,granted_by,granted_at)
    VALUES ('existing','p','token:legacy-owner','service','tila','legacy-owner','service','viewer','fixture',0)`);
  expect((await request("/projects/p/tasks")).status).toBe(200);
  f.sqlite.exec("UPDATE _project_memberships SET revoked_at = 1");
  expect((await request()).status).toBe(401);
  expect(effects).toHaveBeenCalledOnce();
});
it.each(["principal", "source-project", "read-only", "github"])(
  "does not classify %s cookies as bootstrap migration",
  async (kind) => {
    if (kind === "principal")
      f.sqlite.exec("UPDATE _sessions SET principal_id = 'token:unrelated'");
    if (kind === "source-project") {
      f.sqlite.exec(
        "INSERT INTO _projects (project_id,created_at,created_by,cloudflare_account_id) VALUES ('other',0,'fixture','local')",
      );
      f.sqlite.exec("UPDATE _tokens SET project_id = 'other'");
    }
    if (kind === "read-only")
      f.sqlite.exec("UPDATE _tokens SET scopes = 'read'");
    if (kind === "github")
      f.sqlite.exec(
        "UPDATE _sessions SET token_hash = '', principal_id = 'github:github.com:7'",
      );
    const response = await request("/projects/p/tasks");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "membership-required" },
    });
    expect(effects).not.toHaveBeenCalled();
  },
);
it("ignores stored snapshots and uses current source scopes", async () => {
  f.sqlite.exec(
    "UPDATE _sessions SET scopes = 'read', permission = 'read', role = 'viewer', membership_source = '[]'",
  );
  const response = await request();
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    error: { code: "account-migration-required" },
  });
});
it("fails closed on a membership lookup outage without reporting migration", async () => {
  vi.spyOn(ProjectMembershipStore.prototype, "resolve").mockRejectedValue(
    new Error("D1 unavailable"),
  );
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: "auth-unavailable", retryable: true },
  });
  expect(effects).not.toHaveBeenCalled();
});
it("keeps scoped cookie authority tied to its service membership", async () => {
  const actor = { principalId: "fixture" };
  const service = await f.store.createService(
    "p",
    { name: "reader", display_name: "Reader", role: "viewer" },
    actor,
  );
  const hash = await hashToken("scoped-source", "pepper");
  await f.store.issue(
    {
      projectId: "p",
      principalId: service.principal_id,
      name: "reader",
      policy: { role: "viewer", capabilities: ["tasks:read"] },
      tokenHash: hash,
    },
    actor,
  );
  f.sqlite
    .prepare("UPDATE _sessions SET token_hash = ?, principal_id = ?")
    .run(hash, service.principal_id);
  expect((await request("/projects/p/tasks")).status).toBe(200);
  f.sqlite.exec("UPDATE _project_memberships SET revoked_at = 1");
  const response = await request("/projects/p/tasks");
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    error: { code: "session-expired" },
  });
});
