import { evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { lifecycleDefinition } from "../../ops-sqlite/test/readiness-fixture";
import { queueApiFixture as fixture, member } from "./queue-api-fixture";
import { bindings } from "./setup";

type Session = { provider: string; id: string };
type Attempt = {
  id: string;
  revision: number;
  fence: number;
  state: string;
  session: Session | null;
  outcome: unknown;
  revisions: {
    authorized?: { definition_version: number | null };
  } | null;
};
type View = { attempt: Attempt; grant_valid: boolean };
const session: Session = { provider: "fixture", id: "native-1" };

async function result<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return ((await response.json()) as { result: T }).result;
}
const revision = (attempt: { revision: number }) => ({
  idempotency_key: crypto.randomUUID(),
  expected_revision: attempt.revision,
});
const authority = (attempt: Attempt) => ({
  ...revision(attempt),
  fence: attempt.fence,
});

/** A participant-role worker with one running attempt. */
async function running(userId: number) {
  const f = await fixture();
  await f.queue.configure({
    idempotency_key: "enable",
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 2,
  });
  const created = await f.http("/tasks", {
    id: "work",
    type: "issue",
    data: { phase: "todo" },
  });
  expect(created.status, await created.clone().text()).toBe(200);
  await f.queue.enroll({ idempotency_key: "enroll", task_id: "work" });
  const worker = await member(f.project, userId);
  const grant = await result<View>(
    await worker.post("/queue/claim", { idempotency_key: "claim" }, "worker"),
  );
  let attempt = (
    await result<View>(
      await worker.post(
        `/attempts/${grant.attempt.id}/accept`,
        authority(grant.attempt),
        "worker",
      ),
    )
  ).attempt;
  attempt = (
    await result<View>(
      await worker.post(
        `/attempts/${attempt.id}/started`,
        { ...authority(attempt), session },
        "worker",
      ),
    )
  ).attempt;
  const evict = () =>
    evictDurableObject(
      bindings.PROJECT.get(bindings.PROJECT.idFromName(f.project)),
    );
  return { ...f, worker, attempt, evict };
}

it("replaces a restarted native session on the same attempt and recovers owned work after a cold start", async () => {
  const { worker, attempt, evict } = await running(8101);
  await evict();
  const owned = await result<Attempt[]>(
    await worker.get(
      `/attempts?principal_id=${encodeURIComponent(worker.principal)}&participant_id=worker&active=true`,
      "worker",
    ),
  );
  expect(owned.map((a) => a.id)).toEqual([attempt.id]);
  expect(
    await result<Attempt[]>(
      await worker.get(
        `/attempts?principal_id=${encodeURIComponent(worker.principal)}&active=false`,
        "worker",
      ),
    ),
  ).toEqual([]);

  const command = {
    ...authority(attempt),
    reason: "provider session restarted",
    previous_session: session,
    previous_stopped: true,
    session: { ...session, id: "native-2" },
  };
  const replaced = await result<View>(
    await worker.post(
      `/attempts/${attempt.id}/replace-session`,
      command,
      "worker",
    ),
  );
  expect(replaced.attempt.id).toBe(attempt.id);
  expect(replaced.attempt.session?.id).toBe("native-2");
  expect(replaced.attempt.fence).toBeGreaterThan(attempt.fence);
  expect(replaced.attempt.outcome).toBeNull();
  expect(replaced.grant_valid).toBe(true);
  const stale = await worker.post(
    `/attempts/${attempt.id}/heartbeat`,
    authority({ ...attempt, revision: replaced.attempt.revision }),
    "worker",
  );
  expect(stale.status).toBe(403);
  await evict();
  const replay = await result<View>(
    await worker.post(
      `/attempts/${attempt.id}/replace-session`,
      command,
      "worker",
    ),
  );
  expect(replay.attempt.fence).toBe(replaced.attempt.fence);
  expect(replay.grant_valid).toBe(true);
});

it("keeps finishing available while paused, rejects results the current definition forbids and rejects revoked authority", async () => {
  const { http, queue, worker, attempt: started } = await running(8102);
  let attempt = started;
  await queue.configure({
    idempotency_key: "pause",
    expected_revision: 1,
    paused: true,
  });
  attempt = (
    await result<View>(
      await worker.post(
        `/attempts/${attempt.id}/heartbeat`,
        authority(attempt),
        "worker",
      ),
    )
  ).attempt;
  expect(attempt.revisions?.authorized?.definition_version).toBe(1);

  const definition = `${lifecycleDefinition}\n[work_units.issue.fields.required_new]\ntype = "string"\nrequired = true\n`;
  const review = await (await http("/schema/preview", { definition })).json<{
    revision: number;
    reviewed_definition: string;
  }>();
  const applied = await http("/schema", {
    definition,
    expected_revision: review.revision,
    reviewed_definition: review.reviewed_definition,
    strategy: "force",
  });
  expect(applied.status, await applied.clone().text()).toBe(200);
  const outcome = {
    status: "success",
    execution_stopped: true,
    unresolved_external_execution: false,
    evidence: [],
  };
  const rejected = await worker.post(
    `/attempts/${attempt.id}/finish`,
    { ...authority(attempt), outcome },
    "worker",
  );
  expect(rejected.status).toBe(422);
  const body = await rejected.json<{
    error: { code: string; message: string };
  }>();
  expect(body.error.code).toBe("constraint-violation");
  expect(body.error.message).toMatch(/Current definition v2 .*captured v1/);

  await worker.revoke();
  for (const [action, command] of [
    ["heartbeat", authority(attempt)],
    ["finish", { ...authority(attempt), outcome }],
    ["request-cancellation", revision(attempt)],
    [
      "replace-session",
      {
        ...authority(attempt),
        reason: "restart",
        previous_session: session,
        previous_stopped: true,
        session: { ...session, id: "native-3" },
      },
    ],
  ] as const)
    expect([401, 403]).toContain(
      (
        await worker.post(
          `/attempts/${attempt.id}/${action}`,
          command,
          "worker",
        )
      ).status,
    );
});
