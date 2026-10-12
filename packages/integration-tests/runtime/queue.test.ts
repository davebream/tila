import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { schema } from "@tila/ops-sqlite";
import type { QueueClaimResult, QueueInspection } from "@tila/schemas";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vitest";
import { lifecycleDefinition } from "../../ops-sqlite/test/readiness-fixture";
import { post } from "./helpers";
import { bindings } from "./setup";

it("atomically caps 100 concurrent DO consumers and retains grants across cold starts", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  expect(
    (
      await post(stub, "/schema/apply", {
        definition: lifecycleDefinition,
        applied_by: "test",
        expected_revision: 0,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post(stub, "/queue/configure", {
        authorized_role: "maintainer",
        command: {
          idempotency_key: "configure",
          expected_revision: 0,
          enabled: true,
          paused: false,
          execution_limit: 20,
        },
      })
    ).status,
  ).toBe(200);
  for (let i = 0; i < 100; i++) {
    expect(
      (
        await post(stub, "/entity/create", {
          id: `t${i}`,
          type: "issue",
          data: { phase: "todo" },
          created_by: "fixture",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(stub, "/queue/enroll", {
          command: { idempotency_key: `enroll-${i}`, task_id: `t${i}` },
        })
      ).status,
    ).toBe(200);
  }
  const claim = async (i: number) => {
    const response = await post(stub, "/queue/claim", {
      participant_id: `worker-${i}`,
      command: { idempotency_key: `claim-${i}` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json<{ result: QueueClaimResult }>()).result;
  };
  const results = await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const [first, replay] = await Promise.all([claim(i), claim(i)]);
      expect(replay).toEqual(first);
      return first;
    }),
  );
  const granted = results.filter((r) => r.kind === "granted");
  expect(granted).toHaveLength(20);
  expect(new Set(granted.map((r) => r.attempt.task_id)).size).toBe(20);
  await evictDurableObject(stub);
  const winner = results.findIndex((r) => r.kind === "granted");
  expect(await claim(winner)).toEqual(results[winner]);
  const snapshot = await (
    await post(stub, "/queue/inspect", { command: { limit: 100 } })
  ).json<{ result: QueueInspection }>();
  expect(snapshot.result.counts).toMatchObject({
    execution: 20,
    wip: 20,
    backlog: 80,
    active: 20,
  });
  const pause = await post(stub, "/queue/configure", {
    authorized_role: "maintainer",
    command: { idempotency_key: "pause", expected_revision: 1, paused: true },
  });
  expect(pause.status).toBe(200);
  expect(
    (
      await post(stub, "/queue/configure", {
        command: {
          idempotency_key: "impersonate-maintainer",
          expected_revision: 2,
          paused: false,
        },
      })
    ).status,
  ).toBe(403);
  expect(await claim(101)).toMatchObject({
    kind: "no_grant",
    reason: "paused",
  });
  expect(
    (
      await post(stub, "/coord/acquire", {
        resource: "issue:t0",
        mode: "exclusive",
        ttl_ms: 60_000,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post(stub, "/schema/apply", {
        definition: lifecycleDefinition,
        applied_by: "legacy",
      })
    ).status,
  ).toBe(428);
});

it("does not commit a new grant after a racing pause has committed", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  await post(stub, "/schema/apply", {
    definition: lifecycleDefinition,
    applied_by: "test",
    expected_revision: 0,
  });
  await post(stub, "/queue/configure", {
    authorized_role: "maintainer",
    command: {
      idempotency_key: "enable",
      expected_revision: 0,
      enabled: true,
      paused: false,
      execution_limit: 20,
    },
  });
  for (let i = 0; i < 20; i++) {
    await post(stub, "/entity/create", {
      id: `task-${i}`,
      type: "issue",
      data: { phase: "todo" },
      created_by: "test",
    });
    await post(stub, "/queue/enroll", {
      command: { idempotency_key: `enroll-${i}`, task_id: `task-${i}` },
    });
  }
  const claim = (i: number) =>
    post(stub, "/queue/claim", {
      participant_id: `worker-${i}`,
      command: { idempotency_key: `claim-${i}` },
    });
  const first = await (await claim(0)).json<{ result: QueueClaimResult }>();
  expect(first.result.kind).toBe("granted");
  const responses = await Promise.all([
    ...Array.from({ length: 9 }, (_, i) => claim(i + 1)),
    post(stub, "/queue/configure", {
      authorized_role: "maintainer",
      command: {
        idempotency_key: "pause",
        expected_revision: 1,
        paused: true,
        execution_limit: 3,
      },
    }),
    ...Array.from({ length: 10 }, (_, i) => claim(i + 10)),
  ]);
  expect(responses.every((r) => r.status === 200)).toBe(true);
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const journal = db.select().from(schema.journal).all();
    const paused = journal.find(
      (event) =>
        event.kind === "queue.policy_changed" &&
        JSON.parse(event.data).policy.paused,
    );
    expect(paused).toBeDefined();
    expect(
      journal.filter(
        (event) =>
          event.kind === "attempt.reserved" && event.seq > (paused?.seq ?? 0),
      ),
    ).toEqual([]);
  });
});
