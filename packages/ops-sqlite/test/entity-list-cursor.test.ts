import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TaskListSort, list } from "../src/entity-ops";
import {
  InvalidCursorError,
  encodeCursor,
  fingerprint,
} from "../src/list-cursor";
import { blockedTaskIds, readReadinessSnapshot } from "../src/ready-ops";
import * as schema from "../src/schema";
import { applySchema } from "../src/schema-ops";
import { type TestDb, createEntity, createTestDb } from "./helpers";

let testDb: TestDb;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.rawDb.close();
});

/**
 * 300 tasks where most rows share sort values: 60% of updated_at values
 * collide, titles repeat, some titles are NULL or numbers, ids are inserted
 * out of order.
 */
function seed(count = 300) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `task-${String((i * 37) % count).padStart(3, "0")}`;
    const title = i % 7 === 0 ? undefined : i % 11 === 0 ? i : `Title ${i % 5}`;
    createEntity(testDb.db, {
      id,
      type: i % 3 === 0 ? "bug" : "story",
      data: {
        ...(title === undefined ? {} : { title }),
        status: i % 4 === 0 ? null : `s${i % 3}`,
      },
    });
    testDb.db
      .update(schema.entities)
      .set({
        created_at: 1000 + Math.floor(i / 10),
        updated_at: i % 5 < 3 ? 5000 : 5000 + i,
      })
      .where(eq(schema.entities.id, id))
      .run();
    ids.push(id);
  }
  return ids;
}

function collect(
  filter: Parameters<typeof list>[1] & { limit: number },
): string[][] {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = list(testDb.db, { ...filter, cursor });
    pages.push(page.entities.map((e) => e.id));
    if (!page.next_cursor) return pages;
    cursor = page.next_cursor;
  }
  throw new Error("pagination did not terminate");
}

const SORTS: TaskListSort[] = [
  "created_at",
  "updated_at",
  "type",
  "title",
  "status",
  "id",
];

