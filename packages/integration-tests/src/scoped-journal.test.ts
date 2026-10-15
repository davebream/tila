import { type ReplaySnapshot, completeReplay } from "@tila/core";
import { journalVisibilityOps } from "@tila/ops-sqlite";
import { type CredentialPolicy, JournalEventKindSchema } from "@tila/schemas";
import { Hono } from "hono";
import { TilaClient, createJournalMethods, isTilaApiError } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../worker/src/do/project-do-router";
import type { RouterDeps } from "../../worker/src/do/routes/types";
import { journalArchiveObjects } from "../../worker/src/lib/journal-archive";
import { capabilityMiddleware } from "../../worker/src/middleware/capability";
import { errorHandler } from "../../worker/src/middleware/error";
import { continuity } from "../../worker/src/routes/continuity";
import { journal } from "../../worker/src/routes/journal";
import type { Env, HonoVariables } from "../../worker/src/types";
import {
  type TestDb,
  createTestDb,
} from "../../worker/test/do/helpers/create-test-db";

// Scoped journal reads through the Worker middleware and routes, the real
// Durable Object router, real event emitters and the SDK client. What each
// policy may see is written down per action while seeding, so the expectation
// is independent of the predicate under test.

const PROJECT = "p1";
const DAY = 86_400_000;
const WIDE = [
  "journal:read",
  "journal:append",
  "tasks:read",
  "tasks:write",
  "claims:read",
  "claims:acquire",
  "claims:renew",
  "claims:release",
  "records:read",
  "records:write",
  "summary:read",
  "signals:read",
  "artifacts:read",
] as const;
const ANSWER = [{ type: "answer", key_prefixes: ["a1"] }];
const QUESTION = [{ type: "question", key_prefixes: ["q1"] }];
const participant = { role: "participant" as const, capabilities: [...WIDE] };

const POLICIES: Record<string, CredentialPolicy> = {
  // Scoped but not namespace-restricted: reads the journal as it always did.
  plain: { ...participant },
  alpha: { ...participant, restrictions: { task_types: ["alpha"] } },
  split: {
    ...participant,
    restrictions: {
      task_types: ["alpha"],
      records_read: ANSWER,
      records_write: QUESTION,
    },
  },
  legacy: {
    ...participant,
    restrictions: { task_types: ["alpha"], records: [...QUESTION, ...ANSWER] },
  },
  "write-only": {
    ...participant,
    restrictions: { records_write: QUESTION },
  },
  viewer: {
    role: "viewer",
    capabilities: ["journal:read", "tasks:read", "claims:read", "records:read"],
    restrictions: { task_types: ["alpha"] },
  },
  "no-journal-read": {
    ...participant,
    capabilities: WIDE.filter((cap) => cap !== "journal:read"),
    restrictions: { task_types: ["alpha"] },
  },
  "no-claims-read": {
    ...participant,
    capabilities: WIDE.filter((cap) => cap !== "claims:read"),
    restrictions: { task_types: ["alpha"] },
  },
};
const RESTRICTED = [
  "alpha",
  "split",
  "legacy",
  "write-only",
  "viewer",
] as const;

const IDENT = {
  principal_id: "seed",
  participant_id: "seed",
  environment: {},
  actor: "seed",
  created_by: "seed",
};

class FakeBucket {
  objects = new Map<
    string,
    { body: string; customMetadata: Record<string, string> }
  >();
  listed: string[] = [];
  async list(options: { prefix?: string }) {
    this.listed.push(options.prefix ?? "");
    return {
      objects: [...this.objects]
        .filter(([key]) => key.startsWith(options.prefix ?? ""))
        .map(([key, value]) => ({
          key,
          customMetadata: value.customMetadata,
        })),
      truncated: false,
    };
  }
  async get(key: string) {
    const value = this.objects.get(key);
    return value ? { body: new Response(value.body).body } : null;
  }
}

let db: TestDb;
let deps: RouterDeps;
let doApp: ReturnType<typeof createProjectRouter>;
let app: Hono<{ Bindings: Env; Variables: HonoVariables }>;
let bucket: FakeBucket;
const env = { ANALYTICS: { writeDataPoint: () => {} } } as unknown as Env;
const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

/** seq -> the policies whose reader must see that event. */
const visibleTo = new Map<number, Set<string>>();
const maxSeq = () =>
  (
    db.sqlite
      .prepare("SELECT coalesce(max(seq), 0) AS m FROM journal")
      .get() as {
      m: number;
    }
  ).m;
/** Run an action and record who may see every event it produced. */
async function act<T>(
  who: readonly string[] | "all",
  run: () => Promise<T> | T,
): Promise<T> {
  const before = maxSeq();
  const result = await run();
  const names = who === "all" ? Object.keys(POLICIES) : [...who];
  for (let seq = before + 1; seq <= maxSeq(); seq++)
    visibleTo.set(seq, new Set(names));
  return result;
}
const expected = (policy: string) =>
  [...visibleTo]
    .filter(([, who]) => who.has(policy))
    .map(([seq]) => seq)
    .sort((a, b) => a - b);
