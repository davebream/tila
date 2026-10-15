import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { journalArchiveOps, schema } from "@tila/ops-sqlite";
import { JOURNAL_REPLAY_SCAN_BUDGET } from "@tila/schemas";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  EmbeddedProject,
  createBlobJournalArchiveReader,
  runEmbeddedMigrations,
} from "../src/index";
import { MemoryBlobStore, migrationStorage, noopSleep } from "./harness.bun";

type Db = BaseSQLiteDatabase<"sync", void, typeof schema>;
const PROJECT = "project";
let rawDb: Database;
let db: Db;
let blobs: MemoryBlobStore;
let project: EmbeddedProject;

beforeEach(() => {
  rawDb = new Database(":memory:");
  runEmbeddedMigrations(migrationStorage(rawDb));
  db = drizzle(rawDb, { schema }) as unknown as Db;
  blobs = new MemoryBlobStore();
  project = new EmbeddedProject({
    db,
    archives: createBlobJournalArchiveReader(blobs, PROJECT),
    org: "org",
    project: PROJECT,
    sleepSync: noopSleep,
    close: () => rawDb.close(),
  });
});
afterEach(() => rawDb.close());

function append(
  seq: number,
  kind: string,
  data: Record<string, unknown> = {},
): void {
  rawDb
    .query(
      "INSERT INTO journal (seq, t, kind, resource, principal_id, participant_id, environment, actor, data) VALUES (?, ?, ?, 'project', 'principal', 'participant', '{}', 'actor', ?)",
    )
    .run(seq, seq, kind, JSON.stringify(data));
}
const report = (seq: number, eventName: string, correlationId?: string) =>
  append(seq, "custom.reported", {
    event_name: eventName,
    event_version: 1,
    target: { kind: "project" },
    data: {},
    ...(correlationId ? { correlation_id: correlationId } : {}),
  });
async function archive(throughSeq: number, key = "2025/01.part-1.jsonl") {
  const rows = journalArchiveOps.getArchivableEvents(db).events;
  await blobs.write(
    `journal-archive/${PROJECT}/${key}`,
    rows.map((row) => JSON.stringify(row)).join("\n"),
  );
  journalArchiveOps.markArchived(db, throughSeq);
}

describe("embedded filtered journal replay", () => {
  it("finds archived and live reports by event_name and correlation_id", async () => {
    for (let seq = 1; seq <= 3; seq++) append(seq, "task.created");
    report(4, "pipeline.old", "run-1");
    append(5, "task.created");
    append(6, "task.created");
    report(7, "pipeline.live", "run-1");
    report(8, "pipeline.other", "run-2");
    await archive(5);

    const seqs = async (filter: object) =>
      (await project.replayJournal({ after_seq: 0, ...filter })).events.map(
        (event) => event.seq,
      );
    expect(await seqs({ event_name: "pipeline.old" })).toEqual([4]);
    expect(await seqs({ correlation_id: "run-1" })).toEqual([4, 7]);
    expect(
      await seqs({ event_name: "pipeline.live", correlation_id: "run-1" }),
    ).toEqual([7]);
    expect(await seqs({})).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      await project.replayJournal({ after_seq: 0, event_name: "pipeline.old" }),
    ).toMatchObject({ next_after_seq: 8, through_seq: 8, has_more: false });
  });

  it("fails closed on a missing sequence even when the filter matches nothing", async () => {
    for (let seq = 1; seq <= 6; seq++) append(seq, "task.created");
    await archive(4);
    // Lose archived sequence 3 from the blob.
    const key = `journal-archive/${PROJECT}/2025/01.part-1.jsonl`;
    const kept = (await blobs.read(key))
      ?.split("\n")
      .filter((line) => JSON.parse(line).seq !== 3);
    await blobs.write(key, (kept ?? []).join("\n"));
    await expect(
      project.replayJournal({ after_seq: 0, event_name: "no.such_event" }),
    ).rejects.toMatchObject({
      code: "journal-history-unavailable",
      status: 503,
    });
  });

  it("never matches rows without an event_name or outside the report kind", async () => {
    append(1, "custom.reported", { correlation_id: "c-1" });
    append(2, "task.created", { event_name: "x.named", correlation_id: "c-1" });
    report(3, "x.named", "c-1");
    const seqs = async (filter: object) =>
      (await project.replayJournal({ after_seq: 0, ...filter })).events.map(
        (event) => event.seq,
      );
    expect(await seqs({ event_name: "x.named" })).toEqual([3]);
    expect(await seqs({ correlation_id: "c-1" })).toEqual([1, 3]);
  });

  it("exhausts the scan budget with progress that resumes without skipping", async () => {
    const total = JOURNAL_REPLAY_SCAN_BUDGET * 2 + 150;
    rawDb.exec("BEGIN");
    for (let seq = 1; seq <= total; seq++) {
      if (seq === 1500 || seq === 2100) report(seq, "needle.found", "needle");
      else append(seq, "task.created");
    }
    rawDb.exec("COMMIT");

    const found: number[] = [];
    const progress: number[] = [];
    let after = 0;
    let through: number | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await project.replayJournal({
        after_seq: after,
        through_seq: through,
        limit: 5,
        correlation_id: "needle",
      });
      found.push(...result.events.map((event) => event.seq));
      progress.push(result.next_after_seq);
      through = result.through_seq;
      after = result.next_after_seq;
      if (!result.has_more) break;
    }
    expect(found).toEqual([1500, 2100]);
    expect(progress).toEqual([
      JOURNAL_REPLAY_SCAN_BUDGET,
      JOURNAL_REPLAY_SCAN_BUDGET * 2,
      total,
    ]);
  });

  it("keeps unfiltered replay and re-entry unchanged", async () => {
    for (let seq = 1; seq <= 5; seq++) append(seq, "task.created");
    const page = await project.replayJournal({ after_seq: 0, limit: 2 });
    expect(page).toMatchObject({ next_after_seq: 2, has_more: true });
    expect(page.events.map((event) => event.seq)).toEqual([1, 2]);
    const reentry = await project.reentry({ limit: 2 });
    expect(reentry.changes.events.map((event) => event.seq)).toEqual([1, 2]);
  });
});

it("searches nested archived report text through the embedded backfill", async () => {
  append(1, "custom.reported", {
    event_name: "pipeline.old",
    event_version: 1,
    target: { kind: "project" },
    data: { deep: ["embeddedneedle"] },
  });
  await archive(1);
  expect(
    project.searchPage({ q: "embeddedneedle", kinds: ["report"] }).scope
      ?.report_history?.status,
  ).toBe("pending");
  expect(await project.indexReportHistoryBatch()).toMatchObject({
    status: "complete",
  });
  expect(
    project.searchPage({ q: "embeddedneedle", kinds: ["report"] }).results,
  ).toMatchObject([{ type: "report", seq: 1 }]);
  expect(project.searchAll({ q: "embeddedneedle" })).toMatchObject([
    { type: "report", seq: 1 },
  ]);
  expect(await project.reindexReports()).toMatchObject({ status: "complete" });
});
