import { expect, test } from "bun:test";
import { entityOps, schemaOps } from "@tila/ops-sqlite";
import { attemptOrigin } from "../../ops-sqlite/test/attempt-fixture";
import { lifecycleDefinition } from "../../ops-sqlite/test/readiness-fixture";
import { makeHarness } from "./harness.bun";

test("the embedded facade enforces global limits, replay and ordinary managed content edits", async () => {
  const harness = makeHarness();
  try {
    schemaOps.applySchema(harness.db, lifecycleDefinition, "fixture");
    const { queue, attempts } = harness.project;
    await queue.configure({
      idempotency_key: "enable",
      expected_revision: 0,
      enabled: true,
      paused: false,
      execution_limit: 1,
    });
    entityOps.create(
      harness.db,
      {
        id: "task",
        type: "issue",
        data: { phase: "todo" },
        created_by: "fixture",
      },
      1,
      attemptOrigin,
    );
    await queue.enroll({ task_id: "task", idempotency_key: "enroll" });
    expect(
      (await harness.project.update("task", { title: "editable" })).data.title,
    ).toBe("editable");
    const grant = await queue.claimNext({ idempotency_key: "grant" });
    if (grant.kind !== "granted") throw new Error("grant");
    expect(await queue.claimNext({ idempotency_key: "grant" })).toEqual(grant);
    expect(await queue.claimNext({ idempotency_key: "another" })).toMatchObject(
      { reason: "execution_capacity" },
    );
    const accepted = await attempts.accept(grant.attempt.id, {
      idempotency_key: "accept",
      expected_revision: grant.attempt.revision,
      fence: grant.attempt.fence,
    });
    expect(accepted.attempt.state).toBe("starting");
    expect((await queue.inspect()).counts).toMatchObject({
      execution: 1,
      wip: 1,
    });
  } finally {
    harness.close();
  }
});
