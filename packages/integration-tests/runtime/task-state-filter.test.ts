import { evictDurableObject } from "cloudflare:test";
import { PaginatedEntityListResponseSchema } from "@tila/schemas";
import { expect, it } from "vitest";
import { post } from "./helpers";
import { bindings } from "./setup";

// #525: Durable Object SQLite refuses a statement that binds more than 100
// values. With 120 types each declaring a lifecycle, a state expression that
// bound one value per type would fail on its first page; the type-to-field map
// travels as one bound JSON object instead.
const LIFECYCLE_TYPES = 120;
const CHORES = 40;

const typeName = (i: number) => `t${String(i).padStart(3, "0")}`;

const definition = `${[
  "schema_version = 1",
  ...Array.from({ length: LIFECYCLE_TYPES }, (_, i) =>
    [
      `[work_units.${typeName(i)}.fields.f${i}]`,
      'type = "string"',
      `[work_units.${typeName(i)}.lifecycle]`,
      `field = "f${i}"`,
      'dispatchable = ["todo"]',
      'terminal = ["done"]',
      'dependency_satisfied = ["done"]',
    ].join("\n"),
  ),
  "[work_units.chore.fields.status]",
  'type = "string"',
].join("\n")}\n`;

type Row = { id: string; type: string; state: string };

// Created out of id order, so id and state order cannot match insertion order.
const rows: Row[] = [
  ...Array.from({ length: LIFECYCLE_TYPES }, (_, i) => ({
    id: `row-${String((i * 53) % LIFECYCLE_TYPES).padStart(3, "0")}`,
    type: typeName((i * 53) % LIFECYCLE_TYPES),
    state: i % 2 ? "done" : "todo",
  })),
  ...Array.from({ length: CHORES }, (_, i) => ({
    id: `chore-${String(i).padStart(2, "0")}`,
    type: "chore",
    state: i % 4 === 0 ? "done" : i % 4 === 1 ? "in-review" : "open",
  })),
];

const fieldFor = (row: Row) =>
  row.type === "chore" ? "status" : `f${Number(row.type.slice(1))}`;

function expectedOrder(order: "asc" | "desc", states?: string[]): string[] {
  const sorted = rows
    .filter((r) => !states || states.includes(r.state))
    .sort((a, b) =>
      a.state === b.state ? (a.id < b.id ? -1 : 1) : a.state < b.state ? -1 : 1,
    );
  return (order === "desc" ? sorted.reverse() : sorted).map((r) => r.id);
}

it("pages state filters and sorts across 120 lifecycle types within the bound-value cap, across a restart", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const applied = await post(stub, "/schema/apply", {
    definition,
    applied_by: "runtime",
    expected_revision: 0,
  });
  expect(applied.status, await applied.text()).toBe(200);
  for (const row of rows) {
    const created = await post(stub, "/entity/create", {
      id: row.id,
      type: row.type,
      data: { [fieldFor(row)]: row.state },
      created_by: "runtime",
    });
    expect(created.status, await created.text()).toBe(200);
  }

  async function page(query: string) {
    const response = await stub.fetch(`https://project/entity/list?${query}`);
    expect(response.status, `${query}: ${await response.clone().text()}`).toBe(
      200,
    );
    return PaginatedEntityListResponseSchema.parse(await response.json());
  }

  // A state filter with many values plus a state sort, over every type.
  const states = ["done", ...Array.from({ length: 60 }, (_, i) => `x${i}`)];
  const wanted = expectedOrder("asc", ["done"]);
  expect(wanted.length).toBe(LIFECYCLE_TYPES / 2 + CHORES / 4);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const next = await page(
      `state=${encodeURIComponent(states.join(","))}&sort=state&limit=25${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    expect(next.total).toBe(wanted.length);
    seen.push(...next.entities.map((e) => e.id));
    cursor = next.next_cursor ?? null;
    if (!cursor) break;
    // The binding is rebuilt from the stored schema after a restart.
    if (seen.length === 25) await evictDurableObject(stub);
  }
  expect(seen).toEqual(wanted);

  for (const order of ["asc", "desc"] as const) {
    const ids: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const next = await page(
        `sort=state&order=${order}&limit=50${
          after ? `&cursor=${encodeURIComponent(after)}` : ""
        }`,
      );
      expect(next.total).toBe(rows.length);
      ids.push(...next.entities.map((e) => e.id));
      after = next.next_cursor ?? null;
      if (!after) break;
    }
    expect(ids).toEqual(expectedOrder(order));
  }

  // A cursor ends when the state filter changes, and blank lists are refused.
  const first = await page("state=done&sort=state&limit=5");
  const mismatch = await stub.fetch(
    `https://project/entity/list?state=todo&sort=state&limit=5&cursor=${encodeURIComponent(first.next_cursor ?? "")}`,
  );
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toMatchObject({
    error: { code: "invalid-cursor" },
  });
  for (const state of ["", ",", "done,"]) {
    const invalid = await stub.fetch(
      `https://project/entity/list?state=${state}`,
    );
    expect(invalid.status, state).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "validation-error" },
    });
  }
});
