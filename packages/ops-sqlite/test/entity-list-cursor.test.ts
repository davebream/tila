import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
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

/**
 * Three types keep their state in three different lifecycle fields. `chore`
 * declares no lifecycle, so its state is `status`; `legacy` is not declared
 * at all and is stored by raw insert, as a retired type would be.
 */
const STATE_SCHEMA = `schema_version = 1
[work_units.bug.fields.state]
type = "enum"
values = ["open", "in-review", "fixed"]
[work_units.bug.lifecycle]
field = "state"
dispatchable = ["open"]
terminal = ["fixed"]
dependency_satisfied = ["fixed"]
[work_units.story.fields.stage]
type = "string"
[work_units.story.lifecycle]
field = "stage"
dispatchable = ["todo"]
terminal = ["done"]
dependency_satisfied = ["done"]
[work_units.epic.fields.phase]
type = "string"
[work_units.epic.lifecycle]
field = "phase"
dispatchable = ["todo"]
terminal = ["done"]
dependency_satisfied = ["done"]
[work_units.chore.fields.status]
type = "string"
`;

type StateType = "bug" | "story" | "epic" | "chore" | "legacy";

const STATE_TYPES: Record<
  StateType,
  { field: string; pool: [string, string, string]; declared: boolean }
> = {
  bug: { field: "state", pool: ["open", "in-review", "fixed"], declared: true },
  story: {
    field: "stage",
    pool: ["todo", "in-review", "done"],
    declared: true,
  },
  epic: { field: "phase", pool: ["todo", "in-review", "done"], declared: true },
  chore: {
    field: "status",
    pool: ["open", "in-review", "closed"],
    declared: false,
  },
  legacy: {
    field: "status",
    pool: ["open", "in-review", "gone"],
    declared: false,
  },
};

type StateRow = { id: string; type: StateType; state: string | null };

function insertRaw(id: string, type: string, data: unknown, createdAt = 1000) {
  testDb.rawDb
    .prepare(
      "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, 1, ?, 0, ?, ?, 'seed')",
    )
    .run(id, type, JSON.stringify(data), createdAt, createdAt);
}

/**
 * 80 tasks cycling the five types and three states each; every seventh has no
 * state. Each row also carries the OTHER types' state fields as decoys, so a
 * filter reading the wrong field returns wrong rows rather than none.
 */
function seedStates(): StateRow[] {
  const types = Object.keys(STATE_TYPES) as StateType[];
  const rows: StateRow[] = [];
  for (let i = 0; i < 80; i++) {
    const type = types[i % types.length];
    const spec = STATE_TYPES[type];
    const state = i % 7 === 0 ? null : spec.pool[Math.floor(i / 5) % 3];
    const id = `s-${String((i * 17) % 80).padStart(2, "0")}`;
    const data: Record<string, unknown> = {
      // `status` is a decoy on lifecycle types, the state on the others.
      status: "in-review",
      state: "in-review",
      stage: "in-review",
      phase: "in-review",
    };
    delete data[spec.field];
    if (state !== null) data[spec.field] = state;
    if (spec.declared) createEntity(testDb.db, { id, type, data });
    else insertRaw(id, type, data, 1000 + (i % 4));
    rows.push({ id, type, state });
  }
  return rows;
}

const idsWithState = (rows: StateRow[], states: string[]) =>
  rows
    .filter((r) => r.state !== null && states.includes(r.state))
    .map((r) => r.id);

