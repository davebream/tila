import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  type RuntimeCredentialResponse,
  accessTokenHash,
  canonicalizeHtu,
} from "@tila/schemas";
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from "jose";
import { expect, it, vi } from "vitest";
import {
  CredentialStore,
  D1SessionStore,
  D1TokenStore,
} from "../../worker/src/d1";
import worker from "../../worker/src/index";
import { hashToken } from "../../worker/src/lib/hash-token";
import type { Env } from "../../worker/src/types";
import { bindings } from "./setup";

const origin = "https://worker";
const password = "fixture-owner-password-307";
const pepper = "fixture-new-pepper-307";
const cursorKey = "fixture-independent-conversation-key-307";
const policy = {
  role: "viewer" as const,
  capabilities: ["tasks:read" as const],
};
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Issued {
  token: string;
  token_id: string;
  credential_id: string;
  principal_id: string;
  name: string;
  policy: typeof policy;
  expires_at: number;
}
async function json<T>(response: Response, status = 200): Promise<T> {
  // Do not put successful credential responses in assertion diagnostics.
  if (response.status !== status) {
    const body = await response.clone().json<{ error?: { code?: string } }>();
    expect(
      response.status,
      body.error?.code ?? "unexpected response status",
    ).toBe(status);
  }
  return response.json<T>();
}
async function key() {
  const pair = await generateKeyPair("ES256");
  const jwk = await exportJWK(pair.publicKey);
  return { pair, jwk, jkt: await calculateJwkThumbprint(jwk) };
}
type Key = Awaited<ReturnType<typeof key>>;
async function proof(k: Key, token: string, path: string, method: string) {
  return new SignJWT({
    htm: method,
    htu: canonicalizeHtu(`${origin}${path}`),
    ath: await accessTokenHash(token),
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: k.jwk })
    .sign(k.pair.privateKey);
}

/** One database, changing deployment bindings; setup.ts prevents external egress. */
async function deployment() {
  const project = `pepper-${crypto.randomUUID()}`;
  const root = `/projects/${project}`;
  const env = {
    ...bindings,
    HASH_PEPPER: undefined,
    CONVERSATION_CURSOR_KEY: cursorKey,
  } as unknown as Env;
  let cookie = "";
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id,created_at,created_by,cloudflare_account_id,membership_mode) VALUES (?,0,'fixture','local','explicit')",
  )
    .bind(project)
    .run();
  const http = async (
    path: string,
    body?: unknown,
    auth: Record<string, string> = { Cookie: cookie },
    method = body === undefined ? "GET" : "POST",
  ) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(auth.DPoP ? {} : { "X-Tila-Participant-Id": "cutover-operator" }),
          ...auth,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  };
  const login = async (value = password) => {
    const response = await http(
      "/api/account/auth/sign-in/email",
      { email: "owner@example.com", password: value },
      {},
    );
    await json(response.clone());
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(cookie.includes("tila-account.session_token")).toBe(true);
    await json(await http("/api/workspace/select", { project_id: project }));
  };
  const invitation = await json<{ url: string }>(
    await http(
      "/api/account/setup",
      { email: "owner@example.com", projectId: project },
      bearer("runtime-test-infra-owner"),
    ),
  );
  await json(
    await http(
      "/api/account/invitations/accept",
      { token: new URL(invitation.url).hash.slice(1), name: "Owner", password },
      {},
    ),
  );
  await login();
  const owner = await json<{ user: { id: string } }>(
    await http("/api/account/me"),
  );
  const service = await json<{ service_account: { principal_id: string } }>(
    await http(`${root}/service-accounts`, {
      name: "reporter",
      display_name: "Reporter",
      role: "viewer",
    }),
    201,
  );
  const issue = async (name: string, k?: Key) =>
    json<Issued>(
      await http("/api/tokens", {
        name,
        principal_id: service.service_account.principal_id,
        policy,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        ...(k ? { jkt: k.jkt } : {}),
      }),
      201,
    );
  const rotate = async (value: Pick<Issued, "name" | "token_id">) =>
    http(`/api/tokens/${value.name}/rotate`, {
      expected_token_id: value.token_id,
      overlap_seconds: 0,
    });
  const read = async (value: Issued, k?: Key) =>
    http(`${root}/tasks`, undefined, {
      ...bearer(value.token),
      ...(k
        ? { DPoP: await proof(k, value.token, `${root}/tasks`, "GET") }
        : {}),
    });
  return { env, project, root, http, login, issue, rotate, read, owner };
}

