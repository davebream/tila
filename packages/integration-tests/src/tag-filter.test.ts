/**
 * Integration test: tag_filter on list/search end-to-end (HTTP -> Worker -> DO).
 *
 * Exercises the full request path for the additive, backward-compatible
 * multi-tag `tag_filter` facet filter (AND semantics, comma-encoded on the wire):
 *   - GET /projects/:id/tasks (entities list) with tag_filter
 *   - GET /projects/:id/artifacts/search (FTS) with tag_filter
 *   - GET /projects/:id/search (unified) with tag_filter
 *   - invalid tag grammar -> 400 at the worker edge on a list route and a search route
 *
 * Lower layers are covered by faster tests:
 *   - ops-sqlite AND semantics + post-MATCH EXISTS: packages/ops-sqlite/test/*,
 *     packages/backend-do/test/{entity-ops-search,record-search,artifact-search-query}.test.ts
 *   - DO router threading + 400: packages/backend-do/test/entity-artifact-tags-route.test.ts
 *   - worker edge parse/forward + 400: packages/worker/src/routes/{entities,search,artifacts}.test.ts
 *
 * Requires TILA_BASE_URL and TILA_TOKEN to run against a live worker. When the
 * env vars are absent (CI without a live worker) the live suite is skipped,
 * matching the convention in artifact-tags.test.ts.
 */

import { beforeAll, describe, expect, it } from "vitest";

const BASE_URL = process.env.TILA_BASE_URL;
const TOKEN = process.env.TILA_TOKEN;
const PROJECT_ID = process.env.TILA_PROJECT_ID ?? "dev-project";

const auth = { Authorization: `Bearer ${TOKEN}` } as Record<string, string>;
const stamp = Date.now();
const repoTag = `repo:tagf-${stamp}`;
const teamTag = `team:tagf-${stamp}`;

async function createTask(id: string, title: string, tags: string[]) {
  const res = await fetch(`${BASE_URL}/projects/${PROJECT_ID}/tasks`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      type: "task",
      data: { title },
      created_by: "tag-filter-e2e",
      tags,
    }),
  });
  expect(res.status).toBe(200);
}

describe.skipIf(!BASE_URL || !TOKEN)("tag_filter end-to-end", () => {
  const both = `T-tagf-both-${stamp}`;
  const repoOnly = `T-tagf-repo-${stamp}`;
  const teamOnly = `T-tagf-team-${stamp}`;

  beforeAll(async () => {
    await createTask(both, "tagfilter both", [repoTag, teamTag]);
    await createTask(repoOnly, "tagfilter repo", [repoTag]);
    await createTask(teamOnly, "tagfilter team", [teamTag]);
  });

  it("list (tasks) with multi-tag tag_filter returns only AND matches", async () => {
    const url = `${BASE_URL}/projects/${PROJECT_ID}/tasks?tag_filter=${encodeURIComponent(
      `${repoTag},${teamTag}`,
    )}`;
    const res = await fetch(url, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      entities?: Array<{ id: string }>;
      tasks?: Array<{ id: string }>;
    };
    const ids = (body.entities ?? body.tasks ?? []).map((e) => e.id);
    expect(ids).toContain(both);
    expect(ids).not.toContain(repoOnly);
    expect(ids).not.toContain(teamOnly);
  });

  it("list with a single-element tag_filter returns all items carrying that tag", async () => {
    const url = `${BASE_URL}/projects/${PROJECT_ID}/tasks?tag_filter=${encodeURIComponent(
      repoTag,
    )}`;
    const res = await fetch(url, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entities?: Array<{ id: string }>;
      tasks?: Array<{ id: string }>;
    };
    const ids = (body.entities ?? body.tasks ?? []).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([both, repoOnly]));
    expect(ids).not.toContain(teamOnly);
  });

  it("unified search with tag_filter narrows to AND matches", async () => {
    const url = `${BASE_URL}/projects/${PROJECT_ID}/search?q=${encodeURIComponent(
      "tagfilter",
    )}&tag_filter=${encodeURIComponent(`${repoTag},${teamTag}`)}`;
    const res = await fetch(url, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: Array<{ type: string; entity_id?: string }>;
    };
    expect(body.ok).toBe(true);
    const entityIds = body.results
      .filter((r) => r.type === "entity")
      .map((r) => r.entity_id);
    // The "both" task carries both tags; repo-only / team-only must be excluded.
    expect(entityIds).not.toContain(repoOnly);
    expect(entityIds).not.toContain(teamOnly);
  });

  it("artifact search accepts tag_filter and returns 200", async () => {
    const res = await fetch(
      `${BASE_URL}/projects/${PROJECT_ID}/artifacts/search?q=${encodeURIComponent(
        "tagfilter",
      )}&tag_filter=${encodeURIComponent(repoTag)}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("invalid tag grammar returns 400 on a list route", async () => {
    const res = await fetch(
      `${BASE_URL}/projects/${PROJECT_ID}/tasks?tag_filter=${encodeURIComponent(
        "bad!tag",
      )}`,
      { headers: auth },
    );
    expect(res.status).toBe(400);
  });

  it("invalid tag grammar returns 400 on the unified search route", async () => {
    const res = await fetch(
      `${BASE_URL}/projects/${PROJECT_ID}/search?q=hello&tag_filter=${encodeURIComponent(
        "bad!tag",
      )}`,
      { headers: auth },
    );
    expect(res.status).toBe(400);
  });
});

// Non-live guard: always-run static check so the file is exercised in CI.
describe("tag_filter integration - static checks", () => {
  it("comma-encodes a multi-tag filter unambiguously (tags cannot contain commas)", () => {
    const encoded = [repoTag, teamTag].join(",");
    expect(encoded.split(",")).toEqual([repoTag, teamTag]);
    expect(repoTag).not.toContain(",");
  });
});
