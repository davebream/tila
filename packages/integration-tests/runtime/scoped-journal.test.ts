import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { journalVisibilityOps } from "@tila/ops-sqlite";
import type { CredentialPolicy } from "@tila/schemas";
import { expect, it } from "vitest";
import { CredentialStore } from "../../worker/src/d1";
import { archiveJournal } from "../../worker/src/lib/admin-ops";
import { hashToken } from "../../worker/src/lib/hash";
import type { Env } from "../../worker/src/types";
import { queueApiFixture } from "./queue-api-fixture";
import { bindings } from "./setup";

// Restricted journal reads against the real Durable Object, D1 credentials and
// R2 archive. The expected events are named by hand from the fixture's
// identities, so they do not come from the predicate under test.

const DAY_MS = 86_400_000;
const definition = `schema_version = 1
[work_units.alpha.fields.title]
type = "string"
[work_units.beta.fields.title]
type = "string"
[records.answer]
format = "json"
history = "revision"
[records.question]
format = "json"
history = "revision"
`;
const CAPS = [
  "journal:read",
  "tasks:read",
  "claims:read",
  "records:read",
] as const;
const ANSWER = [{ type: "answer", key_prefixes: ["a1"] }];
const QUESTION = [{ type: "question", key_prefixes: ["q1"] }];
const POLICIES: Record<string, CredentialPolicy> = {
  typed: {
    role: "viewer",
    capabilities: [...CAPS],
    restrictions: {
      task_types: ["alpha"],
      records_read: ANSWER,
      records_write: QUESTION,
    },
  },
  "write-only": {
    role: "viewer",
    capabilities: [...CAPS],
    restrictions: { records_write: QUESTION },
  },
  legacy: {
    role: "viewer",
    capabilities: [...CAPS],
    restrictions: { task_types: ["alpha"], records: [...QUESTION, ...ANSWER] },
  },
};

type Event = { seq: number; kind: string; resource: string };
type Page = {
  ok: true;
  events: Event[];
  next_after_seq: number;
  through_seq: number;
  has_more: boolean;
};

