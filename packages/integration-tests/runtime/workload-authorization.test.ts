import {
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  GITHUB_ACTIONS_ISSUER,
  GITHUB_ACTIONS_JWKS_URI,
  ROOT_CAPABILITIES,
  type RuntimeContext,
  accessTokenHash,
  canonicalizeHtu,
} from "@tila/schemas";
import {
  SignJWT,
  calculateJwkThumbprint,
  decodeJwt,
  exportJWK,
  generateKeyPair,
} from "jose";
import { expect, it, vi } from "vitest";
import {
  CredentialStore,
  D1RevokedSubjectsStore,
  D1SessionStore,
  ProjectMembershipStore,
  RepoAllowlistStore,
  RuntimeStore,
} from "../../worker/src/d1";
import worker from "../../worker/src/index";
import { hashToken } from "../../worker/src/lib/hash";
import { clearCacheForTesting } from "../../worker/src/lib/oidc-verify";
import type { Env } from "../../worker/src/types";
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

const enterprise = {
  issuer: "https://github--enterprise.example/_services/token",
  host: "github--enterprise.example",
  jwks_uri: "https://keys.example/enterprise-actions",
};
const trustedIssuers = JSON.stringify([enterprise]);
const exchangePath = "/api/auth/github/exchange-oidc";
const actionsPolicy = {
  role: "participant" as const,
  capabilities: ["tasks:read" as const, "tasks:write" as const],
};

/** Real Worker/D1/DO with changing deployment config and only local signed JWKS. */
async function enterpriseFixture() {
  await setup();
  await new RepoAllowlistStore(bindings.DB).register({
    projectId,
    githubHost: enterprise.host,
    githubOwner: "org",
    githubRepo: "repo",
    githubRepoId: 42,
    createdBy: "fixture",
    membershipEnabled: true,
    membershipRoleCap: "participant",
  });
  await bindings.DB.prepare(
    "UPDATE _project_repos SET oidc_enabled=1, oidc_max_permission='write', oidc_allowed_events='[\"push\"]' WHERE project_id=? AND github_host=?",
  )
    .bind(projectId, enterprise.host)
    .run();
  const env = {
    ...bindings,
    GITHUB_OIDC_AUDIENCE: "https://worker",
    GITHUB_ACTIONS_TRUSTED_ISSUERS: trustedIssuers,
  } as unknown as Env;
  clearCacheForTesting();
  const pair = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  const network = vi
    .mocked(globalThis.fetch)
    .mockImplementation(async (url) => {
      if (url !== enterprise.jwks_uri && url !== GITHUB_ACTIONS_JWKS_URI)
        throw new Error("Unconfigured network destination");
      return Response.json({
        keys: [{ ...jwk, kid: "actions-local", alg: "RS256", use: "sig" }],
      });
    });
  async function assertion(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      ...context,
      iss: enterprise.issuer,
      aud: env.GITHUB_OIDC_AUDIENCE,
      exp: now + 300,
      iat: now,
      nbf: now,
      jti: crypto.randomUUID(),
      repository: "org/repo",
      repository_owner: "org",
      repository_owner_id: "8",
      repository_id: "42",
      actor: "runner",
      actor_id: "7",
      sha: "local-sha",
      workflow: "CI",
      run_id: "1",
      run_number: "1",
      run_attempt: "1",
      repository_visibility: "private",
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: "actions-local" })
      .sign(pair.privateKey);
  }
  async function http(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    method = body === undefined ? "GET" : "POST",
  ) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://worker${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(headers.DPoP ? {} : { "X-Tila-Participant-Id": "workload-440" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }
  async function exchange(
    extra: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    return http(
      exchangePath,
      {
        project_id: projectId,
        oidc_token: await assertion(overrides),
        ...extra,
      },
      headers,
    );
  }
  async function boundService() {
    const store = new CredentialStore(bindings.DB, trustedIssuers);
    const service = await store.createService(
      projectId,
      {
        name: "enterprise-runner",
        display_name: "Enterprise runner",
        role: "participant",
      },
      actor,
    );
    const binding = await store.createBinding(
      projectId,
      service.principal_id,
      {
        name: "enterprise-ci",
        provider: "github-actions",
        issuer: enterprise.issuer,
        subject: context.sub,
        policy: actionsPolicy,
      },
      actor,
    );
    return { store, service, binding };
  }
  return { env, network, assertion, exchange, http, boundService };
}

async function expectStatus(response: Response, status: number) {
  if (response.status !== status) {
    const failure = await response
      .clone()
      .json<{ error?: { code?: string } }>();
    expect(response.status, failure.error?.code).toBe(status);
  }
}

