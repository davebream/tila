import { SELF } from "cloudflare:test";
import { SignJWT } from "jose";
import { RemoteAttemptBackend, RemoteQueueBackend } from "tila-sdk";
import { TilaClient } from "tila-sdk";
import { expect, it } from "vitest";
import { lifecycleDefinition } from "../../ops-sqlite/test/readiness-fixture";
import {
  CredentialStore,
  D1TokenStore,
  ProjectMembershipStore,
} from "../../worker/src/d1";
import { hashToken } from "../../worker/src/lib/hash";
import { bindings } from "./setup";

async function fixture() {
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
    definition: lifecycleDefinition,
    expected_revision: 0,
  });
  expect(schema.status, await schema.clone().text()).toBe(200);
  return { project, token, issued, http, queue, attempts };
}
const revision = (attempt: { revision: number }) => ({
  expected_revision: attempt.revision,
  idempotency_key: crypto.randomUUID(),
});
const authority = (attempt: { revision: number; fence: number }) => ({
  ...revision(attempt),
  fence: attempt.fence,
});

it("executes the complete queue lifecycle through authenticated HTTP and the SDK, with safe replay", async () => {
  const { http, queue, attempts } = await fixture();
  expect((await queue.policy()).enabled).toBe(false);
  await queue.configure({
    idempotency_key: "enable",
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 1,
    wip_limit: 2,
  });
  expect(
    (
      await http("/tasks", {
        id: "one",
        type: "issue",
        data: { phase: "todo" },
      })
    ).status,
  ).toBe(200);
  const entry = await queue.enroll({
    idempotency_key: "enroll",
    task_id: "one",
    required_capabilities: ["coding"],
  });
  expect(
    await queue.claimNext({ idempotency_key: "incompatible" }),
  ).toMatchObject({ kind: "no_grant" });
  const claim = { idempotency_key: "claim", capabilities: ["coding"] };
  const grant = await queue.claimNext(claim);
  expect(grant.kind).toBe("granted");
  if (grant.kind !== "granted") throw new Error("No fixture grant");
  let attempt = grant.attempt;
  expect(attempt.entry_id).toBe(entry.id);
  const accept = authority(attempt);
  attempt = (await attempts.accept(attempt.id, accept)).attempt;
  expect((await attempts.accept(attempt.id, accept)).grant_valid).toBe(true);
  const session = {
    provider: "fixture",
    id: "session",
    worktree: "/fixture/worktree",
  };
  attempt = (
    await attempts.started(attempt.id, { ...authority(attempt), session })
  ).attempt;
  attempt = (await attempts.heartbeat(attempt.id, authority(attempt))).attempt;
  const stolen = await http(
    `/attempts/${attempt.id}/heartbeat`,
    authority(attempt),
    "different-worker",
  );
  expect(stolen.status).toBe(403);
  attempt = (await attempts.requestSuspension(attempt.id, revision(attempt)))
    .attempt;
  attempt = (
    await attempts.confirmSuspension(attempt.id, {
      ...authority(attempt),
      execution_quiescent: true,
      checkpoint: { step: "review" },
    })
  ).attempt;
  expect((await queue.inspect()).counts).toMatchObject({
    execution: 0,
    wip: 1,
    suspended: 1,
  });
  attempt = (await attempts.requestResume(attempt.id, revision(attempt)))
    .attempt;
  const resume = await attempts.claimResume(attempt.id, {
    ...revision(attempt),
    capabilities: ["coding"],
  });
  expect(resume.kind).toBe("granted");
  if (resume.kind !== "granted") throw new Error("No resume");
  attempt = resume.attempt;
  const replayed = await queue.claimNext(claim);
  expect(replayed.kind === "granted" && replayed.grant_valid).toBe(false);
  expect((await attempts.accept(attempt.id, accept)).grant_valid).toBe(false);
  attempt = (
    await attempts.started(attempt.id, { ...authority(attempt), session })
  ).attempt;
  attempt = (await attempts.requestCancellation(attempt.id, revision(attempt)))
    .attempt;
  expect((await queue.inspect()).counts.execution).toBe(1);
  const finish = {
    ...authority(attempt),
    outcome: {
      status: "cancelled" as const,
      execution_stopped: true,
      unresolved_external_execution: false,
      evidence: [],
    },
  };
  const terminal = await attempts.finish(attempt.id, finish);
  expect(await attempts.finish(attempt.id, finish)).toEqual(terminal);
  expect((await queue.inspect()).counts).toMatchObject({
    execution: 0,
    wip: 0,
    terminal: 1,
  });
  expect(await attempts.list({ task_id: "one", limit: 1 })).toHaveLength(1);
  expect((await attempts.get(attempt.id)).attempt.outcome?.status).toBe(
    "cancelled",
  );
  expect(
    (
      await http(
        `/attempts/${attempt.id}/finish`,
        finish,
        "worker",
        "wrong-key",
      )
    ).status,
  ).toBe(409);
});

