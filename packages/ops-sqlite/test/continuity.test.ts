import {
  ContinuityError,
  type JournalArchiveReader,
  completeReplay,
} from "@tila/core";
import { JOURNAL_REPLAY_SCAN_BUDGET } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as continuity from "../src/continuity-ops";
import * as coordination from "../src/coordination-ops";
import { truncateAllDomainTables } from "../src/destroy-ops";
import { getArchivableEvents, markArchived } from "../src/journal-archive-ops";
import { appendJournal } from "../src/journal-ops";
import { MIGRATIONS } from "../src/migrations-sql";
import * as signals from "../src/signal-ops";
import { countStoreRows } from "../src/store-counts-ops";
import { type TestDb, createTestDb, runMigration, testOrigin } from "./helpers";

const identity = {
  principal_id: "principal",
  participant_id: "participant",
  environment: { client_name: "vitest" },
};
const other = { ...identity, participant_id: "other" };
const origin = testOrigin(identity.participant_id, identity.principal_id);
let fixture: TestDb;
beforeEach(() => {
  fixture = createTestDb();
});
afterEach(() => fixture.rawDb.close());
function append(count = 1) {
  for (let i = 0; i < count; i++)
    fixture.db.transaction((tx) =>
      appendJournal(tx, {
        ...origin,
        kind: "entity.created",
        resource: `task:${i}`,
        data: { index: i },
      }),
    );
}
const archive = (rows: unknown[]): JournalArchiveReader => ({
  async *read() {
    yield* rows;
  },
});
const create = (extra = {}) =>
  continuity.createHandoff(fixture.db, identity, {
    id: crypto.randomUUID(),
    summary: "Continue work",
    based_on_seq: 0,
    ...extra,
  });

describe("journal continuity", () => {
  it("pages ascending at a fixed boundary while writers continue", async () => {
    append(5);
    const first = await completeReplay(
      continuity.replaySnapshot(fixture.db, { after_seq: 0, limit: 2 }),
    );
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({
      through_seq: 5,
      next_after_seq: 2,
      has_more: true,
    });
    append(2);
    const second = await completeReplay(
      continuity.replaySnapshot(fixture.db, {
        after_seq: 2,
        through_seq: 5,
        limit: 2,
      }),
    );
    const last = await completeReplay(
      continuity.replaySnapshot(fixture.db, {
        after_seq: second.next_after_seq,
        through_seq: 5,
        limit: 2,
      }),
    );
    expect(second.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(last.events.map((event) => event.seq)).toEqual([5]);
    expect(last.has_more).toBe(false);
    expect(continuity.highSequence(fixture.db)).toBe(7);
  });

  it("replays archives, overlaps, and live rows without gaps", async () => {
    append(5);
    const rows = getArchivableEvents(fixture.db).events;
    markArchived(fixture.db, 3);
    const snapshot = continuity.replaySnapshot(fixture.db, { after_seq: 1 });
    // Another archival completes after the live page was materialized.
    markArchived(fixture.db, 5);
    const result = await completeReplay(
      snapshot,
      archive([...rows.slice(0, 3), ...rows]),
    );
    expect(result.events.map((event) => event.seq)).toEqual([2, 3, 4, 5]);
    expect(result.events[0].principal_id).toBe(identity.principal_id);
    expect(continuity.highSequence(fixture.db)).toBe(5);
    append();
    expect(continuity.highSequence(fixture.db)).toBe(6);
  });

  it("fails closed for missing, conflicting and malformed archive events", async () => {
    append(3);
    const rows = getArchivableEvents(fixture.db).events;
    markArchived(fixture.db, 3);
    const snapshot = continuity.replaySnapshot(fixture.db, { after_seq: 0 });
    await expect(
      completeReplay(snapshot, archive([rows[0], rows[2]])),
    ).rejects.toMatchObject({ code: "journal-history-unavailable" });
    await expect(
      completeReplay(
        snapshot,
        archive([...rows, { ...rows[0], data: { changed: true } }]),
      ),
    ).rejects.toMatchObject({ code: "journal-history-conflict" });
    await expect(
      completeReplay(snapshot, archive([null])),
    ).rejects.toMatchObject({ code: "journal-history-unavailable" });
    expect(continuity.getCursor(fixture.db, identity).seq).toBe(0);
  });

  it("normalizes legacy archive identity without pretending to know the principal", async () => {
    append();
    markArchived(fixture.db, 1);
    const result = await completeReplay(
      continuity.replaySnapshot(fixture.db, { after_seq: 0 }),
      archive([
        {
          seq: 1,
          t: 10,
          kind: "entity.created",
          resource: "task:old",
          actor: "old-name",
          source: "cli",
          source_version: "old",
          data: {},
        },
      ]),
    );
    expect(result.events[0]).toMatchObject({
      principal_id: "legacy-principal:old-name",
      participant_id: "legacy-event:1",
      environment: { client_name: "cli", client_version: "old" },
    });
  });

  it("archives only an age-eligible prefix when timestamps move backwards", () => {
    append(3);
    fixture.rawDb.exec(
      `UPDATE journal SET t = CASE seq WHEN 2 THEN ${Date.now()} ELSE 1 END`,
    );
    const batch = getArchivableEvents(fixture.db, { maxAgeMs: 10000 });
    expect(batch.events.map((event) => event.seq)).toEqual([1]);
    markArchived(fixture.db, batch.throughSeq);
    expect(
      fixture.rawDb.prepare("SELECT seq FROM journal ORDER BY seq").all(),
    ).toEqual([{ seq: 2 }, { seq: 3 }]);
  });

  it("acknowledges monotonically, survives presence expiry, and isolates identities", () => {
    append(4);
    coordination.heartbeat(fixture.db, origin);
    const first = continuity.acknowledge(fixture.db, identity, { seq: 3 });
    expect(continuity.acknowledge(fixture.db, identity, { seq: 3 })).toEqual(
      first,
    );
    expect(continuity.acknowledge(fixture.db, identity, { seq: 1 })).toEqual(
      first,
    );
    fixture.rawDb.exec("DELETE FROM presence");
    expect(continuity.getCursor(fixture.db, identity).seq).toBe(3);
    expect(continuity.getCursor(fixture.db, other).seq).toBe(0);
    expect(
      continuity.getCursor(fixture.db, {
        ...identity,
        principal_id: "different",
      }).seq,
    ).toBe(0);
    expect(() =>
      continuity.acknowledge(fixture.db, identity, { seq: 5 }),
    ).toThrow(ContinuityError);
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        continuity.acknowledge(fixture.db, identity, { seq }),
      ).toThrow();
    expect(continuity.acknowledge(fixture.db, identity, { seq: 4 }).seq).toBe(
      4,
    );
  });
});