describe("entity list keyset pagination", () => {
  for (const sort of SORTS) {
    for (const order of ["asc", "desc"] as const) {
      it(`visits every row exactly once sorted by ${sort} ${order}`, () => {
        const ids = seed();
        const pages = collect({ sort, order, limit: 100 });
        const seen = pages.flat();
        expect(pages.length).toBe(3);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.slice().sort()).toEqual(ids.slice().sort());
        // Paging must reproduce the single-query order exactly.
        expect(seen).toEqual(
          list(testDb.db, { sort, order }).entities.map((e) => e.id),
        );
      });
    }
  }

  it("orders by created_at then id by default", () => {
    seed(30);
    const all = list(testDb.db).entities;
    const expected = all
      .slice()
      .sort(
        (a, b) =>
          a.created_at - b.created_at ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((e) => e.id);
    expect(all.map((e) => e.id)).toEqual(expected);
  });

  it("reports the filtered total on every page and finds row 251", () => {
    seed(260);
    const pages = collect({ type: ["bug", "story"], limit: 100 });
    expect(pages.map((p) => p.length)).toEqual([100, 100, 60]);
    const third = list(testDb.db, {
      limit: 100,
      cursor:
        list(testDb.db, {
          limit: 100,
          cursor: list(testDb.db, { limit: 100 }).next_cursor ?? undefined,
        }).next_cursor ?? undefined,
    });
    expect(third.total).toBe(260);
    expect(third.next_cursor).toBeNull();
    expect(pages.flat()).toContain("task-251");
  });

  it("keeps cursors stable when filtered by type", () => {
    seed(90);
    const bugs = collect({ type: "bug", limit: 7 }).flat();
    expect(bugs.length).toBe(30);
    expect(new Set(bugs).size).toBe(30);
  });

  it("rejects a cursor reused with a different filter or sort", () => {
    seed(20);
    const cursor = list(testDb.db, { limit: 5, sort: "updated_at" })
      .next_cursor as string;
    expect(() =>
      list(testDb.db, { limit: 5, sort: "created_at", cursor }),
    ).toThrow(InvalidCursorError);
    expect(() =>
      list(testDb.db, { limit: 5, sort: "updated_at", type: "bug", cursor }),
    ).toThrow(InvalidCursorError);
    expect(() =>
      list(testDb.db, {
        limit: 5,
        sort: "updated_at",
        order: "desc",
        cursor,
      }),
    ).toThrow(InvalidCursorError);
  });

  it("rejects malformed cursors and cursor plus offset", () => {
    seed(20);
    for (const cursor of ["not-base64!", "e30", btoa('{"v":2,"f":"x"}')])
      expect(() => list(testDb.db, { limit: 5, cursor })).toThrow(
        InvalidCursorError,
      );
    const cursor = list(testDb.db, { limit: 5 }).next_cursor as string;
    expect(() => list(testDb.db, { limit: 5, offset: 5, cursor })).toThrow(
      InvalidCursorError,
    );
  });

  it("issues a cursor from an offset page so offset callers can switch", () => {
    seed(20);
    const offsetPage = list(testDb.db, { limit: 5, offset: 5 });
    const next = list(testDb.db, {
      limit: 5,
      cursor: offsetPage.next_cursor ?? undefined,
    });
    expect(next.entities.map((e) => e.id)).toEqual(
      list(testDb.db, { limit: 5, offset: 10 }).entities.map((e) => e.id),
    );
  });

  it("returns no cursor without a limit or on the last page", () => {
    seed(10);
    expect(list(testDb.db).next_cursor).toBeNull();
    expect(list(testDb.db, { limit: 10 }).next_cursor).toBeNull();
    expect(list(testDb.db, { limit: 9 }).next_cursor).not.toBeNull();
  });

  it("encodes non-ASCII sort keys", () => {
    for (const [i, title] of ["Żółw", "Äpfel", "日本", "émile"].entries())
      createEntity(testDb.db, { id: `u-${i}`, data: { title } });
    const pages = collect({ sort: "title", limit: 1 });
    expect(pages.flat().length).toBe(4);
  });
});

/**
 * `bug` and `story` declare a failure outcome, `epic` declares only success,
 * `chore` has no lifecycle at all.
 */
const OUTCOME_SCHEMA = `schema_version = 1
[work_units.bug.fields.state]
type = "enum"
values = ["open", "fixed", "broken", "wontfix"]
[work_units.bug.lifecycle]
field = "state"
dispatchable = ["open"]
terminal = ["fixed", "broken", "wontfix"]
dependency_satisfied = ["fixed"]
[work_units.bug.lifecycle.outcomes]
success = "fixed"
failure = "broken"
cancelled = "wontfix"
[work_units.story.fields.stage]
type = "string"
[work_units.story.lifecycle]
field = "stage"
dispatchable = ["todo"]
terminal = ["done", "failed"]
dependency_satisfied = ["done"]
[work_units.story.lifecycle.outcomes]
success = "done"
failure = "failed"
[work_units.epic.fields.stage]
type = "string"
[work_units.epic.lifecycle]
field = "stage"
dispatchable = ["todo"]
terminal = ["done", "failed"]
dependency_satisfied = ["done"]
[work_units.epic.lifecycle.outcomes]
success = "done"
[work_units.chore.fields.status]
type = "string"
`;

const STATES = {
  bug: { field: "state", open: "open", success: "fixed", failure: "broken" },
  story: { field: "stage", open: "todo", success: "done", failure: "failed" },
  epic: { field: "stage", open: "todo", success: "done", failure: "failed" },
  chore: {
    field: "status",
    open: "open",
    success: "closed",
    failure: "broken",
  },
} as const;
type SeedType = keyof typeof STATES;