it("does not let cached claim responses bypass managed work or revoked credentials", async () => {
  const { project, token, http, queue } = await fixture();
  expect(
    (
      await http("/tasks", {
        id: "one",
        type: "issue",
        data: { phase: "todo" },
      })
    ).status,
  ).toBe(200);
  const generic = { resource: "issue:one", mode: "exclusive", ttl_ms: 60_000 };
  const acquired = await http("/claims/acquire", generic, "worker", "generic");
  expect(acquired.status, await acquired.clone().text()).toBe(200);
  const { fence } = await acquired.json<{ fence: number }>();
  expect(
    (await http("/claims/release", { resource: "issue:one", fence })).status,
  ).toBe(200);
  await queue.configure({
    idempotency_key: "enable",
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 1,
  });
  await queue.enroll({ idempotency_key: "enroll", task_id: "one" });
  expect(
    (await http("/claims/acquire", generic, "worker", "generic")).status,
  ).toBe(409);
  const claim = { idempotency_key: "claim" };
  expect((await queue.claimNext(claim)).kind).toBe("granted");
  await bindings.DB.prepare(
    "UPDATE _tokens SET revoked_at = ? WHERE project_id = ? AND token_hash = ?",
  )
    .bind(Date.now(), project, await hashToken(token, bindings.HASH_PEPPER))
    .run();
  expect((await http("/queue/claim", claim, "worker", "claim")).status).toBe(
    401,
  );
});