const everySeq = () => [...visibleTo.keys()].sort((a, b) => a - b);

function json(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
async function seed<T = Record<string, unknown>>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const res = await doApp.request(path, json({ ...body, ...IDENT }));
  const parsed = (await res.json()) as T;
  expect(res.status, `${path} ${JSON.stringify(parsed)}`).toBeLessThan(300);
  return parsed;
}
function raw(kind: string, resource: string, data: unknown = {}): void {
  db.sqlite
    .prepare(
      "INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data) VALUES (?, ?, ?, 'raw', 'raw', '{}', '', ?)",
    )
    .run(Date.now(), kind, resource, JSON.stringify(data));
}

/** Every event of the project, by who may read it (see `act`). */
async function seedProject(): Promise<void> {
  // Readers of a task of type alpha, and of one whose type or parent is not.
  const ALL_TASKS = [
    "plain",
    "alpha",
    "split",
    "legacy",
    "viewer",
    "write-only",
  ];
  const ONLY_UNRESTRICTED_TYPES = ["plain", "write-only"];

  await act(ALL_TASKS, () =>
    seed("/entity/create", { id: "a-1", type: "alpha", data: {} }),
  );
  await act(ONLY_UNRESTRICTED_TYPES, () =>
    seed("/entity/create", { id: "b-1", type: "beta", data: {} }),
  );
  await act(ALL_TASKS, () =>
    seed("/entity/create", {
      id: "a-child",
      type: "alpha",
      data: { parent_id: "a-1" },
    }),
  );
  // A permitted type under a parent the typed credentials may not read.
  await act(ONLY_UNRESTRICTED_TYPES, () =>
    seed("/entity/create", {
      id: "a-under-b",
      type: "alpha",
      data: { parent_id: "b-1" },
    }),
  );

  const claim = await act(ALL_TASKS, () =>
    seed<{ fence: number }>("/coord/acquire", {
      resource: "alpha:a-1",
      mode: "exclusive",
      ttl_ms: 60_000,
    }),
  );
  await act(ALL_TASKS, () =>
    seed("/entity/update/a-1", { data: { note: "x" }, fence: claim.fence }),
  );
  await act(ALL_TASKS, () =>
    seed("/coord/renew", {
      resource: "alpha:a-1",
      fence: claim.fence,
      ttl_ms: 60_000,
    }),
  );
  await act(ALL_TASKS, () =>
    seed("/coord/release", { resource: "alpha:a-1", fence: claim.fence }),
  );
  await act(ONLY_UNRESTRICTED_TYPES, () =>
    seed("/coord/acquire", {
      resource: "beta:b-1",
      mode: "exclusive",
      ttl_ms: 60_000,
    }),
  );
  await act(["plain"], () =>
    seed("/coord/acquire", {
      resource: "deploy-lock",
      mode: "exclusive",
      ttl_ms: 60_000,
    }),
  );

  // Records: the answer in a1/, a question in q1/, and an answer outside it.
  const RECORDS_UNRESTRICTED = ["plain", "alpha", "viewer"];
  await act([...RECORDS_UNRESTRICTED, "split", "legacy"], () =>
    seed("/record/answer/create", { key: "a1/x", value: { n: 1 } }),
  );
  const question = await act([...RECORDS_UNRESTRICTED, "legacy"], () =>
    seed<{ fence: number }>("/record/question/create", {
      key: "q1/old",
      value: { n: 1 },
    }),
  );
  await act(RECORDS_UNRESTRICTED, () =>
    seed("/record/answer/create", { key: "other/z", value: { n: 1 } }),
  );
  await act([...RECORDS_UNRESTRICTED, "split", "legacy"], () =>
    seed("/record/answer/a1/x/put", { value: { n: 2 } }),
  );
  const archived = await act([...RECORDS_UNRESTRICTED, "legacy"], () =>
    seed<{ fence: number }>("/record/question/q1/old/archive", {
      fence: question.fence,
    }),
  );
  await act([...RECORDS_UNRESTRICTED, "legacy"], () =>
    seed("/record/question/q1/old/unarchive", { fence: archived.fence }),
  );
  // A claim on a record is a read of that record's namespace side.
  await act([...RECORDS_UNRESTRICTED, "split", "legacy"], () =>
    seed("/coord/acquire", {
      resource: "record:answer/a1/x",
      mode: "exclusive",
      ttl_ms: 60_000,
    }),
  );
  await act([...RECORDS_UNRESTRICTED, "legacy"], () =>
    seed("/coord/acquire", {
      resource: "record:question/q1/old",
      mode: "exclusive",
      ttl_ms: 60_000,
    }),
  );

  // A swept lease expiry is the one allowlisted event that carries a payload.
  await act(ALL_TASKS, () =>
    seed("/coord/acquire", {
      resource: "alpha:a-child",
      mode: "exclusive",
      ttl_ms: 60_000,
    }),
  );
  // The sweep expires every claim still open, so each expiry is accounted for
  // by the resource it names.
  await act(ALL_TASKS, async () => {
    db.sqlite.prepare("UPDATE claims SET expires_at = 1").run();
    await seed("/sweep");
  });
  const sweptResources = new Map(
    (
      db.sqlite
        .prepare(
          "SELECT seq, resource FROM journal WHERE kind = 'claim.expired'",
        )
        .all() as { seq: number; resource: string }[]
    ).map((r) => [r.seq, r.resource]),
  );
  for (const [seq, resource] of sweptResources) {
    const who = resource.startsWith("alpha:")
      ? ALL_TASKS
      : resource.startsWith("beta:")
        ? ONLY_UNRESTRICTED_TYPES
        : resource === "record:answer/a1/x"
          ? [...RECORDS_UNRESTRICTED, "split", "legacy"]
          : resource === "record:question/q1/old"
            ? [...RECORDS_UNRESTRICTED, "legacy"]
            : ["plain"];
    visibleTo.set(seq, new Set(who));
  }

  // Everything else the journal holds is hidden from restricted readers, even
  // on a resource they could read, or with a payload that reaches one they
  // could not.
  await act(["plain"], () => {
    for (const kind of JournalEventKindSchema.options) {
      if (/^(entity|claim|record)\.[a-z]+$/.test(kind)) continue;
      raw(kind, "a-1");
    }
    raw("entity.updated", "a-1", { parent_id: "b-1" });
    raw("entity.updated", "a-1", { nested: { to: "b-1" } });
    raw("claim.acquired", "alpha:b-1");
    raw("record.created", "record:/a1/x");
    raw("record.created", "answer/a1/x");
    raw("claim.acquired", "record:answer");
    raw("entity.created", "alpha:a-1");
    raw("entity.future", "a-1");
    raw("custom.reported", "project", { event_name: "pipeline.done" });
  });
}

