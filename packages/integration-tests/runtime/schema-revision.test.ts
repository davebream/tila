import { evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { post } from "./helpers";
import { bindings } from "./setup";

const definition = `schema_version = 1
[work_units.task.fields.title]
type = "string"
required = true
`;

it("serializes configuration races and retains transactional receipts across DO eviction", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const contenders = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      post(stub, "/schema/apply", {
        definition: `${definition}\n# contender ${i}`,
        applied_by: "runtime",
        expected_revision: 0,
        idempotency_key: `apply-${i}`,
      }),
    ),
  );
  expect(contenders.filter((r) => r.status === 200)).toHaveLength(1);
  expect(contenders.filter((r) => r.status === 412)).toHaveLength(7);
  const winner = contenders.findIndex((r) => r.status === 200);
  const result = await contenders[winner].json();
  await Promise.all(
    contenders.filter((_, i) => i !== winner).map((r) => r.arrayBuffer()),
  );
  await evictDurableObject(stub);
  const retry = await post(bindings.PROJECT.get(stub.id), "/schema/apply", {
    definition: `${definition}\n# contender ${winner}`,
    applied_by: "runtime",
    expected_revision: 0,
    idempotency_key: `apply-${winner}`,
  });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(result);
  const history = await (
    await stub.fetch("https://project/schema/history")
  ).json<{ entries: unknown[] }>();
  expect(history.entries).toHaveLength(1);
});

it("checks the reviewed definition and current revision before a destructive apply", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  expect(
    (
      await post(stub, "/schema/apply", {
        definition,
        applied_by: "runtime",
        expected_revision: 0,
      })
    ).status,
  ).toBe(200);
  const destructive = "schema_version = 1\nwork_units = {}";
  const review = await (
    await post(stub, "/schema/preview", { definition: destructive })
  ).json<{ revision: number; reviewed_definition: string }>();
  const changed = await post(stub, "/schema/apply", {
    definition: destructive,
    expected_revision: review.revision,
    reviewed_definition: definition,
    strategy: "force",
    applied_by: "runtime",
  });
  expect(changed.status).toBe(412);
  const valid = await post(stub, "/schema/apply", {
    definition: destructive,
    expected_revision: review.revision,
    reviewed_definition: review.reviewed_definition,
    strategy: "force",
    applied_by: "runtime",
  });
  expect(valid.status).toBe(200);
  const staleEntity = await post(stub, "/entity/create", {
    id: "stale",
    type: "task",
    data: { title: "stale" },
    schema_version: 1,
    created_by: "runtime",
  });
  expect(staleEntity.status).toBe(422);
});