function createTask(
  id: string,
  type: SeedType,
  state: "open" | "success" | "failure" | "wontfix",
  createdAt: number,
) {
  const spec = STATES[type];
  const value = state === "wontfix" ? state : spec[state];
  createEntity(testDb.db, { id, type, data: { [spec.field]: value } });
  testDb.db
    .update(schema.entities)
    .set({ created_at: createdAt })
    .where(eq(schema.entities.id, id))
    .run();
}

function blocks(from_id: string, to_id: string) {
  testDb.db
    .insert(schema.entityRelationships)
    .values({
      from_id,
      to_id,
      type: "blocks",
      created_at: 1,
      schema_version: 1,
    })
    .run();
}

/**
 * 30 tasks: 14 blocker -> dependent pairs and a two-task cycle. Every third
 * blocker succeeded; one dependent is terminal and one is archived. Returns
 * the ids that must be listed as blocked.
 */
function seedBlocked(): string[] {
  const expected: string[] = [];
  for (let k = 0; k < 14; k++) {
    const type: SeedType = k % 2 ? "story" : "bug";
    const satisfied = k % 3 === 0;
    // Shared created_at values force the id tie-break across pages.
    createTask(`b-${k}`, type, satisfied ? "success" : "open", 1000 + (k % 3));
    createTask(`d-${k}`, type, k === 4 ? "failure" : "open", 1000 + (k % 4));
    blocks(`b-${k}`, `d-${k}`);
    if (k === 5)
      testDb.db
        .update(schema.entities)
        .set({ archived: 1 })
        .where(eq(schema.entities.id, `d-${k}`))
        .run();
    if (!satisfied && k !== 4 && k !== 5) expected.push(`d-${k}`);
  }
  createTask("c-0", "bug", "open", 1000);
  createTask("c-1", "story", "open", 1000);
  blocks("c-0", "c-1");
  blocks("c-1", "c-0");
  expected.push("c-0", "c-1");
  return expected;
}

/**
 * 30 tasks over four types; every other round of four is in its type's
 * failure state. Only `bug` and `story` declare that state as an outcome.
 */
function seedOutcomes() {
  const rows: { id: string; type: SeedType; failing: boolean }[] = [];
  const types: SeedType[] = ["bug", "story", "epic", "chore"];
  for (let i = 0; i < 30; i++) {
    const type = types[i % 4];
    const failing = Math.floor(i / 4) % 2 === 0;
    const id = `o-${String((i * 7) % 30).padStart(2, "0")}`;
    const other = i % 3 === 0 ? "success" : type === "bug" ? "wontfix" : "open";
    createTask(id, type, failing ? "failure" : other, 1000 + Math.floor(i / 6));
    rows.push({ id, type, failing });
  }
  return rows;
}

type ListFilter = NonNullable<Parameters<typeof list>[1]>;

function walk(filter: ListFilter & { limit: number }) {
  const pages: ReturnType<typeof list>[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = list(testDb.db, { ...filter, cursor });
    pages.push(page);
    if (!page.next_cursor) return pages;
    cursor = page.next_cursor;
  }
  throw new Error("pagination did not terminate");
}

function expectExactWalk(
  filter: ListFilter & { limit: number },
  expected: string[],
) {
  const pages = walk(filter);
  const seen = pages.flatMap((page) => page.entities.map((e) => e.id));
  expect(pages.length).toBeGreaterThan(2);
  for (const page of pages) expect(page.total).toBe(expected.length);
  expect(seen).toHaveLength(expected.length);
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.slice().sort()).toEqual(expected.slice().sort());
  const { limit: _limit, ...unpaged } = filter;
  expect(seen).toEqual(list(testDb.db, unpaged).entities.map((e) => e.id));
  return pages;
}