it("exchanges a signed GHES assertion and isolates same-ID host policy, canonical membership and replay", async () => {
  const f = await enterpriseFixture();
  await bindings.DB.prepare(
    "UPDATE _project_repos SET oidc_enabled=0 WHERE project_id=? AND github_host='github.com'",
  )
    .bind(projectId)
    .run();
  const upstream = await f.assertion();
  const exchange = () =>
    f.http(exchangePath, { project_id: projectId, oidc_token: upstream });
  const response = await exchange();
  await expectStatus(response, 200);
  const issued = await response.json<{
    session_token: string;
    principal_id: string;
  }>();
  expect(issued.principal_id).toBe(`oidc:${enterprise.issuer}:${context.sub}`);
  expect(decodeJwt(issued.session_token.slice("tila_s.".length))).toMatchObject(
    {
      workload: {
        issuer: enterprise.issuer,
        repository_host: enterprise.host,
        repository_id: 42,
      },
    },
  );
  const read = () =>
    f.http(`/projects/${projectId}/tasks`, undefined, {
      Authorization: `Bearer ${issued.session_token}`,
    });
  await expectStatus(await read(), 200);
  await expectStatus(await exchange(), 200);
  // An explicit membership in the old GitHub.com principal must not grant GHES access.
  await bindings.DB.prepare(
    "UPDATE _projects SET membership_mode='explicit' WHERE project_id=?",
  )
    .bind(projectId)
    .run();
  await new ProjectMembershipStore(bindings.DB).grant({
    projectId,
    principal: {
      provider: "oidc",
      issuer: GITHUB_ACTIONS_ISSUER,
      subject: context.sub,
    },
    subjectKind: "service",
    role: "participant",
    actorPrincipalId: actor.principalId,
  });
  await expectStatus(await read(), 403);
  await new ProjectMembershipStore(bindings.DB).grant({
    projectId,
    principal: {
      provider: "oidc",
      issuer: enterprise.issuer,
      subject: context.sub,
    },
    subjectKind: "service",
    role: "participant",
    actorPrincipalId: actor.principalId,
  });
  await expectStatus(await read(), 200);
  f.env.GITHUB_ACTIONS_TRUSTED_ISSUERS = undefined;
  await expectStatus(await read(), 403);
  await expectStatus(await exchange(), 401);
  f.env.GITHUB_ACTIONS_TRUSTED_ISSUERS = trustedIssuers;
  await expectStatus(await read(), 200);
  f.env.GITHUB_ACTIONS_TRUSTED_ISSUERS = "malformed-json";
  await expectStatus(await read(), 403);
  f.env.GITHUB_ACTIONS_TRUSTED_ISSUERS = trustedIssuers;
  await bindings.DB.prepare(
    "UPDATE _project_repos SET oidc_enabled=0 WHERE project_id=? AND github_host=?",
  )
    .bind(projectId, enterprise.host)
    .run();
  await expectStatus(await read(), 403);
  await expectStatus(await exchange(), 403);
});

it("does not replay sessions across issuers with identical assertion IDs", async () => {
  const f = await enterpriseFixture();
  const sameJti = crypto.randomUUID();
  const github = await f.exchange(
    {},
    { iss: GITHUB_ACTIONS_ISSUER, jti: sameJti },
  );
  const ghe = await f.exchange({}, { jti: sameJti });
  await expectStatus(github, 200);
  await expectStatus(ghe, 200);
  const githubBody = await github.json<{
    session_token: string;
    principal_id: string;
  }>();
  const gheBody = await ghe.json<{
    session_token: string;
    principal_id: string;
  }>();
  expect(gheBody.principal_id).not.toBe(githubBody.principal_id);
  expect(decodeJwt(gheBody.session_token.slice(7))).toMatchObject({
    workload: { issuer: enterprise.issuer, repository_host: enterprise.host },
  });
});

it("denies unknown issuer and malformed deployment trust before any JWKS network call", async () => {
  const f = await enterpriseFixture();
  await expectStatus(
    await f.exchange({}, { iss: "https://unknown.example/token" }),
    401,
  );
  expect(f.network).not.toHaveBeenCalled();
  f.env.GITHUB_ACTIONS_TRUSTED_ISSUERS = JSON.stringify([
    enterprise,
    { ...enterprise, host: "other.example" },
  ]);
  await expectStatus(await f.exchange(), 500);
  expect(f.network).not.toHaveBeenCalled();
});

