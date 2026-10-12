import { entityOps } from "@tila/ops-sqlite";
import type {
  PaginatedEntityListResponse,
  UnifiedSearchResponse,
} from "@tila/schemas";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../worker/src/do/project-do-router";
import type { RouterDeps } from "../../worker/src/do/routes/types";
import { errorHandler } from "../../worker/src/middleware/error";
import { entities } from "../../worker/src/routes/entities";
import { search } from "../../worker/src/routes/search";
import type { Env, HonoVariables } from "../../worker/src/types";
import {
  type TestDb,
  createTestDb,
} from "../../worker/test/do/helpers/create-test-db";

// #300: with more than 250 tasks, an item outside the first 100 is reachable
// through real cursors and through server-side search.

let db: TestDb;
let app: Hono<{ Bindings: Env; Variables: HonoVariables }>;
let doApp: ReturnType<typeof createProjectRouter>;
const env = { ANALYTICS: { writeDataPoint: () => {} } } as unknown as Env;
const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

beforeEach(() => {
  db = createTestDb();
  const deps: RouterDeps = {
    db: db.db as RouterDeps["db"],
    ctx: {
      storage: {
        sql: {
          exec: (s: string, ...bindings: unknown[]) => ({
            toArray: () => db.sqlite.prepare(s).all(...bindings),
          }),
        },
        getAlarm: vi.fn(async () => null),
        setAlarm: vi.fn(async () => {}),
      },
    } as unknown as DurableObjectState,
    enrichOpts: vi.fn(),
  } as unknown as RouterDeps;
  doApp = createProjectRouter(deps);
  app = new Hono();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("tokenResult", {
      kind: "d1-token",
      projectId: "p1",
      name: "test",
      scopes: "full",
      tokenId: "test",
    });
    c.set("projectId", "p1");
    c.set("principalId", "token:test");
    c.set("participantId", "test-participant");
    c.set("environment", {});
    c.set("doStub", {
      fetch: (request: Request) => doApp.fetch(request),
    } as DurableObjectStub);
    await next();
  });
  app.route("/tasks", entities);
  app.route("/search", search);

  const origin = {
    principalId: "seed",
    participantId: "seed",
    environment: { client_name: "test" },
    actor: "seed",
    source: "test",
  };
  for (let i = 1; i <= 260; i++)
    entityOps.create(
      db.db as RouterDeps["db"],
      {
        id: `task-${String(i).padStart(3, "0")}`,
        type: i % 2 ? "story" : "bug",
        data: { title: `Work item ${i}` },
        created_by: "seed",
      },
      1,
      origin,
    );
  // Every task shares one timestamp so only the id tie-break orders them.
  db.sqlite.exec("UPDATE entities SET created_at = 1, updated_at = 1");
});
afterEach(() => db.sqlite.close());

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path, undefined, env, executionCtx);
  return { status: res.status, body: (await res.json()) as T };
}

describe("task pagination through Worker and DO", () => {
  it("reaches task 251 on the third page with stable totals", async () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 3; page++) {
      const { status, body } = await get<PaginatedEntityListResponse>(
        `/tasks?limit=100&archived=0${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(status).toBe(200);
      expect(body.total).toBe(260);
      expect(body.scope).toEqual({ restricted: false, archived: "excluded" });
      seen.push(...body.entities.map((e) => e.id));
      cursor = body.next_cursor;
      if (page === 2) {
        expect(body.entities.map((e) => e.id)).toContain("task-251");
        expect(body.has_more).toBe(false);
        expect(cursor).toBeNull();
      }
    }
    expect(new Set(seen).size).toBe(260);
  });

  it("rejects a cursor used with a different filter", async () => {
    const first = await get<PaginatedEntityListResponse>("/tasks?limit=10");
    const { status, body } = await get<{ error: { code: string } }>(
      `/tasks?limit=10&type=bug&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid-cursor");
  });

  it("rejects cursor combined with offset", async () => {
    const first = await get<PaginatedEntityListResponse>("/tasks?limit=10");
    const { status } = await get(
      `/tasks?limit=10&offset=10&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
    );
    expect(status).toBe(400);
  });

  it("finds task 251 by id through unified search", async () => {
    const { status, body } = await get<UnifiedSearchResponse>(
      "/search?q=task-251&kind=task&syntax=literal",
    );
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      type: "entity",
      entity_id: "task-251",
    });
    expect(body.scope).toEqual({
      restricted: false,
      kinds: ["task"],
      archived: "excluded",
    });
  });

  it("pages search results with a type filter", async () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const { body } = await get<UnifiedSearchResponse>(
        `/search?q=work&kind=task&type=bug&syntax=literal&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(
        ...body.results.map((r) => (r.type === "entity" ? r.entity_id : "")),
      );
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(seen.length).toBe(130);
    expect(new Set(seen).size).toBe(130);
  });

  it("rejects type without a single task or record kind", async () => {
    const { status } = await get("/search?q=work&type=bug");
    expect(status).toBe(400);
  });

  it("scopes search for a namespace-restricted credential", async () => {
    const policy = JSON.stringify({
      role: "viewer",
      capabilities: ["search:read", "tasks:read", "artifacts:read"],
      restrictions: { task_types: ["bug"] },
    });
    const res = await doApp.request("/search?q=work&limit=100", {
      headers: { "X-Tila-Credential-Policy": policy },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UnifiedSearchResponse;
    expect(
      body.results.every((r) => r.type === "entity" && r.entity_type === "bug"),
    ).toBe(true);
    expect(body.scope).toMatchObject({
      restricted: true,
      kinds: ["task"],
      excluded_kinds: [
        { kind: "artifact", reason: "restricted" },
        { kind: "record", reason: "capability" },
      ],
    });

    const denied = await doApp.request("/search?q=work&kind=artifact", {
      headers: { "X-Tila-Credential-Policy": policy },
    });
    expect(denied.status).toBe(403);
  });
});
