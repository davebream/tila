import { entityOps, relationshipOps, schemaOps } from "@tila/ops-sqlite";
import type {
  CredentialPolicy,
  PaginatedEntityListResponse,
} from "@tila/schemas";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../worker/src/do/project-do-router";
import type { RouterDeps } from "../../worker/src/do/routes/types";
import { capabilityMiddleware } from "../../worker/src/middleware/capability";
import { errorHandler } from "../../worker/src/middleware/error";
import { entities } from "../../worker/src/routes/entities";
import type { Env, HonoVariables } from "../../worker/src/types";
import {
  type TestDb,
  createTestDb,
} from "../../worker/test/do/helpers/create-test-db";

// #306: `GET /tasks?blocked=1` and `GET /tasks?outcome=...` page through the
// real Worker route and DO router with exact totals, also for a credential
// restricted to some task types.

const SCHEMA = `schema_version = 1
[work_units.bug.fields.title]
type = "string"
[work_units.bug.fields.status]
type = "enum"
required = true
values = ["open", "done", "failed", "dropped"]
[work_units.bug.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done", "failed", "dropped"]
dependency_satisfied = ["done"]
[work_units.bug.lifecycle.outcomes]
failure = "failed"
abandoned = "dropped"
[work_units.story.fields.title]
type = "string"
[work_units.story.fields.status]
type = "enum"
required = true
values = ["open", "done"]
[work_units.story.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done"]
dependency_satisfied = ["done"]
`;

type Seed = {
  prefix: string;
  count: number;
  type: "bug" | "story";
  status: string;
  /** Predecessor that `blocks` every task in the group. */
  blockedBy?: string;
  archived?: boolean;
};

