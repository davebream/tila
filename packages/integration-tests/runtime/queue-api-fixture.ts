import { SELF } from "cloudflare:test";
import { SignJWT } from "jose";
import { RemoteAttemptBackend, RemoteQueueBackend, TilaClient } from "tila-sdk";
import { expect } from "vitest";
import { lifecycleDefinition } from "../../ops-sqlite/test/readiness-fixture";
import { D1TokenStore, ProjectMembershipStore } from "../../worker/src/d1";
import { hashToken } from "../../worker/src/lib/hash";
import { bindings } from "./setup";
export async function queueApiFixture(definition = lifecycleDefinition) {
  const project = `queue-api-${crypto.randomUUID()}`;
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, created_at, created_by, cloudflare_account_id, membership_mode) VALUES (?, 0, 'fixture', 'local', 'explicit')",
  )
    .bind(project)
    .run();
  const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  const issued = await new D1TokenStore(bindings.DB).issue({
    projectId: project,
    tokenHash: await hashToken(token, bindings.HASH_PEPPER),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
  const http = (
    path: string,
    body?: unknown,
    participant = "worker",
    key?: string,
  ) =>
    SELF.fetch(`https://worker/projects/${project}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": participant,
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const client = new TilaClient({
    baseUrl: "https://worker",
    token,
    participantId: "worker",
    fetch: (async (input, init) => {
      const response = await SELF.fetch(input, { ...init, redirect: "manual" });
      if (response.status >= 300 && response.status < 400)
        throw new Error("Unexpected redirect");
      return response;
    }) as typeof fetch,
  });
  const queue = new RemoteQueueBackend(client, project);
  const attempts = new RemoteAttemptBackend(client, project);
  const schema = await http("/schema", {
    definition,
    expected_revision: 0,
  });
  expect(schema.status, await schema.clone().text()).toBe(200);
  return { project, token, issued, http, queue, attempts, client };
}
/** A participant-role human member, so maintainer authority never applies. */
export async function member(project: string, userId: number) {
  const { membership } = await new ProjectMembershipStore(bindings.DB).grant({
    projectId: project,
    principal: { provider: "github", host: "github.com", user_id: userId },
    subjectKind: "human",
    role: "participant",
    actorPrincipalId: "fixture",
  });
  const now = Math.floor(Date.now() / 1000);
  const key = Uint8Array.from(
    atob(
      bindings.GITHUB_SESSION_HMAC_KEY.replace(/-/g, "+").replace(/_/g, "/"),
    ),
    (c) => c.charCodeAt(0),
  );
  const token = `tila_s.${await new SignJWT({
    jti: crypto.randomUUID(),
    authorization_version: 2,
    project_id: project,
    github_host: "github.com",
    github_repo_id: 42,
    github_login: `user-${userId}`,
    github_user_id: userId,
    permission: "write",
    issued_at: now,
    expires_at: now + 3600,
    iss: "tila",
    aud: "tila",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(key)}`;
  const principal = `github:github.com:${userId}`;
  const post = async (path: string, body: object, participant: string) =>
    SELF.fetch(`https://worker/projects/${project}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tila-Participant-Id": participant,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const get = async (path: string, participant: string) =>
    SELF.fetch(`https://worker/projects/${project}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tila-Participant-Id": participant,
      },
    });
  return {
    principal,
    post,
    get,
    revoke: () =>
      new ProjectMembershipStore(bindings.DB).revoke({
        projectId: project,
        membershipId: membership.membership_id,
        actorPrincipalId: "fixture",
      }),
  };
}
