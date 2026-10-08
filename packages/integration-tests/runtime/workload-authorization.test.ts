import { SELF } from "cloudflare:test";
import {
  CredentialStore,
  ProjectMembershipStore,
  RepoAllowlistStore,
} from "@tila/backend-d1";
import { GITHUB_ACTIONS_ISSUER, ROOT_CAPABILITIES } from "@tila/schemas";
import { SignJWT } from "jose";
import { expect, it } from "vitest";
import { bindings } from "./setup";

const projectId = "workload-runtime";
const context = {
  repository_id: 42,
  sub: "repo:org/repo:ref:refs/heads/main",
  event_name: "push",
  ref: "refs/heads/main",
};
const actor = { principalId: "bootstrap:fixture" };
async function setup() {
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id, membership_mode) VALUES (?, 'Runtime', 0, 'fixture', 'local', 'hybrid')",
  )
    .bind(projectId)
    .run();
  await new RepoAllowlistStore(bindings.DB).register({
    projectId,
    githubHost: "github.com",
    githubOwner: "org",
    githubRepo: "repo",
    githubRepoId: 42,
    createdBy: "fixture",
    membershipEnabled: true,
    membershipRoleCap: "participant",
  });
  await bindings.DB.prepare(
    "UPDATE _project_repos SET oidc_enabled=1, oidc_max_permission='write', oidc_allowed_events='[\"push\"]', oidc_allowed_refs='[\"refs/heads/main\"]' WHERE project_id=?",
  )
    .bind(projectId)
    .run();
}
async function jwt(overrides: Record<string, unknown> = {}) {
  const key = Uint8Array.from(
    atob(
      bindings.GITHUB_SESSION_HMAC_KEY.replace(/-/g, "+").replace(/_/g, "/"),
    ),
    (x) => x.charCodeAt(0),
  );
  const now = Math.floor(Date.now() / 1000);
  return `tila_s.${await new SignJWT({ sub_type: "github-actions", authorization_version: 2, project_id: projectId, workload: context, actor_name: "owner", actor_id: 7, role: "participant", permission: "write", issued_at: now, expires_at: now + 300, jti: crypto.randomUUID(), ...overrides }).setProtectedHeader({ alg: "HS256" }).setIssuer("tila").setAudience("tila").sign(key)}`;
}
async function request(
  token: string,
  path = "tasks",
  method = "GET",
  body?: unknown,
) {
  const response = await SELF.fetch(
    `https://worker/projects/${projectId}/${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": "runtime-workload",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}
it("rechecks Actions membership and repository policy in the real Worker", async () => {
  await setup();
  await new ProjectMembershipStore(bindings.DB).grant({
    projectId,
    principal: { provider: "github", host: "github.com", user_id: 7 },
    subjectKind: "human",
    role: "owner",
    actorPrincipalId: actor.principalId,
  });
  const token = await jwt();
  expect((await request(token)).status).toBe(200);
  expect(
    (
      await request(token, "memberships", "POST", {
        principal: { provider: "github", user_id: 8 },
        subject_kind: "human",
        role: "owner",
      })
    ).status,
  ).toBe(403);
  await bindings.DB.prepare(
    "UPDATE _project_repos SET oidc_max_permission='read' WHERE project_id=?",
  )
    .bind(projectId)
    .run();
  expect((await request(token)).status).toBe(200);
  expect((await request(token, "tasks", "POST", {})).status).toBe(403);
  await bindings.DB.prepare(
    "UPDATE _project_repos SET oidc_enabled=0 WHERE project_id=?",
  )
    .bind(projectId)
    .run();
  expect((await request(token)).status).toBe(403);
});

it("persists workload context and narrows scoped credentials using real D1", async () => {
  await setup();
  const store = new CredentialStore(bindings.DB);
  const service = await store.createService(
    projectId,
    { name: "runner", display_name: "Runner", role: "owner" },
    actor,
  );
  const policy = {
    role: "participant" as const,
    capabilities: ["tasks:read" as const, "tasks:write" as const],
  };
  const binding = await store.createBinding(
    projectId,
    service.principal_id,
    {
      name: "ci",
      provider: "github-actions",
      issuer: GITHUB_ACTIONS_ISSUER,
      subject: context.sub,
      policy,
    },
    actor,
  );
  const issued = await store.issue(
    {
      projectId,
      principalId: service.principal_id,
      name: "workload",
      tokenHash: "fixture-hash",
      policy,
      workloadBindingId: binding.binding_id,
      workloadContext: context,
    },
    actor,
  );
  expect((await store.resolve(issued.token_id))?.policy.role).toBe(
    "participant",
  );
  await bindings.DB.prepare(
    "UPDATE _project_repos SET oidc_max_permission='read' WHERE project_id=?",
  )
    .bind(projectId)
    .run();
  expect((await store.resolve(issued.token_id))?.policy).toMatchObject({
    role: "viewer",
    capabilities: ["tasks:read"],
  });
  await bindings.DB.prepare(
    "UPDATE _credentials SET workload_context_json=NULL WHERE credential_id=?",
  )
    .bind(issued.credential_id)
    .run();
  expect(await store.resolve(issued.token_id)).toBeNull();
  await expect(
    store.issue(
      {
        projectId,
        principalId: service.principal_id,
        name: "root",
        tokenHash: "root-hash",
        policy: { role: "owner", capabilities: [...ROOT_CAPABILITIES] },
      },
      actor,
    ),
  ).rejects.toThrow("not delegable");
});

it("requires reauthentication for pre-cutover GitHub JWTs in the real Worker", async () => {
  await setup();
  const old = await jwt({
    sub_type: "github",
    authorization_version: undefined,
    github_host: "github.com",
    github_repo_id: 42,
    github_login: "owner",
    github_user_id: 7,
  });
  const response = await request(old);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    error: { code: "session-reauth-required" },
  });
});
