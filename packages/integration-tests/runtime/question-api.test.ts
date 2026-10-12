import { RemoteQuestionBackend } from "tila-sdk";
import { expect, it } from "vitest";
import { queueApiFixture } from "./queue-api-fixture";
import { bindings } from "./setup";

it("checks current D1 responder membership before answering and before replay", async () => {
  const f = await queueApiFixture();
  const remote = new RemoteQuestionBackend(f.client, f.project);
  const principal = `token:${f.issued.tokenId}`;
  await bindings.DB.prepare(`INSERT INTO _project_memberships
    (membership_id, project_id, principal_id, provider, identity_host, subject_id, subject_kind, role, granted_by, granted_at)
    VALUES (?, ?, ?, 'oidc', 'fixture', 'fixture', 'service', 'owner', 'fixture', 0)`)
    .bind(crypto.randomUUID(), f.project, principal)
    .run();
  expect(
    (
      await f.http("/tasks", {
        id: "task",
        type: "issue",
        data: { phase: "todo" },
      })
    ).status,
  ).toBe(200);
  await f.queue.configure({
    idempotency_key: "configure",
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 1,
  });
  await f.queue.enroll({ idempotency_key: "enroll", task_id: "task" });
  const claim = await f.queue.claimNext({ idempotency_key: "claim" });
  if (claim.kind !== "granted") throw new Error("Expected attempt");
  const { attempt } = await f.attempts.accept(claim.attempt.id, {
    idempotency_key: "accept",
    expected_revision: claim.attempt.revision,
    fence: claim.attempt.fence,
  });
  const response = await f.http("/questions", {
    id: crypto.randomUUID(),
    idempotency_key: "ask",
    attempt_id: attempt.id,
    expected_revision: attempt.revision,
    fence: attempt.fence,
    text: "Continue?",
    responder_principal_id: principal,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const {
    result: { question: q },
  } = (await response.json()) as {
    result: {
      question: {
        id: string;
        revision: number;
        attempt_id: string;
        attempt_revision: number;
        attempt_fence: number;
      };
    };
  };
  const input = {
    question_id: q.id,
    idempotency_key: "answer",
    expected_revision: q.revision,
    attempt_id: q.attempt_id,
    attempt_revision: q.attempt_revision,
    attempt_fence: q.attempt_fence,
    text: "Continue",
  };
  expect((await remote.get(q.id)).question.id).toBe(q.id);
  expect((await remote.list({ state: "open" })).questions).toHaveLength(1);
  const path = `/questions/${q.id}/answer`;
  const answered = await f.http(path, input, "owner", "answer");
  expect(answered.status, await answered.clone().text()).toBe(200);
  expect((await f.http(path, input, "owner", "answer")).status).toBe(200);
  await bindings.DB.prepare(
    "UPDATE _project_memberships SET revoked_at = 1 WHERE project_id = ? AND principal_id = ?",
  )
    .bind(f.project, principal)
    .run();
  expect((await f.http(path, input, "owner", "answer")).status).toBe(403);
  const retained = await f.http(`/questions/${q.id}`);
  expect(await retained.json()).toMatchObject({
    result: { question: { answer: { text: "Continue" } } },
  });
});