async function setup() {
  const fixture = await queueApiFixture(definition);
  const { project, http } = fixture;
  const store = new CredentialStore(bindings.DB);
  const actor = { principalId: "fixture" };
  const readers: Record<string, string> = {};
  for (const [name, policy] of Object.entries(POLICIES)) {
    const service = await store.createService(
      project,
      { name, display_name: name, role: "viewer" },
      actor,
    );
    const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
    await store.issue(
      {
        projectId: project,
        principalId: service.principal_id,
        name,
        tokenHash: await hashToken(token, bindings.HASH_PEPPER),
        policy,
      },
      actor,
    );
    readers[name] = token;
  }
  const as = (name: string, path: string, init: RequestInit = {}) =>
    SELF.fetch(`https://worker/projects/${project}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${readers[name]}`,
        "X-Tila-Participant-Id": `reader-${name}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(project));
  const sql = <T = Record<string, unknown>>(
    statement: string,
    ...values: (string | number)[]
  ) =>
    runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql.exec(statement, ...values).toArray() as T[],
    );
  const ok = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const seedLive = async (suffix: string) => {
    await ok(
      await http("/tasks", { id: `a-${suffix}`, type: "alpha", data: {} }),
    );
    await ok(
      await http("/tasks", { id: `b-${suffix}`, type: "beta", data: {} }),
    );
    await ok(
      await http("/claims/acquire", {
        resource: `alpha:a-${suffix}`,
        mode: "exclusive",
        ttl_ms: 60_000,
      }),
    );
    await ok(
      await http("/claims/acquire", {
        resource: `beta:b-${suffix}`,
        mode: "exclusive",
        ttl_ms: 60_000,
      }),
    );
    await ok(
      await http("/records/answer", {
        key: `a1/${suffix}`,
        value: { n: 1 },
      }),
    );
    await ok(
      await http("/records/question", {
        key: `q1/${suffix}`,
        value: { n: 1 },
      }),
    );
  };
  const archiveEverything = async () => {
    await sql("UPDATE journal SET t = ?", Date.now() - 100 * DAY_MS);
    const result = await archiveJournal(
      { ARTIFACTS: bindings.ARTIFACTS } as unknown as Env,
      stub,
      project,
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  };
  const replay = async (
    name: string,
    query: string,
  ): Promise<{ status: number; text: string }> => {
    const response = await as(name, `/journal/replay?${query}`);
    return { status: response.status, text: await response.text() };
  };
  const everyone = async (): Promise<Event[]> => {
    const response = await http("/journal/replay?after_seq=0&limit=200");
    expect(response.status).toBe(200);
    return ((await response.json()) as Page).events;
  };
  /** Every page of a reader's replay, pinned to the first page's through_seq. */
  const pages = async (name: string, limit: number): Promise<Page[]> => {
    const out: Page[] = [];
    let after = 0;
    let through: number | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const { status, text } = await replay(
        name,
        `after_seq=${after}&limit=${limit}${
          through === undefined ? "" : `&through_seq=${through}`
        }`,
      );
      expect(status, text).toBe(200);
      const page = JSON.parse(text) as Page;
      out.push(page);
      through = page.through_seq;
      after = page.next_after_seq;
      if (!page.has_more) break;
    }
    return out;
  };
  return {
    ...fixture,
    stub,
    sql,
    as,
    ok,
    seedLive,
    archiveEverything,
    replay,
    everyone,
    pages,
  };
}

/** What each reader may read, by the fixture's identities. */
const readable: Record<string, (e: Event) => boolean> = {
  typed: (e) =>
    (e.kind.startsWith("entity.") && /^a-/.test(e.resource)) ||
    (e.kind.startsWith("claim.") &&
      (/^alpha:a-/.test(e.resource) ||
        /^record:answer\/a1\//.test(e.resource))) ||
    (e.kind.startsWith("record.") && /^record:answer\/a1\//.test(e.resource)),
  legacy: (e) =>
    (e.kind.startsWith("entity.") && /^a-/.test(e.resource)) ||
    (e.kind.startsWith("claim.") &&
      (/^alpha:a-/.test(e.resource) ||
        /^record:(answer\/a1|question\/q1)\//.test(e.resource))) ||
    (e.kind.startsWith("record.") &&
      /^record:(answer\/a1|question\/q1)\//.test(e.resource)),
  "write-only": (e) =>
    (e.kind.startsWith("entity.") && /^[ab]-/.test(e.resource)) ||
    (e.kind.startsWith("claim.") && /^(alpha|beta):[ab]-/.test(e.resource)),
};

it("shows each restricted reader exactly its events, live and across a real archive boundary", async () => {
  const t = await setup();
  await t.seedLive("one");
  await t.ok(
    await t.http(
      "/journal",
      {
        event_name: "pipeline.done",
        event_version: 1,
        target: { kind: "project" },
        data: {},
        correlation_id: "run-1",
      },
      "worker",
      "report-1",
    ),
  );
  await t.archiveEverything();
  expect(await t.sql("SELECT seq FROM journal")).toEqual([]);
  await t.seedLive("two");

  const all = await t.everyone();
  expect(all.map((e) => e.kind)).toContain("custom.reported");
  expect(all.map((e) => e.kind)).toContain("schema.applied");
  const high = all[all.length - 1].seq;

  for (const name of Object.keys(POLICIES)) {
    const want = all.filter(readable[name]).map((e) => e.seq);
    expect(want.length, name).toBeGreaterThan(4);
    for (const limit of [1, 2, 200]) {
      const pages = await t.pages(name, limit);
      const got = pages.flatMap((page) => page.events.map((e) => e.seq));
      expect(got, `${name} limit ${limit}`).toEqual(want);
      for (const page of pages) {
        expect(page.through_seq).toBe(high);
        expect(page.events.length).toBeLessThanOrEqual(limit);
      }
      for (const page of pages.slice(0, -1)) {
        expect(page.has_more).toBe(true);
        expect(page.events).toHaveLength(limit);
      }
      expect(pages[pages.length - 1].has_more).toBe(false);
      expect(pages[pages.length - 1].next_after_seq).toBe(high);
    }
    const text = JSON.stringify(await t.pages(name, 200));
    for (const hidden of all.filter((e) => !readable[name](e)))
      if (!all.some((e) => readable[name](e) && e.resource === hidden.resource))
        expect(text, `${name} must not see ${hidden.resource}`).not.toContain(
          JSON.stringify(hidden.resource),
        );
  }
});

it("lists only what a restricted reader may read, and points archived cursors at replay", async () => {
  const t = await setup();
  await t.seedLive("one");
  const before = await t.everyone();
  await t.archiveEverything();
  await t.seedLive("two");

  const listed = await t.as("typed", "/journal?after_seq=0&limit=1000");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({
    events: [],
    archived: true,
    lastArchivedSeq: before[before.length - 1].seq,
  });
  const live = await t.as(
    "typed",
    `/journal?after_seq=${before[before.length - 1].seq}&limit=1000`,
  );
  const events = ((await live.json()) as { events: Event[] }).events;
  const all = await t.everyone();
  expect(events.map((e) => e.seq)).toEqual(
    all
      .filter((e) => e.seq > before[before.length - 1].seq)
      .filter(readable.typed)
      .map((e) => e.seq),
  );
  const tail = await t.as("typed", "/journal?limit=2");
  expect(
    ((await tail.json()) as { events: Event[] }).events.map((e) => e.seq),
  ).toEqual(
    all
      .filter(readable.typed)
      .map((e) => e.seq)
      .slice(-2)
      .reverse(),
  );
});

it("fails closed when archived history is lost, naming nothing of what it held", async () => {
  const t = await setup();
  await t.seedLive("one");
  await t.archiveEverything();
  const objects = await bindings.ARTIFACTS.list({
    prefix: `journal-archive/${t.project}/`,
  });
  expect(objects.objects.length).toBeGreaterThan(0);
  for (const object of objects.objects)
    await bindings.ARTIFACTS.delete(object.key);

  for (const name of Object.keys(POLICIES)) {
    const { status, text } = await t.replay(name, "after_seq=0&limit=200");
    expect(status, name).toBe(503);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "journal-history-unavailable", retryable: true },
    });
    for (const secret of ["a-one", "b-one", "record:", "alpha", "beta"])
      expect(text).not.toContain(secret);
  }
});

it("serves the participant cursor and refuses to move it", async () => {
  const t = await setup();
  await t.seedLive("one");
  const read = await t.as("typed", "/journal/cursor");
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({
    ok: true,
    cursor: { seq: 0, updated_at: null },
  });
  for (const name of Object.keys(POLICIES)) {
    const put = await t.as(name, "/journal/cursor", {
      method: "PUT",
      body: JSON.stringify({ seq: 1 }),
    });
    expect(put.status, name).toBe(403);
  }
  const unchanged = (await (await t.as("typed", "/journal/cursor")).json()) as {
    cursor: { seq: number };
  };
  expect(unchanged.cursor.seq).toBe(0);
  // An unrestricted credential still moves its own cursor.
  const owner = await SELF.fetch(
    `https://worker/projects/${t.project}/journal/cursor`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${t.token}`,
        "X-Tila-Participant-Id": "worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seq: 1 }),
    },
  );
  expect(owner.status, await owner.clone().text()).toBe(200);
  expect(await owner.json()).toMatchObject({ cursor: { seq: 1 } });
});

