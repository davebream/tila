import { completeReplay } from "@tila/core";
import {
  CREDENTIAL_PRESETS,
  CUSTOM_REPORT_RETENTION_MS,
  type JournalAppendRequest,
  type ProjectRole,
} from "@tila/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acknowledge, getCursor, replaySnapshot } from "../src/continuity-ops";
import { acquire } from "../src/coordination-ops";
import {
  CORRECTION_CHAIN_LIMIT,
  appendReport,
  validateJournalReportBackupRow,
} from "../src/custom-journal-ops";
import { listJournal } from "../src/journal-ops";
import * as transfer from "../src/project-transfer-ops";
import * as schema from "../src/schema";
import { type TestDb, createEntity, createTestDb, testOrigin } from "./helpers";

const input: JournalAppendRequest = {
  event_name: "pipeline.tests_passed",
  event_version: 1,
  target: { kind: "project" },
  data: { passed: 87 },
  correlation_id: "run-one",
};
let fixture: TestDb;
const origin = testOrigin();
const now = 1_800_000_000_000;
const send = (
  key: string,
  change: Partial<JournalAppendRequest> = {},
  options: Partial<Parameters<typeof appendReport>[1]> = {},
) =>
  appendReport(fixture.db, {
    projectId: "project",
    origin,
    input: { ...input, ...change },
    idempotencyKey: key,
    authorizedRole: "participant",
    now,
    ...options,
  });
beforeEach(() => {
  fixture = createTestDb();
});
afterEach(() => fixture.rawDb.close());