/** A project report row: only `kind` and `data` matter to replay filtering. */
function report(
  eventName: string | null,
  correlationId?: string,
  kind: "custom.reported" | "entity.created" = "custom.reported",
  extra: Record<string, unknown> = {},
) {
  fixture.db.transaction((tx) =>
    appendJournal(tx, {
      ...origin,
      kind,
      resource: "project",
      data: {
        ...(eventName === null ? {} : { event_name: eventName }),
        event_version: 1,
        target: { kind: "project" },
        data: {},
        ...(correlationId === undefined
          ? {}
          : { correlation_id: correlationId }),
        ...extra,
      },
    }),
  );
}
const seqs = (page: { events: { seq: number }[] }) =>
  page.events.map((event) => event.seq);
function countingArchive(rows: unknown[]) {
  const calls: [number, number][] = [];
  const reader: JournalArchiveReader = {
    async *read(afterSeq, throughSeq) {
      calls.push([afterSeq, throughSeq]);
      yield* rows;
    },
  };
  return { calls, reader };
}
/** Page a filtered replay to completion the way a client must: on has_more. */
async function pageAll(
  filter: { event_name?: string; correlation_id?: string },
  options: { limit?: number; reader?: JournalArchiveReader } = {},
) {
  const pages = [];
  let after = 0;
  let through: number | undefined;
  for (;;) {
    const page = await completeReplay(
      continuity.replaySnapshot(fixture.db, {
        after_seq: after,
        through_seq: through,
        limit: options.limit ?? 100,
        ...filter,
      }),
      options.reader,
    );
    pages.push(page);
    through = page.through_seq;
    expect(page.next_after_seq).toBeGreaterThan(after);
    after = page.next_after_seq;
    if (!page.has_more) return pages;
    if (pages.length > 50) throw new Error("replay did not terminate");
  }
}

