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

test("the embedded facade lists a compact queue that narrows only task data", async () => {
  const harness = makeHarness();
  try {
    schemaOps.applySchema(harness.db, lifecycleDefinition, "fixture");
    const { queue } = harness.project;
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
        data: {
          phase: "todo",
          title: "A title",
          notes: "A long note. ".repeat(50),
        },
        created_by: "fixture",
      },
      1,
      attemptOrigin,
    );
    await queue.enroll({ task_id: "task", idempotency_key: "enroll" });
    const full = await queue.inspect();
    expect(await queue.inspect({ compact: false })).toMatchObject({
      total: 1,
      entries: [{ task: { data: { notes: expect.any(String) } } }],
    });
    const compact = await queue.inspect({ compact: true });
    expect(full.entries[0].task?.data.notes).toEqual(expect.any(String));
    expect(compact.entries[0].task).toEqual({
      id: "task",
      type: "issue",
      data: { phase: "todo", title: "A title" },
    });
    expect(compact.entries[0].entry).toEqual(full.entries[0].entry);
    expect(compact.total).toBe(full.total);
  } finally {
    harness.close();
  }
});