describe("entity list blocked and outcome filters", () => {
  beforeEach(() => {
    applySchema(testDb.db, OUTCOME_SCHEMA, "test");
  });

  for (const order of [
    {},
    { sort: "id", order: "desc" },
    { sort: "updated_at", order: "asc" },
  ] as const) {
    it(`pages exactly the blocked tasks (${JSON.stringify(order)})`, () => {
      const expected = seedBlocked();
      expect(expected).toHaveLength(9);
      expect(
        [...blockedTaskIds(readReadinessSnapshot(testDb.db))].sort(),
      ).toEqual(expected.slice().sort());
      const pages = expectExactWalk(
        { blocked: true, limit: 2, ...order },
        expected,
      );
      for (const page of pages) expect(page.outcome_types).toBeUndefined();
    });

    it(`pages exactly the failed tasks (${JSON.stringify(order)})`, () => {
      const rows = seedOutcomes();
      const expected = rows
        .filter((r) => r.failing && (r.type === "bug" || r.type === "story"))
        .map((r) => r.id);
      expect(expected).toHaveLength(8);
      const pages = expectExactWalk(
        { outcome: ["failure"], limit: 3, ...order },
        expected,
      );
      for (const page of pages)
        expect(page.outcome_types).toEqual(["bug", "story"]);
    });
  }

  it("reports the participating types for each outcome", () => {
    seedOutcomes();
    const types = (filter: ListFilter) => list(testDb.db, filter).outcome_types;
    expect(types({ outcome: ["failure"] })).toEqual(["bug", "story"]);
    expect(types({ outcome: ["success"] })).toEqual(["bug", "epic", "story"]);
    expect(types({ outcome: ["cancelled"] })).toEqual(["bug"]);
    expect(types({ outcome: ["failure", "cancelled"] })).toEqual([
      "bug",
      "story",
    ]);
    expect(types({ outcome: ["failure"], type: "story" })).toEqual(["story"]);
    expect(types({ outcome: ["failure"], type: ["epic", "chore"] })).toEqual(
      [],
    );
    expect(types({})).toBeUndefined();
    // Several outcomes match any of their states.
    const either = list(testDb.db, { outcome: ["failure", "cancelled"] });
    for (const entity of either.entities)
      expect(["broken", "wontfix", "failed"]).toContain(
        entity.data.state ?? entity.data.stage,
      );
    expect(either.total).toBe(
      list(testDb.db, { outcome: ["failure"] }).total +
        list(testDb.db, { outcome: ["cancelled"] }).total,
    );
  });

  it("limits outcome types and totals to the caller's task types", () => {
    const rows = seedOutcomes();
    const failingBugs = rows
      .filter((r) => r.failing && r.type === "bug")
      .map((r) => r.id)
      .sort();
    for (const task_types of [["bug"], ["bug", "chore"]]) {
      const page = list(testDb.db, {
        outcome: ["failure"],
        restrictions: { task_types },
      });
      expect(page.outcome_types).toEqual(["bug"]);
      expect(page.total).toBe(failingBugs.length);
      expect(page.entities.map((e) => e.id).sort()).toEqual(failingBugs);
    }
    const hidden = list(testDb.db, {
      outcome: ["failure"],
      restrictions: { task_types: ["epic", "chore"] },
    });
    expect(hidden.outcome_types).toEqual([]);
    expect(hidden.total).toBe(0);
  });

  it("rejects a cursor reused with a different blocked or outcome filter", () => {
    seedBlocked();
    seedOutcomes();
    const blockedCursor = list(testDb.db, { blocked: true, limit: 2 })
      .next_cursor as string;
    expect(blockedCursor).toEqual(expect.any(String));
    const notBlocked: ListFilter[] = [
      {},
      { blocked: false },
      { outcome: ["failure"] },
    ];
    for (const other of notBlocked)
      expect(() =>
        list(testDb.db, { ...other, limit: 2, cursor: blockedCursor }),
      ).toThrow(InvalidCursorError);
    expect(
      list(testDb.db, { blocked: true, limit: 2, cursor: blockedCursor })
        .entities,
    ).toHaveLength(2);

    const failureCursor = list(testDb.db, { outcome: ["failure"], limit: 2 })
      .next_cursor as string;
    expect(failureCursor).toEqual(expect.any(String));
    const otherOutcomes: ListFilter[] = [
      {},
      { outcome: [] },
      { outcome: ["cancelled"] },
      { outcome: ["failure", "cancelled"] },
      { outcome: ["failure"], blocked: true },
    ];
    for (const other of otherOutcomes)
      expect(() =>
        list(testDb.db, { ...other, limit: 2, cursor: failureCursor }),
      ).toThrow(InvalidCursorError);
    // The binding sorts outcomes, so their order does not matter.
    const pairCursor = list(testDb.db, {
      outcome: ["failure", "cancelled"],
      limit: 2,
    }).next_cursor as string;
    expect(
      list(testDb.db, {
        outcome: ["cancelled", "failure"],
        limit: 2,
        cursor: pairCursor,
      }).entities,
    ).toHaveLength(2);
  });
});

