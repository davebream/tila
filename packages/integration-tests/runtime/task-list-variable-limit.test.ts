import { SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { expect, it } from "vitest";
import { D1TokenStore } from "../../worker/src/d1";
import { projects } from "../../worker/src/d1/schema";
import { hashToken } from "../../worker/src/lib/hash";
import { scaleDefinition } from "../fixtures/s1-scale";
import { bindings } from "./setup";

// Durable Object SQLite refuses a statement that binds more than 100 values.
// Each page below exceeds that in one of the per-page lookups: tag enrichment
// binds one value per task, compact counts bind every task id plus two types.
const COUNT = 150;
const numbered = Array.from(
  { length: COUNT },
  (_, i) => `vl-${String(i).padStart(3, "0")}`,
);
const blockerIds = ["vl-zz-blocker-a", "vl-zz-blocker-b"];
const expectedIds = [...numbered, ...blockerIds].sort();

const tagsFor = (i: number) =>
  i % 4 === 0 ? [] : i % 4 === 1 ? ["odd"] : [`group-${i % 10}`, "shared"];
const blockersFor = (i: number) => i % 3;

type Row = {
  id: string;
  tags?: string[];
  blockers?: number;
};
type Page = {
  ok: boolean;
  entities: Row[];
  total: number;
  limit: number | null;
  has_more: boolean;
  next_cursor: string | null;
};

let project: string;
let token: string;

async function call(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await SELF.fetch(
    `https://worker/projects/${project}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": "variable-limit-runtime",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
  );
  return { status: response.status, json: await response.json() };
}

async function ok(path: string, body?: unknown): Promise<unknown> {
  const { status, json } = await call(path, body);
  expect(status, `${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
  return json;
}

async function page(query: string): Promise<Page> {
  const { status, json } = await call(`/tasks${query}`);
  expect(status, `GET /tasks${query}: ${JSON.stringify(json)}`).toBe(200);
  return json as Page;
}

/** Follows `next_cursor` to the end, returning every page in order. */
async function walk(query: string): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const next: Page = await page(
      `${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    pages.push(next);
    cursor = next.next_cursor;
    expect(pages.length).toBeLessThanOrEqual(COUNT);
  } while (cursor);
  return pages;
}

async function seedProject(): Promise<void> {
  project = `task-list-limit-${crypto.randomUUID()}`;
  await drizzle(bindings.DB).insert(projects).values({
    project_id: project,
    created_at: 0,
    created_by: "fixture",
    cloudflare_account_id: "local",
  });
  token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await new D1TokenStore(bindings.DB).issue({
    projectId: project,
    tokenHash: await hashToken(token, bindings.HASH_PEPPER),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
  await ok("/schema", { definition: scaleDefinition, expected_revision: 0 });

  // Created out of id order so id-sorted pages cannot match insertion order.
  for (let k = 0; k < COUNT; k++) {
    const i = (37 * k) % COUNT;
    await ok("/tasks", {
      id: numbered[i],
      type: "task",
      data: { title: `Variable limit ${i}` },
      tags: tagsFor(i),
    });
  }
  for (const id of blockerIds)
    await ok("/tasks", { id, type: "task", data: { title: id } });
  for (let i = 0; i < COUNT; i++)
    for (let b = 0; b < blockersFor(i); b++)
      await ok("/tasks/relationships", {
        from_id: blockerIds[b],
        to_id: numbered[i],
        type: "blocks",
        actor: "variable-limit-runtime",
      });
}

function expectTags(rows: Row[], label: string) {
  for (const row of rows) {
    const i = numbered.indexOf(row.id);
    if (i >= 0)
      expect(row.tags?.slice().sort(), `${label} ${row.id}`).toEqual(
        tagsFor(i).slice().sort(),
      );
  }
}

it("serves task lists over the 100-variable limit with correct pages, tags and blocker counts", async () => {
  await seedProject();
  const all = COUNT + 2;

  // No limit: the original unbounded request, answered whole.
  const unbounded = await page("?sort=id&order=asc");
  expect(unbounded.entities.map((e) => e.id)).toEqual(expectedIds);
  expect(unbounded).toMatchObject({
    total: all,
    limit: null,
    has_more: false,
    next_cursor: null,
  });
  expectTags(unbounded.entities, "no limit");

  // A limit just over 100 is honored, and its cursor continues the list.
  const first = await page("?sort=id&order=asc&limit=101");
  expect(first.entities.map((e) => e.id)).toEqual(expectedIds.slice(0, 101));
  expect(first).toMatchObject({ limit: 101, has_more: true });
  expect(first.next_cursor).toBeTypeOf("string");

  // The documented ceiling: a larger limit is served as 500, not refused.
  const clamped = await page("?sort=id&order=asc&limit=1000");
  expect(clamped.entities.map((e) => e.id)).toEqual(expectedIds);
  expect(clamped).toMatchObject({ limit: 500, has_more: false });

  // Cursor walks over the boundary: no gaps, no duplicates, tags intact.
  for (const limit of [101, 120, 500]) {
    const pages = await walk(`?sort=id&order=asc&limit=${limit}`);
    const seen = pages.flatMap((p) => p.entities.map((e) => e.id));
    expect(seen, `limit ${limit}`).toEqual(expectedIds);
    expect(pages, `limit ${limit}`).toHaveLength(Math.ceil(all / limit));
    for (const p of pages) {
      expect(p.total).toBe(all);
      expectTags(p.entities, `limit ${limit}`);
    }
  }

  // The default order has no id tie to lean on: every task, exactly once.
  const defaults = await walk("?limit=120");
  expect(defaults.map((p) => p.entities.length)).toEqual([120, all - 120]);
  const defaultIds = defaults.flatMap((p) => p.entities.map((e) => e.id));
  expect(new Set(defaultIds).size).toBe(all);
  expect([...defaultIds].sort()).toEqual(expectedIds);

  // Compact counts bind every id plus two relationship types: 99 ids fail.
  for (const [label, query, expected] of [
    ["limit 99", "?sort=id&limit=99", 99],
    ["limit 120", "?sort=id&limit=120", 120],
    ["no limit", "?sort=id", all],
  ] as const) {
    const compact = await page(`${query}&compact=true`);
    expect(compact.entities, label).toHaveLength(expected);
    for (const row of compact.entities) {
      const i = numbered.indexOf(row.id);
      expect(row.blockers, `${label} ${row.id}`).toBe(
        i >= 0 ? blockersFor(i) : 0,
      );
    }
  }

  // A filter that narrows the set pages by the same cursor.
  const shared = numbered.filter((_, i) => tagsFor(i).includes("shared"));
  const filtered = await walk("?sort=id&order=desc&limit=40&tag_filter=shared");
  expect(filtered.flatMap((p) => p.entities.map((e) => e.id))).toEqual(
    [...shared].reverse(),
  );
  expect(filtered[0]?.total).toBe(shared.length);
}, 90_000);
