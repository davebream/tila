import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { queueApiFixture as fixture } from "./queue-api-fixture";
import { bindings } from "./setup";

const revision = (value: { revision: number }) => ({
  idempotency_key: crypto.randomUUID(),
  expected_revision: value.revision,
});
const authority = (value: { revision: number; fence: number }) => ({
  ...revision(value),
  fence: value.fence,
});

it("links a hotfix to an accepted result over HTTP and the DO refuses to rewrite that result", async () => {
  const { project, http, queue, attempts } = await fixture();
  await queue.configure({
    idempotency_key: "enable",
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 1,
  });
  for (const id of ["shipped", "hotfix"]) {
    const created = await http("/tasks", {
      id,
      type: "issue",
      data: { phase: "todo" },
    });
    expect(created.status, await created.clone().text()).toBe(200);
  }
  await queue.enroll({ idempotency_key: "enroll", task_id: "shipped" });
  const grant = await queue.claimNext({ idempotency_key: "claim" });
  if (grant.kind !== "granted") throw new Error("Expected a grant");
  let attempt = (
    await attempts.accept(grant.attempt.id, authority(grant.attempt))
  ).attempt;
  const early = await http(`/attempts/${attempt.id}/correct`, {
    idempotency_key: "too-early",
    task_id: "hotfix",
    reason: "not finished yet",
  });
  expect(early.status).toBe(409);
  const outcome = {
    status: "success" as const,
    execution_stopped: true,
    unresolved_external_execution: false,
    evidence: ["release-1"],
  };
  attempt = (
    await attempts.finish(attempt.id, { ...authority(attempt), outcome })
  ).attempt;

  const command = {
    idempotency_key: "link-hotfix",
    task_id: "hotfix",
    reason: "Regression reported after release",
  };
  const linked = await attempts.correct(attempt.id, command);
  expect(linked.attempt.outcome).toEqual(outcome);
  expect(linked.corrections).toMatchObject([
    { task_id: "hotfix", reason: "Regression reported after release" },
  ]);
  expect(
    (await attempts.correct(attempt.id, command)).corrections,
  ).toHaveLength(1);
  expect((await attempts.get(attempt.id)).corrections).toHaveLength(1);

  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(project));
  await runInDurableObject(stub, (_instance, state) => {
    expect(() =>
      state.storage.sql.exec(
        "UPDATE work_attempts SET outcome = ? WHERE id = ?",
        JSON.stringify({ ...outcome, status: "failure" }),
        attempt.id,
      ),
    ).toThrow(/attempt-terminal-immutable/);
  });
  expect((await attempts.get(attempt.id)).attempt.outcome).toEqual(outcome);
});
