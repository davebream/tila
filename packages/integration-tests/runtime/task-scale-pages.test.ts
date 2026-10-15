import { SELF, evictDurableObject } from "cloudflare:test";
import {
  PaginatedEntityListResponseSchema,
  UnifiedSearchResponseSchema,
} from "@tila/schemas";
import { drizzle } from "drizzle-orm/d1";
import { expect, it } from "vitest";
import { D1TokenStore } from "../../worker/src/d1";
import { projects } from "../../worker/src/d1/schema";
import { hashToken } from "../../worker/src/lib/hash";
import {
  scaleCreates,
  scaleDefinition,
  scaleExpectedIds,
} from "../fixtures/s1-scale";
import { bindings } from "./setup";

it("retains all 301 task list and literal search pages after a real DO restart", async () => {
  const project = `task-scale-${crypto.randomUUID()}`;
  await drizzle(bindings.DB).insert(projects).values({
    project_id: project,
    created_at: 0,
    created_by: "fixture",
    cloudflare_account_id: "local",
  });
  const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await new D1TokenStore(bindings.DB).issue({
    projectId: project,
    tokenHash: await hashToken(token, bindings.HASH_PEPPER),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await SELF.fetch(
      `https://worker/projects/${project}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Tila-Participant-Id": "scale-runtime",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    // Drain each public acknowledgement before the next create or eviction.
    const data: unknown = await response.json();
    expect(response.ok, JSON.stringify(data)).toBe(true);
    expect(data).toMatchObject({ ok: true });
    return data;
  }
  await request("/schema", {
    definition: scaleDefinition,
    expected_revision: 0,
  });
  const schema = await request("/schema");
  const history = await request("/schema/history");
  const listQuery = "/tasks?sort=id&order=asc&archived=0&limit=100";
  expect(await request(listQuery)).toMatchObject({ entities: [], total: 0 });
  for (const task of scaleCreates) {
    expect(await request("/tasks", task)).toMatchObject({ entity: task });
  }
  await evictDurableObject(
    bindings.PROJECT.get(bindings.PROJECT.idFromName(project)),
  );

  const all = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < 4; i++) {
    const page = PaginatedEntityListResponseSchema.parse(
      await request(
        `${listQuery}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    );
    expect(page.entities.map((e) => e.id)).toEqual(
      scaleExpectedIds.slice(i * 100, (i + 1) * 100),
    );
    expect(page).toMatchObject({
      total: 301,
      limit: 100,
      has_more: i < 3,
      scope: { restricted: false, archived: "excluded" },
    });
    if (i < 3) expect(page.next_cursor).toBeTypeOf("string");
    else expect(page.next_cursor).toBeNull();
    all.push(...page.entities);
    cursor = page.next_cursor;
  }
  expect(new Set(all.map((e) => e.id)).size).toBe(301);
  expect(all.map(({ id, type, data }) => ({ id, type, data }))).toEqual(
    scaleExpectedIds.map((id, i) => ({
      id,
      type: "task",
      data: {
        title: `s1scalecommon ${i === 300 ? "s1scalesentinel" : `s1scalerow${String(i + 1).padStart(3, "0")}`}`,
      },
    })),
  );

  const searchQuery = "/search?kind=task&syntax=literal&limit=100&q=";
  cursor = null;
  const found: string[] = [];
  for (let i = 0; i < 4; i++) {
    const page = UnifiedSearchResponseSchema.parse(
      await request(
        `${searchQuery}s1scalecommon${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    );
    const ids = page.results.map((r) =>
      r.type === "entity" ? r.entity_id : r.type,
    );
    expect(ids).toEqual(scaleExpectedIds.slice(i * 100, (i + 1) * 100));
    expect(page).toMatchObject({
      total: i === 3 ? 1 : 100,
      scope: { kinds: ["task"], restricted: false, archived: "excluded" },
    });
    if (i < 3) expect(page.next_cursor).toBeTypeOf("string");
    else expect(page.next_cursor).toBeNull();
    found.push(...ids);
    cursor = page.next_cursor;
  }
  expect(found).toEqual(scaleExpectedIds);
  for (const q of ["s1scalesentinel", "s1-scale-301"]) {
    const page = UnifiedSearchResponseSchema.parse(
      await request(`${searchQuery}${q}`),
    );
    expect(page.results).toMatchObject([
      { type: "entity", entity_id: "s1-scale-301" },
    ]);
    expect(page).toMatchObject({ total: 1, next_cursor: null });
  }
  expect(await request(`${searchQuery}s1scaleabsent`)).toMatchObject({
    results: [],
    total: 0,
    next_cursor: null,
  });
  expect(await request(`${listQuery}&type=bug`)).toMatchObject({
    entities: [],
    total: 0,
    next_cursor: null,
    has_more: false,
  });
  expect(await request("/tasks/~/types")).toMatchObject({
    types: [
      { type: "bug", declaration: "declared", count: 0, archived_count: 0 },
      { type: "task", declaration: "declared", count: 301, archived_count: 0 },
    ],
  });
  expect(await request("/schema")).toEqual(schema);
  expect(await request("/schema/history")).toEqual(history);
}, 90_000);
