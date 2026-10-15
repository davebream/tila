import { ContinuityError, type JournalArchiveReader } from "@tila/core";
import {
  type CredentialPolicy,
  JOURNAL_REPLAY_SCAN_BUDGET,
  JournalEventKindSchema,
  type NamespaceRestrictions,
  formatRecordResource,
} from "@tila/schemas";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as coordination from "../src/coordination-ops";
import * as entityOps from "../src/entity-ops";
import * as archiveOps from "../src/journal-archive-ops";
import {
  SCOPED_JOURNAL_KINDS,
  SCOPED_SCAN_FIRST_SPAN,
  SCOPED_SCAN_LIMIT,
  SCOPED_SCAN_MAX_SPAN,
  foldWindow,
  listScopedJournal,
  nextWindowEnd,
  scopedReplay,
  startScan,
  visibleJournalEvents,
} from "../src/journal-visibility";
import * as schema from "../src/schema";
import * as sweepOps from "../src/sweep-ops";
import { type TestDb, createTestDb, testOrigin } from "./helpers";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

const CAPS = [
  "journal:read",
  "tasks:read",
  "claims:read",
  "records:read",
] as const;
const policy = (
  restrictions?: NamespaceRestrictions,
  capabilities: readonly CredentialPolicy["capabilities"][number][] = CAPS,
): CredentialPolicy => ({
  role: "viewer",
  capabilities: [...capabilities],
  ...(restrictions ? { restrictions } : {}),
});
const ANSWER_A1 = { type: "answer", key_prefixes: ["a1"] };
const QUESTION_Q1 = { type: "question", key_prefixes: ["q1"] };

let f: TestDb;
beforeEach(() => {
  f = createTestDb();
});
afterEach(() => f.rawDb.close());

function append(
  kind: string,
  resource: string,
  data: unknown = {},
  t = Date.now(),
): number {
  const result = f.rawDb
    .prepare(
      "INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data) VALUES (?, ?, ?, 'p', 'q', '{}', '', ?)",
    )
    .run(t, kind, resource, JSON.stringify(data));
  return Number(result.lastInsertRowid);
}
function task(id: string, type: string, parent?: unknown): void {
  entityOps.create(
    f.db,
    {
      id,
      type,
      data: parent === undefined ? {} : { parent_id: parent },
      created_by: "seed",
    },
    1,
    testOrigin(),
  );
}
const visibleSeqs = (
  events: { seq: number; kind: string; resource: string; data: unknown }[],
  p: CredentialPolicy,
) => visibleJournalEvents(f.db, p, events).map((event) => event.seq);
/**
 * A database that counts the statements run through it and refuses both a
 * statement binding over 100 values and more than `cap` statements, so a scan
 * that is not bounded fails at once instead of running on.
 */
function metered(raw: TestDb["rawDb"], cap = 200) {
  const stats = { statements: 0, widest: 0 };
  const db = drizzle(raw, {
    schema,
    logger: {
      logQuery(query, params) {
        stats.statements++;
        stats.widest = Math.max(stats.widest, params.length);
        if (params.length > 100)
          throw new Error(`too many SQL variables: ${query.slice(0, 80)}`);
        if (stats.statements > cap)
          throw new Error(`unbounded scan: more than ${cap} statements`);
      },
    },
  }) as unknown as Db;
  return { db, stats };
}

function allRows() {
  return f.db
    .select()
    .from(schema.journal)
    .all()
    .map((row) => ({
      seq: row.seq,
      kind: row.kind,
      resource: row.resource,
      data: JSON.parse(row.data) as unknown,
    }));
}