it("cuts over existing credentials, recovers the owner and a lost rotation response without widening access", async () => {
  const d = await deployment();
  const k = await key();
  const issued = await d.issue("report", k);
  const revoked = await d.issue("revoked");
  expect((await d.read(issued, k)).status).toBe(200);
  await json(
    await d.http("/api/tokens/revoked", undefined, undefined, "DELETE"),
  );
  expect((await d.read(revoked)).status).toBe(401);
  const memberships = await json(await d.http(`${d.root}/memberships`));
  // A persisted, pre-existing scoped cookie: the retired token-to-cookie API is not used.
  const legacyCookie = `legacy-${crypto.randomUUID()}`;
  const source = await d.issue("legacy-cookie-source");
  await new D1SessionStore(bindings.DB).create({
    sessionHash: await hashToken(legacyCookie, undefined),
    projectId: d.project,
    tokenHash: await hashToken(source.token, undefined),
    actorName: "legacy",
    principalId: source.principal_id,
    scopes: "scoped-v1",
    permission: "read",
    expiresAt: Date.now() + 3600_000,
  });
  const legacyAuth = { Cookie: `tila_session=${legacyCookie}` };
  expect((await d.http(`${d.root}/tasks`, undefined, legacyAuth)).status).toBe(
    200,
  );
  await json(
    await d.http(`${d.root}/rooms`, { id: "general", name: "General" }),
  );
  await json(
    await d.http(`${d.root}/rooms/general/messages`, {
      client_op_id: "before",
      body: "before cutover",
    }),
  );
  const history = await json<{ cursor: string }>(
    await d.http(`${d.root}/rooms/general/messages?limit=1`),
  );

  d.env.HASH_PEPPER = pepper;
  expect((await d.read(issued, k)).status).toBe(401);
  expect((await d.http(`${d.root}/tasks`, undefined, legacyAuth)).status).toBe(
    401,
  );
  expect((await d.http("/api/account/me")).status).toBe(200);
  // Interruption immediately after secret change: discard the owner's active session.
  const recovery = await json<{ url: string }>(
    await d.http(
      "/api/account/recovery/owner",
      { email: "owner@example.com" },
      bearer("runtime-test-infra-owner"),
    ),
  );
  expect(
    (
      await d.http(
        "/api/account/recovery/owner",
        { email: "owner@example.com" },
        bearer("wrong-infra-token"),
      )
    ).status,
  ).toBe(403);
  const reset = {
    token: new URL(recovery.url).hash.slice(1),
    password: "recovered-owner-password-307",
  };
  await json(await d.http("/api/account/recovery/accept", reset, {}));
  expect((await d.http("/api/account/me")).status).toBe(401);
  expect((await d.http("/api/account/recovery/accept", reset, {})).status).toBe(
    400,
  );
  await d.login(reset.password);
  expect(await json(await d.http(`${d.root}/memberships`))).toEqual(
    memberships,
  );

  // Simulate losing a successful rotation's plaintext response.
  const lost = await d.rotate(issued);
  expect(lost.status).toBe(201);
  await lost.arrayBuffer();
  expect((await d.rotate(issued)).status).toBe(409);
  const list = await json<{ tokens: Issued[] }>(await d.http("/api/tokens"));
  const current = list.tokens.find((row) => row.name === "report");
  expect(current).toBeDefined();
  if (!current) throw new Error("Missing credential inventory entry");
  const replacement = await json<Issued>(await d.rotate(current), 201);
  expect(replacement).toMatchObject({
    credential_id: issued.credential_id,
    principal_id: issued.principal_id,
    policy: issued.policy,
    expires_at: issued.expires_at,
  });
  expect((await d.read(replacement, k)).status).toBe(200);
  expect((await d.read(replacement)).status).toBe(401);
  expect(
    (
      await d.http(
        `${d.root}/tasks`,
        { id: "forbidden", type: "task", data: {} },
        {
          ...bearer(replacement.token),
          "X-Tila-Participant-Id": "bound-reporter",
          DPoP: await proof(k, replacement.token, `${d.root}/tasks`, "POST"),
        },
      )
    ).status,
  ).toBe(403);
  expect((await d.read(revoked)).status).toBe(401);
  await json(
    await d.http(`${d.root}/rooms/general/messages`, {
      client_op_id: "after",
      body: "after cutover",
    }),
  );
  const messages = await json<{ messages: { body: string }[] }>(
    await d.http(`${d.root}/rooms/general/messages`),
  );
  expect(messages.messages.map((message) => message.body)).toEqual(
    expect.arrayContaining(["before cutover", "after cutover"]),
  );
  expect(
    (
      await d.http(
        `${d.root}/rooms/general/messages?cursor=${encodeURIComponent(history.cursor)}`,
      )
    ).status,
  ).toBe(200);
  const publicState = JSON.stringify(
    await json(await d.http("/api/health", undefined, {})),
  );
  const inventory = JSON.stringify(list);
  for (const secret of [pepper, cursorKey, issued.token, replacement.token]) {
    expect(publicState.includes(secret)).toBe(false);
    expect(inventory.includes(secret)).toBe(false);
  }
});