describe("authenticated custom reports", () => {
  it("accepts record observations and only currently accessible artifact references", async () => {
    createEntity(fixture.db, { id: "evidence-task" });
    fixture.db
      .insert(schema.records)
      .values({
        type: "result",
        key: "run/one",
        schema_version: 1,
        value_json: "{}",
        value_sha256: "hash",
        revision: 1,
        created_at: now,
        updated_at: now,
        updated_by: origin.participantId,
      })
      .run();
    fixture.db
      .insert(schema.artifactPointers)
      .values({
        r2_key: "produced/run/hash.json",
        resource: "evidence-task",
        kind: "result",
        sha256: "hash",
        bytes: 2,
        mime_type: "application/json",
        produced_at: now,
        produced_by: origin.participantId,
      })
      .run();
    const report = {
      target: { kind: "resource" as const, resource: "record:result/run/one" },
      artifact_refs: ["produced/run/hash.json"],
    };
    const accepted = await send("record", report);
    expect(accepted.response.event.resource).toBe("record:result/run/one");
    expect(accepted.response.event.fence).toBeNull();
    fixture.db.update(schema.artifactPointers).set({ tombstoned: 1 }).run();
    await expect(send("record", report)).rejects.toMatchObject({
      code: "not-found",
    });
    expect(
      fixture.db.select().from(schema.journalReportReceipts).all(),
    ).toHaveLength(1);
    expect(fixture.db.select().from(schema.records).get()?.revision).toBe(1);
  });
  it("shares the project quota across principals and never counts rejected writes", async () => {
    for (let i = 0; i < 300; i++)
      await send(
        `global-${i}`,
        {},
        { origin: testOrigin(`worker-${i}`, `principal-${i}`) },
      );
    await expect(send("project-limited")).rejects.toMatchObject({
      code: "rate-limited",
    });
    expect(fixture.db.select().from(schema.journal).all()).toHaveLength(300);
    expect(
      fixture.db
        .select()
        .from(schema.journalReportRates)
        .where(eq(schema.journalReportRates.key, "project"))
        .get()?.count,
    ).toBe(300);
    expect(
      (await send("project-limited", {}, { now: now + 60_000 })).response.event
        .seq,
    ).toBe(301);
  }, 30_000);
  it("interleaves in the journal without changing domain state or using producer time for order", async () => {
    createEntity(fixture.db, { id: "one" });
    const before = fixture.db.select().from(schema.entities).all();
    const first = await send("first", {
      event_name: "attempt.finished",
      occurred_at: "2000-01-01T00:00:00Z",
      target: { kind: "resource", resource: "one" },
    });
    const second = await send("second");
    expect(first.response.event).toMatchObject({
      seq: 2,
      t: now,
      kind: "custom.reported",
      resource: "task:one",
      principal_id: origin.principalId,
      participant_id: origin.participantId,
      fence: null,
    });
    expect(second.response.event.seq).toBe(3);
    expect(fixture.db.select().from(schema.entities).all()).toEqual(before);
    for (const table of [
      schema.claims,
      schema.gates,
      schema.queueEntries,
      schema.workAttempts,
      schema.executionReservations,
    ])
      expect(fixture.db.select().from(table).all()).toEqual([]);
    expect(
      listJournal(fixture.db, {
        event_name: "pipeline.tests_passed",
        correlation_id: "run-one",
      }).map((event) => event.seq),
    ).toEqual([3]);
    const replay = await completeReplay(
      replaySnapshot(fixture.db, { after_seq: 0, limit: 10 }),
    );
    expect(replay.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    const identity = {
      principal_id: origin.principalId,
      participant_id: origin.participantId,
      environment: {},
    };
    expect(getCursor(fixture.db, identity).seq).toBe(0);
    acknowledge(fixture.db, identity, { seq: 3 });
    expect(getCursor(fixture.db, identity).seq).toBe(3);
  });

  it("co-commits concurrent retries and replays the original attribution after credential rotation", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => send("same")),
    );
    expect(
      new Set(results.map((result) => result.response.event.seq)).size,
    ).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const retry = await send(
      "same",
      {},
      {
        origin: {
          ...origin,
          tokenId: "rotated",
          environment: { machine: "new" },
        },
      },
    );
    expect(retry.response).toEqual(results[0].response);
    await expect(send("same", { data: { passed: 88 } })).rejects.toMatchObject({
      code: "idempotency-key-conflict",
    });
    expect(
      (await send("same", {}, { origin: testOrigin("another") })).response.event
        .seq,
    ).toBe(2);
  });

  it("expires receipts at seven days and gives an explicit new acceptance afterward", async () => {
    const first = await send("key");
    expect(first.response.dedup_expires_at).toBe(
      now + CUSTOM_REPORT_RETENTION_MS,
    );
    expect(
      (await send("key", {}, { now: now + CUSTOM_REPORT_RETENTION_MS - 1 }))
        .response,
    ).toEqual(first.response);
    expect(
      (await send("key", {}, { now: now + CUSTOM_REPORT_RETENTION_MS }))
        .response.event.seq,
    ).toBe(2);
  });

  it("checks ownership, claim expiry and current fences even on retries", async () => {
    createEntity(fixture.db, { id: "owned" });
    const claim = acquire(
      fixture.db,
      "task:owned",
      origin,
      "exclusive",
      60_000,
      undefined,
      now,
    );
    if (claim.fence === undefined)
      throw new Error("Fixture claim was not acquired");
    const target = {
      kind: "claim" as const,
      resource: "task:owned",
      fence: claim.fence,
    };
    await send("owned", { target });
    await expect(
      send("owned", { target }, { origin: testOrigin("intruder") }),
    ).rejects.toThrow("Credential does not permit");
    await expect(
      send("owned", { target }, { now: now + 60_000 }),
    ).rejects.toMatchObject({ name: "ExpiredClaimError" });
    await expect(
      send("stale", { target: { ...target, fence: target.fence + 1 } }),
    ).rejects.toThrow();
    expect(listJournal(fixture.db, { kind: "custom.reported" })).toHaveLength(
      1,
    );
    expect(
      (
        await send(
          "observation",
          { target: { kind: "resource", resource: "owned" } },
          { origin: testOrigin("observer") },
        )
      ).response.event.fence,
    ).toBeNull();
  });

  it("rejects inaccessible references and restricted policies without appending", async () => {
    for (const resource of [
      "room:private",
      "task:other-project",
      "record:secret/missing",
    ])
      await expect(
        send(resource, { target: { kind: "resource", resource } }),
      ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      send("artifact", { artifact_refs: ["other/project/hash.txt"] }),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      send(
        "restricted",
        {},
        {
          policy: {
            ...CREDENTIAL_PRESETS.worker,
            restrictions: { task_types: ["task"] },
          },
        },
      ),
    ).rejects.toThrow("Credential does not permit");
    await expect(
      send(
        "viewer",
        {},
        { policy: { role: "viewer", capabilities: ["journal:append"] } },
      ),
    ).rejects.toThrow("Credential does not permit");
    expect(listJournal(fixture.db, {})).toEqual([]);
    expect(
      fixture.db.select().from(schema.journalReportReceipts).all(),
    ).toEqual([]);
  });

  it("limits new appends atomically while allowing identical receipts at the limit", async () => {
    for (let i = 0; i < 60; i++) await send(`rate-${i}`);
    await expect(send("limited")).rejects.toMatchObject({
      code: "rate-limited",
      status: 429,
      retryAfter: 60,
    });
    expect((await send("rate-0")).replayed).toBe(true);
    expect(listJournal(fixture.db, {})).toHaveLength(60);
    expect(
      fixture.db.select().from(schema.journalReportReceipts).all(),
    ).toHaveLength(60);
    expect(
      (await send("limited", {}, { now: now + 60_000 })).response.event.seq,
    ).toBe(61);
  });

  it("retains receipts through archival and validates corrections through archived replay", async () => {
    const first = await send("archived");
    const events = listJournal(fixture.db, {});
    fixture.db.delete(schema.journal).where(eq(schema.journal.seq, 1)).run();
    fixture.db
      .insert(schema.journalArchiveWatermark)
      .values({ id: 1, last_archived_seq: 1, archived_at: now })
      .run();
    const archives = {
      async *read() {
        yield* events;
      },
    };
    expect((await send("archived")).response).toEqual(first.response);
    const corrected = await send(
      "correction",
      { corrects_seq: 1 },
      { archives },
    );
    expect(corrected.response.event.seq).toBe(2);
    expect(
      (
        await completeReplay(
          replaySnapshot(fixture.db, { after_seq: 0, limit: 10 }),
          archives,
        )
      ).events.map((event) => event.seq),
    ).toEqual([1, 2]);
    await expect(
      send("missing-archive", { corrects_seq: 1 }),
    ).rejects.toMatchObject({ code: "journal-history-unavailable" });
  });

  it("exports/imports event identity and receipts and rejects malformed receipts", async () => {
    const first = await send("backup");
    const sql = {
      exec(statement: string, ...bindings: unknown[]) {
        if (/^\s*(SELECT|PRAGMA)/i.test(statement))
          return {
            toArray: () =>
              fixture.rawDb.prepare(statement).all(...bindings) as Record<
                string,
                unknown
              >[],
          };
        if (bindings.length) fixture.rawDb.prepare(statement).run(...bindings);
        else fixture.rawDb.exec(statement);
        return { toArray: () => [] };
      },
    };
    const rows = Object.fromEntries(
      transfer.PROJECT_BACKUP_TABLES.map((table) => [
        table,
        transfer.readSnapshotPage(sql, table).rows,
      ]),
    );
    const digest = await transfer.semanticDigest(sql);
    transfer.replaceSnapshotRows(sql, rows, 2);
    expect(await transfer.semanticDigest(sql)).toBe(digest);
    expect((await send("backup")).response).toEqual(first.response);
    expect((await send("next")).response.event.seq).toBe(2);
    expect(() =>
      validateJournalReportBackupRow("journal_report_receipts", {
        ...rows.journal_report_receipts[0],
        expires_at: 0,
      }),
    ).toThrow();
    expect(() =>
      validateJournalReportBackupRow("journal_report_rates", {
        key: "project",
        window_start: now,
        count: 301,
      }),
    ).toThrow();
    const legacyRows = Object.fromEntries(
      Object.entries(rows).filter(
        ([table]) =>
          table !== "journal_report_receipts" &&
          table !== "journal_report_rates",
      ),
    );
    transfer.replaceSnapshotRows(sql, legacyRows, 2);
    expect(
      fixture.db.select().from(schema.journalReportReceipts).all(),
    ).toEqual([]);
    expect(fixture.db.select().from(schema.journalReportRates).all()).toEqual(
      [],
    );
    expect(listJournal(fixture.db, {})[0].seq).toBe(first.response.event.seq);
  });
});