describe("the visibility predicate", () => {
  it("shows entity and claim events of permitted task types and hides the rest", () => {
    task("t-a", "alpha");
    task("t-b", "beta");
    const shown = [
      append("entity.updated", "t-a"),
      append("entity.archived", "t-a"),
      append("claim.acquired", "alpha:t-a"),
      append("claim.renewed", "alpha:t-a"),
      append("claim.released", "alpha:t-a"),
    ];
    append("entity.updated", "t-b");
    append("claim.acquired", "beta:t-b");
    const rows = allRows();
    // Creation went through the real emitter: `entity.created` for t-a too.
    const created = rows.find(
      (r) => r.kind === "entity.created" && r.resource === "t-a",
    );
    expect(created).toBeDefined();
    expect(visibleSeqs(rows, policy({ task_types: ["alpha"] }))).toEqual([
      created?.seq,
      ...shown,
    ]);
    expect(visibleSeqs(rows, policy({ task_types: ["beta"] }))).toEqual([
      rows.find((r) => r.kind === "entity.created" && r.resource === "t-b")
        ?.seq,
      rows.find((r) => r.kind === "entity.updated" && r.resource === "t-b")
        ?.seq,
      rows.find((r) => r.kind === "claim.acquired" && r.resource === "beta:t-b")
        ?.seq,
    ]);
  });

  it("hides every kind outside the allowlist, even on a readable resource", () => {
    task("t-a", "alpha");
    const allowed = new Set(SCOPED_JOURNAL_KINDS);
    const hidden: number[] = [];
    for (const kind of JournalEventKindSchema.options) {
      if (allowed.has(kind)) continue;
      for (const resource of ["t-a", "alpha:t-a", "record:answer/a1/x"])
        hidden.push(append(kind, resource));
    }
    // Kinds this build does not know yet stay hidden until added on purpose.
    for (const kind of [
      "entity.future",
      "claim.stolen",
      "record.deleted",
      "relationship.entity.created",
      "ENTITY.CREATED",
    ])
      hidden.push(append(kind, "t-a"));
    expect(hidden.length).toBeGreaterThan(100);
    const p = policy({ task_types: ["alpha"], records: [ANSWER_A1] });
    expect(visibleSeqs(allRows(), p).filter((s) => hidden.includes(s))).toEqual(
      [],
    );
  });

  it("allowlists exactly the entity, claim and record kinds the journal emits", () => {
    expect([...SCOPED_JOURNAL_KINDS].sort()).toEqual(
      JournalEventKindSchema.options
        .filter((kind) => /^(entity|claim|record)\.[a-z]+$/.test(kind))
        .sort(),
    );
  });

  it("judges a resource by the shape its kind produces, never by how it looks", () => {
    task("t-a", "alpha");
    const p = policy({ task_types: ["alpha"] });
    const hidden = [
      // An entity event names a bare id: a claim-form or custom string is not it.
      append("entity.created", "alpha:t-a"),
      append("entity.updated", ""),
      append("entity.updated", "no-such-task"),
      // A claim event names `<type>:<id>`: bare ids and custom locks are not it.
      append("claim.acquired", "t-a"),
      append("claim.acquired", "deploy-lock"),
      append("claim.acquired", "alpha:"),
      append("claim.acquired", ":t-a"),
      append("claim.acquired", "beta:t-a"),
      append("claim.acquired", "alpha:no-such-task"),
      // Records need `record:<type>/<key>`.
      append("record.created", "t-a"),
      append("record.created", "alpha:t-a"),
      append("record.created", "record:answer"),
      append("record.created", "record:/a1/x"),
    ];
    expect(visibleSeqs(allRows(), p).filter((s) => hidden.includes(s))).toEqual(
      [],
    );
  });

  it("applies the parent rule only while task types are restricted", () => {
    task("p-a", "alpha");
    task("p-b", "beta");
    task("child-ok", "alpha", "p-a");
    task("child-root", "alpha");
    task("child-null", "alpha", null);
    task("child-bad-parent", "alpha", "p-b");
    task("child-missing", "alpha", "no-such-parent");
    task("child-number", "alpha", 7);
    const rows = allRows().filter((r) => r.kind === "entity.created");
    const seqOf = (id: string) => rows.find((r) => r.resource === id)?.seq;
    const shown = visibleSeqs(rows, policy({ task_types: ["alpha"] }));
    expect(shown).toEqual(
      ["p-a", "child-ok", "child-root", "child-null"].map(seqOf),
    );
    // Only records are restricted: tasks are not, so the parent rule is idle.
    const recordsOnly = visibleSeqs(rows, policy({ records: [ANSWER_A1] }));
    expect(recordsOnly).toEqual(rows.map((r) => r.seq));
    // Both types permitted: the cross-type parent is readable too.
    expect(
      visibleSeqs(rows, policy({ task_types: ["alpha", "beta"] })),
    ).toContain(seqOf("child-bad-parent"));
  });

  it("follows the current parent, so re-parenting changes what earlier events show", () => {
    task("p-a", "alpha");
    task("p-b", "beta");
    task("child", "alpha", "p-a");
    const created = allRows().find(
      (r) => r.kind === "entity.created" && r.resource === "child",
    );
    const p = policy({ task_types: ["alpha"] });
    expect(visibleSeqs([created as never], p)).toEqual([created?.seq]);
    f.rawDb
      .prepare("UPDATE entities SET data = ? WHERE id = 'child'")
      .run(JSON.stringify({ parent_id: "p-b" }));
    expect(visibleSeqs([created as never], p)).toEqual([]);
  });

  it("reads records through the READ side of the record namespace only", () => {
    const events = [
      ["answer", "a1"],
      ["answer", "a1/x"],
      ["answer", "a10/x"],
      ["answer", "b/x"],
      ["question", "q1/old"],
      ["question", "q2/out"],
    ].map(([type, key]) => ({
      type,
      key,
      seq: append("record.updated", formatRecordResource(type, key)),
    }));
    const pick = (...wanted: string[]) =>
      events
        .filter((e) => wanted.includes(`${e.type}/${e.key}`))
        .map((e) => e.seq);
    const rows = allRows();
    const cases: [string, NamespaceRestrictions | undefined, string[]][] = [
      [
        "split: read answers, write questions",
        { records_read: [ANSWER_A1], records_write: [QUESTION_Q1] },
        ["answer/a1", "answer/a1/x"],
      ],
      [
        "split: write-only yields no record events",
        { records_write: [QUESTION_Q1, ANSWER_A1] },
        [],
      ],
      [
        "split: an empty read list denies every record",
        { records_read: [], records_write: [QUESTION_Q1] },
        [],
      ],
      [
        "split: read-only",
        { records_read: [QUESTION_Q1] },
        ["question/q1/old"],
      ],
      [
        "legacy: the one list governs reads, as it always did",
        { records: [QUESTION_Q1, ANSWER_A1] },
        ["answer/a1", "answer/a1/x", "question/q1/old"],
      ],
      [
        "a whole type without prefixes",
        { records_read: [{ type: "answer" }] },
        ["answer/a1", "answer/a1/x", "answer/a10/x", "answer/b/x"],
      ],
      [
        "task types only: records are unrestricted",
        { task_types: ["alpha"] },
        events.map((e) => `${e.type}/${e.key}`),
      ],
    ];
    for (const [label, restrictions, wanted] of cases)
      expect(visibleSeqs(rows, policy(restrictions)), label).toEqual(
        pick(...wanted),
      );
  });

  it("applies the record side to claims on records and the task rule to claims on tasks", () => {
    task("t-a", "alpha");
    const readable = append("claim.acquired", "record:answer/a1/x");
    append("claim.acquired", "record:question/q1/old");
    const own = append("claim.released", "alpha:t-a");
    const p = policy({
      task_types: ["alpha"],
      records_read: [ANSWER_A1],
      records_write: [QUESTION_Q1],
    });
    expect(
      visibleSeqs(
        allRows().filter((r) => r.kind.startsWith("claim.")),
        p,
      ),
    ).toEqual([readable, own]);
  });

  it("requires the read capability of what the event shows", () => {
    task("t-a", "alpha");
    const e = append("entity.updated", "t-a");
    const c = append("claim.acquired", "alpha:t-a");
    const r = append("record.updated", "record:answer/a1/x");
    const restrictions = { task_types: ["alpha"], records: [ANSWER_A1] };
    const rows = allRows().filter((row) => [e, c, r].includes(row.seq));
    const without = (cap: string) =>
      policy(
        restrictions,
        CAPS.filter((x) => x !== cap),
      );
    expect(visibleSeqs(rows, policy(restrictions))).toEqual([e, c, r]);
    expect(visibleSeqs(rows, without("tasks:read"))).toEqual([c, r]);
    expect(visibleSeqs(rows, without("claims:read"))).toEqual([e, r]);
    expect(visibleSeqs(rows, without("records:read"))).toEqual([e, c]);
  });

  it("hides an event whose payload holds anything beyond what its kind carries", () => {
    task("t-a", "alpha");
    task("t-b", "beta");
    const p = policy({ task_types: ["alpha"], records: [ANSWER_A1] });
    const expired = {
      mode: "exclusive",
      expired_at: 5,
      principal_id: "x",
      participant_id: "y",
    };
    const shown = [
      append("entity.updated", "t-a", {}),
      append("claim.expired", "alpha:t-a", expired),
      append("claim.expired", "alpha:t-a", { ...expired, principal_id: null }),
      append("claim.expired", "alpha:t-a", {}),
    ];
    const hidden = [
      // A reference to a task the credential may not read.
      append("entity.updated", "t-a", { parent_id: "t-b" }),
      append("entity.created", "t-a", { to_id: "t-b", type: "blocks" }),
      append("claim.acquired", "alpha:t-a", { resource: "beta:t-b" }),
      append("record.updated", "record:answer/a1/x", { from: "question/q1" }),
      // Nested, or merely the wrong shape.
      append("entity.updated", "t-a", { nested: { id: "t-b" } }),
      append("entity.updated", "t-a", { list: ["t-b"] }),
      append("claim.expired", "alpha:t-a", { ...expired, extra: "t-b" }),
      append("claim.expired", "alpha:t-a", { ...expired, mode: { id: "t-b" } }),
      append("claim.expired", "alpha:t-a", { ...expired, expired_at: "5" }),
      append("entity.updated", "t-a", null),
      append("entity.updated", "t-a", ["t-b"]),
      append("entity.updated", "t-a", "t-b"),
    ];
    const visible = visibleSeqs(allRows(), p);
    for (const seq of shown) expect(visible).toContain(seq);
    for (const seq of hidden) expect(visible).not.toContain(seq);
  });

  it("does not take a record claim for a task of the type named record", () => {
    task("question/q1", "record");
    const shadowed = append("claim.acquired", "record:question/q1");
    const real = append("claim.acquired", "record:question/q2");
    const p = policy({ records: [{ type: "question" }] });
    expect(
      visibleSeqs(
        allRows().filter((r) => r.kind === "claim.acquired"),
        p,
      ),
    ).toEqual([real]);
    expect(shadowed).not.toBe(real);
  });

  it("shows what the real emitters produce, including a swept claim expiry", () => {
    const origin = testOrigin();
    task("t-a", "alpha");
    const claim = coordination.acquire(
      f.db,
      "alpha:t-a",
      origin,
      "exclusive",
      1,
      undefined,
      1_000,
    );
    expect(claim.acquired).toBe(true);
    if (!claim.acquired) return;
    coordination.renew(f.db, "alpha:t-a", origin, claim.fence, 1, 1_000);
    sweepOps.sweep(f.db, 10_000);
    const rows = allRows();
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual([
      "entity.created",
      "claim.acquired",
      "claim.renewed",
      "claim.expired",
    ]);
    expect(visibleSeqs(rows, policy({ task_types: ["alpha"] }))).toEqual(
      rows.map((r) => r.seq),
    );
    expect(visibleSeqs(rows, policy({ task_types: ["beta"] }))).toEqual([]);
  });
});