const ids = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`,
  );

// 300 tasks. Exactly 120 are open with an unsatisfied `blocks` predecessor.
const SEEDS: Seed[] = [
  // Predecessors: one still open, one done (dependency satisfied).
  { prefix: "gate-open", count: 1, type: "bug", status: "open" },
  { prefix: "gate-done", count: 1, type: "bug", status: "done" },
  // Blocked: 90 bugs + 30 stories waiting on the open predecessor.
  {
    prefix: "blocked-bug",
    count: 90,
    type: "bug",
    status: "open",
    blockedBy: "gate-open-001",
  },
  {
    prefix: "blocked-story",
    count: 30,
    type: "story",
    status: "open",
    blockedBy: "gate-open-001",
  },
  // Not blocked: the predecessor is done.
  {
    prefix: "cleared-bug",
    count: 20,
    type: "bug",
    status: "open",
    blockedBy: "gate-done-001",
  },
  // Not blocked: terminal (failed) despite the open predecessor.
  {
    prefix: "failed-blocked",
    count: 5,
    type: "bug",
    status: "failed",
    blockedBy: "gate-open-001",
  },
  // Not blocked: archived despite the open predecessor.
  {
    prefix: "archived-blocked",
    count: 5,
    type: "bug",
    status: "open",
    blockedBy: "gate-open-001",
    archived: true,
  },
  { prefix: "failed", count: 10, type: "bug", status: "failed" },
  { prefix: "dropped", count: 12, type: "bug", status: "dropped" },
  { prefix: "done", count: 8, type: "bug", status: "done" },
  { prefix: "free-bug", count: 59, type: "bug", status: "open" },
  { prefix: "free-story", count: 59, type: "story", status: "open" },
];

const BLOCKED_IDS = [...ids("blocked-bug", 90), ...ids("blocked-story", 30)];
const FAILED_OR_DROPPED = 5 + 10 + 12;

let db: TestDb;
let doApp: ReturnType<typeof createProjectRouter>;
const env = { ANALYTICS: { writeDataPoint: () => {} } } as unknown as Env;
const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

/**
 * Worker app over the in-process DO router. With a policy, the request carries
 * a scoped d1-token and runs through `capabilityMiddleware`, which forwards the
 * server-derived policy to the DO the same way production does.
 */
function workerApp(policy?: CredentialPolicy) {
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set(
      "tokenResult",
      policy
        ? {
            kind: "d1-token",
            projectId: "p1",
            name: "restricted",
            scopes: "scoped-v1",
            tokenId: "restricted",
            policy,
          }
        : {
            kind: "d1-token",
            projectId: "p1",
            name: "test",
            scopes: "full",
            tokenId: "test",
          },
    );
    c.set("projectId", "p1");
    c.set("principalId", "token:test");
    c.set("participantId", "test-participant");
    c.set("environment", {});
    c.set("doStub", {
      fetch: (request: Request) => doApp.fetch(request),
    } as DurableObjectStub);
    await next();
  });
  if (policy) app.use("*", capabilityMiddleware());
  app.route("/projects/p1/tasks", entities);
  return app;
}

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

  const opsDb = db.db as RouterDeps["db"];
  schemaOps.applySchema(opsDb, SCHEMA, "seed");
  const origin = {
    principalId: "seed",
    participantId: "seed",
    environment: { client_name: "test" },
    actor: "seed",
    source: "test",
  };
  for (const seed of SEEDS) {
    for (const id of ids(seed.prefix, seed.count)) {
      entityOps.create(
        opsDb,
        {
          id,
          type: seed.type,
          data: { title: `Work item ${id}`, status: seed.status },
          created_by: "seed",
        },
        1,
        origin,
      );
      if (seed.blockedBy)
        relationshipOps.insertEntityRelationship(
          opsDb,
          {
            from_id: seed.blockedBy,
            to_id: id,
            type: "blocks",
            schema_version: 1,
          },
          "seed",
        );
      if (seed.archived)
        db.sqlite
          .prepare("UPDATE entities SET archived = 1 WHERE id = ?")
          .run(id);
    }
  }
  // Every task shares one timestamp so only the id tie-break orders them.
  db.sqlite.exec("UPDATE entities SET created_at = 1, updated_at = 1");
});
afterEach(() => db.sqlite.close());

async function get<T>(
  path: string,
  app = workerApp(),
): Promise<{ status: number; body: T }> {
  const res = await app.request(
    `/projects/p1${path}`,
    undefined,
    env,
    executionCtx,
  );
  return { status: res.status, body: (await res.json()) as T };
}

async function walk(path: string, app = workerApp()) {
  const seen: string[] = [];
  const totals: number[] = [];
  let cursor: string | null | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const { status, body } = await get<PaginatedEntityListResponse>(
      `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      app,
    );
    expect(status).toBe(200);
    totals.push(body.total);
    seen.push(...body.entities.map((e) => e.id));
    cursor = body.next_cursor;
    if (!cursor) {
      expect(body.has_more).toBe(false);
      break;
    }
    expect(body.has_more).toBe(true);
  }
  return { seen, totals };
}

