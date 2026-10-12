import { evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { lifecycleDefinition } from "../../ops-sqlite/test/readiness-fixture";
import { post } from "./helpers";
import { bindings } from "./setup";

it("uses custom lifecycle success and cycle rules through real DO requests and cold starts", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const apply = await post(stub, "/schema/apply", {
    definition: lifecycleDefinition,
    applied_by: "runtime",
    expected_revision: 0,
  });
  expect(apply.status, await apply.text()).toBe(200);
  for (const [id, phase] of Object.entries({
    done: "shipped",
    cancelled: "aborted",
    ready: "todo",
    blocked: "todo",
    "cycle-a": "todo",
    "cycle-b": "todo",
  })) {
    const response = await post(stub, "/entity/create", {
      id,
      type: "issue",
      data: { phase },
      created_by: "runtime",
    });
    expect(response.status, await response.text()).toBe(200);
  }
  for (const [from_id, to_id] of [
    ["done", "ready"],
    ["cancelled", "blocked"],
    ["cycle-a", "cycle-b"],
    ["cycle-b", "cycle-a"],
  ]) {
    const response = await post(stub, "/entity/relationship/create", {
      from_id,
      to_id,
      type: "blocks",
      actor: "runtime",
    });
    expect(response.status, await response.text()).toBe(201);
  }
  async function ready() {
    const response = await stub.fetch(
      "https://project/entity/ready?type=issue",
    );
    expect(response.status).toBe(200);
    return (await response.json<{ entities: { id: string }[] }>()).entities.map(
      (entity) => entity.id,
    );
  }
  expect(await ready()).toEqual(["ready"]);
  await evictDurableObject(stub);
  expect(await ready()).toEqual(["ready"]);
});