beforeEach(async () => {
  visibleTo.clear();
  resourceOf.clear();
  bucket = new FakeBucket();
  db = createTestDb();
  deps = {
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
    const name = (c.req.header("Authorization") ?? "Bearer plain").slice(7);
    const policy = POLICIES[name];
    if (!policy) return c.json({ error: `unknown test policy ${name}` }, 500);
    c.set("tokenResult", {
      kind: "d1-token",
      projectId: PROJECT,
      name,
      tokenId: name,
      scopes: "scoped-v1",
      policy,
    });
    c.set("projectId", PROJECT);
    c.set("principalId", `token:${name}`);
    c.set("participantId", `participant-${name}`);
    c.set("environment", {});
    c.set("doStub", {
      fetch: (request: Request) => doApp.fetch(request),
    } as DurableObjectStub);
    await next();
  });
  app.use("*", capabilityMiddleware());
  app.route("/projects/:projectId", continuity);
  app.route("/projects/:projectId/journal", journal);
  await seedProject();
  for (const row of db.sqlite
    .prepare("SELECT seq, resource FROM journal")
    .all() as { seq: number; resource: string }[])
    resourceOf.set(row.seq, row.resource);
  deps.artifacts = bucket as unknown as R2Bucket;
});
afterEach(() => db.sqlite.close());