it("revalidates issued GHES credentials and historical cookie sessions after trust removal and policy disabling", async () => {
  const f = await enterpriseFixture();
  const { store, service } = await f.boundService();
  const upstream = await f.assertion();
  const exchange = () =>
    f.http(exchangePath, { project_id: projectId, oidc_token: upstream });
  const response = await exchange();
  await expectStatus(response, 200);
  const issued = await response.json<{
    session_token: string;
    token_id: string;
    credential_id: string;
    principal_id: string;
  }>();
  expect(issued.principal_id).toBe(service.principal_id);
  const row = await bindings.DB.prepare(
    "SELECT workload_context_json FROM _credentials WHERE credential_id=?",
  )
    .bind(issued.credential_id)
    .first<{ workload_context_json: string }>();
  expect(JSON.parse(row?.workload_context_json ?? "null")).toMatchObject({
    issuer: enterprise.issuer,
    repository_host: enterprise.host,
  });
  const cookie = `fixture-cookie-${crypto.randomUUID()}`;
  await new D1SessionStore(bindings.DB).create({
    sessionHash: await hashToken(cookie, bindings.HASH_PEPPER),
    projectId,
    tokenHash: await hashToken(issued.session_token, bindings.HASH_PEPPER),
    actorName: "runner",
    principalId: service.principal_id,
    scopes: "scoped-v1",
    permission: "write",
    expiresAt: Date.now() + 300_000,
  });
  const bearerRead = () =>
    f.http(`/projects/${projectId}/tasks`, undefined, {
      Authorization: `Bearer ${issued.session_token}`,
    });
  const cookieRead = () =>
    f.http(`/projects/${projectId}/tasks`, undefined, {
      Cookie: `tila_session=${cookie}`,
    });
  await expectStatus(await bearerRead(), 200);
  await expectStatus(await cookieRead(), 200);
  await expectStatus(await exchange(), 409);
  f.env.GITHUB_ACTIONS_TRUSTED_ISSUERS = "[]";
  await expectStatus(await bearerRead(), 401);
  await expectStatus(await cookieRead(), 401);
  await expectStatus(await exchange(), 401);
  expect(
    await new CredentialStore(bindings.DB).resolve(issued.token_id),
  ).toBeNull();
  f.env.GITHUB_ACTIONS_TRUSTED_ISSUERS = trustedIssuers;
  await expectStatus(await bearerRead(), 200);
  await bindings.DB.prepare(
    "UPDATE _project_repos SET oidc_enabled=0 WHERE project_id=? AND github_host=?",
  )
    .bind(projectId, enterprise.host)
    .run();
  expect(await store.resolve(issued.token_id)).toBeNull();
  await expectStatus(await bearerRead(), 401);
  await expectStatus(await cookieRead(), 401);
  await expectStatus(await exchange(), 403);
});