/** (state, id) order with no-state first, as SQLite sorts NULL ascending. */
function stateOrder(rows: StateRow[], order: "asc" | "desc"): string[] {
  const sorted = rows.slice().sort((a, b) => {
    if (a.state !== b.state) {
      if (a.state === null) return -1;
      if (b.state === null) return 1;
      return a.state < b.state ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return (order === "desc" ? sorted.reverse() : sorted).map((r) => r.id);
}

describe("entity list state filter and sort", () => {
  beforeEach(() => {
    expect(applySchema(testDb.db, STATE_SCHEMA, "test").ok).toBe(true);
  });

  it("matches each type by its own lifecycle field, whatever it is called", () => {
    const rows = seedStates();
    const expected = idsWithState(rows, ["in-review"]);
    const page = list(testDb.db, { state: ["in-review"] });
    expect(page.entities.map((e) => e.id).sort()).toEqual(expected.sort());
    expect(page.total).toBe(expected.length);
    // The filter spans every type, including fields that are not `status`.
    expect(new Set(page.entities.map((e) => e.type))).toEqual(
      new Set(["bug", "story", "epic", "chore", "legacy"]),
    );
    // A lifecycle type's decoy `status` never counts as its state.
    for (const entity of page.entities) {
      const spec = STATE_TYPES[entity.type as StateType];
      expect(entity.data[spec.field]).toBe("in-review");
    }
    expect(page.outcome_types).toBeUndefined();
  });

  it("accepts several states, repeated and in any order", () => {
    const rows = seedStates();
    const expected = idsWithState(rows, ["done", "fixed"]).sort();
    for (const state of [
      ["done", "fixed"],
      ["fixed", "done", "done"],
    ])
      expect(
        list(testDb.db, { state })
          .entities.map((e) => e.id)
          .sort(),
      ).toEqual(expected);
    expect(list(testDb.db, { state: ["no-such-state"] }).total).toBe(0);
    // An empty list is no filter, as an empty outcome list is.
    expect(list(testDb.db, { state: [] }).total).toBe(80);
  });

  it("matches exactly, with case and spacing", () => {
    seedStates();
    for (const state of ["In-Review", "in-review ", " in-review", "in_review"])
      expect(list(testDb.db, { state: [state] }).total).toBe(0);
  });

  for (const order of [
    {},
    { sort: "id", order: "desc" },
    { sort: "state", order: "asc" },
    { sort: "state", order: "desc" },
  ] as const) {
    it(`pages exactly the tasks in a state (${JSON.stringify(order)})`, () => {
      const rows = seedStates();
      const expected = idsWithState(rows, ["in-review", "done"]);
      expect(expected.length).toBeGreaterThan(20);
      expectExactWalk(
        { state: ["in-review", "done"], limit: 4, ...order },
        expected,
      );
    });
  }

  for (const order of ["asc", "desc"] as const) {
    it(`sorts by state then id across types and pages (${order})`, () => {
      const rows = seedStates();
      const unpaged = list(testDb.db, { sort: "state", order });
      const expected = stateOrder(rows, order);
      expect(unpaged.entities.map((e) => e.id)).toEqual(expected);
      // Pages of 7 cut through runs of equal states and through the no-state run.
      const pages = walk({ sort: "state", order, limit: 7 });
      expect(pages.length).toBeGreaterThan(10);
      expect(pages.flatMap((p) => p.entities.map((e) => e.id))).toEqual(
        expected,
      );
      for (const page of pages) expect(page.total).toBe(80);
    });
  }

  it("reads a missing, blank or non-string value as no state", () => {
    const rows = seedStates();
    const odd: Record<string, unknown> = {
      "odd-empty": { status: "" },
      "odd-spaces": { status: "   " },
      "odd-tabs": { status: "\t\n" },
      "odd-number": { status: 5 },
      "odd-null": { status: null },
      "odd-object": { status: { state: "open" } },
      "odd-array": { status: ["open"] },
      "odd-bool": { status: true },
      "odd-absent": {},
    };
    for (const [id, data] of Object.entries(odd)) insertRaw(id, "legacy", data);
    const oddIds = Object.keys(odd);

    for (const state of ["", " ", "5", "1", "true", "null", "open"]) {
      const matched = list(testDb.db, { state: [state] }).entities.map(
        (e) => e.id,
      );
      for (const id of oddIds) expect(matched).not.toContain(id);
    }
    const ascending = list(testDb.db, { sort: "state", order: "asc" });
    const leading = ascending.entities
      .slice(0, oddIds.length + rows.filter((r) => r.state === null).length)
      .map((e) => e.id);
    for (const id of oddIds) expect(leading).toContain(id);
  });

  it("matches a lifecycle field whose name contains a dot by its exact key", () => {
    const dotted = `${STATE_SCHEMA}[work_units.job.fields."run.state"]
type = "enum"
values = ["queued", "in-review", "done"]
[work_units.job.lifecycle]
field = "run.state"
dispatchable = ["queued"]
terminal = ["done"]
dependency_satisfied = ["done"]
`;
    expect(applySchema(testDb.db, dotted, "test").ok).toBe(true);
    createEntity(testDb.db, {
      id: "job-review",
      type: "job",
      data: { "run.state": "in-review" },
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
      data: { "run.state": "queued", run: { state: "in-review" } },
    });
    const page = list(testDb.db, { state: ["in-review"] });
    expect(page.entities.map((e) => e.id)).toEqual(["job-review"]);
    const sorted = list(testDb.db, { sort: "state" });
    // done < in-review < queued, read from the dotted key and nowhere else.
    expect(sorted.entities.map((e) => e.id)).toEqual([
      "job-done",
      "job-review",
      "job-nested",
    ]);
  });

  it("falls back to status for every type when no schema is applied", () => {
    // A fresh project: no schema, so no lifecycle fields at all.
    testDb.rawDb.close();
    testDb = createTestDb();
    createEntity(testDb.db, {
      id: "a",
      type: "task",
      data: { status: "alpha" },
    });
    createEntity(testDb.db, {
      id: "b",
      type: "task",
      data: { status: "beta" },
    });
    // `stage` is not a lifecycle field here, so this task has no state.
    createEntity(testDb.db, {
      id: "c",
      type: "task",
      data: { stage: "alpha" },
    });
    expect(
      list(testDb.db, { state: ["alpha"] }).entities.map((e) => e.id),
    ).toEqual(["a"]);
    expect(
      list(testDb.db, { sort: "state", order: "desc" }).entities.map(
        (e) => e.id,
      ),
    ).toEqual(["b", "a", "c"]);
  });

  it("composes with type, restrictions, archived, blocked and outcome", () => {
    const rows = seedStates();
    const inReview = (type: StateType) =>
      rows
        .filter((r) => r.type === type && r.state === "in-review")
        .map((r) => r.id)
        .sort();
    const ids = (filter: ListFilter) =>
      list(testDb.db, filter)
        .entities.map((e) => e.id)
        .sort();
    expect(ids({ state: ["in-review"], type: "story" })).toEqual(
      inReview("story"),
    );
    expect(ids({ state: ["in-review"], type: ["story", "chore"] })).toEqual(
      [...inReview("story"), ...inReview("chore")].sort(),
    );
    expect(
      ids({ state: ["in-review"], restrictions: { task_types: ["bug"] } }),
    ).toEqual(inReview("bug"));
    expect(
      list(testDb.db, {
        state: ["in-review"],
        restrictions: { task_types: ["epic"] },
        sort: "state",
      }).total,
    ).toBe(inReview("epic").length);

    const target = inReview("story")[0];
    testDb.db
      .update(schema.entities)
      .set({ archived: 1 })
      .where(eq(schema.entities.id, target))
      .run();
    expect(ids({ state: ["in-review"], type: "story", archived: 0 })).toEqual(
      inReview("story").filter((id) => id !== target),
    );
    expect(ids({ state: ["in-review"], type: "story", archived: 1 })).toEqual([
      target,
    ]);

    // Another filter narrows the same state list: failing stories only.
    const failed = list(testDb.db, {
      state: ["in-review"],
      outcome: ["success"],
    });
    for (const entity of failed.entities)
      expect(entity.data.state ?? entity.data.stage ?? entity.data.phase).toBe(
        "in-review",
      );
    expect(failed.total).toBe(0);
  });

  describe("cursor binding", () => {
    it("ends a cursor when the state filter or sort changes", () => {
      seedStates();
      const cursor = list(testDb.db, {
        state: ["in-review", "done"],
        sort: "state",
        limit: 5,
      }).next_cursor as string;
      expect(cursor).toEqual(expect.any(String));
      const others: ListFilter[] = [
        { sort: "state" },
        { state: ["in-review"], sort: "state" },
        { state: ["in-review", "done", "open"], sort: "state" },
        { state: ["in-review", "done"] },
        { state: ["in-review", "done"], sort: "status" },
        { state: ["in-review", "done"], sort: "state", order: "desc" },
        { state: ["in-review", "done"], sort: "state", type: "bug" },
      ];
      for (const other of others)
        expect(() => list(testDb.db, { ...other, limit: 5, cursor })).toThrow(
          InvalidCursorError,
        );
      // Order and repeats of the list do not matter.
      expect(
        list(testDb.db, {
          state: ["done", "in-review", "done"],
          sort: "state",
          limit: 5,
          cursor,
        }).entities,
      ).toHaveLength(5);
    });

    it("ends a state cursor under any other sort and a sort cursor under any filter", () => {
      seedStates();
      const sortCursor = list(testDb.db, { sort: "state", limit: 5 })
        .next_cursor as string;
      for (const other of [
        {},
        { sort: "status" },
        { sort: "title" },
        { sort: "type" },
        { sort: "state", state: ["done"] },
      ] as ListFilter[])
        expect(() =>
          list(testDb.db, { ...other, limit: 5, cursor: sortCursor }),
        ).toThrow(InvalidCursorError);
      const filterCursor = list(testDb.db, { state: ["done"], limit: 5 })
        .next_cursor as string;
      for (const other of [
        {},
        { sort: "state" },
        { state: ["fixed"] },
        { state: ["done"], blocked: true },
        { state: ["done"], outcome: ["success"] },
      ] as ListFilter[])
        expect(() =>
          list(testDb.db, { ...other, limit: 5, cursor: filterCursor }),
        ).toThrow(InvalidCursorError);
      // A cursor from another sort never opens a state sort.
      const created = list(testDb.db, { limit: 5 }).next_cursor as string;
      expect(() =>
        list(testDb.db, { sort: "state", limit: 5, cursor: created }),
      ).toThrow(InvalidCursorError);
    });

    it("ends a state cursor when a schema change moves what a state is", () => {
      seedStates();
      const cursor = list(testDb.db, { sort: "state", limit: 5 })
        .next_cursor as string;
      expect(
        list(testDb.db, { sort: "state", limit: 5, cursor }).entities,
      ).toHaveLength(5);
      // `epic` keeps its state in `stage` from now on: the same rows would
      // order differently, so the old position no longer means anything.
      const moved = STATE_SCHEMA.replace(
        "[work_units.epic.fields.phase]",
        "[work_units.epic.fields.stage]",
      ).replace('field = "phase"', 'field = "stage"');
      expect(moved).not.toBe(STATE_SCHEMA);
      expect(applySchema(testDb.db, moved, "test", "relax").ok).toBe(true);
      expect(() =>
        list(testDb.db, { sort: "state", limit: 5, cursor }),
      ).toThrow(InvalidCursorError);
      // Cursors that do not depend on states are untouched by the change.
      const plain = list(testDb.db, { limit: 5 }).next_cursor as string;
      expect(
        list(testDb.db, { limit: 5, cursor: plain }).entities,
      ).toHaveLength(5);
    });

    it("keeps cursors issued before state existed valid", () => {
      seedStates();
      const first = list(testDb.db, { limit: 5, sort: "status" });
      const last = first.entities.at(-1);
      if (!last) throw new Error("empty page");
      // The exact binding `list` used before `state` existed.
      const legacy = encodeCursor(
        fingerprint({
          type: null,
          archived: null,
          dataFilter: null,
          tag: null,
          tagFilter: null,
          sort: "status",
          order: "asc",
        }),
        { k: last.data.status ?? null, id: last.id },
      );
      expect(first.next_cursor).toBe(legacy);
      expect(
        list(testDb.db, { limit: 5, sort: "status", cursor: legacy }).entities,
      ).toHaveLength(5);
    });
  });

  it("binds a fixed number of values however many types declare a lifecycle", () => {
    // 150 lifecycle types would bind 300+ values if each were a parameter.
    const parts = [STATE_SCHEMA];
    for (let i = 0; i < 150; i++) {
      const type = `t${String(i).padStart(3, "0")}`;
      parts.push(
        `[work_units.${type}.fields.f${i}]`,
        'type = "string"',
        `[work_units.${type}.lifecycle]`,
        `field = "f${i}"`,
        'dispatchable = ["todo"]',
        'terminal = ["done"]',
        'dependency_satisfied = ["done"]',
      );
    }
    expect(applySchema(testDb.db, parts.join("\n"), "test").ok).toBe(true);
    for (let i = 0; i < 150; i++)
      createEntity(testDb.db, {
        id: `many-${String(i).padStart(3, "0")}`,
        type: `t${String(i).padStart(3, "0")}`,
        data: { [`f${i}`]: i % 2 ? "done" : "todo" },
      });

    let widest = 0;
    const capped = drizzle(testDb.rawDb, {
      schema,
      logger: {
        logQuery(query, params) {
          widest = Math.max(widest, params.length);
          if (params.length > 100)
            throw new Error(
              `too many SQL variables (${params.length}): ${query.slice(0, 80)}`,
            );
        },
      },
    }) as unknown as typeof testDb.db;

    const states = Array.from({ length: 40 }, (_, i) => `x${i}`).concat("done");
    const first = list(capped, { state: states, sort: "state", limit: 20 });
    expect(first.total).toBe(75);
    expect(first.entities).toHaveLength(20);
    const second = list(capped, {
      state: states,
      sort: "state",
      limit: 20,
      cursor: first.next_cursor as string,
    });
    expect(second.entities).toHaveLength(20);
    expect(widest).toBeLessThanOrEqual(100);
    expect(widest).toBeGreaterThan(0);
  });
});
