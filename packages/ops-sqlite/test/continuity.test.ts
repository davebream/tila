import {
  ContinuityError,
  type JournalArchiveReader,
  completeReplay,
} from "@tila/core";
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