it("revalidates GHES runtime runs and denies credential/assertion replay after trust removal or disabled policy", async () => {
  const f = await enterpriseFixture();
  await f.boundService();
  const pair = await generateKeyPair("ES256");
  const jwk = await exportJWK(pair.publicKey);
  const jkt = await calculateJwkThumbprint(jwk);
  const operationId = crypto.randomUUID();
  async function proof(token: string, path: string, method: string) {
    return new SignJWT({
      htm: method,
      htu: canonicalizeHtu(`https://worker${path}`),
      ath: await accessTokenHash(token),
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .sign(pair.privateKey);
  }
  const upstream = await f.assertion();
  const exchange = async (assertion = upstream) =>
    f.http(
      exchangePath,
      {
        project_id: projectId,
        oidc_token: assertion,
        jkt,
        runtime: { operation_id: operationId, policy: actionsPolicy },
      },
      { DPoP: await proof(assertion, exchangePath, "POST") },
    );
  const response = await exchange();
  await expectStatus(response, 200);
  const issued = await response.json<{
    token: string;
    context: RuntimeContext;
  }>();
  expect(issued.context.workload_binding_id).toBeTruthy();
  const read = async () =>
    f.http(`/projects/${projectId}/tasks`, undefined, {
      Authorization: `Bearer ${issued.token}`,
      DPoP: await proof(issued.token, `/projects/${projectId}/tasks`, "GET"),
    });
  await expectStatus(await read(), 200);
  await expectStatus(await exchange(), 409);
  f.env.GITHUB_ACTIONS_TRUSTED_ISSUERS = undefined;
  await expectStatus(await read(), 403);
  await expectStatus(await exchange(), 401);
  f.env.GITHUB_ACTIONS_TRUSTED_ISSUERS = trustedIssuers;
  await expectStatus(await read(), 200);
  await bindings.DB.prepare(
    "UPDATE _project_repos SET oidc_enabled=0 WHERE project_id=? AND github_host=?",
  )
    .bind(projectId, enterprise.host)
    .run();
  await expectStatus(await read(), 403);
  await expectStatus(await exchange(await f.assertion()), 403);
});

it("checks the actual GHES issuer in the signed session subject-revocation identity", async () => {
  const f = await enterpriseFixture();
  const response = await f.exchange();
  await expectStatus(response, 200);
  const issued = await response.json<{ session_token: string }>();
  const read = () =>
    f.http(`/projects/${projectId}/tasks`, undefined, {
      Authorization: `Bearer ${issued.session_token}`,
    });
  await expectStatus(await read(), 200);
  await new D1RevokedSubjectsStore(bindings.DB).revokeSubject(
    projectId,
    GITHUB_ACTIONS_ISSUER,
    context.sub,
    Date.now() + 1000,
  );
  await expectStatus(await read(), 200);
  await new D1RevokedSubjectsStore(bindings.DB).revokeSubject(
    projectId,
    enterprise.issuer,
    context.sub,
    Date.now() + 1000,
  );
  await expectStatus(await read(), 401);
});

it("rejects issuer/host mismatches and never treats legacy GHES contexts as Enterprise authority", async () => {
  const f = await enterpriseFixture();
  const mismatched = await jwt({
    workload: {
      ...context,
      issuer: enterprise.issuer,
      repository_host: "github.com",
    },
  });
  await expectStatus(
    await f.http(`/projects/${projectId}/tasks`, undefined, {
      Authorization: `Bearer ${mismatched}`,
    }),
    403,
  );
  const { store, service, binding } = await f.boundService();
  const issued = await store.issue(
    {
      projectId,
      principalId: service.principal_id,
      name: "legacy-ghes",
      policy: actionsPolicy,
      tokenHash: "local-legacy-ghes",
      workloadBindingId: binding.binding_id,
      workloadContext: context,
    },
    actor,
  );
  expect(await store.resolve(issued.token_id)).toBeNull();
  const run = await new RuntimeStore(
    bindings.DB,
    undefined,
    undefined,
    trustedIssuers,
  ).startWithPolicy(
    projectId,
    service.principal_id,
    {
      operation_id: crypto.randomUUID(),
      jkt: "a".repeat(43),
      policy: actionsPolicy,
    },
    actionsPolicy,
    { id: crypto.randomUUID(), hash: "local-ghes-run" },
    {
      workload_binding_id: binding.binding_id,
      workload_context_json: JSON.stringify({
        ...context,
        issuer: enterprise.issuer,
        repository_host: enterprise.host,
      }),
    },
  );
  await bindings.DB.prepare(
    "UPDATE _runtime_runs SET workload_context_json=? WHERE run_id=?",
  )
    .bind(JSON.stringify(context), run.run_id)
    .run();
  await expect(
    new RuntimeStore(bindings.DB, undefined, undefined, trustedIssuers).context(
      run.token_id,
    ),
  ).rejects.toMatchObject({ code: "enrollment-revoked" });
});

it("keeps legacy GitHub.com runtime contexts usable without Enterprise deployment configuration", async () => {
  const f = await enterpriseFixture();
  const { store, service } = await f.boundService();
  const binding = await store.createBinding(
    projectId,
    service.principal_id,
    {
      name: "github-ci",
      provider: "github-actions",
      issuer: GITHUB_ACTIONS_ISSUER,
      subject: context.sub,
      policy: actionsPolicy,
    },
    actor,
  );
  const runtime = new RuntimeStore(bindings.DB);
  const run = await runtime.startWithPolicy(
    projectId,
    service.principal_id,
    {
      operation_id: crypto.randomUUID(),
      jkt: "a".repeat(43),
      policy: actionsPolicy,
    },
    actionsPolicy,
    { id: crypto.randomUUID(), hash: "local-github-run" },
    {
      workload_binding_id: binding.binding_id,
      workload_context_json: JSON.stringify(context),
    },
  );
  expect((await runtime.context(run.token_id)).policy).toMatchObject(
    actionsPolicy,
  );
  await bindings.DB.prepare(
    "UPDATE _project_repos SET oidc_enabled=0 WHERE project_id=? AND github_host='github.com'",
  )
    .bind(projectId)
    .run();
  await expect(runtime.context(run.token_id)).rejects.toMatchObject({
    code: "enrollment-revoked",
  });
});
