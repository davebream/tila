import { SELF } from "cloudflare:test";
import {
  RUNTIME_RUN_CEILING,
  type RuntimeCredentialResponse,
  type RuntimeViewResponse,
  accessTokenHash,
  canonicalizeHtu,
} from "@tila/schemas";
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from "jose";
import { expect, it } from "vitest";
import {
  D1TokenStore,
  ProjectMembershipStore,
  RuntimeStore,
} from "../../worker/src/d1";
import { hashToken } from "../../worker/src/lib/hash";
import { bindings } from "./setup";

async function key() {
  const pair = await generateKeyPair("ES256");
  const jwk = await exportJWK(pair.publicKey);
  return { pair, jwk, jkt: await calculateJwkThumbprint(jwk) };
}

async function fixture() {
  const project = `runtime-view-${crypto.randomUUID()}`;
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, created_at, created_by, cloudflare_account_id, membership_mode) VALUES (?, 0, 'fixture', 'local', 'explicit')",
  )
    .bind(project)
    .run();
  const owner = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await new D1TokenStore(bindings.DB).issue({
    projectId: project,
    tokenHash: await hashToken(owner, bindings.HASH_PEPPER),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
  const root = `/projects/${project}`;
  async function http(
    path: string,
    token = owner,
    method = "GET",
    body?: unknown,
    proofKey?: Awaited<ReturnType<typeof key>>,
    participant = "operator",
  ) {
    const url = `https://worker${root}${path}`;
    const proof = proofKey
      ? await new SignJWT({
          htm: method,
          htu: canonicalizeHtu(url),
          ath: await accessTokenHash(token),
          iat: Math.floor(Date.now() / 1000),
          jti: crypto.randomUUID(),
        })
          .setProtectedHeader({
            typ: "dpop+jwt",
            alg: "ES256",
            jwk: proofKey.jwk,
          })
          .sign(proofKey.pair.privateKey)
      : undefined;
    return SELF.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(proof ? { DPoP: proof } : {}),
        "X-Tila-Participant-Id": participant,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const installation = await key();
  const invite = await http("/runtime/invitations", owner, "POST", {
    name: "studio-mac",
    policy: RUNTIME_RUN_CEILING,
  });
  expect(invite.status, await invite.clone().text()).toBe(200);
  const { invitation } = await invite.json<{ invitation: string }>();
  const redeemed = await http(
    "/runtime/redeem",
    invitation,
    "POST",
    {
      invitation,
      name: "studio-mac",
      installation_id: crypto.randomUUID(),
      operation_id: crypto.randomUUID(),
      jkt: installation.jkt,
      policy: RUNTIME_RUN_CEILING,
    },
    installation,
  );
  expect(redeemed.status, await redeemed.clone().text()).toBe(200);
  const parent = await redeemed.json<RuntimeCredentialResponse>();
  const registered = await http("/agents", owner, "POST", {
    id: "worker",
    name: "Worker",
    bind_policy: [
      { principal_id: parent.context.principal_id, agent_id: "worker" },
    ],
  });
  expect(registered.status, await registered.clone().text()).toBe(200);
  const enrollment = parent.context.enrollment_id as string;

  async function startAndBind(epoch: number, session: string) {
    const runKey = await key();
    const started = await http(
      "/runtime/runs",
      parent.token,
      "POST",
      {
        operation_id: crypto.randomUUID(),
        jkt: runKey.jkt,
        agent_id: "worker",
        policy: RUNTIME_RUN_CEILING,
      },
      installation,
    );
    expect(started.status, await started.clone().text()).toBe(200);
    const run = await started.json<RuntimeCredentialResponse>();
    const bound = await http(
      "/agents/worker/bind",
      run.token,
      "POST",
      {
        expected_epoch: epoch,
        harness: "claude-code",
        mechanism: "native-queue",
        // Both sessions run in the same directory; only the session differs.
        native_session_ref: {
          host_ref: enrollment,
          harness: "claude-code",
          profile_id: "work",
          session_id: session,
        },
        profile: {
          profile_id: "work",
          profile_revision: 2,
          account_ref: "b".repeat(64),
          verification: "declared",
        },
        capability_report: {
          protocol: 1,
          adapter_version: "1.2.0",
          capabilities: { "io.tila/native-queue": true },
        },
      },
      runKey,
      run.context.participant_id as string,
    );
    expect(bound.status, await bound.clone().text()).toBe(200);
    return run;
  }
  async function view(token = owner, query = "") {
    const response = await http(`/runtime-view${query}`, token);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    return response.json<RuntimeViewResponse>();
  }
  return { project, owner, http, startAndBind, view, enrollment };
}

it("links agents to runs, hosts and sessions and keeps replaced occupants distinct", async () => {
  const f = await fixture();
  const first = await f.startAndBind(0, "session-one");
  const second = await f.startAndBind(1, "session-two");
  const body = await f.view();
  expect(body.sources).toEqual({
    agents: "ok",
    runs: "ok",
    enrollments: "ok",
    presence: "ok",
  });
  const [row] = body.rows;
  expect(row.work_attempt).toBeNull();
  expect(row.current).toMatchObject({
    binding: {
      detail: "full",
      binding_epoch: 2,
      native_session_ref: { session_id: "session-two" },
      profile: { verification: "declared" },
    },
    run: { status: "visible", run_id: second.context.run_id },
    host: { status: "enrollment", name: "studio-mac" },
    observation: { lifecycle: "attached", detail: "full" },
  });
  expect(row.previous).toMatchObject({
    binding: {
      binding_epoch: 1,
      native_session_ref: { session_id: "session-one" },
    },
    run: { status: "visible", run_id: first.context.run_id },
    observation: {
      lifecycle: "replaced",
      reasons: ["replaced-run-still-active"],
    },
  });
  expect(row.commands).toMatchObject({
    release: { allowed: true, expected_epoch: 2 },
    reconnect: { supported: false, reason: "no-host-adapter-command" },
    stop: { supported: false, reason: "no-host-adapter-command" },
  });

  // The replaced occupant's epoch cannot release the current binding.
  const stale = await f.http("/agents/worker/release", f.owner, "POST", {
    expected_epoch: 1,
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: { code: "stale-binding" },
  });
  const released = await f.http("/agents/worker/release", f.owner, "POST", {
    expected_epoch: 2,
  });
  expect(released.status, await released.clone().text()).toBe(200);
  const again = await f.http("/agents/worker/release", f.owner, "POST", {
    expected_epoch: 2,
  });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({
    error: { code: "no-active-binding" },
  });
  const after = await f.view();
  expect(after.rows[0].current).toBeNull();
  expect(after.rows[0].previous?.observation.lifecycle).toBe("released");
  expect(after.rows[0].commands.release).toMatchObject({
    allowed: false,
    denied_reason: "no-active-binding",
  });
});

it("uses D1 run authority over the DO lease snapshot", async () => {
  const f = await fixture();
  const run = await f.startAndBind(0, "session-one");
  await bindings.DB.prepare(
    "UPDATE _runtime_runs SET lease_expires_at = ? WHERE run_id = ?",
  )
    .bind(Math.floor(Date.now() / 1000) - 1, run.context.run_id)
    .run();
  expect((await f.view()).rows[0].current?.observation).toMatchObject({
    lifecycle: "expired",
    reasons: ["run-lease-lapsed"],
  });
  await bindings.DB.prepare(
    "UPDATE _runtime_runs SET lease_expires_at = ? WHERE run_id = ?",
  )
    .bind(Math.floor(Date.now() / 1000) + 300, run.context.run_id)
    .run();
  await bindings.DB.prepare(
    "UPDATE _runtime_enrollments SET revoked_at = ? WHERE enrollment_id = ?",
  )
    .bind(Math.floor(Date.now() / 1000), f.enrollment)
    .run();
  expect((await f.view()).rows[0].current?.observation).toMatchObject({
    lifecycle: "expired",
    reasons: ["host-enrollment-revoked"],
  });
});

it("redacts binding, run, host and session evidence for a viewer", async () => {
  const f = await fixture();
  const run = await f.startAndBind(0, "session-one");
  const { membership } = await new ProjectMembershipStore(bindings.DB).grant({
    projectId: f.project,
    principal: { provider: "github", host: "github.com", user_id: 777 },
    subjectKind: "human",
    role: "viewer",
    actorPrincipalId: "fixture",
  });
  expect(membership.role).toBe("viewer");
  const now = Math.floor(Date.now() / 1000);
  const hmac = Uint8Array.from(
    atob(
      bindings.GITHUB_SESSION_HMAC_KEY.replace(/-/g, "+").replace(/_/g, "/"),
    ),
    (character) => character.charCodeAt(0),
  );
  const viewer = `tila_s.${await new SignJWT({
    authorization_version: 2,
    project_id: f.project,
    github_host: "github.com",
    github_repo_id: 42,
    github_login: "viewer",
    github_user_id: 777,
    permission: "read",
    issued_at: now,
    expires_at: now + 3600,
    iss: "tila",
    aud: "tila",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(hmac)}`;
  const body = await f.view(viewer);
  const json = JSON.stringify(body);
  for (const secret of [
    run.context.run_id as string,
    run.context.participant_id as string,
    "session-one",
    "b".repeat(64),
    "studio-mac",
    f.enrollment,
  ])
    expect(json).not.toContain(secret);
  expect(body.rows[0].current).toMatchObject({
    binding: { detail: "redacted", binding_epoch: 1 },
    run: { status: "redacted" },
    host: { status: "redacted" },
    observation: { lifecycle: "attached", detail: "redacted" },
  });
  expect(body.rows[0].commands.release.allowed).toBe(false);
});

it("bounds pages, rejects bad cursors and keeps internal routes private", async () => {
  const f = await fixture();
  for (const id of ["runtime-view", "zeta"])
    expect(
      (await f.http("/agents", f.owner, "POST", { id, name: id })).status,
    ).toBe(200);
  const first = await f.view(f.owner, "?limit=1");
  expect(first.rows.map((row) => row.agent.id)).toEqual(["runtime-view"]);
  expect(first.next_cursor).toEqual(expect.any(String));
  const second = await f.view(f.owner, `?limit=1&cursor=${first.next_cursor}`);
  expect(second.rows.map((row) => row.agent.id)).toEqual(["worker"]);
  expect(
    (await f.view(f.owner, "?agent=zeta")).rows.map((row) => row.agent.id),
  ).toEqual(["zeta"]);
  expect((await f.http("/runtime-view?limit=51")).status).toBe(400);
  expect((await f.http("/runtime-view?cursor=not-a-cursor")).status).toBe(400);
  // An agent may be named like the new route; its own view is unaffected.
  expect((await f.http("/agents/runtime-view")).status).toBe(200);
  // Unmapped routes fail closed before reaching the DO.
  expect((await f.http("/agents/internal/runtime-page?limit=1")).status).toBe(
    403,
  );
});

it("looks up runs and enrollments in parameter-bounded chunks", async () => {
  const store = new RuntimeStore(bindings.DB);
  const project = "chunked";
  const ids = Array.from({ length: 120 }, () => crypto.randomUUID());
  await bindings.DB.batch(
    ids.map((id, index) =>
      bindings.DB.prepare(
        "INSERT INTO _runtime_runs (run_id, project_id, workload_binding_id, principal_id, participant_id, jkt, policy_json, lease_expires_at, created_at, current_token_id) VALUES (?, ?, 'workload', 'p', ?, 'jkt', '{}', 1, 1, ?)",
      ).bind(id, project, `participant-${index}`, crypto.randomUUID()),
    ),
  );
  const runs = await store.runsByIds(project, [...ids, ...ids.slice(0, 5)]);
  expect(runs).toHaveLength(120);
  expect(runs[0]).not.toHaveProperty("jkt");
  expect(runs[0]).not.toHaveProperty("policy_json");
  expect(await store.runsByIds("other", ids)).toHaveLength(0);
});