it("rehearses rollback before and after replacement without undoing revocations", async () => {
  const d = await deployment();
  const issued = await d.issue("consumer");
  const legacy = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await new D1TokenStore(bindings.DB).issue({
    projectId: d.project,
    tokenHash: await hashToken(legacy, undefined),
    name: "legacy-bootstrap",
    createdBy: "fixture",
    createdAt: 0,
  });
  expect(
    (await d.http(`${d.root}/tasks`, undefined, bearer(legacy))).status,
  ).toBe(200);
  await json(
    await d.http(
      "/api/tokens/legacy-bootstrap",
      undefined,
      undefined,
      "DELETE",
    ),
  );
  d.env.HASH_PEPPER = pepper;
  expect((await d.read(issued)).status).toBe(401);
  d.env.HASH_PEPPER = undefined;
  expect((await d.read(issued)).status).toBe(200);
  expect(
    (await d.http(`${d.root}/tasks`, undefined, bearer(legacy))).status,
  ).toBe(401);
  d.env.HASH_PEPPER = pepper;
  const replacement = await json<Issued>(await d.rotate(issued), 201);
  expect((await d.read(replacement)).status).toBe(200);
  d.env.HASH_PEPPER = undefined;
  expect((await d.read(replacement)).status).toBe(401);
  expect((await d.read(issued)).status).toBe(401);
  expect(
    (await d.http(`${d.root}/tasks`, undefined, bearer(legacy))).status,
  ).toBe(401);
  expect((await d.http("/api/account/me")).status).toBe(200);
  d.env.HASH_PEPPER = pepper;
  expect((await d.read(replacement)).status).toBe(200);
});

