import { SELF } from "cloudflare:test";
import { D1TokenStore, RuntimeStore } from "@tila/backend-d1";
import {
  type RuntimeContext,
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
import { hashToken } from "../../worker/src/lib/hash";
import { bindings } from "./setup";

it("enrolls, runs workflows, renews and revokes through real Worker, D1, DO SQLite and R2", async () => {
  const project = `run-${crypto.randomUUID()}`;
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, created_at, created_by, cloudflare_account_id, membership_mode) VALUES (?, 0, 'fixture', 'local', 'explicit')",
  )
    .bind(project)
    .run();
  const owner = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await new D1TokenStore(bindings.DB).issue({
    projectId: project,
    tokenHash: await hashToken(owner, undefined),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
  async function key() {
    const pair = await generateKeyPair("ES256");
    const jwk = await exportJWK(pair.publicKey);
    return { pair, jwk, jkt: await calculateJwkThumbprint(jwk) };
  }
  const installation = await key();
  const runKey = await key();
  async function http(
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
    proofKey?: Awaited<ReturnType<typeof key>>,
    participant?: string | null,
  ) {
    const url = `https://worker${path}`;
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
    const response = await SELF.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `${method}:${path}`,
        ...(proof ? { DPoP: proof } : {}),
        ...(participant ? { "X-Tila-Participant-Id": participant } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        token: string;
        invitation: string;
        context: RuntimeContext;
        fence: number;
        key: string;
        id: string;
      },
    };
  }
  const root = `/projects/${project}`;
  const invite = await http(`${root}/runtime/invitations`, owner, "POST", {
    name: "Runner",
  });
  expect(invite.status).toBe(200);
  const enrolled = await http(
    `${root}/runtime/redeem`,
    invite.body.invitation,
    "POST",
    {
      invitation: invite.body.invitation,
      operation_id: crypto.randomUUID(),
      installation_id: crypto.randomUUID(),
      name: "Runner",
      jkt: installation.jkt,
    },
    installation,
  );
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
  const run = await http(
    `${root}/runtime/runs`,
    enrolled.body.token,
    "POST",
    { operation_id: crypto.randomUUID(), jkt: runKey.jkt },
    installation,
  );
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  const participant = run.body.context.participant_id;
  expect(
    (
      await http(
        `${root}/tasks`,
        run.body.token,
        "GET",
        undefined,
        runKey,
        participant,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await http(
        `${root}/presence/heartbeat`,
        run.body.token,
        "POST",
        {},
        runKey,
        participant,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await http(
        `${root}/schema`,
        run.body.token,
        "PUT",
        {},
        runKey,
        participant,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await http(
        `${root}/tasks`,
        enrolled.body.token,
        "GET",
        undefined,
        installation,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await http(
        `${root}/tasks`,
        run.body.token,
        "GET",
        undefined,
        runKey,
        "spoof",
      )
    ).status,
  ).toBe(403);
  // The worker preset covers the complete coordination path, including R2.
  async function work(path: string, method = "GET", body?: unknown) {
    const result = await http(
      `${root}${path}`,
      run.body.token,
      method,
      body,
      runKey,
      participant,
    );
    expect(result.status, `${path}: ${JSON.stringify(result.body)}`).toBe(200);
    return result.body;
  }
  await work("/reentry");
  await work("/schema");
  await work("/summary");
  await work("/tasks", "POST", {
    id: "runtime-task",
    type: "task",
    data: { title: "Managed work" },
  });
  const claim = await work("/claims/acquire", "POST", {
    resource: "artifact:runtime-report",
    mode: "exclusive",
    ttl_ms: 60_000,
  });
  await work("/claims/renew", "POST", {
    resource: "artifact:runtime-report",
    fence: claim.fence,
    ttl_ms: 60_000,
  });
  const artifact = await work("/artifacts/text", "POST", {
    content: "Managed report",
    kind: "report",
    mime_type: "text/plain",
    lineage_id: "runtime-report",
    lineage_fence: claim.fence,
  });
  await work(`/artifacts/${encodeURIComponent(artifact.key)}/meta`);
  const signal = await work("/signals/send", "POST", {
    target: {
      type: "participant",
      principal_id: run.body.context.principal_id,
      participant_id: participant,
    },
    kind: "info",
    payload: { ready: true },
  });
  await work("/signals");
  await work(`/signals/${signal.id}/ack`, "POST", {});
  await work("/handoffs", "POST", {
    id: crypto.randomUUID(),
    kind: "shutdown",
    summary: "Completed run",
    based_on_seq: 0,
  });
  await work("/journal/cursor", "PUT", { seq: 0 });
  await work("/claims/release", "POST", {
    resource: "artifact:runtime-report",
    fence: claim.fence,
  });
  const renewed = await http(
    `${root}/runtime/runs/${run.body.context.run_id}/renew`,
    enrolled.body.token,
    "POST",
    { expected_token_id: run.body.context.token_id },
    installation,
  );
  expect(renewed.status).toBe(200);
  expect(renewed.body.context.participant_id).toBe(participant);
  const replay = await http(
    `${root}/claims/acquire`,
    renewed.body.token,
    "POST",
    { resource: "artifact:runtime-report", mode: "exclusive", ttl_ms: 60_000 },
    runKey,
    participant,
  );
  expect(replay.status, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body.fence).toBe(claim.fence);

  expect(
    (
      await http(
        `${root}/runtime/enrollments/${enrolled.body.context.enrollment_id}/revoke`,
        owner,
        "POST",
        {},
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await http(
        `${root}/tasks`,
        renewed.body.token,
        "GET",
        undefined,
        runKey,
        participant,
      )
    ).status,
  ).toBe(403);
  await expect(
    new RuntimeStore(bindings.DB).context(run.body.context.token_id),
  ).rejects.toThrow();
});
