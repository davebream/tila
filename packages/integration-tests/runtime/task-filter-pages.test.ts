import { evictDurableObject } from "cloudflare:test";
import { PaginatedEntityListResponseSchema } from "@tila/schemas";
import { expect, it } from "vitest";
import { lifecycleDefinition } from "../../ops-sqlite/test/readiness-fixture";
import { post } from "./helpers";
import { bindings } from "./setup";

it("retains exact task filter pages, cursor bindings and scope after a DO restart", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const applied = await post(stub, "/schema/apply", {
    definition: lifecycleDefinition,
    applied_by: "runtime",
    expected_revision: 0,
  });
  expect(applied.status, await applied.text()).toBe(200);
  for (const [id, type, data] of [
    ["cancelled", "issue", { phase: "aborted" }],
    ["blocked-a", "issue", { phase: "todo" }],
    ["blocked-b", "issue", { phase: "todo" }],
    ["blocked-c", "task", { status: "open" }],
    ["success", "issue", { phase: "shipped" }],
  ] as const) {
    const created = await post(stub, "/entity/create", {
      id,
      type,
      data,
      created_by: "runtime",
    });
    expect(created.status, await created.text()).toBe(200);
  }
  for (const to_id of ["blocked-a", "blocked-b", "blocked-c"]) {
    const linked = await post(stub, "/entity/relationship/create", {
      from_id: "cancelled",
      to_id,
      type: "blocks",
      actor: "runtime",
    });
    expect(linked.status, await linked.text()).toBe(201);
  }
  async function page(query: string, restricted = false) {
    const response = await stub.fetch(`https://project/entity/list?${query}`, {
      headers: restricted
        ? {
            "X-Tila-Credential-Policy": JSON.stringify({
              role: "viewer",
              capabilities: ["tasks:read"],
              restrictions: { task_types: ["task"] },
            }),
          }
        : {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return PaginatedEntityListResponseSchema.parse(await response.json());
  }
  const first = await page("blocked=1&sort=id&limit=2");
  expect(first.entities.map((e) => e.id)).toEqual(["blocked-a", "blocked-b"]);
  expect(first).toMatchObject({
    total: 3,
    limit: 2,
    offset: 0,
    has_more: true,
    scope: { restricted: false },
  });
  expect(first.next_cursor).toBeTypeOf("string");
  await evictDurableObject(stub);
  const continuation = encodeURIComponent(first.next_cursor ?? "");
  const last = await page(`blocked=1&sort=id&limit=2&cursor=${continuation}`);
  expect(last.entities.map((e) => e.id)).toEqual(["blocked-c"]);
  expect(last).toMatchObject({ total: 3, has_more: false, next_cursor: null });
  const mismatch = await stub.fetch(
    `https://project/entity/list?sort=id&limit=2&cursor=${continuation}`,
  );
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toMatchObject({
    error: { code: "invalid-cursor" },
  });

  const outcomes = await page("outcome=success,cancelled&sort=id&limit=1");
  expect(outcomes).toMatchObject({
    total: 2,
    has_more: true,
    scope: { outcome_types: ["issue"] },
  });
  const next = await page(
    `outcome=cancelled,success&sort=id&limit=1&cursor=${encodeURIComponent(outcomes.next_cursor ?? "")}`,
  );
  expect(next).toMatchObject({ total: 2, has_more: false, next_cursor: null });
  expect(next.entities[0]?.id).toBe("success");
  expect(await page("outcome=abandoned&limit=1")).toMatchObject({
    entities: [],
    total: 0,
    has_more: false,
    next_cursor: null,
    scope: { outcome_types: [] },
  });
  expect(await page("outcome=success,cancelled&limit=1", true)).toMatchObject({
    entities: [],
    total: 0,
    scope: { restricted: true, outcome_types: [] },
  });
  expect(await page("blocked=1&limit=1", true)).toMatchObject({
    total: 1,
    scope: { restricted: true },
  });
  const invalid = await stub.fetch(
    "https://project/entity/list?outcome=invalid",
  );
  expect(invalid.status).toBe(400);
  await invalid.text();
  for (const query of [
    "limit=0",
    "limit=-1",
    "limit=1.5",
    "limit=NaN",
    "limit=Infinity",
    "offset=-1",
    "offset=1.5",
    "offset=NaN",
    "offset=Infinity",
    "offset=9007199254740992",
  ]) {
    const invalid = await stub.fetch(`https://project/entity/list?${query}`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "validation-error" },
    });
  }
  expect(await page("limit=501&offset=0")).toMatchObject({
    limit: 500,
    offset: 0,
    total: 5,
    has_more: false,
    next_cursor: null,
  });
});