it("matches nothing when no type declares the requested outcome", () => {
  const withoutFailure = OUTCOME_SCHEMA.replace(
    'failure = "broken"\n',
    "",
  ).replace('failure = "failed"\n', "");
  expect(withoutFailure).not.toContain("failure =");
  expect(applySchema(testDb.db, withoutFailure, "test").ok).toBe(true);
  seedOutcomes();
  const page = list(testDb.db, { outcome: ["failure"], limit: 5 });
  expect(page.total).toBe(0);
  expect(page.entities).toEqual([]);
  expect(page.outcome_types).toEqual([]);
  expect(page.next_cursor).toBeNull();
  // Tasks in the old failure states exist; only the declaration is missing.
  expect(
    list(testDb.db, { dataFilter: { state: "broken" } }).total,
  ).toBeGreaterThan(0);
  expect(list(testDb.db, { outcome: ["success"] }).outcome_types).toEqual([
    "bug",
    "epic",
    "story",
  ]);
});

it("keeps accepting cursors issued before the blocked and outcome filters", () => {
  seed(20);
  const first = list(testDb.db, { limit: 5 });
  const last = first.entities.at(-1);
  if (!last) throw new Error("empty page");
  // The exact binding `list` used before `blocked` and `outcome` existed.
  const legacy = encodeCursor(
    fingerprint({
      type: null,
      archived: null,
      dataFilter: null,
      tag: null,
      tagFilter: null,
      sort: "created_at",
      order: "asc",
    }),
    { k: last.created_at, id: last.id },
  );
  expect(first.next_cursor).toBe(legacy);
  const expected = list(testDb.db, { limit: 5, offset: 5 }).entities.map(
    (e) => e.id,
  );
  const unset: ListFilter[] = [{}, { blocked: false }, { outcome: [] }];
  for (const extra of unset)
    expect(
      list(testDb.db, { ...extra, limit: 5, cursor: legacy }).entities.map(
        (e) => e.id,
      ),
    ).toEqual(expected);
});

it("matches a lifecycle field whose name contains a dot by its exact key", () => {
  const dotted = `schema_version = 1
[work_units.job.fields."run.state"]
type = "enum"
values = ["queued", "done", "broken"]
[work_units.job.lifecycle]
field = "run.state"
dispatchable = ["queued"]
terminal = ["done", "broken"]
dependency_satisfied = ["done"]
[work_units.job.lifecycle.outcomes]
failure = "broken"
`;
  expect(applySchema(testDb.db, dotted, "test").ok).toBe(true);
  createEntity(testDb.db, {
    id: "job-broken",
    type: "job",
    data: { "run.state": "broken" },
  });
  createEntity(testDb.db, {
    id: "job-done",
    type: "job",
    data: { "run.state": "done" },
  });
  // A nested object must not match: the field is the literal key.
  createEntity(testDb.db, {
    id: "job-nested",
    type: "job",
    data: { "run.state": "queued", run: { state: "broken" } },
  });
  const page = list(testDb.db, { outcome: ["failure"] });
  expect(page.entities.map((e) => e.id)).toEqual(["job-broken"]);
  expect(page.total).toBe(1);
  expect(page.outcome_types).toEqual(["job"]);
});
