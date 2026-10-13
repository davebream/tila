import { evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { queueApiFixture as fixture, member } from "./queue-api-fixture";
import { bindings } from "./setup";

type Attempt = { id: string; revision: number; fence: number };
const session = { provider: "fixture", id: "native", worktree: "/fixture" };

async function result<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return ((await response.json()) as { result: T }).result;
}
const revision = (
  attempt: { revision: number },
  key: string = crypto.randomUUID(),
) => ({
  idempotency_key: key,
  expected_revision: attempt.revision,
});
const authority = (attempt: Attempt) => ({
  ...revision(attempt),
  fence: attempt.fence,
});

it("rejects control requests from a former owner while the assigner keeps control across a cold start", async () => {
  const { project, queue, attempts } = await fixture();
  await queue.configure({
    idempotency_key: "enable",
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 2,
  });
  const orchestrator = await member(project, 7001);
  const worker = await member(project, 7002);
  const created = await orchestrator.post(
    "/tasks",
    { id: "assigned", type: "issue", data: { phase: "todo" } },
    "orchestrator",
  );
  expect(created.status, await created.clone().text()).toBe(200);
  const enroll = {
    idempotency_key: "assign",
    task_id: "assigned",
    target_principal: worker.principal,
  };
  const entry = await result<{ id: string; enrolled_by_principal: string }>(
    await orchestrator.post("/queue/enroll", enroll, "orchestrator"),
  );
  expect(entry.enrolled_by_principal).toBe(orchestrator.principal);

  const grant = await result<{ attempt: Attempt }>(
    await worker.post("/queue/claim", { idempotency_key: "claim" }, "worker"),
  );
  let attempt = (
    await result<{ attempt: Attempt }>(
      await worker.post(
        `/attempts/${grant.attempt.id}/accept`,
        authority(grant.attempt),
        "worker",
      ),
    )
  ).attempt;
  attempt = (
    await result<{ attempt: Attempt }>(
      await worker.post(
        `/attempts/${attempt.id}/started`,
        { ...authority(attempt), session },
        "worker",
      ),
    )
  ).attempt;

  // A maintainer moves execution to a replacement process of the same worker.
  attempt = (
    await attempts.rebind(attempt.id, {
      ...revision(attempt),
      reason: "process replaced",
      principal_id: worker.principal,
      participant_id: "replacement",
      session,
    })
  ).attempt;

  const denied = await worker.post(
    `/attempts/${attempt.id}/request-cancellation`,
    revision(attempt),
    "worker",
  );
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({
    error: { code: "queue-authority-lost" },
  });

  const cancel = revision(attempt, "orchestrator-cancel");
  const cancelled = await result<{
    attempt: { cancellation_requested: boolean };
    assigner_principal_id: string;
  }>(
    await orchestrator.post(
      `/attempts/${attempt.id}/request-cancellation`,
      cancel,
      "orchestrator",
    ),
  );
  expect(cancelled.attempt.cancellation_requested).toBe(true);
  expect(cancelled.assigner_principal_id).toBe(orchestrator.principal);

  await evictDurableObject(
    bindings.PROJECT.get(bindings.PROJECT.idFromName(project)),
  );
  // Retries after the restart are harmless: same command, same assignment.
  expect(
    (
      await result<{ attempt: { cancellation_requested: boolean } }>(
        await orchestrator.post(
          `/attempts/${attempt.id}/request-cancellation`,
          cancel,
          "orchestrator",
        ),
      )
    ).attempt.cancellation_requested,
  ).toBe(true);
  expect(
    (
      await result<{ id: string }>(
        await orchestrator.post("/queue/enroll", enroll, "orchestrator"),
      )
    ).id,
  ).toBe(entry.id);
  const ambiguous = await orchestrator.post(
    "/queue/enroll",
    { ...enroll, idempotency_key: "assign-again" },
    "orchestrator",
  );
  expect(ambiguous.status).toBe(409);
  expect(await ambiguous.text()).toContain(entry.id);
});