function call(
  policy: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> | Response {
  return app.request(
    `/projects/${PROJECT}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${policy}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    executionCtx,
  );
}
type Listed = {
  ok: boolean;
  events: { seq: number; kind: string; resource: string }[];
  archived?: boolean;
  lastArchivedSeq?: number | null;
};
async function list(policy: string, query = "after_seq=0&limit=1000") {
  const res = await call(policy, "GET", `/journal?${query}`);
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as Listed;
}
type Page = {
  ok: true;
  events: { seq: number; kind: string; resource: string }[];
  next_after_seq: number;
  through_seq: number;
  has_more: boolean;
};
async function replayAll(policy: string, limit: number): Promise<Page[]> {
  const pages: Page[] = [];
  let after = 0;
  let through: number | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const res = await call(
      policy,
      "GET",
      `/journal/replay?after_seq=${after}&limit=${limit}${
        through === undefined ? "" : `&through_seq=${through}`
      }`,
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const page = JSON.parse(text) as Page;
    pages.push(page);
    through = page.through_seq;
    after = page.next_after_seq;
    if (!page.has_more) break;
  }
  return pages;
}
function sdkAs(policy: string) {
  const client = new TilaClient({
    baseUrl: "http://tila.test",
    token: policy,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url,
      );
      return app.request(
        `${url.pathname}${url.search}`,
        {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            Authorization: `Bearer ${policy}`,
          },
        },
        env,
        executionCtx,
      );
    }) as typeof fetch,
  });
  return createJournalMethods(client, PROJECT);
}
/** The resource every event names, kept before any of it is archived. */
const resourceOf = new Map<number, string>();
/**
 * Resources named only by events `policy` may not read, found as whole JSON
 * strings in `text`. A resource a readable event also names is not hidden.
 */
function leaked(text: string, policy: string): string[] {
  const readable = new Set(expected(policy));
  const shown = new Set<string>();
  const hidden = new Set<string>();
  for (const [seq, resource] of resourceOf)
    (readable.has(seq) ? shown : hidden).add(resource);
  return [...hidden].filter(
    (resource) =>
      !shown.has(resource) && text.includes(JSON.stringify(resource)),
  );
}

describe("the seeded journal", () => {
  it("covers every allowlisted kind through a real emitter", () => {
    const kinds = new Set(
      (
        db.sqlite
          .prepare(
            "SELECT DISTINCT kind FROM journal WHERE principal_id != 'raw'",
          )
          .all() as { kind: string }[]
      ).map((r) => r.kind),
    );
    for (const kind of [
      "entity.created",
      "entity.updated",
      "claim.acquired",
      "claim.renewed",
      "claim.released",
      "claim.expired",
      "record.created",
      "record.updated",
      "record.archived",
      "record.unarchived",
    ])
      expect(kinds, kind).toContain(kind);
  });
});

describe("GET /journal", () => {
  it.each(RESTRICTED)(
    "%s sees exactly the events it may read, live",
    async (policy) => {
      const body = await list(policy);
      expect(body.events.map((e) => e.seq)).toEqual(expected(policy));
      expect(body.archived).toBe(false);
      expect(leaked(JSON.stringify(body), policy)).toEqual([]);
      for (const e of body.events)
        expect(e.kind).toMatch(/^(entity|claim|record)\./);
    },
  );

  it("splits record visibility by side: write-only sees none, legacy keeps the one list", async () => {
    const kinds = async (policy: string) =>
      (await list(policy)).events.filter((e) => e.kind.startsWith("record."));
    expect(await kinds("write-only")).toEqual([]);
    const split = await kinds("split");
    expect(split.map((e) => e.resource)).toEqual([
      "record:answer/a1/x",
      "record:answer/a1/x",
    ]);
    const legacy = new Set((await kinds("legacy")).map((e) => e.resource));
    expect(legacy).toEqual(
      new Set(["record:answer/a1/x", "record:question/q1/old"]),
    );
  });

  it("fills a page with exactly limit visible events and resumes after the cursor", async () => {
    const all = expected("split");
    const tail = await list("split", "limit=4");
    expect(tail.events.map((e) => e.seq)).toEqual(all.slice(-4).reverse());

    const seen: number[] = [];
    let after = 0;
    for (let guard = 0; guard < 50; guard++) {
      const page = await list("split", `after_seq=${after}&limit=4`);
      seen.push(...page.events.map((e) => e.seq));
      if (page.events.length < 4) break;
      expect(page.events).toHaveLength(4);
      after = page.events[3].seq;
    }
    expect(seen).toEqual(all);
  });

  it("selects nothing with a hidden kind or a report selector", async () => {
    for (const query of [
      "kind=custom.reported",
      "kind=schema.applied&after_seq=0",
      "event_name=pipeline.done",
      "correlation_id=run-1",
      "resource=project",
    ])
      expect((await list("alpha", query)).events, query).toEqual([]);
    expect(
      (await list("alpha", "kind=entity.created&after_seq=0")).events.map(
        (e) => e.resource,
      ),
    ).toEqual(["a-1", "a-child"]);
  });

  it("refuses an out-of-range limit or cursor instead of clamping it", async () => {
    for (const query of [
      "limit=1001",
      "limit=0",
      "limit=-5",
      "limit=abc",
      "limit=2.5",
      "after_seq=-1",
      "after_seq=abc",
    ]) {
      const res = await call("alpha", "GET", `/journal?${query}`);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "validation-error" },
      });
    }
    // The cap is for restricted readers; an unrestricted list is unchanged.
    expect((await list("plain", "limit=1001")).events.length).toBe(
      everySeq().length,
    );
  });

  it("denies a restricted credential without the journal capability", async () => {
    for (const policy of ["no-journal-read"])
      for (const path of [
        "/journal",
        "/journal/replay?after_seq=0",
        "/journal/cursor",
      ])
        expect((await call(policy, "GET", path)).status, path).toBe(403);
  });

  it("shows claim events only to a credential that may read claims", async () => {
    const body = await list("no-claims-read");
    expect(body.events.length).toBeGreaterThan(0);
    for (const e of body.events)
      expect(e.kind.startsWith("claim.")).toBe(false);
  });
});

describe("GET /journal/replay", () => {
  it.each(RESTRICTED)(
    "%s pages exactly the readable events with visible has_more semantics",
    async (policy) => {
      const want = expected(policy);
      const high = maxSeq();
      for (const limit of [1, 3, 200]) {
        const pages = await replayAll(policy, limit);
        const seqs = pages.flatMap((p) => p.events.map((e) => e.seq));
        expect(seqs, `limit ${limit}`).toEqual(want);
        for (const page of pages) {
          expect(page.through_seq).toBe(high);
          expect(page.events.length).toBeLessThanOrEqual(limit);
        }
        // Full pages while more exist; the last one is the only short one.
        for (const page of pages.slice(0, -1)) {
          expect(page.events).toHaveLength(limit);
          expect(page.has_more).toBe(true);
          expect(page.next_after_seq).toBe(
            page.events[page.events.length - 1].seq,
          );
        }
        const last = pages[pages.length - 1];
        expect(last.has_more).toBe(false);
        expect(last.next_after_seq).toBe(high);
        expect(leaked(JSON.stringify(pages), policy)).toEqual([]);
      }
    },
  );

  it("does not say more remains when only hidden events follow", async () => {
    const readable = expected("split");
    const lastReadable = readable[readable.length - 1];
    expect(maxSeq()).toBeGreaterThan(lastReadable);
    const res = await call(
      "split",
      "GET",
      `/journal/replay?after_seq=${lastReadable - 1}&limit=5`,
    );
    const page = (await res.json()) as Page;
    expect(page.events.map((e) => e.seq)).toEqual([lastReadable]);
    expect(page.has_more).toBe(false);
    expect(page.next_after_seq).toBe(maxSeq());

    const past = (await (
      await call("split", "GET", `/journal/replay?after_seq=${lastReadable}`)
    ).json()) as Page;
    expect(past).toMatchObject({
      events: [],
      has_more: false,
      next_after_seq: maxSeq(),
    });
  });

  it("answers report selectors with nothing instead of reports", async () => {
    for (const query of ["event_name=pipeline.done", "correlation_id=run-1"]) {
      const res = await call(
        "alpha",
        "GET",
        `/journal/replay?after_seq=0&${query}`,
      );
      expect(await res.json()).toMatchObject({ events: [], has_more: false });
    }
  });

  it("refuses bounds beyond the journal the way replay always has", async () => {
    const high = maxSeq();
    for (const query of [
      `after_seq=${high + 1}`,
      `after_seq=0&through_seq=${high + 1}`,
    ]) {
      const res = await call("alpha", "GET", `/journal/replay?${query}`);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "invalid-cursor" },
      });
    }
  });

  it("reads the project's own archive, whatever the request names", async () => {
    await call("alpha", "GET", "/journal/replay?after_seq=0&project_id=other");
    expect(bucket.listed).toEqual([]);
    db.sqlite.prepare("UPDATE journal SET t = ?").run(Date.now() - 100 * DAY);
    await archiveAll();
    await call("alpha", "GET", "/journal/replay?after_seq=0&project_id=other");
    expect(bucket.listed.length).toBeGreaterThan(0);
    expect(new Set(bucket.listed)).toEqual(
      new Set([`journal-archive/${PROJECT}/`]),
    );
  });
});

/** Archive every journal row the way the daily job does, into the fake bucket. */
async function archiveAll(): Promise<number> {
  const res = await doApp.request("/journal/archive", { method: "POST" });
  const body = (await res.json()) as {
    events: { seq: number; t: number }[];
    throughSeq: number;
  };
  for (const object of journalArchiveObjects(
    PROJECT,
    body.events,
    body.throughSeq,
  ))
    bucket.objects.set(object.key, {
      body: object.body,
      customMetadata: object.customMetadata,
    });
  const confirm = await doApp.request(
    "/journal/archive/confirm",
    json({ throughSeq: body.throughSeq }),
  );
  expect(confirm.status).toBe(200);
  return body.throughSeq;
}

describe("archived history", () => {
  it.each(RESTRICTED)(
    "%s reads the same events from the archive as it did live",
    async (policy) => {
      const live = (await replayAll(policy, 3)).flatMap((p) =>
        p.events.map((e) => e.seq),
      );
      expect(live).toEqual(expected(policy));

      // Archive everything up to partway through, so the journal is split.
      const cut = Math.floor(maxSeq() / 2);
      db.sqlite
        .prepare("UPDATE journal SET t = ? WHERE seq <= ?")
        .run(Date.now() - 100 * DAY, cut);
      expect(await archiveAll()).toBe(cut);
      const remaining = db.sqlite
        .prepare("SELECT count(*) AS n FROM journal")
        .get() as { n: number };
      expect(remaining.n).toBe(maxSeq() - cut);

      for (const limit of [1, 3, 200]) {
        const pages = await replayAll(policy, limit);
        expect(
          pages.flatMap((p) => p.events.map((e) => e.seq)),
          `limit ${limit}`,
        ).toEqual(expected(policy));
        expect(leaked(JSON.stringify(pages), policy)).toEqual([]);
      }
      // The list is not an archive reader: a cursor inside it says so.
      const inside = await list(policy, "after_seq=0&limit=10");
      expect(inside).toMatchObject({ events: [], archived: true });
      expect(inside.lastArchivedSeq).toBe(cut);
    },
  );

  it("fails closed when archived history is lost, even for a window it could not see", async () => {
    db.sqlite.prepare("UPDATE journal SET t = ?").run(Date.now() - 100 * DAY);
    await archiveAll();
    bucket.objects.clear();
    for (const policy of RESTRICTED) {
      const res = await call(policy, "GET", "/journal/replay?after_seq=0");
      const text = await res.text();
      expect(res.status, policy).toBe(503);
      expect(JSON.parse(text)).toMatchObject({
        error: { code: "journal-history-unavailable", retryable: true },
      });
      expect(leaked(text, policy)).toEqual([]);
      for (const resource of ["a-1", "alpha:", "record:"])
        expect(text).not.toContain(resource);
    }
  });

  it("fails closed on a corrupt archive row", async () => {
    db.sqlite.prepare("UPDATE journal SET t = ?").run(Date.now() - 100 * DAY);
    await archiveAll();
    for (const object of bucket.objects.values())
      object.body = `${object.body}\n{not json`;
    const res = await call("alpha", "GET", "/journal/replay?after_seq=0");
    expect(res.status).toBe(503);
  });
});

describe("GET /journal/cursor and what stays denied", () => {
  it("reads the participant cursor and refuses to move it", async () => {
    const before = await call("alpha", "GET", "/journal/cursor");
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({
      ok: true,
      cursor: { seq: 0, updated_at: null },
    });
    // Set through the DO for this credential's own participant identity.
    const set = await doApp.request(
      "/journal/cursor",
      json(
        {
          identity: {
            principal_id: "token:alpha",
            participant_id: "participant-alpha",
            environment: {},
          },
          input: { seq: 3 },
        },
        "PUT",
      ),
    );
    expect(set.status).toBe(200);
    const after = (await (
      await call("alpha", "GET", "/journal/cursor")
    ).json()) as {
      cursor: { seq: number };
    };
    expect(after.cursor.seq).toBe(3);

    for (const policy of RESTRICTED) {
      const put = await call(policy, "PUT", "/journal/cursor", { seq: 5 });
      expect(put.status, policy).toBe(403);
    }
    const unchanged = (await (
      await call("alpha", "GET", "/journal/cursor")
    ).json()) as { cursor: { seq: number } };
    expect(unchanged.cursor.seq).toBe(3);
  });

  it("keeps cursor writes working for an unrestricted credential", async () => {
    const put = await call("plain", "PUT", "/journal/cursor", { seq: 4 });
    expect(put.status, await put.clone().text()).toBe(200);
    const read = (await (
      await call("plain", "GET", "/journal/cursor")
    ).json()) as {
      cursor: { seq: number };
    };
    expect(read.cursor.seq).toBe(4);
  });

  it("denies appends, handoffs, re-entry and archiving to a restricted credential", async () => {
    const report = {
      event_name: "pipeline.done",
      event_version: 1,
      target: { kind: "project" },
      data: {},
    };
    for (const policy of RESTRICTED)
      for (const [method, path, body] of [
        ["POST", "/journal", report],
        ["POST", "/handoffs", {}],
        ["GET", "/handoffs", undefined],
        ["GET", "/handoffs/one", undefined],
        ["GET", "/reentry", undefined],
        ["POST", "/admin/archive/journal", {}],
      ] as const) {
        const res = await call(policy, method, path, body, {
          "Idempotency-Key": "k",
        });
        expect(res.status, `${policy} ${method} ${path}`).toBe(403);
      }
    // Nothing was appended by any of those.
    expect(maxSeq()).toBe(everySeq()[everySeq().length - 1]);
  });

  it("keeps the same denials when a request reaches the DO directly", async () => {
    const headers = (policy: string) => ({
      "Content-Type": "application/json",
      "X-Tila-Credential-Policy": JSON.stringify(POLICIES[policy]),
    });
    for (const [method, path, body] of [
      ["PUT", "/journal/cursor", { identity: {}, input: { seq: 1 } }],
      ["POST", "/journal/append", { input: {} }],
      ["GET", "/handoffs", undefined],
      ["GET", "/reentry", undefined],
      ["POST", "/handoffs", {}],
      ["GET", "/summary", undefined],
    ] as const) {
      const res = await doApp.request(path, {
        method,
        headers: headers("split"),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // A DO reached without journal:read does not list either.
    const res = await doApp.request("/journal/list", {
      headers: headers("no-journal-read"),
    });
    expect(res.status).toBe(403);
  });

  it("ignores a policy header the client supplies", async () => {
    const wide = JSON.stringify(POLICIES.plain);
    const filtered = await call(
      "alpha",
      "GET",
      "/journal?after_seq=0&limit=1000",
      undefined,
      {
        "X-Tila-Credential-Policy": wide,
      },
    );
    const body = (await filtered.json()) as Listed;
    expect(body.events.map((e) => e.seq)).toEqual(expected("alpha"));
    const replay = await call(
      "alpha",
      "GET",
      "/journal/replay?after_seq=0&limit=200",
      undefined,
      {
        "X-Tila-Credential-Policy": wide,
      },
    );
    const page = (await replay.json()) as Page;
    expect(page.events.map((e) => e.seq)).toEqual(expected("alpha"));
  });
});

describe("a restricted list says when it stopped early", () => {
  it("carries has_more, and next_after_seq on a forward read only", async () => {
    const forward = (await (
      await call("split", "GET", "/journal?after_seq=0&limit=1000")
    ).json()) as Record<string, unknown>;
    expect(Object.keys(forward).sort()).toEqual(
      [
        "archived",
        "events",
        "has_more",
        "lastArchivedSeq",
        "next_after_seq",
        "ok",
      ].sort(),
    );
    expect(forward.has_more).toBe(false);
    expect(forward.next_after_seq).toBe(maxSeq());

    const tail = (await (
      await call("split", "GET", "/journal?limit=1000")
    ).json()) as Record<string, unknown>;
    expect(Object.keys(tail).sort()).toEqual(
      ["archived", "events", "has_more", "lastArchivedSeq", "ok"].sort(),
    );
    expect(tail.has_more).toBe(false);
  });

  it("marks a full forward page as having more, and the last one as caught up", async () => {
    const want = expected("split");
    const first = (await (
      await call("split", "GET", "/journal?after_seq=0&limit=2")
    ).json()) as Listed & { has_more: boolean; next_after_seq: number };
    expect(first.events.map((e) => e.seq)).toEqual(want.slice(0, 2));
    expect(first.has_more).toBe(true);
    expect(first.next_after_seq).toBe(want[1]);

    const last = (await (
      await call(
        "split",
        "GET",
        `/journal?after_seq=${want[want.length - 2]}&limit=5`,
      )
    ).json()) as Listed & { has_more: boolean };
    expect(last.events.map((e) => e.seq)).toEqual(want.slice(-1));
    expect(last.has_more).toBe(false);
  });

  it("does not call a cursor inside the archive caught up", async () => {
    db.sqlite.prepare("UPDATE journal SET t = ?").run(Date.now() - 100 * DAY);
    await archiveAll();
    const body = (await (
      await call("split", "GET", "/journal?after_seq=0&limit=10")
    ).json()) as Listed & { has_more: boolean; next_after_seq: number };
    expect(body).toMatchObject({
      events: [],
      archived: true,
      has_more: true,
      next_after_seq: 0,
    });
  });
});

describe("a long run of hidden events", () => {
  const BOUND = journalVisibilityOps.SCOPED_SCAN_LIMIT;

  /** Hidden events of an allowlisted kind: the work a restricted read must do. */
  function addHiddenRun(count: number): void {
    db.sqlite
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data)
         SELECT 1, 'claim.renewed', 'beta:b-1', 'raw', 'raw', '{}', '', '{}' FROM n`,
      )
      .run(count);
  }
  function addReadable(): number {
    const result = db.sqlite
      .prepare(
        "INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data) VALUES (1, 'entity.updated', 'a-1', 'raw', 'raw', '{}', '', '{}')",
      )
      .run();
    return Number(result.lastInsertRowid);
  }

  it("answers a list in bounded steps and never reports a short page as caught up", async () => {
    const start = maxSeq();
    addHiddenRun(2 * BOUND + 500);
    const needle = addReadable();
    let after = start;
    const steps: { moved: number; events: number; more: boolean }[] = [];
    const seen: number[] = [];
    for (let guard = 0; guard < 20; guard++) {
      const res = await call(
        "alpha",
        "GET",
        `/journal?after_seq=${after}&limit=5`,
      );
      const body = (await res.json()) as Listed & {
        has_more: boolean;
        next_after_seq: number;
      };
      expect(res.status).toBe(200);
      steps.push({
        moved: body.next_after_seq - after,
        events: body.events.length,
        more: body.has_more,
      });
      seen.push(...body.events.map((e) => e.seq));
      after = body.next_after_seq;
      if (!body.has_more) break;
    }
    expect(seen).toEqual([needle]);
    expect(steps).toEqual([
      { moved: BOUND, events: 0, more: true },
      { moved: BOUND, events: 0, more: true },
      { moved: needle - start - 2 * BOUND, events: 1, more: false },
    ]);
  });

  it("answers a replay in bounded steps and resumes to the same event", async () => {
    const start = maxSeq();
    addHiddenRun(2 * BOUND + 500);
    const needle = addReadable();
    const through = maxSeq();
    let after = start;
    const steps: { moved: number; events: number; more: boolean }[] = [];
    const seen: number[] = [];
    for (let guard = 0; guard < 20; guard++) {
      const res = await call(
        "alpha",
        "GET",
        `/journal/replay?after_seq=${after}&limit=5&through_seq=${through}`,
      );
      const body = (await res.json()) as Page;
      expect(res.status).toBe(200);
      steps.push({
        moved: body.next_after_seq - after,
        events: body.events.length,
        more: body.has_more,
      });
      seen.push(...body.events.map((e) => e.seq));
      after = body.next_after_seq;
      if (!body.has_more) break;
    }
    expect(seen).toEqual([needle]);
    expect(steps.slice(0, 2)).toEqual([
      { moved: BOUND, events: 0, more: true },
      { moved: BOUND, events: 0, more: true },
    ]);
    expect(steps[2]).toMatchObject({ events: 1, more: false });
  });

  it("flags a tail read whose newest range holds nothing readable as incomplete", async () => {
    addHiddenRun(2 * BOUND);
    const body = (await (
      await call("alpha", "GET", "/journal?limit=5")
    ).json()) as Listed & { has_more: boolean };
    expect(body.events).toEqual([]);
    expect(body.has_more).toBe(true);
    expect("next_after_seq" in body).toBe(false);
    // The readable history is still reachable, bounded step by step.
    let after = 0;
    const seen: number[] = [];
    for (let guard = 0; guard < 30; guard++) {
      const page = (await (
        await call("alpha", "GET", `/journal?after_seq=${after}&limit=1000`)
      ).json()) as Listed & { has_more: boolean; next_after_seq: number };
      seen.push(...page.events.map((e) => e.seq));
      after = page.next_after_seq;
      if (!page.has_more) break;
    }
    expect(seen).toEqual(expected("alpha"));
  });

  it("reveals nothing but sequence positions about what the hidden run was", async () => {
    const run = async (kind: string, resource: string) => {
      db.sqlite
        .prepare("DELETE FROM journal WHERE principal_id = 'bulk'")
        .run();
      db.sqlite
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
           INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data)
           SELECT 1, ?, ?, 'bulk', 'raw', '{}', '', '{}' FROM n`,
        )
        .run(BOUND + 100, kind, resource);
      // Sequences are never reused, so compare positions from the run's start.
      const out: unknown[] = [];
      const origin = maxSeq() - (BOUND + 100);
      let after = origin;
      for (let guard = 0; guard < 5; guard++) {
        const body = (await (
          await call("alpha", "GET", `/journal?after_seq=${after}&limit=5`)
        ).json()) as {
          events: unknown[];
          next_after_seq: number;
          has_more: boolean;
        };
        out.push({
          ...body,
          next_after_seq: body.next_after_seq - origin,
        });
        after = body.next_after_seq;
        if (!body.has_more) break;
      }
      return out;
    };
    const asClaims = await run("claim.renewed", "beta:b-1");
    expect(await run("room.created", "room:private")).toEqual(asClaims);
    expect(await run("entity.updated", "no-such-task")).toEqual(asClaims);
  });
});

describe("unrestricted readers keep their behavior", () => {
  it("lists byte for byte what the Durable Object lists, hidden kinds included", async () => {
    const query = "after_seq=0&limit=1000";
    const viaWorker = await (
      await call("plain", "GET", `/journal?${query}`)
    ).text();
    const direct = await (await doApp.request(`/journal/list?${query}`)).text();
    expect(viaWorker).toBe(direct);
    // The bounded-scan fields belong to restricted readers only.
    expect(Object.keys(JSON.parse(viaWorker)).sort()).toEqual(
      ["archived", "events", "lastArchivedSeq", "ok"].sort(),
    );
    const kinds = new Set(
      (JSON.parse(viaWorker) as Listed).events.map((e) => e.kind),
    );
    expect(kinds).toContain("custom.reported");
    expect(kinds).toContain("schema.applied");
    expect(kinds).toContain("entity.future");
    expect((JSON.parse(viaWorker) as Listed).events.map((e) => e.seq)).toEqual(
      everySeq(),
    );
  });

  it("replays the complete journal exactly as the snapshot completes", async () => {
    for (const limit of [3, 50]) {
      const snapshot = (await (
        await doApp.request(`/journal/replay?after_seq=0&limit=${limit}`)
      ).json()) as ReplaySnapshot;
      const want = await completeReplay(snapshot);
      const got = await (
        await call("plain", "GET", `/journal/replay?after_seq=0&limit=${limit}`)
      ).json();
      expect(got).toEqual(want);
    }
  });

  it("is unaffected by a role-only policy that has no namespace restrictions", async () => {
    const pages = await replayAll("plain", 50);
    expect(pages.flatMap((p) => p.events.map((e) => e.seq))).toEqual(
      everySeq(),
    );
  });
});

describe("through the SDK", () => {
  it("parses list, replay and the cursor read for a restricted credential", async () => {
    const sdk = sdkAs("split");
    const listed = await sdk.query({ after_seq: "0", limit: "1000" });
    expect(listed.events.map((e) => e.seq)).toEqual(expected("split"));
    const replay = await sdk.replay({ after_seq: 0, limit: 200 });
    expect(replay.events.map((e) => e.seq)).toEqual(expected("split"));
    expect(replay.has_more).toBe(false);
    expect((await sdk.getCursor()).cursor.seq).toBe(0);
  });

  it("surfaces a refused cursor write as a typed 403", async () => {
    await expect(sdkAs("split").acknowledge({ seq: 1 })).rejects.toSatisfy(
      (error) => isTilaApiError(error) && error.status === 403,
    );
  });
});
