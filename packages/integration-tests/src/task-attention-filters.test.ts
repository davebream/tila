import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { entityOps, relationshipOps, schemaOps } from "@tila/ops-sqlite";
import type {
  CredentialPolicy,
  PaginatedEntityListResponse,
} from "@tila/schemas";
import { Hono } from "hono";
import {
  RemoteBackend,
  type TaskListOptions,
  TilaClient,
  createNamespace,
  createTaskMethods,
} from "tila-sdk";
import {
  type TilaLocal,
  buildLocalResources,
  createTilaLocal,
} from "tila-sdk/local";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../worker/src/do/project-do-router";
import type { RouterDeps } from "../../worker/src/do/routes/types";
import { capabilityMiddleware } from "../../worker/src/middleware/capability";
import { errorHandler } from "../../worker/src/middleware/error";
import { entities } from "../../worker/src/routes/entities";
import type { Env, HonoVariables } from "../../worker/src/types";
import type { TestDb } from "../../worker/test/do/helpers/create-test-db";

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
let local: TilaLocal;
let directory: string;
let dbPath: string;
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

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "tila-task-filters-"));
  dbPath = join(directory, "project.db");
  local = await createTilaLocal({
    dbPath,
    artifactsPath: join(directory, "artifacts"),
    project: "p1",
    skipFilesystemCheck: true,
  });
  const handle = local.project.getDb() as TestDb["db"] & {
    $client: TestDb["sqlite"];
  };
  db = { db: handle, sqlite: handle.$client };
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
afterEach(() => {
  local.close();
  rmSync(directory, { recursive: true, force: true });
});

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

function sdkClient(app = workerApp()) {
  return new TilaClient({
    baseUrl: "https://tila.test",
    token: "test",
    fetch: async (input, init) =>
      app.request(new Request(input, init), undefined, env, executionCtx),
  });
}