describe("the Durable Object bound-value cap", () => {
  const DO_SQLITE_VARIABLE_LIMIT = 100;
  let capped: Db;
  let widest = 0;
  beforeEach(() => {
    widest = 0;
    capped = drizzle(f.rawDb, {
      schema,
      logger: {
        logQuery(query, params) {
          widest = Math.max(widest, params.length);
          if (params.length > DO_SQLITE_VARIABLE_LIMIT)
            throw new Error(
              `too many SQL variables (${params.length}): ${query.slice(0, 120)}`,
            );
        },
      },
    }) as unknown as Db;
  });

  it("judges events over many distinct tasks and parents in bounded statements", () => {
    const insert = f.rawDb.prepare(
      "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, 1, ?, 0, 1, 1, 's')",
    );
    for (let p = 0; p < 4; p++)
      insert.run(`parent-${p}`, p === 3 ? "beta" : "alpha", "{}");
    const expected: number[] = [];
    for (let i = 0; i < 1200; i++) {
      const id = `task-${i}`;
      const hiddenParent = i % 5 === 0;
      insert.run(
        id,
        "alpha",
        JSON.stringify({ parent_id: `parent-${hiddenParent ? 3 : i % 3}` }),
      );
      const seq = append("claim.acquired", `alpha:${id}`);
      if (!hiddenParent) expected.push(seq);
    }
    const p = policy({ task_types: ["alpha"] });
    const shown = visibleJournalEvents(capped, p, allRows()).map((e) => e.seq);
    expect(shown).toEqual(expected);
    expect(widest).toBeLessThanOrEqual(DO_SQLITE_VARIABLE_LIMIT);
    expect(widest).toBeGreaterThan(0);
    // The scoped list and replay reach it through the same lookup.
    expect(
      listScopedJournal(capped, p, { limit: 1000, after_seq: 0 }).events.map(
        (e) => e.seq,
      ),
    ).toEqual(expected.slice(0, 1000));
  });
});