describe("filtered journal replay", () => {
  it("finds archived and live reports by event_name and correlation_id", async () => {
    append(3); // 1-3
    report("pipeline.old", "run-1"); // 4: archived
    append(2); // 5-6
    report("pipeline.live", "run-1"); // 7
    report("pipeline.other", "run-2"); // 8
    const rows = getArchivableEvents(fixture.db).events;
    markArchived(fixture.db, 5);
    const run = async (filter: object) =>
      completeReplay(
        continuity.replaySnapshot(fixture.db, { after_seq: 0, ...filter }),
        archive(rows),
      );
    expect(seqs(await run({ event_name: "pipeline.old" }))).toEqual([4]);
    expect(seqs(await run({ correlation_id: "run-1" }))).toEqual([4, 7]);
    expect(
      seqs(await run({ event_name: "pipeline.live", correlation_id: "run-1" })),
    ).toEqual([7]);
    expect(
      seqs(await run({ event_name: "pipeline.old", correlation_id: "run-2" })),
    ).toEqual([]);
    const page = await run({ event_name: "pipeline.old" });
    expect(page).toMatchObject({
      ok: true,
      through_seq: 8,
      next_after_seq: 8,
      has_more: false,
    });
    expect(page.events[0]).toMatchObject({
      kind: "custom.reported",
      data: { event_name: "pipeline.old", correlation_id: "run-1" },
    });
  });

  it("fails closed on a missing archived sequence even when nothing would match", async () => {
    append(6);
    const rows = getArchivableEvents(fixture.db).events;
    markArchived(fixture.db, 4);
    for (const filter of [
      { event_name: "no.such_event" },
      { correlation_id: "no-such-run" },
    ]) {
      const snapshot = continuity.replaySnapshot(fixture.db, {
        after_seq: 0,
        ...filter,
      });
      await expect(
        completeReplay(snapshot, archive([rows[0], rows[1], rows[3]])),
      ).rejects.toMatchObject({
        code: "journal-history-unavailable",
        status: 503,
      });
      await expect(completeReplay(snapshot)).rejects.toMatchObject({
        code: "journal-history-unavailable",
      });
      // The same window with its history intact is a legitimate empty page.
      await expect(
        completeReplay(snapshot, archive(rows)),
      ).resolves.toMatchObject({ events: [], has_more: false });
    }
  });

  it("fails closed on a lost live sequence and on conflicting copies in non-matching rows", async () => {
    append(5);
    report("pipeline.hit", "run-9"); // 6
    fixture.rawDb.exec("DELETE FROM journal WHERE seq = 3");
    await expect(
      completeReplay(
        continuity.replaySnapshot(fixture.db, {
          after_seq: 0,
          event_name: "pipeline.hit",
        }),
      ),
    ).rejects.toMatchObject({ code: "journal-history-unavailable" });

    fixture.rawDb.exec("DELETE FROM journal");
    append(4);
    const rows = getArchivableEvents(fixture.db).events;
    markArchived(fixture.db, 2);
    await expect(
      completeReplay(
        continuity.replaySnapshot(fixture.db, {
          after_seq: 0,
          event_name: "pipeline.hit",
        }),
        archive([...rows, { ...rows[3], data: { changed: true } }]),
      ),
    ).rejects.toMatchObject({ code: "journal-history-conflict", status: 409 });
  });

  it("never matches events without an event_name or outside the report kind", async () => {
    report(null, "c-1"); // 1: report with no event_name
    report("x.named", undefined, "entity.created"); // 2: wrong kind
    report("x.named", "c-1", "entity.created"); // 3: wrong kind, same ids
    report("x.named", "c-1"); // 4: the only real match
    report("x.named"); // 5: payload later corrupted to JSON null
    fixture.rawDb.exec("UPDATE journal SET data = 'null' WHERE seq = 5");
    const run = async (filter: object) =>
      seqs(
        await completeReplay(
          continuity.replaySnapshot(fixture.db, { after_seq: 0, ...filter }),
        ),
      );
    expect(await run({ event_name: "x.named" })).toEqual([4]);
    expect(await run({ correlation_id: "c-1" })).toEqual([1, 4]);
    expect(await run({ event_name: "x.named", correlation_id: "c-1" })).toEqual(
      [4],
    );
    // No filter: every row is returned, so a missing name is only a filter miss.
    expect(await run({})).toEqual([1, 2, 3, 4, 5]);
  });

  it("exhausts the scan budget with honest progress that resumes without skipping", async () => {
    const total = JOURNAL_REPLAY_SCAN_BUDGET * 2 + 150;
    fixture.db.transaction((tx) => {
      for (let i = 1; i <= total; i++)
        appendJournal(tx, {
          ...origin,
          kind: i === 1500 || i === 2100 ? "custom.reported" : "entity.created",
          resource: `task:${i}`,
          data:
            i === 1500 || i === 2100
              ? { event_name: "needle.found", correlation_id: "needle" }
              : { index: i },
        });
    });
    const first = await completeReplay(
      continuity.replaySnapshot(fixture.db, {
        after_seq: 0,
        event_name: "needle.found",
        limit: 5,
      }),
    );
    // Nothing matched in the first budget: an empty page that must still advance.
    expect(first).toMatchObject({
      events: [],
      next_after_seq: JOURNAL_REPLAY_SCAN_BUDGET,
      through_seq: total,
      has_more: true,
    });
    const pages = await pageAll({ event_name: "needle.found" }, { limit: 5 });
    expect(pages.map((page) => page.next_after_seq)).toEqual([
      JOURNAL_REPLAY_SCAN_BUDGET,
      JOURNAL_REPLAY_SCAN_BUDGET * 2,
      total,
    ]);
    expect(pages.flatMap(seqs)).toEqual([1500, 2100]);
    expect(pages.map((page) => page.has_more)).toEqual([true, true, false]);
    expect(new Set(pages.map((page) => page.through_seq))).toEqual(
      new Set([total]),
    );
  });

  it("caps matches at limit and resumes immediately after the last one returned", async () => {
    for (let i = 0; i < 30; i++) {
      append();
      report("bulk.item", i % 2 ? "odd" : "even");
    }
    const everything = await completeReplay(
      continuity.replaySnapshot(fixture.db, {
        after_seq: 0,
        event_name: "bulk.item",
        limit: 200,
      }),
    );
    expect(everything.events).toHaveLength(30);

    const pages = await pageAll({ event_name: "bulk.item" }, { limit: 7 });
    expect(pages.map((page) => page.events.length)).toEqual([7, 7, 7, 7, 2]);
    expect(pages.flatMap(seqs)).toEqual(seqs(everything));
    for (const page of pages.slice(0, -1)) {
      expect(page.next_after_seq).toBe(page.events[page.events.length - 1].seq);
      expect(page.has_more).toBe(true);
    }
    // A request whose matches exactly fill the limit consumes its whole scan.
    const exact = await completeReplay(
      continuity.replaySnapshot(fixture.db, {
        after_seq: 0,
        event_name: "bulk.item",
        limit: 30,
      }),
    );
    expect(exact).toMatchObject({ next_after_seq: 60, has_more: false });
    expect(exact.events).toHaveLength(30);
  });

  it("reads the archive once per request however many windows it scans", async () => {
    const total = JOURNAL_REPLAY_SCAN_BUDGET + 300;
    fixture.db.transaction((tx) => {
      for (let i = 1; i <= total; i++)
        appendJournal(tx, {
          ...origin,
          kind: i === 1100 ? "custom.reported" : "entity.created",
          resource: `task:${i}`,
          data: i === 1100 ? { event_name: "late.report" } : { index: i },
        });
    });
    const rows = getArchivableEvents(fixture.db).events;
    markArchived(fixture.db, total);
    const { calls, reader } = countingArchive(rows);
    const pages = await pageAll(
      { event_name: "late.report" },
      { reader, limit: 1 },
    );
    expect(pages.flatMap(seqs)).toEqual([1100]);
    // Two requests, each scanning five 200-sequence windows' worth at most.
    expect(calls).toEqual([
      [0, JOURNAL_REPLAY_SCAN_BUDGET],
      [JOURNAL_REPLAY_SCAN_BUDGET, total],
    ]);
  });

  it("leaves unfiltered requests and re-entry exactly as before", async () => {
    append(5);
    const snapshot = continuity.replaySnapshot(fixture.db, {
      after_seq: 0,
      limit: 2,
    });
    expect(snapshot.page_through_seq).toBe(2);
    expect(snapshot).not.toHaveProperty("filter");
    const reentry = continuity.reentrySnapshot(fixture.db, identity, {
      limit: 2,
      ...({ event_name: "x.y" } as object),
    });
    expect(reentry.replay.page_through_seq).toBe(2);
    expect(reentry.replay).not.toHaveProperty("filter");
    expect(() =>
      continuity.replaySnapshot(fixture.db, {
        after_seq: 0,
        event_name: "Not A Name",
      }),
    ).toThrow();
  });
});