describe("SDK task filter and page parity over HTTP, Node and Bun", () => {
  const cases: [TaskListOptions, number, string[] | undefined][] = [
    [{ blocked: true }, 120, undefined],
    [{ outcome: ["failure", "abandoned"] }, FAILED_OR_DROPPED, ["bug"]],
    [{ outcome: ["success"] }, 0, []],
    [{ type: "story", outcome: ["failure"] }, 0, []],
    [{ blocked: false }, 300, undefined],
    [{}, 300, undefined],
  ];

  it.each(cases)(
    "keeps ids, totals, ordering and scope for %j",
    async (filter, total, outcomeTypes) => {
      const remote = createTaskMethods(sdkClient(), "p1");
      const node = buildLocalResources(local.project, local.artifacts).tasks;
      const query = {
        ...filter,
        limit: "17",
        sort: "id" as const,
        order: "desc" as const,
      };
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const options = { ...query, cursor };
        const http = await remote.list(options);
        const embedded = await node.list(options);
        expect(embedded).toEqual(http);
        expect(http.total).toBe(total);
        expect(http.scope?.outcome_types).toEqual(outcomeTypes);
        expect(http.has_more).toBe(http.next_cursor !== null);
        seen.push(...http.entities.map((entity) => entity.id));
        cursor = http.next_cursor ?? undefined;
        pages++;
        expect(pages).toBeLessThan(25);
      } while (cursor);
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
      expect(seen).toEqual(seen.slice().sort().reverse());

      // The Bun adapter reads the exact same migrated project file and walks
      // every page in its own runtime, including the cursor/filter mismatch.
      const result = spawnSync(
        "bun",
        ["run", resolve(import.meta.dirname, "fixtures/bun-cross-runtime.ts")],
        {
          env: {
            ...process.env,
            OP: "task-filter-pages",
            DB: dbPath,
            QUERY: JSON.stringify(query),
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const bun = JSON.parse(result.stdout.trim());
      expect(bun.ids).toEqual(seen);
      expect(bun.totals).toEqual(Array(pages).fill(total));
      expect(bun.outcome_types).toEqual(outcomeTypes);
      if (total > 17) expect(bun.mismatch).toBe("invalid-cursor");
    },
  );

  it("preserves the array backend method and exposes real page metadata remotely", async () => {
    const backend = new RemoteBackend(sdkClient(), "p1");
    const filter = { blocked: true, limit: 11, archived: 0 as const };
    const page = await backend.listPage(filter);
    expect(await backend.list(filter)).toEqual(page.entities);
    expect(await local.project.listPage(filter)).toEqual(page);
    expect(await local.project.list(filter)).toEqual(page.entities);
    expect(page.total).toBe(120);
    expect(page.entities).toHaveLength(11);
    expect(page.scope).toEqual({ restricted: false, archived: "excluded" });
  });

  it("rejects cursor reuse with changed filters and cursor plus offset", async () => {
    const remote = createTaskMethods(sdkClient(), "p1");
    const node = buildLocalResources(local.project, local.artifacts).tasks;
    for (const tasks of [remote, node]) {
      const first = await tasks.list({ blocked: true, limit: "7" });
      const cursor = first.next_cursor ?? undefined;
      await expect(tasks.list({ limit: "7", cursor })).rejects.toMatchObject({
        code: "invalid-cursor",
      });
      await expect(
        tasks.list({ blocked: true, limit: "7", offset: "2", cursor }),
      ).rejects.toThrow();
      const outcome = await tasks.list({
        outcome: ["failure", "abandoned"],
        limit: "7",
      });
      await expect(
        tasks.list({
          outcome: ["failure"],
          limit: "7",
          cursor: outcome.next_cursor ?? undefined,
        }),
      ).rejects.toMatchObject({ code: "invalid-cursor" });
      // Reordering the same outcomes preserves the filter binding.
      expect(
        (
          await tasks.list({
            outcome: ["abandoned", "failure"],
            limit: "7",
            cursor: outcome.next_cursor ?? undefined,
          })
        ).total,
      ).toBe(FAILED_OR_DROPPED);
    }
  });

  it("validates outcome enums and empty lists in both SDK transports", async () => {
    const remote = createTaskMethods(sdkClient(), "p1");
    const node = buildLocalResources(local.project, local.artifacts).tasks;
    for (const tasks of [remote, node]) {
      for (const outcome of [[], ["bogus"], ["failure", ""]])
        await expect(
          tasks.list({ outcome: outcome as TaskListOptions["outcome"] }),
        ).rejects.toThrow();
    }
  });

  it("validates paging boundaries consistently over HTTP and Node/Bun adapters", async () => {
    const http = createTaskMethods(sdkClient(), "p1");
    const node = buildLocalResources(local.project, local.artifacts).tasks;
    const invalid = [
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      "9007199254740992",
      "",
      "1.0",
      " 2 ",
    ];
    for (const key of ["limit", "offset"] as const) {
      for (const value of [...invalid, ...(key === "limit" ? ["0"] : [])]) {
        expect(
          (await get(`/tasks?${key}=${encodeURIComponent(value)}`)).status,
        ).toBe(400);
        await expect(http.list({ [key]: value })).rejects.toThrow();
        await expect(node.list({ [key]: value })).rejects.toThrow();
      }
    }
    for (const key of ["limit", "offset"] as const)
      for (const value of [
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        ...(key === "limit" ? [0] : []),
      ])
        await expect(
          local.project.listPage({ [key]: value }),
        ).rejects.toThrow();
    expect(await node.list({ offset: "0", limit: "501" })).toEqual(
      await http.list({ offset: "0", limit: "501" }),
    );
    const zero = await node.list({ offset: "0", limit: "1" });
    expect(zero).toMatchObject({
      limit: 1,
      offset: 0,
      total: 300,
      has_more: true,
    });
    const exhausted = await node.list({ offset: "300", limit: "1" });
    expect(exhausted).toMatchObject({
      entities: [],
      total: 300,
      has_more: false,
      next_cursor: null,
    });
    const capped = await local.project.listPage({ limit: 501 });
    expect(capped.limit).toBe(500);

    const result = spawnSync(
      "bun",
      ["run", resolve(import.meta.dirname, "fixtures/bun-cross-runtime.ts")],
      {
        env: { ...process.env, OP: "task-filter-boundaries", DB: dbPath },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      rejected: 13,
      limit: 500,
      offset: 0,
      total: 300,
    });
  });

  it("pages namespaced mixed-type outcomes with each type prefixed and scope stripped", async () => {
    const namespacedDefinition = SCHEMA.replace("schema_version = 1", "")
      .replaceAll("work_units.bug", "work_units.tools_bug")
      .replaceAll("work_units.story", "work_units.tools_story");
    await local.project.applySchema({
      definition: `${SCHEMA}\n${namespacedDefinition}\n[work_units.tools_story.lifecycle.outcomes]\nfailure = "done"\n`,
      expected_revision: 1,
    });
    for (const [id, type, status] of [
      ["namespaced-a", "tools_bug", "failed"],
      ["namespaced-b", "tools_story", "done"],
      ["namespaced-c", "tools_bug", "dropped"],
      ["namespaced-d", "tools_story", "done"],
      ["namespaced-e", "tools_bug", "failed"],
    ])
      await local.project.create({
        id,
        type,
        data: { status },
        created_by: "test",
      });
    const tasks = createNamespace(sdkClient(), "p1", "tools").tasks;
    const query = {
      type: "bug,story",
      outcome: ["failure", "abandoned"] as const,
      sort: "id" as const,
      limit: "2",
    };
    const first = await tasks.list({ ...query, outcome: [...query.outcome] });
    expect(first).toMatchObject({
      total: 5,
      has_more: true,
      scope: { outcome_types: ["bug", "story"] },
    });
    expect(first.entities.map((e) => [e.id, e.type])).toEqual([
      ["namespaced-a", "bug"],
      ["namespaced-b", "story"],
    ]);
    const cursor = first.next_cursor ?? undefined;
    const second = await tasks.list({
      ...query,
      outcome: ["abandoned", "failure"],
      cursor,
    });
    expect(second).toMatchObject({
      total: 5,
      has_more: true,
      scope: { outcome_types: ["bug", "story"] },
    });
    const last = await tasks.list({
      ...query,
      outcome: [...query.outcome],
      cursor: second.next_cursor ?? undefined,
    });
    expect(last).toMatchObject({
      total: 5,
      has_more: false,
      next_cursor: null,
      scope: { outcome_types: ["bug", "story"] },
    });
    expect(
      [...first.entities, ...second.entities, ...last.entities].map(
        (e) => e.id,
      ),
    ).toEqual([
      "namespaced-a",
      "namespaced-b",
      "namespaced-c",
      "namespaced-d",
      "namespaced-e",
    ]);
    await expect(
      tasks.list({
        ...query,
        type: "bug",
        outcome: [...query.outcome],
        cursor,
      }),
    ).rejects.toMatchObject({ code: "invalid-cursor" });
  });

  it("retains HTTP scope restrictions in SDK envelopes and remote backend pages", async () => {
    const client = sdkClient(
      workerApp({
        role: "viewer",
        capabilities: ["tasks:read"],
        restrictions: { task_types: ["story"] },
      }),
    );
    const tasks = createTaskMethods(client, "p1");
    const first = await tasks.list({ blocked: true, limit: "13" });
    const second = await tasks.list({
      blocked: true,
      limit: "13",
      cursor: first.next_cursor ?? undefined,
    });
    expect(first.total).toBe(30);
    expect(second.total).toBe(30);
    expect(second.entities.every((e) => e.type === "story")).toBe(true);
    expect(second.scope).toMatchObject({ restricted: true });
    const none = await new RemoteBackend(client, "p1").listPage({
      outcome: ["failure", "abandoned"],
      limit: 3,
    });
    expect(none).toMatchObject({
      entities: [],
      total: 0,
      next_cursor: null,
      has_more: false,
      scope: { restricted: true, outcome_types: [] },
    });
  });

  it("keeps compact projection compatibility while preserving exact metadata", async () => {
    const query = { outcome: ["failure"] as const, limit: "2", compact: true };
    const http = await createTaskMethods(sdkClient(), "p1").list({
      ...query,
      outcome: [...query.outcome],
    });
    const embedded = await buildLocalResources(
      local.project,
      local.artifacts,
    ).tasks.list({ ...query, outcome: [...query.outcome] });
    expect(http.entities.map((e) => e.id)).toEqual(
      embedded.entities.map((e) => e.id),
    );
    expect(http.entities[0]).toHaveProperty("title");
    expect(http.entities[0]).not.toHaveProperty("data");
    expect(embedded.entities[0]).toHaveProperty("data");
    expect(http.total).toBe(15);
    const { entities: _httpEntities, ...httpMetadata } = http;
    const { entities: _embeddedEntities, ...embeddedMetadata } = embedded;
    expect(embeddedMetadata).toEqual(httpMetadata);
  });
});