it("revalidates human membership before permanent receipts and restricts configuration to maintainers", async () => {
  const { project, queue, http } = await fixture();
  await queue.configure({
    idempotency_key: "enable",
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 1,
  });
  expect(
    (
      await http("/tasks", {
        id: "member-task",
        type: "issue",
        data: { phase: "todo" },
      })
    ).status,
  ).toBe(200);
  await queue.enroll({ idempotency_key: "enroll", task_id: "member-task" });
  const memberships = new ProjectMembershipStore(bindings.DB);
  const { membership } = await memberships.grant({
    projectId: project,
    principal: { provider: "github", host: "github.com", user_id: 12345 },
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
  const token = `tila_s.${await new SignJWT({ jti: crypto.randomUUID(), authorization_version: 2, project_id: project, github_host: "github.com", github_repo_id: 42, github_login: "runtime", github_user_id: 12345, permission: "write", issued_at: now, expires_at: now + 3600, iss: "tila", aud: "tila" }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(key)}`;
  const request = (path: string, body: unknown) =>
    SELF.fetch(`https://worker/projects/${project}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tila-Participant-Id": "human-worker",
        "Content-Type": "application/json",
        "Idempotency-Key": "member-claim",
      },
      body: JSON.stringify(body),
    });
  expect(
    (
      await request("/queue/configure", {
        idempotency_key: "member-claim",
        expected_revision: 1,
        paused: true,
      })
    ).status,
  ).toBe(403);
  const command = {
    idempotency_key: "member-claim",
    principal_id: "forged-owner",
    participant_id: "forged-worker",
  };
  const granted = await request("/queue/claim", command);
  expect(granted.status, await granted.clone().text()).toBe(200);
  expect(await granted.json()).toMatchObject({
    result: {
      kind: "granted",
      attempt: {
        principal_id: "github:github.com:12345",
        participant_id: "human-worker",
      },
    },
  });
  await memberships.revoke({
    projectId: project,
    membershipId: membership.membership_id,
    actorPrincipalId: "fixture",
  });
  expect([401, 403]).toContain((await request("/queue/claim", command)).status);
});

it("admits exactly twenty of one hundred authenticated consumers", async () => {
  const { queue, http } = await fixture();
  await queue.configure({
    idempotency_key: "enable",
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 20,
  });
  for (let index = 0; index < 100; index++) {
    expect(
      (
        await http("/tasks", {
          id: `task-${index}`,
          type: "issue",
          data: { phase: "todo" },
        })
      ).status,
    ).toBe(200);
    await queue.enroll({
      idempotency_key: `enroll-${index}`,
      task_id: `task-${index}`,
    });
  }
  const results = await Promise.all(
    Array.from({ length: 100 }, async (_, index) => {
      const response = await http(
        "/queue/claim",
        { idempotency_key: `claim-${index}` },
        `worker-${index}`,
      );
      expect(response.status).toBe(200);
      return response.json<{
        result: { kind: string; attempt?: { id: string; task_id: string } };
      }>();
    }),
  );
  const grants = results.filter((r) => r.result.kind === "granted");
  expect(grants).toHaveLength(20);
  expect(new Set(grants.map((r) => r.result.attempt?.task_id)).size).toBe(20);
  expect((await queue.inspect()).counts).toMatchObject({
    execution: 20,
    wip: 20,
    backlog: 80,
  });
}, 30000);

it("filters scoped work before pagination and never confuses scheduling capabilities with authorization", async () => {
  const { project, queue, http } = await fixture();
  const store = new CredentialStore(bindings.DB);
  const actor = { principalId: "fixture" };
  const service = await store.createService(
    project,
    {
      name: "scoped-worker",
      display_name: "Scoped worker",
      role: "participant",
    },
    actor,
  );
  const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await store.issue(
    {
      projectId: project,
      principalId: service.principal_id,
      name: "scoped",
      tokenHash: await hashToken(token, bindings.HASH_PEPPER),
      policy: {
        role: "participant",
        capabilities: [
          "tasks:read",
          "tasks:write",
          "claims:read",
          "claims:acquire",
          "claims:renew",
        ],
        restrictions: { task_types: ["ticket"] },
      },
    },
    actor,
  );
  const client = new TilaClient({
    baseUrl: "https://worker",
    token,
    participantId: "scoped-process",
    fetch: (async (input, init) =>
      SELF.fetch(input, { ...init, redirect: "manual" })) as typeof fetch,
  });
  const scoped = new RemoteQueueBackend(client, project);
  const scopedAttempts = new RemoteAttemptBackend(client, project);
  const definition = `${lifecycleDefinition}
[work_units.ticket.fields.status]
type = "enum"
values = ["open", "done"]
[work_units.ticket.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done"]
dependency_satisfied = ["done"]
`;
  const applied = await http("/schema", { definition, expected_revision: 1 });
  expect(applied.status, await applied.clone().text()).toBe(200);
  await queue.configure({
    idempotency_key: "enable",
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 2,
  });
  for (const [id, type, data] of [
    ["hidden", "issue", { phase: "todo" }],
    ["visible", "ticket", { status: "open" }],
  ] as const) {
    expect((await http("/tasks", { id, type, data })).status).toBe(200);
    await queue.enroll({
      idempotency_key: `enroll-${id}`,
      task_id: id,
      priority: id === "hidden" ? 100 : 0,
      required_capabilities: ["coding"],
    });
  }
  const inspected = await scoped.inspect({ limit: 1 });
  expect(inspected.total).toBe(1);
  expect(inspected.entries[0].entry.task_id).toBe("visible");
  await expect(
    scoped.enroll({ idempotency_key: "forbidden", task_id: "hidden" }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    scoped.configure({
      idempotency_key: "configure",
      expected_revision: 1,
      paused: true,
    }),
  ).rejects.toMatchObject({ status: 403 });
  const grant = await scoped.claimNext({
    idempotency_key: "claim",
    capabilities: ["coding", "schema:write"],
  });
  expect(grant.kind).toBe("granted");
  if (grant.kind !== "granted") throw new Error("No grant");
  expect(grant.attempt.task_id).toBe("visible");
  const hidden = await queue.claimNext({
    idempotency_key: "owner-claim",
    capabilities: ["coding"],
  });
  if (hidden.kind !== "granted") throw new Error("No hidden grant");
  await expect(scopedAttempts.get(hidden.attempt.id)).rejects.toMatchObject({
    status: 403,
  });
  expect(await scopedAttempts.list({ limit: 1 })).toHaveLength(1);
  expect((await scopedAttempts.list())[0].task_id).toBe("visible");
});