describe("the scoped list", () => {
  /** Alternating visible and hidden events; returns the visible seqs in order. */
  function seedAlternating(pairs: number): number[] {
    task("t-a", "alpha");
    task("t-b", "beta");
    const visible: number[] = [
      allRows().find((r) => r.kind === "entity.created" && r.resource === "t-a")
        ?.seq as number,
    ];
    for (let i = 0; i < pairs; i++) {
      append("entity.updated", "t-b");
      append("record.updated", "record:question/q1/hidden");
      visible.push(append("entity.updated", "t-a"));
      append("custom.reported", "project", { event_name: "x" });
    }
    return visible;
  }
  const p = policy({
    task_types: ["alpha"],
    records_read: [ANSWER_A1],
    records_write: [QUESTION_Q1],
  });

  it("fills each page with exactly limit visible events and resumes without loss or duplicates", () => {
    const visible = seedAlternating(12);
    const pages: number[][] = [];
    let after = 0;
    for (let guard = 0; guard < 20; guard++) {
      const page = listScopedJournal(f.db, p, {
        after_seq: after,
        limit: 5,
      }).events;
      pages.push(page.map((e) => e.seq));
      if (page.length < 5) break;
      after = page[page.length - 1].seq;
    }
    expect(pages.map((x) => x.length)).toEqual([5, 5, 3]);
    expect(pages.flat()).toEqual(visible);
    expect(new Set(pages.flat()).size).toBe(visible.length);
  });

  it("returns the newest visible events first when no cursor is given", () => {
    const visible = seedAlternating(12);
    expect(
      listScopedJournal(f.db, p, { limit: 4 }).events.map((e) => e.seq),
    ).toEqual(visible.slice(-4).reverse());
    // The page is full of visible events however many hidden ones sit between.
    expect(listScopedJournal(f.db, p, { limit: 100 }).events).toHaveLength(
      visible.length,
    );
  });

  it("spans more rows than one read batch without a short page", () => {
    task("t-a", "alpha");
    for (let i = 0; i < 1300; i++) append("custom.reported", "project", {});
    const last = append("entity.updated", "t-a");
    const page = listScopedJournal(f.db, p, { after_seq: 0, limit: 2 });
    expect(page.events.map((e) => e.seq)).toEqual([1, last]);
    expect(page.has_more).toBe(false);
    expect(
      listScopedJournal(f.db, p, { limit: 1 }).events.map((e) => e.seq),
    ).toEqual([last]);
  });

  it("applies the list filters and cannot be steered toward hidden kinds", () => {
    const visible = seedAlternating(3);
    const seqs = (query: Parameters<typeof listScopedJournal>[2]) =>
      listScopedJournal(f.db, p, query).events.map((e) => e.seq);
    expect(seqs({ kind: "entity.updated" })).toEqual(
      visible.slice(1).reverse(),
    );
    expect(seqs({ kind: ["entity.created", "entity.archived"] })).toEqual([
      visible[0],
    ]);
    expect(seqs({ resource: "t-a", after_seq: 0 })).toEqual(visible);
    expect(seqs({ resource: ["t-a", "t-b"], after_seq: 0 })).toEqual(visible);
    // Hidden kinds, and report selectors, only ever select nothing.
    for (const query of [
      { kind: "custom.reported" },
      { kind: ["schema.applied", "room.created"] },
      { event_name: "x" },
      { correlation_id: "c" },
      { resource: "project" },
    ])
      expect(seqs(query)).toEqual([]);
  });

  it("answers a cursor inside the archived region like the unrestricted list", () => {
    seedAlternating(2);
    // Nothing is returned, the cursor stays put, and the page is not "caught
    // up": readable events may be in the archive.
    expect(
      listScopedJournal(
        f.db,
        p,
        { after_seq: 3, limit: 10 },
        { lastArchivedSeq: 5 },
      ),
    ).toEqual({ events: [], has_more: true, next_after_seq: 3 });
    expect(
      listScopedJournal(
        f.db,
        p,
        { after_seq: 5, limit: 10 },
        { lastArchivedSeq: 5 },
      ).events.length,
    ).toBeGreaterThan(0);
  });

  it("keeps the documented event shape", () => {
    task("t-a", "alpha");
    const [event] = listScopedJournal(f.db, p, {
      after_seq: 0,
      limit: 1,
    }).events;
    expect(Object.keys(event).sort()).toEqual(
      [
        "data",
        "environment",
        "fence",
        "kind",
        "participant_id",
        "principal_id",
        "resource",
        "seq",
        "t",
        "token_id",
      ].sort(),
    );
  });
});

