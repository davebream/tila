import { runInDurableObject } from "cloudflare:test";
import { StoreCountsResponseSchema } from "@tila/schemas";
import { expect, it } from "vitest";
import { identity, post } from "./helpers";
import { bindings } from "./setup";

it("reports the runtime database size and growth after writes", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  async function sample() {
    const response = await stub.fetch("https://project/admin/store-counts");
    expect(response.status).toBe(200);
    const body = StoreCountsResponseSchema.parse(await response.json());
    const runtimeSize = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.sql.databaseSize,
    );
    expect(body.db_bytes).toBe(runtimeSize);
    expect(body.db_bytes).toBeGreaterThan(0);
    return body;
  }

  const before = await sample();
  for (let index = 0; index < 32; index++) {
    const response = await post(stub, "/entity/create", {
      id: `size-task-${index}`,
      type: "task",
      created_by: identity.principal_id,
      data: { title: `Size task ${index}`, description: "x".repeat(8192) },
    });
    expect(response.status, await response.text()).toBe(200);
  }
  const after = await sample();
  expect(after.db_bytes).toBeGreaterThan(before.db_bytes as number);
  expect(after.counts.domain.entities).toBe(before.counts.domain.entities + 32);
  expect(after.counts.domain.journal).toBeGreaterThan(
    before.counts.domain.journal,
  );
  expect(after.counts.schemaHistory).toBe(before.counts.schemaHistory);
});
