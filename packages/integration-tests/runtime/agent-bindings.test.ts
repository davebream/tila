import { SELF } from "cloudflare:test";
import { D1TokenStore } from "@tila/backend-d1";
import { projectTransferOps } from "@tila/ops-sqlite";
import {
  RUNTIME_RUN_CEILING,
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
import { expect, it } from "vitest";
import { hashToken } from "../../worker/src/lib/hash";
import { bindings } from "./setup";

it("restores real DO snapshots without resurrecting bindings or rewinding epochs", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const principal = "fixture:owner";
  const runtime = {
    run_id: crypto.randomUUID(),
    agent_id: "worker",
    run_role: "acting",
    principal_id: principal,
    participant_id: "fixture",
    enrollment_id: crypto.randomUUID(),
    workload_binding_id: null,
    lease_expires_at: Math.floor(Date.now() / 1000) + 300,
  };
  async function post(path: string, body: unknown, run = runtime) {
    const response = await stub.fetch(`https://project${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tila-Agent-Authority": JSON.stringify({
          principal_id: principal,
          can_manage: true,
          runtime: run,
        }),
      },
      body: JSON.stringify(body),
    });
    expect(response.status, `${path}: ${await response.clone().text()}`).toBe(
      200,
    );
    return response;
  }
  await post("/agents", { id: "worker", name: "Worker" });
  const attach = {
    harness: "cli",
    mechanism: "native-peer",
    capability_report: {
      protocol: 1,
      adapter_version: "fixture",
      capabilities: {},
    },
  };
  await post("/agents/worker/bind", { ...attach, expected_epoch: 0 });
  const conversationAuthority = {
    principal_id: principal,
    participant_id: "fixture",
    can_manage: true,
    runtime: null,
  };
  async function conversation(path: string, body?: unknown) {
    const response = await stub.fetch(`https://project${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tila-Conversation-Authority": JSON.stringify(conversationAuthority),
        "X-Tila-Conversation-Cursor-Key": "restore-test-key",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response;
  }
  await conversation("/rooms", { id: "general", name: "General" });
  const joined = await stub.fetch(
    "https://project/rooms/general/members/agent:worker",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Tila-Conversation-Authority": JSON.stringify(conversationAuthority),
        "X-Tila-Conversation-Cursor-Key": "restore-test-key",
      },
      body: JSON.stringify({ wake: true }),
    },
  );
  expect(joined.status).toBe(200);
  await conversation("/rooms/general/messages", {
    client_op_id: "restore-message",
    body: "Retain history",
    targets: [{ kind: "room" }],
  });
  const historyBefore = await (
    await conversation("/rooms/general/messages")
  ).json<{ cursor: string }>();
  const leaseResponse = await stub.fetch(
    "https://project/dispatch/worker/lease",
    {
      method: "POST",
      headers: {
        "X-Tila-Conversation-Authority": JSON.stringify({
          ...conversationAuthority,
          runtime: {
            ...runtime,
            run_id: crypto.randomUUID(),
            run_role: "relay",
          },
        }),
        "X-Tila-Conversation-Cursor-Key": "restore-test-key",
      },
    },
  );
  expect(leaseResponse.status).toBe(200);
  expect(await leaseResponse.json()).toMatchObject({
    lease: { lease_token: expect.any(String) },
  });
  const meta = await (
    await stub.fetch("https://project/admin/transfer/meta")
  ).json<{
    digest: string;
    migrationVersion: number;
    journal: { nextSequence: number };
    tables: string[];
  }>();
  expect(meta.migrationVersion).toBe(31);
  const snapshot = new Map<string, Record<string, unknown>[]>();
  for (const table of meta.tables) {
    const { rows } = await (
      await stub.fetch(
        `https://project/admin/transfer/snapshot/${table}?limit=250`,
      )
    ).json<{ rows: Record<string, unknown>[] }>();
    snapshot.set(table, rows);
  }
  await post(
    "/agents/worker/bind",
    { ...attach, expected_epoch: 1 },
    { ...runtime, run_id: crypto.randomUUID() },
  );
  const sessionId = crypto.randomUUID();
  await post("/admin/transfer/begin", {
    sessionId,
    mode: "import",
    owner: principal,
    archiveDigest: "fixture",
  });
  await post("/admin/transfer/prepare", { sessionId });
  // A retried prepare must preserve the original destination high-water marks.
  await post("/admin/transfer/prepare", { sessionId });
  for (const [table, rows] of snapshot) {
    const encoded =
      rows.map((row) => projectTransferOps.canonicalJson(row)).join("\n") +
      (rows.length ? "\n" : "");
    await post(`/admin/transfer/rows/${table}`, {
      sessionId,
      chunkIndex: 0,
      sha256: await projectTransferOps.sha256Hex(encoded),
      rows,
    });
  }
  await post("/admin/transfer/finalize", {
    sessionId,
    semanticDigest: meta.digest,
    migrationVersion: meta.migrationVersion,
    journalNextSequence: meta.journal.nextSequence,
  });
  const view = await stub.fetch("https://project/agents/worker", {
    headers: {
      "X-Tila-Agent-Authority": JSON.stringify({
        principal_id: principal,
        can_manage: true,
        runtime: null,
      }),
    },
  });
  expect(await view.json()).toMatchObject({
    agent: { binding_epoch: 3 },
    binding: null,
  });
  const oldHistory = await stub.fetch(
    `https://project/rooms/general/messages?cursor=${encodeURIComponent(historyBefore.cursor)}`,
    {
      headers: {
        "X-Tila-Conversation-Authority": JSON.stringify(conversationAuthority),
        "X-Tila-Conversation-Cursor-Key": "restore-test-key",
      },
    },
  );
  expect(oldHistory.status).toBe(410);
  const restoredOutbox = await (
    await stub.fetch(
      "https://project/admin/transfer/snapshot/dispatch_outbox?limit=250",
    )
  ).json<{
    rows: { lease_token: string | null; lease_until: number | null }[];
  }>();
  expect(
    restoredOutbox.rows.every(
      (row) => row.lease_token === null && row.lease_until === null,
    ),
  ).toBe(true);
  const retained = await (await conversation("/rooms/general/messages")).json<{
    messages: { body: string }[];
  }>();
  expect(retained.messages[0].body).toBe("Retain history");
  await post(
    "/agents/worker/bind",
    { ...attach, expected_epoch: 3 },
    { ...runtime, run_id: crypto.randomUUID() },
  );
  await post("/admin/destroy", {});
  const counts = await (
    await stub.fetch("https://project/admin/store-counts")
  ).json<{ counts: { domain: Record<string, number> } }>();
  expect(counts.counts.domain.agents).toBe(0);
  expect(counts.counts.domain.agent_bindings).toBe(0);
});

