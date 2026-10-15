import { SELF } from "cloudflare:test";
import { SignJWT } from "jose";
import { RemoteAttemptBackend, RemoteQueueBackend } from "tila-sdk";
import { TilaClient } from "tila-sdk";
import { expect, it } from "vitest";
import {
  jsonBytes,
  managedWork,
} from "../../ops-sqlite/test/queue-compact-fixture";
import { lifecycleDefinition } from "../../ops-sqlite/test/readiness-fixture";
import { CredentialStore, ProjectMembershipStore } from "../../worker/src/d1";
import { hashToken } from "../../worker/src/lib/hash";
import { queueApiFixture as fixture } from "./queue-api-fixture";
import { bindings } from "./setup";

const revision = (attempt: { revision: number }) => ({
  expected_revision: attempt.revision,
  idempotency_key: crypto.randomUUID(),
});
const authority = (attempt: { revision: number; fence: number }) => ({
  ...revision(attempt),
  fence: attempt.fence,
});

it("allows participant-less inspection without granting execution authority", async () => {
  const { project, token, http, queue } = await fixture();
  await queue.configure({
    ...revision({ revision: 0 }),
    enabled: true,
    paused: false,
    execution_limit: 1,
  });
  await http("/tasks", {
    id: "read-only",
    type: "issue",
    data: { phase: "todo" },
  });
  await queue.enroll({
    idempotency_key: "enroll-reader",
    task_id: "read-only",
  });
  const grantResponse = await http(
    "/queue/claim",
    { idempotency_key: "claim-reader" },
    "queue-read-only",
  );
  const grant = (await grantResponse.json()) as {
    result: { attempt: { id: string } };
  };
  for (const path of [
    "/queue",
    "/queue/policy",
    "/attempts",
    `/attempts/${grant.result.attempt.id}`,
  ]) {
    const response = await SELF.fetch(
      `https://worker/projects/${project}${path}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    if (path.endsWith(grant.result.attempt.id))
      expect(await response.json()).toMatchObject({
        result: { grant_valid: false },
      });
  }
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
    ["visible", "ticket", { status: "open", description: "visible brief" }],
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
  // Compact applies the same filtering and only ever removes task data.
  const compact = await scoped.inspect({ limit: 1, compact: true });
  expect(compact.total).toBe(1);
  // Waiting age reads the clock; every other count is state.
  expect({ ...compact.counts, oldest_waiting_age_ms: null }).toEqual({
    ...inspected.counts,
    oldest_waiting_age_ms: null,
  });
  expect(compact.entries.map((view) => view.entry)).toEqual(
    inspected.entries.map((view) => view.entry),
  );
  expect(inspected.entries[0].task?.data).toMatchObject({
    description: "visible brief",
  });
  expect(compact.entries[0].task).toEqual({
    id: "visible",
    type: "ticket",
    data: { status: "open" },
  });
  const raw = await SELF.fetch(
    `https://worker/projects/${project}/queue?compact=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(raw.status).toBe(200);
  const rawText = await raw.text();
  expect(rawText).not.toContain("hidden");
  expect(rawText).not.toContain("visible brief");
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

it("serves the full listing unless compact is exactly true, and rejects other values", async () => {
  const { project, token, http, queue } = await fixture();
  await queue.configure({
    ...revision({ revision: 0 }),
    enabled: true,
    paused: false,
    execution_limit: 1,
  });
  for (const id of ["one", "two"]) {
    await http("/tasks", {
      id,
      type: "issue",
      data: { phase: "todo", title: `Task ${id}`, description: `Brief ${id}` },
    });
    await queue.enroll({ idempotency_key: `enroll-${id}`, task_id: id });
  }
  const read = (search: string) =>
    SELF.fetch(`https://worker/projects/${project}/queue${search}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  // Wall-clock readings differ between two reads of the same state.
  const stable = async (response: Response) => {
    const { result } = (await response.json()) as {
      result: {
        diagnostics?: unknown;
        counts: Record<string, unknown>;
        entries: Array<{ task: { data: Record<string, unknown> } }>;
      };
    };
    return {
      ...result,
      diagnostics: undefined,
      counts: { ...result.counts, oldest_waiting_age_ms: null },
    };
  };
  const absent = await stable(await read(""));
  expect(await stable(await read("?compact=false"))).toEqual(absent);
  expect(absent.entries[0].task.data.description).toBe("Brief one");
  const compact = await stable(await read("?compact=true"));
  expect(compact.entries.map((view) => view.task)).toEqual([
    { id: "one", type: "issue", data: { phase: "todo", title: "Task one" } },
    { id: "two", type: "issue", data: { phase: "todo", title: "Task two" } },
  ]);
  for (const value of ["1", "0", "yes", "TRUE", ""]) {
    const response = await read(`?compact=${value}`);
    expect(response.status, value).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "validation-error" },
    });
  }
});

it("returns at least 5x fewer bytes for a 100-task queue sized like the observed one", async () => {
  const { project, token, http, queue } = await fixture();
  await queue.configure({
    ...revision({ revision: 0 }),
    enabled: true,
    paused: false,
    execution_limit: 1,
  });
  for (let index = 0; index < 100; index++) {
    const id = `work-${index}`;
    expect(
      (await http("/tasks", { id, type: "issue", data: managedWork(index) }))
        .status,
    ).toBe(200);
    await queue.enroll({ idempotency_key: `enroll-${id}`, task_id: id });
  }
  const body = async (search: string) => {
    const response = await SELF.fetch(
      `https://worker/projects/${project}/queue?limit=100${search}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    return new Uint8Array(await response.arrayBuffer()).byteLength;
  };
  const full = await body("");
  const compact = await body("&compact=true");
  // The issue observed about 575 KB for 100 tasks.
  expect(full).toBeGreaterThan(500_000);
  expect(full).toBeLessThan(650_000);
  expect(full / compact).toBeGreaterThanOrEqual(5);
  expect(jsonBytes(managedWork(0))).toBeGreaterThan(4_500);
}, 60_000);