describe("report correction authority", () => {
  const reporter = testOrigin("reporter-process", "principal-reporter");
  const other = testOrigin("other-process", "principal-other");
  const maintainer = testOrigin("maintainer-process", "principal-maintainer");
  const owner = testOrigin("owner-process", "principal-owner");
  const denied = { code: "report-correction-denied", status: 403 };
  /** The Worker's resolved role and the credential policy that carries it. */
  const as = (who: typeof origin, role: ProjectRole = "participant") => ({
    origin: who,
    authorizedRole: role,
    policy: { ...CREDENTIAL_PRESETS.worker, role },
  });
  const state = () => ({
    journal: fixture.db.select().from(schema.journal).all(),
    receipts: fixture.db.select().from(schema.journalReportReceipts).all(),
    rates: fixture.db.select().from(schema.journalReportRates).all(),
  });
  /** A stored report written outside appendReport, for history it would not produce. */
  function rawEvent(
    principal: string,
    data: unknown,
    kind = "custom.reported",
  ) {
    return fixture.db
      .insert(schema.journal)
      .values({
        t: now,
        kind,
        resource: "project:project",
        principal_id: principal,
        participant_id: "raw-process",
        environment: "{}",
        actor: "",
        data: JSON.stringify(data),
      })
      .returning()
      .get().seq;
  }
  const seqOf = (result: Awaited<ReturnType<typeof send>>) =>
    result.response.event.seq;

  it("refuses an unrelated participant before any journal, receipt or rate write", async () => {
    const root = seqOf(await send("root", {}, as(reporter)));
    const correction = seqOf(
      await send("fix", { corrects_seq: root }, as(reporter)),
    );
    const before = state();
    for (const target of [root, correction]) {
      await expect(
        send(`intruder-${target}`, { corrects_seq: target }, as(other)),
      ).rejects.toMatchObject(denied);
      // The answer is stable on retry and does not depend on the key.
      await expect(
        send(`intruder-${target}`, { corrects_seq: target }, as(other)),
      ).rejects.toMatchObject(denied);
    }
    expect(state()).toEqual(before);
  });

  it("lets the original reporter correct the original and later corrections, including past a maintainer's", async () => {
    const root = seqOf(await send("root", {}, as(reporter)));
    const byMaintainer = await send(
      "maintainer-fix",
      { corrects_seq: root, data: { passed: 2 } },
      as(maintainer, "maintainer"),
    );
    // The recorded corrector is the actual principal, not the original reporter.
    expect(byMaintainer.response.event.principal_id).toBe(
      maintainer.principalId,
    );
    const first = await send(
      "reporter-fix",
      { corrects_seq: seqOf(byMaintainer), data: { passed: 3 } },
      as(reporter),
    );
    const second = await send(
      "reporter-fix-again",
      { corrects_seq: seqOf(first), data: { passed: 4 } },
      as(reporter),
    );
    expect(first.response.event.principal_id).toBe(reporter.principalId);
    expect(second.response.event.principal_id).toBe(reporter.principalId);
    // Correcting the original after it was superseded is still the reporter's right.
    expect(
      (await send("reporter-original", { corrects_seq: root }, as(reporter)))
        .response.event.principal_id,
    ).toBe(reporter.principalId);
  });

  it("does not let a maintainer's correction transfer authorship", async () => {
    const root = seqOf(await send("root", {}, as(reporter)));
    const byMaintainer = seqOf(
      await send(
        "maintainer-fix",
        { corrects_seq: root },
        as(maintainer, "maintainer"),
      ),
    );
    const before = state();
    // Another participant cannot correct the maintainer's event or the original.
    for (const target of [root, byMaintainer])
      await expect(
        send(`other-${target}`, { corrects_seq: target }, as(other)),
      ).rejects.toMatchObject(denied);
    // The maintainer acting without maintainer authority is not the reporter.
    await expect(
      send("demoted", { corrects_seq: byMaintainer }, as(maintainer)),
    ).rejects.toMatchObject(denied);
    expect(state()).toEqual(before);
  });

  it("allows maintainer and owner overrides, recording the real corrector, and replays them once", async () => {
    const root = seqOf(await send("root", {}, as(reporter)));
    for (const [who, role] of [
      [maintainer, "maintainer"],
      [owner, "owner"],
    ] as const) {
      const key = `override-${role}`;
      const accepted = await send(key, { corrects_seq: root }, as(who, role));
      expect(accepted.replayed).toBe(false);
      expect(accepted.response.event).toMatchObject({
        principal_id: who.principalId,
        participant_id: who.participantId,
        kind: "custom.reported",
      });
      const before = state();
      const replay = await send(key, { corrects_seq: root }, as(who, role));
      expect(replay).toEqual({ response: accepted.response, replayed: true });
      expect(state()).toEqual(before);
    }
  });

  it("replays an accepted reporter correction without a second event or rate count", async () => {
    const root = seqOf(await send("root", {}, as(reporter)));
    const accepted = await send("fix", { corrects_seq: root }, as(reporter));
    const before = state();
    const replay = await send("fix", { corrects_seq: root }, as(reporter));
    expect(replay).toEqual({ response: accepted.response, replayed: true });
    expect(state()).toEqual(before);
  });

  it("takes authority only from the authenticated principal and the Worker-resolved role", async () => {
    const root = seqOf(await send("root", {}, as(reporter)));
    const before = state();
    for (const forged of [
      { actor: reporter.principalId },
      { role: "owner" },
      { authorized_role: "owner" },
      { principal_id: reporter.principalId },
      { participant_id: reporter.participantId },
    ])
      await expect(
        send(
          `forged-${Object.keys(forged)[0]}`,
          { corrects_seq: root, ...forged } as Partial<JournalAppendRequest>,
          as(other),
        ),
      ).rejects.toThrow();
    // A reporter's participant label proves nothing about the principal.
    await expect(
      send(
        "participant-label",
        { corrects_seq: root },
        as(testOrigin(reporter.participantId, other.principalId)),
      ),
    ).rejects.toMatchObject(denied);
    // A credential ceiling lowers the resolved role; a policy cannot raise it.
    await expect(
      send(
        "ceiling",
        { corrects_seq: root },
        {
          ...as(other),
          authorizedRole: "owner",
        },
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      send(
        "raised",
        { corrects_seq: root },
        {
          origin: other,
          authorizedRole: "participant",
          policy: { ...CREDENTIAL_PRESETS.worker, role: "owner" },
        },
      ),
    ).rejects.toMatchObject(denied);
    expect(state()).toEqual(before);
  });

  it("leaves reports that do not correct anything open to any participant", async () => {
    await send("root", {}, as(reporter));
    const unrelated = await send("unrelated", {}, as(other));
    expect(unrelated.replayed).toBe(false);
    expect(unrelated.response.event.principal_id).toBe(other.principalId);
  });

  describe.each([
    ["live", false],
    ["archived", true],
  ])("%s history", (_name, archived) => {
    /** root (reporter) <- middle (maintainer) <- tail (reporter), optionally archived. */
    async function chain() {
      const root = seqOf(await send("root", {}, as(reporter)));
      const middle = seqOf(
        await send(
          "middle",
          { corrects_seq: root },
          as(maintainer, "maintainer"),
        ),
      );
      const tail = seqOf(
        await send("tail", { corrects_seq: middle }, as(reporter)),
      );
      if (!archived) return { root, middle, tail, archives: undefined };
      const events = listJournal(fixture.db, {});
      fixture.db
        .delete(schema.journal)
        .where(eq(schema.journal.seq, root))
        .run();
      fixture.db
        .delete(schema.journal)
        .where(eq(schema.journal.seq, middle))
        .run();
      fixture.db
        .insert(schema.journalArchiveWatermark)
        .values({ id: 1, last_archived_seq: middle, archived_at: now })
        .run();
      return {
        root,
        middle,
        tail,
        archives: {
          async *read() {
            yield* events;
          },
        },
      };
    }

    it("applies the same authority rules", async () => {
      const { root, middle, tail, archives } = await chain();
      const before = state();
      for (const target of [root, middle, tail])
        await expect(
          send(
            `other-${target}`,
            { corrects_seq: target },
            { ...as(other), archives },
          ),
        ).rejects.toMatchObject(denied);
      expect(state()).toEqual(before);
      for (const target of [root, middle, tail]) {
        const accepted = await send(
          `reporter-${target}`,
          { corrects_seq: target },
          { ...as(reporter), archives },
        );
        expect(accepted.response.event.principal_id).toBe(reporter.principalId);
      }
      const override = await send(
        "override",
        { corrects_seq: tail },
        { ...as(owner, "owner"), archives },
      );
      expect(override.response.event.principal_id).toBe(owner.principalId);
    });

    it("fails closed without a trace when needed history cannot be read", async () => {
      const { middle, tail } = await chain();
      const before = state();
      if (archived) {
        // The root is unreachable, so nobody whose authority depends on it is let through.
        for (const who of [reporter, other])
          await expect(
            send(`${who.principalId}-tail`, { corrects_seq: tail }, as(who)),
          ).rejects.toMatchObject({ code: "journal-history-unavailable" });
        // A maintainer needs the report being corrected, which is archived here.
        await expect(
          send(
            "override-middle",
            { corrects_seq: middle },
            as(maintainer, "maintainer"),
          ),
        ).rejects.toMatchObject({ code: "journal-history-unavailable" });
        expect(state()).toEqual(before);
      } else {
        // Nothing is archived, so the same requests resolve without any archive reader.
        expect(
          (await send("reporter-tail", { corrects_seq: tail }, as(reporter)))
            .response.event.seq,
        ).toBe(tail + 1);
      }
    });
  });

  it("does not read lineage for a maintainer override", async () => {
    const root = seqOf(await send("root", {}, as(reporter)));
    const tail = seqOf(
      await send("tail", { corrects_seq: root }, as(reporter)),
    );
    fixture.db.delete(schema.journal).where(eq(schema.journal.seq, root)).run();
    fixture.db
      .insert(schema.journalArchiveWatermark)
      .values({ id: 1, last_archived_seq: root, archived_at: now })
      .run();
    // The archived root is unreachable, but the live report being corrected is enough.
    expect(
      (
        await send(
          "override",
          { corrects_seq: tail },
          as(maintainer, "maintainer"),
        )
      ).response.event.principal_id,
    ).toBe(maintainer.principalId);
    await expect(
      send("reporter", { corrects_seq: tail }, as(reporter)),
    ).rejects.toMatchObject({ code: "journal-history-unavailable" });
  });

  it("fails closed on a lineage link that is not a report or does not point back", async () => {
    createEntity(fixture.db, { id: "not-a-report" }); // sequence 1, a task event
    const reporterEvent = (change: Partial<JournalAppendRequest>) =>
      rawEvent(reporter.principalId, { ...input, ...change });
    const pointsAtTask = reporterEvent({ corrects_seq: 1 });
    const pointsForward = reporterEvent({ corrects_seq: 99 });
    const malformed = rawEvent(reporter.principalId, { not: "a report" });
    const pointsAtMalformed = reporterEvent({ corrects_seq: malformed });
    const before = state();
    for (const target of [pointsAtTask, pointsForward, pointsAtMalformed])
      for (const who of [reporter, other])
        await expect(
          send(
            `${who.principalId}-${target}`,
            { corrects_seq: target },
            as(who),
          ),
        ).rejects.toMatchObject({ code: "journal-history-unavailable" });
    // A malformed event is not a report, so it can never be the target.
    await expect(
      send(
        "malformed",
        { corrects_seq: malformed },
        as(maintainer, "maintainer"),
      ),
    ).rejects.toMatchObject({ code: "validation-error" });
    expect(state()).toEqual(before);
  });

  it("verifies a reporter through a bounded chain and leaves longer ones to maintainers", async () => {
    let tail = seqOf(await send("root", {}, as(reporter)));
    for (let i = 0; i < CORRECTION_CHAIN_LIMIT; i++)
      tail = rawEvent(reporter.principalId, { ...input, corrects_seq: tail });
    const atLimit = seqOf(
      await send("at-limit", { corrects_seq: tail }, as(reporter)),
    );
    const before = state();
    await expect(
      send("past-limit", { corrects_seq: atLimit }, as(reporter)),
    ).rejects.toMatchObject(denied);
    expect(state()).toEqual(before);
    expect(
      (
        await send(
          "past-limit-maintainer",
          { corrects_seq: atLimit },
          as(maintainer, "maintainer"),
        )
      ).response.event.seq,
    ).toBe(atLimit + 1);
  });
});