it("keeps denying appends, handoffs, re-entry and archiving to restricted readers", async () => {
  const t = await setup();
  await t.seedLive("one");
  const before = await t.sql<{ n: number }>(
    "SELECT count(*) AS n FROM journal",
  );
  for (const name of Object.keys(POLICIES))
    for (const [method, path, body] of [
      [
        "POST",
        "/journal",
        {
          event_name: "pipeline.done",
          event_version: 1,
          target: { kind: "project" },
          data: {},
        },
      ],
      ["POST", "/handoffs", {}],
      ["GET", "/handoffs", undefined],
      ["GET", "/reentry", undefined],
      ["POST", "/admin/archive/journal", {}],
    ] as const) {
      const response = await t.as(name, path, {
        method,
        headers: { "Idempotency-Key": "k" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, `${name} ${method} ${path}`).toBe(403);
    }
  expect(await t.sql("SELECT count(*) AS n FROM journal")).toEqual(before);
});

it("resumes a restricted replay after the Durable Object restarts", async () => {
  const t = await setup();
  await t.seedLive("one");
  await t.archiveEverything();
  await t.seedLive("two");
  const want = (await t.everyone()).filter(readable.typed).map((e) => e.seq);
  expect(want.length).toBeGreaterThanOrEqual(4);

  const first = JSON.parse(
    (await t.replay("typed", "after_seq=0&limit=2")).text,
  ) as Page;
  expect(first.events.map((e) => e.seq)).toEqual(want.slice(0, 2));
  expect(first.has_more).toBe(true);
  await evictDurableObject(t.stub);
  const second = JSON.parse(
    (
      await t.replay(
        "typed",
        `after_seq=${first.next_after_seq}&limit=2&through_seq=${first.through_seq}`,
      )
    ).text,
  ) as Page;
  expect(second.events.map((e) => e.seq)).toEqual(want.slice(2, 4));
});

it(
  "answers a long hidden-only run in bounded steps, live and across a real archive",
  { timeout: 180_000 },
  async () => {
    const t = await setup();
    const BOUND = journalVisibilityOps.SCOPED_SCAN_LIMIT;
    const hiddenRun = (count: number) =>
      t.sql(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data)
       SELECT ?, 'claim.renewed', 'beta:b-one', 'runtime', 'runtime', '{}', '', '{}' FROM n`,
        count,
        Date.now(),
      );
    const rows = () =>
      t.sql<Event>("SELECT seq, kind, resource FROM journal ORDER BY seq");

    // Readable events, then more hidden events than one request may examine.
    await t.seedLive("one");
    await hiddenRun(BOUND + 1500);
    const early = await rows();
    await t.archiveEverything();
    expect(await t.sql("SELECT seq FROM journal")).toEqual([]);

    // After the archive: a second hidden run, then readable events, live.
    await hiddenRun(BOUND + 500);
    await t.seedLive("two");
    const live = await rows();
    const want = [...early, ...live].filter(readable.typed).map((e) => e.seq);
    expect(want.length).toBeGreaterThanOrEqual(6);

    // Replay: bounded steps from the start, crossing the archive boundary.
    let after = 0;
    let through: number | undefined;
    const seen: number[] = [];
    const steps: { moved: number; events: number; more: boolean }[] = [];
    for (let guard = 0; guard < 60; guard++) {
      const { status, text } = await t.replay(
        "typed",
        `after_seq=${after}&limit=2${
          through === undefined ? "" : `&through_seq=${through}`
        }`,
      );
      expect(status, text).toBe(200);
      const page = JSON.parse(text) as Page;
      steps.push({
        moved: page.next_after_seq - after,
        events: page.events.length,
        more: page.has_more,
      });
      seen.push(...page.events.map((e) => e.seq));
      through = page.through_seq;
      after = page.next_after_seq;
      if (!page.has_more) break;
    }
    expect(seen).toEqual(want);
    // Some request examined exactly the bound, found nothing, and said so; none
    // examined more than the bound without returning an event it stopped on.
    expect(
      steps.some((s) => s.events === 0 && s.more && s.moved === BOUND),
    ).toBe(true);
    for (const step of steps)
      if (step.events === 0) expect(step.moved).toBeLessThanOrEqual(BOUND);
    expect(steps[steps.length - 1].more).toBe(false);

    // The list is bounded the same way, and says where archived history is.
    const archived = (await (
      await t.as("typed", "/journal?after_seq=0&limit=50")
    ).json()) as { events: Event[]; archived: boolean; has_more: boolean };
    expect(archived).toMatchObject({
      events: [],
      archived: true,
      has_more: true,
    });
    const watermark = early[early.length - 1].seq;
    let cursor = watermark;
    const listed: number[] = [];
    const listSteps: { moved: number; events: number; more: boolean }[] = [];
    for (let guard = 0; guard < 30; guard++) {
      const page = (await (
        await t.as("typed", `/journal?after_seq=${cursor}&limit=2`)
      ).json()) as {
        events: Event[];
        has_more: boolean;
        next_after_seq: number;
      };
      listSteps.push({
        moved: page.next_after_seq - cursor,
        events: page.events.length,
        more: page.has_more,
      });
      listed.push(...page.events.map((e) => e.seq));
      cursor = page.next_after_seq;
      if (!page.has_more) break;
    }
    expect(listed).toEqual(live.filter(readable.typed).map((e) => e.seq));
    expect(
      listSteps.some((s) => s.events === 0 && s.more && s.moved === BOUND),
    ).toBe(true);

    // A tail read holds the newest readable events and is complete when full.
    const tail = (await (await t.as("typed", "/journal?limit=3")).json()) as {
      events: Event[];
      has_more: boolean;
    };
    expect(tail.events.map((e) => e.seq)).toEqual(
      live
        .filter(readable.typed)
        .map((e) => e.seq)
        .slice(-3)
        .reverse(),
    );
    expect(tail.has_more).toBe(false);
  },
);