describe("handoffs and re-entry", () => {
  it("prefers the newest work handoff across shutdown pages within the selected scope", () => {
    expect(continuity.reentrySnapshot(fixture.db, identity).handoff).toBeNull();
    create();
    const work = create({
      kind: "work",
      references: [{ type: "task", id: "shared" }],
    });
    let newest = work;
    for (let i = 0; i < 105; i++) {
      newest = create({
        kind: "shutdown",
        references: [{ type: "task", id: "shared" }],
      });
    }
    expect(continuity.reentrySnapshot(fixture.db, identity).handoff).toEqual(
      work,
    );
    expect(continuity.reentrySnapshot(fixture.db, other).handoff).toBeNull();
    expect(
      continuity.reentrySnapshot(fixture.db, {
        ...identity,
        principal_id: "elsewhere",
      }).handoff,
    ).toBeNull();
    expect(
      continuity.reentrySnapshot(fixture.db, other, { resource: "task:shared" })
        .handoff,
    ).toEqual(work);
    expect(
      continuity.reentrySnapshot(fixture.db, identity, {
        resource: "task:missing",
      }).handoff,
    ).toBeNull();
    expect(
      continuity.reentrySnapshot(fixture.db, identity, {
        handoff_id: newest.id,
      }).handoff,
    ).toEqual(newest);
    expect(
      continuity.listHandoffs(fixture.db, identity, { limit: 1 }).handoffs,
    ).toEqual([newest]);
    expect(continuity.getHandoff(fixture.db, work.id)).toEqual(work);
  });

  it("falls back to the newest shutdown snapshot after exhausting all pages", () => {
    let newest = create({ kind: "shutdown" });
    for (let i = 0; i < 100; i++) newest = create({ kind: "shutdown" });
    expect(continuity.reentrySnapshot(fixture.db, identity).handoff).toEqual(
      newest,
    );
  });

  it("treats unmarked handoffs as work without guessing from legacy shutdown content", () => {
    create({ kind: "work" });
    const legacy = create({
      summary: "codex session ended; coordination snapshot only.",
      current_state: {
        environment: {},
        session_id: "legacy",
        cleanup: "requested",
      },
    });
    create({ kind: "shutdown" });
    expect(continuity.reentrySnapshot(fixture.db, identity).handoff).toEqual(
      legacy,
    );
    expect(legacy).not.toHaveProperty("kind");
  });

  it("stores immutable retry-safe snapshots and a single journal event", () => {
    const input = {
      id: crypto.randomUUID(),
      summary: "Ready",
      based_on_seq: 0,
      current_state: { b: 2, a: 1 },
    };
    const first = continuity.createHandoff(fixture.db, identity, input);
    const retry = continuity.createHandoff(fixture.db, identity, {
      ...input,
      current_state: { a: 1, b: 2 },
    });
    expect(retry).toEqual(first);
    expect(retry).not.toHaveProperty("kind");
    const storedRequest = fixture.rawDb
      .prepare("SELECT request_json FROM handoffs WHERE id = ?")
      .get(input.id) as { request_json: string };
    expect(JSON.parse(storedRequest.request_json)).not.toHaveProperty("kind");
    expect(continuity.highSequence(fixture.db)).toBe(1);
    expect(() => continuity.createHandoff(fixture.db, other, input)).toThrow(
      ContinuityError,
    );
    expect(() =>
      continuity.createHandoff(fixture.db, identity, {
        ...input,
        summary: "changed",
      }),
    ).toThrow(ContinuityError);
    const replacement = create({ supersedes_id: first.id });
    expect(continuity.getHandoff(fixture.db, first.id)).toEqual(first);
    expect(replacement.supersedes_id).toBe(first.id);
    expect(() =>
      continuity.createHandoff(fixture.db, identity, {
        ...input,
        kind: "work",
      }),
    ).toThrow(ContinuityError);
    const marked = {
      ...input,
      id: crypto.randomUUID(),
      kind: "shutdown" as const,
    };
    const shutdown = continuity.createHandoff(fixture.db, identity, marked);
    expect(continuity.createHandoff(fixture.db, identity, marked)).toEqual(
      shutdown,
    );
    expect(() =>
      continuity.createHandoff(fixture.db, identity, {
        ...marked,
        kind: "work",
      }),
    ).toThrow(ContinuityError);
  });

  it("selects across participants only with ID or resource, and paginates newest first", () => {
    const first = create({
      references: [{ type: "task", id: "deleted-task" }],
    });
    const second = create({
      references: [{ type: "task", id: "deleted-task" }],
    });
    expect(continuity.listHandoffs(fixture.db, other).handoffs).toEqual([]);
    expect(
      continuity.reentrySnapshot(fixture.db, other, {
        resource: "task:deleted-task",
      }).handoff?.id,
    ).toBe(second.id);
    expect(
      continuity.reentrySnapshot(fixture.db, other, { handoff_id: first.id })
        .handoff?.id,
    ).toBe(first.id);
    const page = continuity.listHandoffs(fixture.db, identity, { limit: 1 });
    expect(page.handoffs[0].id).toBe(second.id);
    expect(
      continuity.listHandoffs(fixture.db, identity, {
        before_seq: page.next_before_seq ?? undefined,
        limit: 1,
      }).handoffs[0].id,
    ).toBe(first.id);
    expect(() =>
      continuity.reentrySnapshot(fixture.db, identity, {
        handoff_id: first.id,
        resource: "task:x",
      }),
    ).toThrow();
  });

  it("resolves cursor precedence, including an explicitly acknowledged zero", () => {
    append(3);
    const handoff = create({ based_on_seq: 2 });
    expect(
      continuity.reentrySnapshot(fixture.db, identity).replay.after_seq,
    ).toBe(2);
    continuity.acknowledge(fixture.db, identity, { seq: 0 });
    expect(
      continuity.reentrySnapshot(fixture.db, identity).replay.after_seq,
    ).toBe(0);
    expect(
      continuity.reentrySnapshot(fixture.db, identity, { after_seq: 1 }).replay
        .after_seq,
    ).toBe(1);
    expect(
      continuity.reentrySnapshot(fixture.db, other, { handoff_id: handoff.id })
        .replay.after_seq,
    ).toBe(2);
    expect(continuity.getCursor(fixture.db, other).updated_at).toBeNull();
  });

  it("distinguishes historical claims from live claims and leaves signals pending", () => {
    coordination.acquire(fixture.db, "work", origin, "exclusive", 30000);
    const handoff = create();
    expect(handoff.active_claims).toHaveLength(1);
    signals.send(fixture.db, {
      target: { type: "participant", ...other },
      kind: "info",
      sender: { ...identity, display_name: null },
    });
    fixture.rawDb.exec("UPDATE claims SET expires_at = 1");
    const state = continuity.reentrySnapshot(fixture.db, other, {
      handoff_id: handoff.id,
    });
    expect(state.active_claims).toEqual([]);
    expect(state.handoff?.active_claims).toHaveLength(1);
    expect(state.pending_signals).toHaveLength(1);
    expect(signals.inbox(fixture.db, other)).toHaveLength(1);
    expect(
      continuity.reentrySnapshot(fixture.db, identity).pending_signals,
    ).toHaveLength(0);
  });

  it("migrates idempotently and deletes all continuity state on project destruction", () => {
    const migration = MIGRATIONS.find((migration) => migration.version === 26);
    if (!migration) throw new Error("Missing migration 26");
    runMigration(fixture.rawDb, migration);
    const handoff = create({ references: [{ type: "artifact", key: "blob" }] });
    continuity.acknowledge(fixture.db, identity, { seq: handoff.created_seq });
    const counts = countStoreRows(fixture.db).domain;
    expect(counts).toMatchObject({
      handoffs: 1,
      handoff_references: 1,
      journal_cursors: 1,
    });
    truncateAllDomainTables({
      exec: (statement) => fixture.rawDb.exec(statement),
    });
    expect(
      Object.values(countStoreRows(fixture.db).domain).every(
        (count) => count === 0,
      ),
    ).toBe(true);
  });

  it("blocks continuity writes during a project export", () => {
    append();
    fixture.rawDb
      .prepare(`INSERT INTO _project_transfer_state
      (singleton, session_id, mode, owner, started_at, updated_at, expires_at, applying)
      VALUES (1, 'export', 'export', 'owner', 1, 1, ?, 0)`)
      .run(Date.now() + 60000);
    expect(() =>
      continuity.acknowledge(fixture.db, identity, { seq: 1 }),
    ).toThrow(/project-maintenance/);
    expect(() => create()).toThrow(/project-maintenance/);
    expect(continuity.getCursor(fixture.db, identity).updated_at).toBeNull();
    expect(continuity.listHandoffs(fixture.db, identity).handoffs).toEqual([]);
  });
});