it("replaces shared installations and runs and rejects pre-cutover invitations", async () => {
  const d = await deployment();
  const installation = await key();
  const runKey = await key();
  const invite = async () =>
    json<{ invitation: string }>(
      await d.http(`${d.root}/runtime/invitations`, { name: "Host" }),
    );
  const redeem = async (invitation: string) =>
    d.http(
      `${d.root}/runtime/redeem`,
      {
        invitation,
        name: "Host",
        operation_id: crypto.randomUUID(),
        installation_id: crypto.randomUUID(),
        jkt: installation.jkt,
      },
      {
        ...bearer(invitation),
        DPoP: await proof(
          installation,
          invitation,
          `${d.root}/runtime/redeem`,
          "POST",
        ),
      },
    );
  const start = async (token: string) =>
    d.http(
      `${d.root}/runtime/runs`,
      { operation_id: crypto.randomUUID(), jkt: runKey.jkt },
      {
        ...bearer(token),
        DPoP: await proof(
          installation,
          token,
          `${d.root}/runtime/runs`,
          "POST",
        ),
      },
    );
  const oldInvitation = await invite();
  const oldEnrollment = await json<RuntimeCredentialResponse>(
    await redeem(oldInvitation.invitation),
  );
  const oldRun = await json<RuntimeCredentialResponse>(
    await start(oldEnrollment.token),
  );
  const context = async (token: string, k: Key) =>
    d.http("/api/runtime/context", undefined, {
      ...bearer(token),
      DPoP: await proof(k, token, "/api/runtime/context", "GET"),
    });
  expect((await context(oldRun.token, runKey)).status).toBe(200);
  d.env.HASH_PEPPER = pepper;
  expect((await context(oldEnrollment.token, installation)).status).toBe(401);
  expect((await context(oldRun.token, runKey)).status).toBe(401);
  expect((await redeem(oldInvitation.invitation)).status).toBe(403);
  await json(
    await d.http(
      `${d.root}/runtime/enrollments/${oldEnrollment.context.enrollment_id}/revoke`,
      {},
    ),
  );
  const newInvitation = await invite();
  const enrollment = await json<RuntimeCredentialResponse>(
    await redeem(newInvitation.invitation),
  );
  const run = await json<RuntimeCredentialResponse>(
    await start(enrollment.token),
  );
  expect((await context(run.token, runKey)).status).toBe(200);
  expect(
    (
      await d.http(`${d.root}/tasks`, undefined, {
        ...bearer(run.token),
        DPoP: await proof(runKey, run.token, `${d.root}/tasks`, "GET"),
      })
    ).status,
  ).toBe(200);
  // A rollback cannot revive the revoked old installation or its descendants.
  d.env.HASH_PEPPER = undefined;
  expect((await context(oldEnrollment.token, installation)).status).toBe(403);
  expect((await context(oldRun.token, runKey)).status).toBe(403);
});

it("re-exchanges a signed workload assertion under the new pepper without weakening verification or replay protection", async () => {
  const d = await deployment();
  const issuer = `https://issuer-${crypto.randomUUID()}.example.com`;
  const pair = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
  // Only the external provider transport is a fixture. Discovery, signature,
  // audience, workload authorization, mint and lookup execute production code.
  vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${issuer}/.well-known/openid-configuration`)
      return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
    if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    throw new Error("Unexpected outbound network call");
  });
  await bindings.DB.prepare(
    "UPDATE _projects SET oidc_issuer=?, oidc_audience='tila' WHERE project_id=?",
  )
    .bind(issuer, d.project)
    .run();
  const store = new CredentialStore(bindings.DB);
  const actor = { principalId: `user:${d.owner.user.id}` };
  const service = await store.createService(
    d.project,
    { name: "ci", display_name: "CI", role: "viewer" },
    actor,
  );
  await store.createBinding(
    d.project,
    service.principal_id,
    { name: "ci", provider: "oidc", issuer, subject: "build", policy },
    actor,
  );
  const assertion = async (audience = "tila") =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("build")
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey);
  const exchange = (token: string) =>
    d.http(
      "/api/auth/oidc/exchange",
      { project_id: d.project, oidc_token: token },
      {},
    );
  const oldAssertion = await assertion();
  const old = await json<{
    session_token: string;
    principal_id: string;
    policy: typeof policy;
  }>(await exchange(oldAssertion));
  expect(
    (await d.http(`${d.root}/tasks`, undefined, bearer(old.session_token)))
      .status,
  ).toBe(200);
  d.env.HASH_PEPPER = pepper;
  expect(
    (await d.http(`${d.root}/tasks`, undefined, bearer(old.session_token)))
      .status,
  ).toBe(401);
  expect((await exchange(oldAssertion)).status).toBe(409);
  expect((await exchange(await assertion("wrong-audience"))).status).toBe(401);
  const replacement = await json<typeof old>(await exchange(await assertion()));
  expect(replacement.principal_id).toBe(old.principal_id);
  expect(replacement.policy).toEqual(old.policy);
  expect(
    (
      await d.http(
        `${d.root}/tasks`,
        undefined,
        bearer(replacement.session_token),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await d.http(
        `${d.root}/tasks`,
        { id: "forbidden", type: "task", data: {} },
        bearer(replacement.session_token),
      )
    ).status,
  ).toBe(403);
});