describe("the scoped replay", () => {
  const p = policy({
    task_types: ["alpha"],
    records_read: [ANSWER_A1],
    records_write: [QUESTION_Q1],
  });
  type Row = Record<string, unknown>;

  /** An archive holding exactly the rows given, as the R2 reader would yield. */
  function reader(rows: () => Row[]): JournalArchiveReader {
    return {
      async *read() {
        for (const row of rows()) yield row;
      },
    };
  }
  /** Move every live row up to `through` into the returned archive. */
  function archiveThrough(through: number): Row[] {
    const batch = archiveOps.getArchivableEvents(f.db, { maxAgeMs: -1 });
    const moved = batch.events.filter((e) => e.seq <= through);
    archiveOps.markArchived(f.db, through);
    return moved.map((e) => ({ ...e }));
  }
  async function pageAll(
    archive: JournalArchiveReader | undefined,
    limit: number,
    filter = "",
  ) {
    const pages: {
      seqs: number[];
      next: number;
      more: boolean;
      through: number;
    }[] = [];
    let after = 0;
    let through: number | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const response = await scopedReplay(
        f.db,
        p,
        {
          after_seq: after,
          limit,
          ...(through === undefined ? {} : { through_seq: through }),
          ...(filter ? { event_name: filter } : {}),
        },
        archive,
      );
      pages.push({
        seqs: response.events.map((e) => e.seq),
        next: response.next_after_seq,
        more: response.has_more,
        through: response.through_seq,
      });
      through = response.through_seq;
      after = response.next_after_seq;
      if (!response.has_more) break;
    }
    return pages;
  }
  /** 30 visible events spread over alternating hidden ones; returns visible seqs. */
  function seed(): number[] {
    task("t-a", "alpha");
    task("t-b", "beta");
    const visible = [1];
    for (let i = 0; i < 29; i++) {
      append("entity.updated", "t-b");
      append("custom.reported", "project", { event_name: "n", i });
      append("record.updated", "record:question/q1/a");
      visible.push(
        append(
          i % 2 ? "record.updated" : "entity.updated",
          i % 2 ? "record:answer/a1/x" : "t-a",
        ),
      );
    }
    return visible;
  }

  it("pages exactly limit visible events across the archive boundary with nothing lost or repeated", async () => {
    const visible = seed();
    const live = await pageAll(undefined, 7);
    const archived = archiveThrough(60);
    const split = await pageAll(
      reader(() => archived),
      7,
    );

    for (const pages of [live, split]) {
      expect(pages.flatMap((x) => x.seqs)).toEqual(visible);
      expect(pages.map((x) => x.seqs.length)).toEqual([7, 7, 7, 7, 2]);
      expect(pages.map((x) => x.more)).toEqual([true, true, true, true, false]);
      // A page that is not the last one resumes right after its last event.
      for (const page of pages.slice(0, -1))
        expect(page.next).toBe(page.seqs[page.seqs.length - 1]);
    }
    // The archived region reads exactly as the live region did.
    expect(split).toEqual(live);
  });

  it("does not report more when only hidden events remain, and says no more about them", async () => {
    task("t-a", "alpha");
    const through = append("custom.reported", "project", {});
    append("entity.updated", "t-b");
    const high = append("room.created", "room:1");
    const response = await scopedReplay(f.db, p, { after_seq: 0, limit: 5 });
    expect(response).toEqual({
      ok: true,
      events: [expect.objectContaining({ seq: 1, kind: "entity.created" })],
      next_after_seq: high,
      through_seq: high,
      has_more: false,
    });
    expect(through).toBeLessThan(high);
  });

  it("returns an empty, finished page when nothing is visible", async () => {
    for (let i = 0; i < 5; i++) append("room.created", `room:${i}`);
    expect(await scopedReplay(f.db, p, { after_seq: 0 })).toEqual({
      ok: true,
      events: [],
      next_after_seq: 5,
      through_seq: 5,
      has_more: false,
    });
    expect(await scopedReplay(f.db, p, { after_seq: 5 })).toEqual({
      ok: true,
      events: [],
      next_after_seq: 5,
      through_seq: 5,
      has_more: false,
    });
  });

  it("keeps the requested bounds and refuses invalid ones the way replay does", async () => {
    seed();
    const high = allRows().length;
    const pinned = await scopedReplay(f.db, p, {
      after_seq: 0,
      limit: 200,
      through_seq: 10,
    });
    expect(pinned.through_seq).toBe(10);
    expect(Math.max(...pinned.events.map((e) => e.seq))).toBeLessThanOrEqual(
      10,
    );
    for (const input of [
      { after_seq: high + 1 },
      { after_seq: 0, through_seq: high + 1 },
      { after_seq: 5, through_seq: 4 },
    ])
      await expect(scopedReplay(f.db, p, input)).rejects.toMatchObject({
        code: "invalid-cursor",
      });
  });

  it("proves history complete before filtering: lost history fails even if all of it is hidden", async () => {
    for (let i = 0; i < 4; i++) append("room.created", `room:${i}`);
    const archived = archiveThrough(4);
    append("room.created", "room:live");
    const probe = (archive: JournalArchiveReader | undefined) =>
      scopedReplay(f.db, p, { after_seq: 0 }, archive);

    await expect(probe(undefined)).rejects.toMatchObject({
      code: "journal-history-unavailable",
      status: 503,
    });
    await expect(probe(reader(() => archived.slice(1)))).rejects.toMatchObject({
      code: "journal-history-unavailable",
      status: 503,
    });
    await expect(
      probe({
        // biome-ignore lint/correctness/useYield: a reader that fails outright
        async *read() {
          throw new Error("boom");
        },
      }),
    ).rejects.toBeInstanceOf(ContinuityError);
    await expect(
      probe(
        reader(() => [
          ...archived,
          { ...archived[0], resource: "room:tampered" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "journal-history-conflict", status: 409 });
    // The error names a sequence and nothing of what the events held.
    const error = await probe(reader(() => archived.slice(1))).catch((e) => e);
    expect(error.message).not.toMatch(/room/);
    // Complete history answers.
    expect(await probe(reader(() => archived))).toMatchObject({
      events: [],
      has_more: false,
    });
  });

  it("applies report selectors on top of visibility and still verifies the window", async () => {
    task("t-a", "alpha");
    append("custom.reported", "project", {
      event_name: "pipeline.passed",
      correlation_id: "run-1",
    });
    const archived = archiveThrough(2);
    for (const filter of [
      { event_name: "pipeline.passed" },
      { correlation_id: "run-1" },
      { event_name: "pipeline.passed", correlation_id: "run-1" },
    ]) {
      expect(
        await scopedReplay(
          f.db,
          p,
          { after_seq: 0, ...filter },
          reader(() => archived),
        ),
      ).toMatchObject({ events: [], has_more: false });
      await expect(
        scopedReplay(f.db, p, { after_seq: 0, ...filter }, undefined),
      ).rejects.toMatchObject({ code: "journal-history-unavailable" });
    }
  });

  it(
    "ends an over-long scan with an honest cursor and resumes to the visible event",
    { timeout: 60_000 },
    async () => {
      task("t-a", "alpha");
      const hidden = SCOPED_SCAN_LIMIT + JOURNAL_REPLAY_SCAN_BUDGET * 5;
      f.rawDb
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data)
         SELECT 1, 'room.created', 'room:bulk', 'p', 'q', '{}', '', '{}' FROM n`,
        )
        .run(hidden);
      const needle = append("entity.updated", "t-a");
      expect(needle).toBe(hidden + 2);

      const first = await scopedReplay(metered(f.rawDb).db, p, {
        after_seq: 1,
        limit: 5,
      });
      expect(first.events).toEqual([]);
      expect(first.has_more).toBe(true);
      expect(first.through_seq).toBe(needle);
      // Exactly the bound, from the cursor given: no more is ever examined.
      expect(first.next_after_seq).toBe(1 + SCOPED_SCAN_LIMIT);
      expect(first.next_after_seq).toBeLessThan(needle);

      const second = await scopedReplay(metered(f.rawDb).db, p, {
        after_seq: first.next_after_seq,
        limit: 5,
        through_seq: first.through_seq,
      });
      expect(second.events.map((e) => e.seq)).toEqual([needle]);
      expect(second).toMatchObject({ has_more: false, next_after_seq: needle });
    },
  );

  it("reads every visible event of a project once, however it is split between live and archived", async () => {
    const visible = seed();
    const archived = archiveThrough(40);
    for (const limit of [1, 3, 200]) {
      const pages = await pageAll(
        reader(() => archived),
        limit,
      );
      expect(pages.flatMap((x) => x.seqs)).toEqual(visible);
      expect(pages[pages.length - 1].more).toBe(false);
      expect(new Set(pages.map((x) => x.through)).size).toBe(1);
    }
  });
});

// These build journals larger than one request may examine; a loaded host
// should slow them down, not fail them.
describe("bounded scans", { timeout: 60_000 }, () => {
  const p = policy({ task_types: ["alpha"] });

  /** Insert `count` journal rows of `kind` on `resource` in one statement. */
  function bulk(
    raw: TestDb["rawDb"],
    count: number,
    kind: string,
    resource: string,
  ): void {
    raw
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data)
         SELECT 1, ?, ?, 'p', 'q', '{}', '', '{}' FROM n`,
      )
      .run(count, kind, resource);
  }
  function appendTo(
    raw: TestDb["rawDb"],
    kind: string,
    resource: string,
    data: unknown = {},
  ): number {
    return Number(
      raw
        .prepare(
          "INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data) VALUES (1, ?, ?, 'p', 'q', '{}', '', ?)",
        )
        .run(kind, resource, JSON.stringify(data)).lastInsertRowid,
    );
  }
  function seedTasks(raw: TestDb["rawDb"]): void {
    const insert = raw.prepare(
      "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, 1, '{}', 0, 1, 1, 's')",
    );
    insert.run("t-a", "alpha");
    insert.run("t-b", "beta");
  }
  describe("the windowing core", () => {
    it("plans windows that grow to a maximum and stop exactly at the bound", () => {
      let state = startScan<{ seq: number }>(0);
      const through = 50 * SCOPED_SCAN_LIMIT;
      const spans: number[] = [];
      for (;;) {
        const end = nextWindowEnd(state, through);
        spans.push(end - state.cursor);
        const step = foldWindow(state, end, [], 5, through);
        if (step.done) {
          expect(step).toEqual({
            done: true,
            page: [],
            next_after_seq: SCOPED_SCAN_LIMIT,
            has_more: true,
          });
          break;
        }
        state = step.state;
      }
      expect(spans.reduce((a, b) => a + b, 0)).toBe(SCOPED_SCAN_LIMIT);
      expect(spans[0]).toBe(SCOPED_SCAN_FIRST_SPAN);
      expect(Math.max(...spans)).toBeLessThanOrEqual(SCOPED_SCAN_MAX_SPAN);
    });

    it("never plans past the range and calls an exhausted range caught up", () => {
      const state = startScan<{ seq: number }>(10);
      expect(nextWindowEnd(state, 15)).toBe(15);
      expect(foldWindow(state, 15, [{ seq: 12 }], 5, 15)).toEqual({
        done: true,
        page: [{ seq: 12 }],
        next_after_seq: 15,
        has_more: false,
      });
    });

    it("stops right after the last returned event when a further one is visible", () => {
      const state = startScan<{ seq: number }>(0);
      expect(
        foldWindow(state, 100, [{ seq: 3 }, { seq: 9 }, { seq: 20 }], 2, 1000),
      ).toEqual({
        done: true,
        page: [{ seq: 3 }, { seq: 9 }],
        next_after_seq: 9,
        has_more: true,
      });
    });
  });

  describe("a long run of hidden events", () => {
    /** Tasks, `hidden` events nobody here may read, then one event they may. */
    function journalWithHiddenRun(
      hidden: number,
      kind = "claim.renewed",
      resource = "beta:t-b",
    ) {
      const raw = createTestDb().rawDb;
      seedTasks(raw);
      bulk(raw, hidden, kind, resource);
      const needle = appendTo(raw, "entity.updated", "t-a");
      return { raw, needle, first: 0 };
    }

    it("hands back a cursor instead of scanning on, and never calls that caught up", () => {
      const g = journalWithHiddenRun(3 * SCOPED_SCAN_LIMIT);
      let after = 0;
      const seen: number[] = [];
      const steps: { has_more: boolean; moved: number; events: number }[] = [];
      for (let guard = 0; guard < 20; guard++) {
        const page = listScopedJournal(metered(g.raw).db, p, {
          after_seq: after,
          limit: 5,
        });
        steps.push({
          has_more: page.has_more,
          moved: (page.next_after_seq ?? after) - after,
          events: page.events.length,
        });
        seen.push(...page.events.map((e) => e.seq));
        after = page.next_after_seq ?? after;
        if (!page.has_more) break;
      }
      expect(seen).toEqual([g.needle]);
      // Every request but the last examined exactly the bound and said so.
      expect(steps.slice(0, -1)).toEqual(
        steps.slice(0, -1).map(() => ({
          has_more: true,
          moved: SCOPED_SCAN_LIMIT,
          events: 0,
        })),
      );
      expect(steps.length).toBeGreaterThanOrEqual(4);
      expect(steps[steps.length - 1]).toMatchObject({
        has_more: false,
        events: 1,
      });
      expect(after).toBe(g.needle);
      g.raw.close();
    });

    it("costs the same number of statements however long the hidden run is", async () => {
      const cost = async (hidden: number) => {
        const g = journalWithHiddenRun(hidden);
        const list = metered(g.raw);
        const forward = listScopedJournal(list.db, p, {
          after_seq: 0,
          limit: 5,
        });
        const tail = listScopedJournal(list.db, p, { limit: 5 });
        const listStatements = list.stats.statements;
        const replayMeter = metered(g.raw);
        const replayed = await scopedReplay(replayMeter.db, p, {
          after_seq: 0,
          limit: 5,
        });
        g.raw.close();
        return {
          forward,
          tail,
          listStatements,
          replayed,
          replayStatements: replayMeter.stats.statements,
          widest: Math.max(list.stats.widest, replayMeter.stats.widest),
          needle: g.needle,
        };
      };
      const small = await cost(2 * SCOPED_SCAN_LIMIT);
      const large = await cost(12 * SCOPED_SCAN_LIMIT);

      // A forward read examines exactly the bound and says it stopped there.
      expect(small.forward).toEqual(large.forward);
      expect(small.forward).toEqual({
        events: [],
        has_more: true,
        next_after_seq: SCOPED_SCAN_LIMIT,
      });
      // The newest readable event is within the newest range, so a tail read
      // finds it, and still reports that older ones were out of reach.
      expect(small.tail.events.map((e) => e.seq)).toEqual([small.needle]);
      expect(small.tail.has_more).toBe(true);
      expect(large.tail.events.map((e) => e.seq)).toEqual([large.needle]);
      expect(large.tail.has_more).toBe(true);
      // The work depends on the bound, not on the journal: the same statements
      // for a journal six times longer, none of them binding over 100 values.
      expect(small.listStatements).toBe(large.listStatements);
      expect(small.replayStatements).toBe(large.replayStatements);
      expect(large.listStatements).toBeLessThan(60);
      expect(large.replayStatements).toBeLessThan(60);
      expect(large.widest).toBeLessThanOrEqual(100);
      // Only the global sequence differs between the two journals.
      expect({ ...small.replayed, through_seq: 0 }).toEqual({
        ...large.replayed,
        through_seq: 0,
      });
      expect(small.replayed.through_seq).toBe(small.needle);
      expect(large.replayed).toEqual({
        ok: true,
        events: [],
        next_after_seq: SCOPED_SCAN_LIMIT,
        through_seq: large.needle,
        has_more: true,
      });
    });

    it("answers a tail read short and incomplete, then fills from the front", () => {
      const raw = createTestDb().rawDb;
      seedTasks(raw);
      const early = appendTo(raw, "entity.updated", "t-a");
      bulk(raw, 3 * SCOPED_SCAN_LIMIT, "claim.renewed", "beta:t-b");

      // The newest events are all hidden and the bound is reached first: not
      // caught up, so not a short page the reader may take for the whole story.
      expect(listScopedJournal(metered(raw).db, p, { limit: 5 })).toEqual({
        events: [],
        has_more: true,
      });
      // Paging forward is bounded and resumable, and gets there.
      let after = 0;
      const seen: number[] = [];
      for (let guard = 0; guard < 20; guard++) {
        const page = listScopedJournal(metered(raw).db, p, {
          after_seq: after,
          limit: 5,
        });
        seen.push(...page.events.map((e) => e.seq));
        after = page.next_after_seq ?? after;
        if (!page.has_more) break;
      }
      expect(seen).toEqual([early]);
      raw.close();
    });

    it("fills a tail page when enough readable events are among the newest", () => {
      const raw = createTestDb().rawDb;
      seedTasks(raw);
      appendTo(raw, "entity.updated", "t-a");
      bulk(raw, 3 * SCOPED_SCAN_LIMIT, "claim.renewed", "beta:t-b");
      const recent = [
        appendTo(raw, "entity.updated", "t-a"),
        appendTo(raw, "claim.acquired", "alpha:t-a"),
        appendTo(raw, "entity.updated", "t-a"),
      ];
      const db = () => metered(raw).db;
      expect(listScopedJournal(db(), p, { limit: 3 })).toEqual({
        events: expect.any(Array),
        has_more: false,
      });
      expect(
        listScopedJournal(db(), p, { limit: 3 }).events.map((e) => e.seq),
      ).toEqual([...recent].reverse());
      // Asking for more than the newest range holds is incomplete, and says so.
      const more = listScopedJournal(db(), p, { limit: 10 });
      expect(more.events.map((e) => e.seq)).toEqual([...recent].reverse());
      expect(more.has_more).toBe(true);
      raw.close();
    });

    it("answers identically whatever the hidden events were, given the same sequence layout", async () => {
      const layout = async (kind: string, resource: string, hidden: number) => {
        const g = journalWithHiddenRun(hidden, kind, resource);
        const db = () => metered(g.raw).db;
        const out: unknown[] = [];
        let after = 0;
        for (let guard = 0; guard < 20; guard++) {
          const page = listScopedJournal(db(), p, {
            after_seq: after,
            limit: 3,
          });
          out.push(page);
          after = page.next_after_seq ?? after;
          if (!page.has_more) break;
        }
        out.push(listScopedJournal(db(), p, { limit: 3 }));
        let replayAfter = 0;
        for (let guard = 0; guard < 20; guard++) {
          const page = await scopedReplay(db(), p, {
            after_seq: replayAfter,
            limit: 3,
          });
          out.push(page);
          replayAfter = page.next_after_seq;
          if (!page.has_more) break;
        }
        g.raw.close();
        return out;
      };
      for (const hidden of [2_500, SCOPED_SCAN_LIMIT + 2_500]) {
        const asClaims = await layout("claim.renewed", "beta:t-b", hidden);
        const asRooms = await layout("room.created", "room:private", hidden);
        const asMissing = await layout("entity.updated", "no-such", hidden);
        expect(asRooms, `hidden=${hidden}`).toEqual(asClaims);
        expect(asMissing, `hidden=${hidden}`).toEqual(asClaims);
      }
    });
  });

  describe("across the archive boundary", () => {
    type Row = Record<string, unknown>;
    it("pages a project whose live and archived history is mostly hidden, losing and repeating nothing", async () => {
      // Readable events at known positions, separated by hidden runs longer
      // than one request may examine.
      const raw = f.rawDb;
      seedTasks(raw);
      const gap = SCOPED_SCAN_LIMIT + Math.floor(SCOPED_SCAN_LIMIT / 4);
      const readable: number[] = [];
      for (let round = 0; round < 3; round++) {
        bulk(raw, gap, "claim.renewed", "beta:t-b");
        readable.push(appendTo(raw, "entity.updated", "t-a"));
        readable.push(appendTo(raw, "claim.acquired", "alpha:t-a"));
      }
      const high = Number(
        (
          raw.prepare("SELECT max(seq) AS m FROM journal").get() as {
            m: number;
          }
        ).m,
      );
      const walk = async (archive: JournalArchiveReader | undefined) => {
        const pages: { seqs: number[]; moved: number; more: boolean }[] = [];
        let after = 0;
        let through: number | undefined;
        for (let guard = 0; guard < 200; guard++) {
          const page = await scopedReplay(
            metered(f.rawDb).db,
            p,
            {
              after_seq: after,
              limit: 3,
              ...(through === undefined ? {} : { through_seq: through }),
            },
            archive,
          );
          pages.push({
            seqs: page.events.map((e) => e.seq),
            moved: page.next_after_seq - after,
            more: page.has_more,
          });
          through = page.through_seq;
          after = page.next_after_seq;
          if (!page.has_more) break;
        }
        return pages;
      };

      const live = await walk(undefined);
      expect(live.flatMap((x) => x.seqs)).toEqual(readable);
      for (const page of live) expect(page.moved).toBeLessThanOrEqual(high);
      for (const page of live.slice(0, -1)) expect(page.more).toBe(true);
      expect(live[live.length - 1].more).toBe(false);
      // No request examined more than the bound unless it stopped on an event.
      for (const page of live)
        if (page.seqs.length === 0)
          expect(page.moved).toBeLessThanOrEqual(SCOPED_SCAN_LIMIT);

      // Archive through the middle of a hidden run, so the boundary falls
      // inside a stretch no single request can cross.
      const through = readable[2] + Math.floor(gap / 2);
      const batch = archiveOps.getArchivableEvents(f.db, { maxAgeMs: -1 });
      const archived: Row[] = batch.events
        .filter((e) => e.seq <= through)
        .map((e) => ({ ...e }));
      archiveOps.markArchived(f.db, through);
      const archive: JournalArchiveReader = {
        async *read() {
          for (const row of archived) yield row;
        },
      };
      const split = await walk(archive);
      expect(split.flatMap((x) => x.seqs)).toEqual(readable);
      expect(split).toEqual(live);

      // The list serves only the live side, and says where the rest is.
      const list = listScopedJournal(
        metered(f.rawDb).db,
        p,
        { after_seq: 0, limit: 5 },
        { lastArchivedSeq: through },
      );
      expect(list).toEqual({ events: [], has_more: true, next_after_seq: 0 });
      const liveList = listScopedJournal(
        metered(f.rawDb).db,
        p,
        { after_seq: through, limit: 50 },
        { lastArchivedSeq: through },
      );
      const wanted = readable.filter((s) => s > through);
      expect(liveList.events.map((e) => e.seq)).toEqual(
        wanted.slice(0, liveList.events.length),
      );
      let cursor = through;
      const listed: number[] = [];
      for (let guard = 0; guard < 50; guard++) {
        const page = listScopedJournal(
          metered(f.rawDb).db,
          p,
          { after_seq: cursor, limit: 50 },
          { lastArchivedSeq: through },
        );
        listed.push(...page.events.map((e) => e.seq));
        cursor = page.next_after_seq ?? cursor;
        if (!page.has_more) break;
      }
      expect(listed).toEqual(wanted);
    });
  });
});