it("authorizes agent selection and binding against current credentials before any replay", async () => {
  const project = `agents-${crypto.randomUUID()}`;
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
  async function key() {
    const pair = await generateKeyPair("ES256");
    const jwk = await exportJWK(pair.publicKey);
    return { pair, jwk, jkt: await calculateJwkThumbprint(jwk) };
  }
  const installation = await key();
  const actingKey = await key();
  const relayKey = await key();
  const root = `/projects/${project}`;
  async function http(
    path: string,
    token = owner,
    method = "GET",
    body?: unknown,
    proofKey?: Awaited<ReturnType<typeof key>>,
    participant?: string | null,
    extra: Record<string, string> = {},
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
        "Idempotency-Key": `${method}:${path}`,
        ...(proof ? { DPoP: proof } : {}),
        "X-Tila-Participant-Id": participant ?? "operator",
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const inviteResponse = await http("/runtime/invitations", owner, "POST", {
    name: "host",
    policy: RUNTIME_RUN_CEILING,
  });
  expect(inviteResponse.status, await inviteResponse.clone().text()).toBe(200);
  const { invitation } = await inviteResponse.json<{ invitation: string }>();
  const enrollmentResponse = await http(
    "/runtime/redeem",
    invitation,
    "POST",
    {
      invitation,
      name: "host",
      installation_id: crypto.randomUUID(),
      operation_id: crypto.randomUUID(),
      jkt: installation.jkt,
      policy: RUNTIME_RUN_CEILING,
    },
    installation,
  );
  expect(enrollmentResponse.status).toBe(200);
  const parent = await enrollmentResponse.json<RuntimeCredentialResponse>();
  const operation = {
    operation_id: crypto.randomUUID(),
    jkt: actingKey.jkt,
    agent_id: "worker",
    policy: RUNTIME_RUN_CEILING,
  };
  expect(
    (await http("/runtime/runs", parent.token, "POST", operation, installation))
      .status,
  ).toBe(403);
  const registered = await http("/agents", owner, "POST", {
    id: "worker",
    name: "Worker",
    bind_policy: [
      { principal_id: parent.context.principal_id, agent_id: "worker" },
    ],
  });
  expect(registered.status, await registered.clone().text()).toBe(200);
  const started = await http(
    "/runtime/runs",
    parent.token,
    "POST",
    operation,
    installation,
  );
  expect(started.status, await started.clone().text()).toBe(200);
  const acting = await started.json<RuntimeCredentialResponse>();
  expect(acting.context).toMatchObject({
    agent_id: "worker",
    run_role: "acting",
  });
  const attach = {
    expected_epoch: 0,
    harness: "cli",
    capability_report: {
      protocol: 1,
      adapter_version: "test",
      capabilities: {},
    },
  };
  const bound = await http(
    "/agents/worker/bind",
    acting.token,
    "POST",
    attach,
    actingKey,
    acting.context.participant_id,
  );
  expect(bound.status, await bound.clone().text()).toBe(200);
  expect(bound.headers.get("Cache-Control")).toBe("private, no-store");
  const first = await bound.json<{
    binding: { consumer_binding_id: string; binding_epoch: number };
  }>();
  const repeated = await http(
    "/agents/worker/bind",
    acting.token,
    "POST",
    attach,
    actingKey,
    acting.context.participant_id,
  );
  expect(await repeated.json()).toMatchObject({
    binding: {
      consumer_binding_id: first.binding.consumer_binding_id,
      binding_epoch: first.binding.binding_epoch,
    },
  });
  const changed = await http(
    "/agents/worker/bind",
    acting.token,
    "POST",
    { ...attach, attended: false },
    actingKey,
    acting.context.participant_id,
  );
  expect(changed.status).toBe(403);
  expect(await changed.json()).toMatchObject({
    error: { code: "profile-mismatch" },
  });
  const forged = await http(
    "/agents/worker/bind",
    owner,
    "POST",
    attach,
    undefined,
    undefined,
    {
      "X-Tila-Agent-Authority": JSON.stringify({
        can_manage: true,
        runtime: acting.context,
      }),
    },
  );
  expect(forged.status).toBe(403);
  const relayResponse = await http(
    "/runtime/runs",
    parent.token,
    "POST",
    {
      operation_id: crypto.randomUUID(),
      jkt: relayKey.jkt,
      agent_id: "worker",
      run_role: "relay",
      policy: { role: "participant", capabilities: ["agent-bindings:attach"] },
    },
    installation,
  );
  expect(relayResponse.status, await relayResponse.clone().text()).toBe(200);
  const relay = await relayResponse.json<RuntimeCredentialResponse>();
  const relayBound = await http(
    "/agents/worker/bind",
    relay.token,
    "POST",
    { ...attach, acting_run_id: acting.context.run_id },
    relayKey,
    relay.context.participant_id,
  );
  expect(relayBound.status, await relayBound.clone().text()).toBe(200);
  expect(await relayBound.json()).toMatchObject({
    binding: { consumer_binding_id: first.binding.consumer_binding_id },
  });
  expect(
    (
      await http(
        "/agents",
        relay.token,
        "GET",
        undefined,
        relayKey,
        relay.context.participant_id,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await http(
        `/runtime/runs/${acting.context.run_id}/revoke`,
        owner,
        "POST",
        {},
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await http(
        "/agents/worker/bind",
        acting.token,
        "POST",
        attach,
        actingKey,
        acting.context.participant_id,
      )
    ).status,
  ).toBe(403);
  expect(await (await http("/agents/worker")).json()).toMatchObject({
    binding: null,
    agent: { binding_epoch: 1 },
  });
  const orphanRelay = await http(
    "/agents/worker/bind",
    relay.token,
    "POST",
    { ...attach, expected_epoch: 1, acting_run_id: acting.context.run_id },
    relayKey,
    relay.context.participant_id,
  );
  expect(orphanRelay.status).toBe(403);
});
