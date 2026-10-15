import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { entityOps, schemaOps } from "@tila/ops-sqlite";
import type {
  CredentialPolicy,
  PaginatedEntityListResponse,
} from "@tila/schemas";
import { Hono } from "hono";
import {
  RemoteBackend,
  type TaskListOptions,
  TilaClient,
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

// #525: `GET /tasks?state=` and `sort=state` read each task's state from the
// field its own type's lifecycle names, through the real Worker route and DO
// router, and the SDK's HTTP and local transports agree with them.

/**
 * `bug` and `story` keep their state in fields that are not `status`; `chore`
 * declares no lifecycle, so its state is `status`.
 */
const SCHEMA = `schema_version = 1
[work_units.bug.fields.title]
type = "string"
[work_units.bug.fields.phase]
type = "enum"
values = ["new", "in-review", "fixed"]
[work_units.bug.lifecycle]
field = "phase"
dispatchable = ["new"]
terminal = ["fixed"]
dependency_satisfied = ["fixed"]
[work_units.story.fields.title]
type = "string"
[work_units.story.fields.stage]
type = "enum"
values = ["todo", "in-review", "done"]
[work_units.story.lifecycle]
field = "stage"
dispatchable = ["todo"]
terminal = ["done"]
dependency_satisfied = ["done"]
[work_units.chore.fields.title]
type = "string"
[work_units.chore.fields.status]
type = "string"
`;

type Kind = "bug" | "story" | "chore";

const KINDS: Record<Kind, { field: string; pool: string[] }> = {
  bug: { field: "phase", pool: ["new", "in-review", "fixed"] },
  story: { field: "stage", pool: ["todo", "in-review", "done"] },
  chore: { field: "status", pool: ["open", "in-review", "closed"] },
};

type Row = { id: string; type: Kind; state: string | null };

// 120 tasks, 40 per type. Every task also carries a decoy `status` of
// `in-review`, which is the state of a chore only.
const ROWS: Row[] = Array.from({ length: 120 }, (_, i) => {
  const type = (["bug", "story", "chore"] as const)[i % 3];
  const { pool } = KINDS[type];
  return {
    id: `t-${String((i * 11) % 120).padStart(3, "0")}`,
    type,
    state: i % 9 === 0 ? null : pool[Math.floor(i / 3) % pool.length],
  };
});

const withState = (...states: string[]) =>
  ROWS.filter((r) => r.state !== null && states.includes(r.state)).map(
    (r) => r.id,
  );

function stateOrder(order: "asc" | "desc"): string[] {
  const sorted = ROWS.slice().sort((a, b) => {
    if (a.state !== b.state) {
      if (a.state === null) return -1;
      if (b.state === null) return 1;
      return a.state < b.state ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });
  return (order === "desc" ? sorted.reverse() : sorted).map((r) => r.id);
}

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
  directory = mkdtempSync(join(tmpdir(), "tila-task-state-"));
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
  for (const row of ROWS) {
    entityOps.create(
      opsDb,
      {
        id: row.id,
        type: row.type,
        data: {
          title: `Work item ${row.id}`,
          // Never the state of a bug or story, and the state of a chore only
          // through its own `status` field below.
          ...(row.type === "chore" ? {} : { status: "in-review" }),
          ...(row.state === null ? {} : { [KINDS[row.type].field]: row.state }),
        },
        created_by: "seed",
      },
      1,
      origin,
    );
  }
  // Shared timestamps leave the id tie-break as the only other ordering.
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
  for (let guard = 0; guard < 30; guard++) {
    const { status, body } = await get<PaginatedEntityListResponse>(
      `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      app,
    );
    expect(status).toBe(200);
    totals.push(body.total);
    seen.push(...body.entities.map((e) => e.id));
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  return { seen, totals };
}

describe("task state filter and sort through Worker and DO", () => {
  it("seeds 120 tasks", async () => {
    const { body } = await get<PaginatedEntityListResponse>("/tasks?limit=1");
    expect(body.total).toBe(120);
  });

  it("matches in-review across types whose lifecycle field is not status", async () => {
    const expected = withState("in-review");
    const { body } = await get<PaginatedEntityListResponse>(
      "/tasks?state=in-review&limit=500",
    );
    expect(body.total).toBe(expected.length);
    expect(body.entities.map((e) => e.id).sort()).toEqual(expected.sort());
    expect(new Set(body.entities.map((e) => e.type))).toEqual(
      new Set(["bug", "story", "chore"]),
    );
    // What the State column shows is what matched: the type's own field.
    for (const entity of body.entities)
      expect(entity.data[KINDS[entity.type as Kind].field]).toBe("in-review");
  });

  it("leaves the status filter reading data.status exactly as before", async () => {
    const { body } = await get<PaginatedEntityListResponse>(
      "/tasks?status=in-review&limit=500",
    );
    // Every bug and story carries the decoy `status`; a chore only when its
    // state is in-review.
    const expected = ROWS.filter(
      (r) => r.type !== "chore" || r.state === "in-review",
    ).map((r) => r.id);
    expect(body.entities.map((e) => e.id).sort()).toEqual(expected.sort());
    expect(body.total).not.toBe(withState("in-review").length);
  });

  it("pages a state filter by cursor with an exact total on every page", async () => {
    const expected = withState("in-review", "done");
    const { seen, totals } = await walk(
      "/tasks?state=in-review,done&limit=10&sort=id&order=desc",
    );
    expect(totals.every((t) => t === expected.length)).toBe(true);
    expect(totals.length).toBeGreaterThan(2);
    expect(seen).toEqual(expected.slice().sort().reverse());
  });

  for (const order of ["asc", "desc"] as const)
    it(`sorts by state across types, stable over pages (${order})`, async () => {
      const { seen, totals } = await walk(
        `/tasks?sort=state&order=${order}&limit=17`,
      );
      expect(totals).toEqual(Array(totals.length).fill(120));
      expect(seen).toEqual(stateOrder(order));
    });

  it("sorts a filtered list by state and keeps the filter on every page", async () => {
    const expected = stateOrder("asc").filter((id) =>
      withState("in-review", "fixed").includes(id),
    );
    const { seen } = await walk(
      "/tasks?state=in-review,fixed&sort=state&order=asc&limit=7",
    );
    expect(seen).toEqual(expected);
  });

  it("ends a cursor when the state filter or sort changes", async () => {
    const first = await get<PaginatedEntityListResponse>(
      "/tasks?state=in-review&sort=state&limit=5",
    );
    const cursor = encodeURIComponent(first.body.next_cursor ?? "");
    expect(cursor).not.toBe("");
    for (const query of [
      "state=done&sort=state",
      "sort=state",
      "state=in-review",
      "state=in-review&sort=status",
      "state=in-review&sort=state&order=desc",
    ]) {
      const { status, body } = await get<{ error: { code: string } }>(
        `/tasks?${query}&limit=5&cursor=${cursor}`,
      );
      expect(status, query).toBe(400);
      expect(body.error.code).toBe("invalid-cursor");
    }
    const same = await get<PaginatedEntityListResponse>(
      `/tasks?state=in-review&sort=state&limit=5&cursor=${cursor}`,
    );
    expect(same.status).toBe(200);
    expect(same.body.entities).toHaveLength(5);
  });

  it("rejects blank state lists before reaching the DO", async () => {
    for (const state of ["", ",", "in-review,", ",done", "%20", "done,%20"]) {
      const { status, body } = await get<{ error: { code: string } }>(
        `/tasks?state=${state}`,
      );
      expect(status, state).toBe(400);
      expect(body.error.code).toBe("validation-error");
    }
    expect((await get("/tasks?sort=bogus")).status).toBe(400);
    expect((await get("/tasks?sort=state")).status).toBe(200);
  });

  it("limits a restricted credential to the types it may read", async () => {
    const policy: CredentialPolicy = {
      role: "viewer",
      capabilities: ["tasks:read"],
      restrictions: { task_types: ["story"] },
    };
    const expected = ROWS.filter(
      (r) => r.type === "story" && r.state === "in-review",
    ).map((r) => r.id);
    const { seen, totals } = await walk(
      "/tasks?state=in-review&sort=state&limit=5",
      workerApp(policy),
    );
    expect(seen.slice().sort()).toEqual(expected.sort());
    expect(totals.every((t) => t === expected.length)).toBe(true);
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

describe("SDK state filter and sort parity over HTTP, Node and Bun", () => {
  const cases: [TaskListOptions, string[]][] = [
    [{ state: ["in-review"] }, withState("in-review")],
    [
      { state: ["done", "fixed"], sort: "state", order: "desc" },
      stateOrder("desc").filter((id) =>
        withState("done", "fixed").includes(id),
      ),
    ],
    [{ sort: "state", order: "asc" }, stateOrder("asc")],
    [
      { state: ["in-review"], type: "story" },
      ROWS.filter((r) => r.type === "story" && r.state === "in-review").map(
        (r) => r.id,
      ),
    ],
  ];
  /** Only sort-only lists cover every task; the others match `expected`. */
  const totalFor = (filter: TaskListOptions, expected: string[]) =>
    filter.state || filter.type ? expected.length : ROWS.length;

  it.each(cases)(
    "keeps ids, totals and ordering for %j",
    async (filter, expected) => {
      const remote = createTaskMethods(sdkClient(), "p1");
      const node = buildLocalResources(local.project, local.artifacts).tasks;
      const query = { ...filter, limit: "17" };
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const options = { ...query, cursor };
        const http = await remote.list(options);
        const embedded = await node.list(options);
        expect(embedded).toEqual(http);
        expect(http.total).toBe(totalFor(filter, expected));
        seen.push(...http.entities.map((entity) => entity.id));
        cursor = http.next_cursor ?? undefined;
        pages++;
        expect(pages).toBeLessThan(25);
      } while (cursor);
      if (filter.sort === "state") expect(seen).toEqual(expected);
      else expect(seen.slice().sort()).toEqual(expected.slice().sort());

      // The Bun adapter reads the same migrated project file in its own
      // runtime; the fixture also replays page one under a flipped filter.
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
      expect(bun.totals).toEqual(Array(pages).fill(totalFor(filter, expected)));
      if (expected.length > 17) expect(bun.mismatch).toBe("invalid-cursor");
    },
  );

  it("exposes the state filter on the backend page method", async () => {
    const backend = new RemoteBackend(sdkClient(), "p1");
    const filter = { state: ["in-review"], sort: "state" as const, limit: 9 };
    const page = await backend.listPage(filter);
    expect(await local.project.listPage(filter)).toEqual(page);
    expect(page.total).toBe(withState("in-review").length);
    expect(page.entities).toHaveLength(9);
  });

  it("rejects cursor reuse across state changes in both transports", async () => {
    const remote = createTaskMethods(sdkClient(), "p1");
    const node = buildLocalResources(local.project, local.artifacts).tasks;
    for (const tasks of [remote, node]) {
      const first = await tasks.list({
        state: ["in-review"],
        sort: "state",
        limit: "7",
      });
      const cursor = first.next_cursor ?? undefined;
      expect(cursor).toBeDefined();
      for (const other of [
        { state: ["done"], sort: "state" as const },
        { sort: "state" as const },
        { state: ["in-review"] },
      ])
        await expect(
          tasks.list({ ...other, limit: "7", cursor }),
        ).rejects.toMatchObject({ code: "invalid-cursor" });
      // Order and repeats of the list do not change its binding.
      const again = await tasks.list({
        state: ["in-review", "in-review"],
        sort: "state",
        limit: "7",
        cursor,
      });
      expect(again.entities).toHaveLength(7);
    }
  });

  it("validates state lists in both SDK transports before sending", async () => {
    const remote = createTaskMethods(sdkClient(), "p1");
    const node = buildLocalResources(local.project, local.artifacts).tasks;
    for (const tasks of [remote, node])
      for (const state of [[], [""], ["  "], ["done", ""]])
        await expect(
          tasks.list({ state: state as TaskListOptions["state"] }),
        ).rejects.toThrow();
  });
});