describe("task attention filters through Worker and DO", () => {
  it("seeds 300 tasks", async () => {
    const { body } = await get<PaginatedEntityListResponse>("/tasks?limit=1");
    expect(body.total).toBe(300);
  });

  it("pages every blocked task by cursor with an exact total on each page", async () => {
    const { seen, totals } = await walk("/tasks?blocked=1&limit=50");
    expect(totals).toEqual([120, 120, 120]);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen.slice().sort()).toEqual(BLOCKED_IDS.slice().sort());
  });

  it("combines blocked with a type filter", async () => {
    const { seen, totals } = await walk("/tasks?blocked=1&type=story&limit=50");
    expect(totals).toEqual([30]);
    expect(seen.slice().sort()).toEqual(ids("blocked-story", 30));
  });

  it("rejects a blocked cursor reused without the blocked filter", async () => {
    const first = await get<PaginatedEntityListResponse>(
      "/tasks?blocked=1&limit=50",
    );
    const { status, body } = await get<{ error: { code: string } }>(
      `/tasks?limit=50&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid-cursor");
  });

  it("counts failed and dropped tasks and names the declaring type", async () => {
    const { status, body } = await get<PaginatedEntityListResponse>(
      "/tasks?outcome=failure,abandoned&limit=1",
    );
    expect(status).toBe(200);
    expect(body.total).toBe(FAILED_OR_DROPPED);
    expect(body.entities).toHaveLength(1);
    expect(body.has_more).toBe(true);
    expect(body.scope?.outcome_types).toEqual(["bug"]);

    const failure = await get<PaginatedEntityListResponse>(
      "/tasks?outcome=failure&limit=100",
    );
    expect(failure.body.total).toBe(15);
    expect(failure.body.entities.every((e) => e.data.status === "failed")).toBe(
      true,
    );

    const { seen, totals } = await walk(
      "/tasks?outcome=abandoned,failure&limit=10",
    );
    expect(totals).toEqual([
      FAILED_OR_DROPPED,
      FAILED_OR_DROPPED,
      FAILED_OR_DROPPED,
    ]);
    expect(new Set(seen).size).toBe(FAILED_OR_DROPPED);
  });

  it("returns zero and no outcome types when no type declares the outcome", async () => {
    const { status, body } = await get<PaginatedEntityListResponse>(
      "/tasks?outcome=success",
    );
    expect(status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.entities).toEqual([]);
    expect(body.scope?.outcome_types).toEqual([]);

    // story declares no outcomes, so narrowing to it leaves nothing to match.
    const story = await get<PaginatedEntityListResponse>(
      "/tasks?outcome=failure&type=story",
    );
    expect(story.body.total).toBe(0);
    expect(story.body.scope?.outcome_types).toEqual([]);
  });

  it("omits outcome_types when no outcome filter is set", async () => {
    const { body } = await get<PaginatedEntityListResponse>(
      "/tasks?blocked=1&limit=1",
    );
    expect(body.scope).not.toHaveProperty("outcome_types");
  });

  it("rejects invalid filter values before reaching the DO", async () => {
    for (const query of ["outcome=bogus", "blocked=yes"]) {
      const { status, body } = await get<{ error: { code: string } }>(
        `/tasks?${query}`,
      );
      expect(status).toBe(400);
      expect(body.error.code).toBe("validation-error");
    }
  });

  describe("for a credential restricted to some task types", () => {
    const restricted = (task_types: string[]): CredentialPolicy => ({
      role: "viewer",
      capabilities: ["tasks:read"],
      restrictions: { task_types },
    });

    it("counts only blocked tasks of permitted types", async () => {
      const app = workerApp(restricted(["story"]));
      const { seen, totals } = await walk("/tasks?blocked=1&limit=20", app);
      expect(totals).toEqual([30, 30]);
      expect(seen.slice().sort()).toEqual(ids("blocked-story", 30));

      const scope = await get<PaginatedEntityListResponse>(
        "/tasks?blocked=1&limit=1",
        app,
      );
      expect(scope.body.scope?.restricted).toBe(true);
    });

    it("hides outcome types the credential cannot see", async () => {
      const storyOnly = await get<PaginatedEntityListResponse>(
        "/tasks?outcome=failure,abandoned",
        workerApp(restricted(["story"])),
      );
      expect(storyOnly.status).toBe(200);
      expect(storyOnly.body.total).toBe(0);
      expect(storyOnly.body.scope).toMatchObject({
        restricted: true,
        outcome_types: [],
      });

      const bugOnly = workerApp(restricted(["bug"]));
      const outcome = await get<PaginatedEntityListResponse>(
        "/tasks?outcome=failure,abandoned&limit=1",
        bugOnly,
      );
      expect(outcome.body.total).toBe(FAILED_OR_DROPPED);
      expect(outcome.body.scope?.outcome_types).toEqual(["bug"]);
      const blocked = await get<PaginatedEntityListResponse>(
        "/tasks?blocked=1&limit=1",
        bugOnly,
      );
      expect(blocked.body.total).toBe(90);
    });
  });
});
