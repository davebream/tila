import type { JournalArchiveReader } from "@tila/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendReport } from "../src/custom-journal-ops";
import { truncateAllDomainTables } from "../src/destroy-ops";
import { markArchived } from "../src/journal-archive-ops";
import { listJournal } from "../src/journal-ops";
import * as transfer from "../src/project-transfer-ops";
import {
  indexReportHistoryBatch,
  reportHistoryScope,
  startReportIndex,
} from "../src/report-search-ops";
import * as schema from "../src/schema";
import {
  SearchKindDenied,
  searchPage,
  searchableKinds,
} from "../src/search-page-ops";
import { type TestDb, createEntity, createTestDb, testOrigin } from "./helpers";

let f: TestDb;
beforeEach(() => {
  f = createTestDb();
});
afterEach(() => f.rawDb.close());
const input = {
  event_name: "pipeline.reviewed",
  event_version: 1,
  target: { kind: "project" as const },
  correlation_id: "correlationneedle",
  data: {
    secretkey: ["nestedneedle", { body: "markdown **needle**" }],
    number: 987654321,
    bool: true,
  },
};
const append = (key: string, corrects_seq?: number) =>
  appendReport(f.db, {
    projectId: "project",
    origin: testOrigin(),
    input: { ...input, ...(corrects_seq ? { corrects_seq } : {}) },
    authorizedRole: "participant",
    idempotencyKey: key,
  });
const search = (
  q: string,
  more: Partial<Parameters<typeof searchPage>[1]> = {},
) => searchPage(f.db, { q, kinds: ["report"], limit: 20, ...more });
function rawEvents() {
  return listJournal(f.db, { after_seq: 0, limit: 2000 });
}
function reader(events = rawEvents()): JournalArchiveReader {
  return {
    async *read() {
      yield* events;
    },
  };
}
function eraseIndex() {
  f.db.delete(schema.reportSearchDocs).run();
}
function legacy(seq: number, kind = "entity.created") {
  f.db
    .insert(schema.journal)
    .values({
      seq,
      t: seq,
      kind,
      resource: "project:project",
      principal_id: "p",
      participant_id: "part",
      environment: "{}",
      actor: "",
      data: JSON.stringify(kind === "custom.reported" ? input : {}),
    })
    .run();
}

describe("report full-text search", () => {
  it("indexes only nested strings and metadata, with atomic idempotent writes", async () => {
    const report = await append("one");
    for (const term of [
      "nestedneedle",
      "needle",
      "reviewed",
      "correlationneedle",
    ])
      expect(search(term).results).toMatchObject([
        { type: "report", seq: report.response.event.seq },
      ]);
    for (const term of ["secretkey", "987654321", "true", "testprincipal"])
      expect(search(term).results).toEqual([]);
    expect(search("nestedneedle", { tagFilter: ["team:one"] }).results).toEqual(
      [],
    );
    expect(() => search('"unterminated')).toThrow();
    expect(search("nestedn", { syntax: "literal" }).results).toHaveLength(1);
    await append("one");
    expect(f.db.select().from(schema.reportSearchDocs).all()).toHaveLength(1);
  });
  it("rolls back journal, receipt and quota when indexing fails", async () => {
    f.rawDb.exec(
      "CREATE TRIGGER reject_report_index BEFORE INSERT ON report_search_docs BEGIN SELECT RAISE(ABORT, 'index unavailable'); END",
    );
    await expect(append("rejected")).rejects.toThrow("index unavailable");
    for (const table of [
      schema.journal,
      schema.journalReportReceipts,
      schema.journalReportRates,
    ])
      expect(f.db.select().from(table).all()).toEqual([]);
  });
  it("retains originals and corrections across archival and pages without duplicates", async () => {
    const first = await append("original");
    await append("correction", first.response.event.seq);
    createEntity(f.db, { id: "needle-task", data: { title: "needle" } });
    const one = search("needle", { limit: 1 });
    if (!one.next_cursor) throw new Error("Expected another result page");
    const two = search("needle", { limit: 1, cursor: one.next_cursor });
    expect([...one.results, ...two.results]).toMatchObject([
      { seq: 1 },
      { seq: 2 },
    ]);
    expect(two.next_cursor).toBeNull();
    expect(
      search("needle", { kinds: ["task", "report"] }).results.map(
        (r) => r.type,
      ),
    ).toEqual(["entity", "report", "report"]);
    markArchived(f.db, 2);
    expect(search("needle").results).toMatchObject([
      { seq: 1, corrects_seq: null },
      { seq: 2, corrects_seq: 1 },
    ]);
  });
  it("requires journal read and excludes namespace-restricted reports", () => {
    expect(
      searchableKinds({ capabilities: ["journal:read"] }, ["report"]).kinds,
    ).toEqual(["report"]);
    expect(() => searchableKinds({ capabilities: [] }, ["report"])).toThrow(
      SearchKindDenied,
    );
    const policy = {
      capabilities: ["journal:read"],
      restrictions: { task_types: ["task"] },
    };
    expect(() => searchableKinds(policy, ["report"])).toThrow(SearchKindDenied);
    expect(searchableKinds(policy, undefined).excluded_kinds).toContainEqual({
      kind: "report",
      reason: "restricted",
    });
  });
});

describe("verified historical indexing", () => {
  it("bounds batches, fixes the target and resumes across archives and new writes", async () => {
    for (let seq = 1; seq <= 1002; seq++)
      legacy(
        seq,
        seq === 1 || seq === 1002 ? "custom.reported" : "entity.created",
      );
    const archives = reader();
    markArchived(f.db, 1001);
    expect(reportHistoryScope(f.db).status).toBe("pending");
    expect(startReportIndex(f.db).target_through_seq).toBe(1002);
    expect((await append("live")).response.event.seq).toBe(1003);
    expect(await indexReportHistoryBatch(f.db, { archives })).toMatchObject({
      status: "running",
      indexed_through_seq: 1000,
      target_through_seq: 1002,
    });
    expect(search("needle").results).toHaveLength(2);
    expect(await indexReportHistoryBatch(f.db, { archives })).toMatchObject({
      status: "complete",
      indexed_through_seq: 1002,
    });
    expect(search("needle").results).toHaveLength(3);
    startReportIndex(f.db, true);
    expect(search("needle").results).toHaveLength(3);
    expect(reportHistoryScope(f.db)).toMatchObject({
      status: "running",
      target_through_seq: 1003,
      indexed_through_seq: 0,
    });
  });
  it("fails on missing archives without advancing and resumes after repair", async () => {
    await append("old");
    const archives = reader();
    markArchived(f.db, 1);
    eraseIndex();
    startReportIndex(f.db);
    expect(await indexReportHistoryBatch(f.db)).toMatchObject({
      status: "failed",
      indexed_through_seq: 0,
      error: "journal-history-unavailable",
    });
    expect(startReportIndex(f.db).status).toBe("failed");
    startReportIndex(f.db, true);
    expect(await indexReportHistoryBatch(f.db, { archives })).toMatchObject({
      status: "complete",
      indexed_through_seq: 1,
    });
    expect(search("needle").results).toHaveLength(1);
  });
  it("rejects conflicting archives without publishing part of a window", async () => {
    await append("old");
    const events = rawEvents();
    markArchived(f.db, 1);
    eraseIndex();
    startReportIndex(f.db);
    const archives: JournalArchiveReader = {
      async *read() {
        yield* events;
        yield { ...events[0], principal_id: "other" };
      },
    };
    expect(await indexReportHistoryBatch(f.db, { archives })).toMatchObject({
      status: "failed",
      indexed_through_seq: 0,
      error: "journal-history-conflict",
    });
    expect(search("needle").results).toEqual([]);
  });
  it("rechecks maintenance after archive I/O", async () => {
    await append("old");
    const events = rawEvents();
    markArchived(f.db, 1);
    eraseIndex();
    startReportIndex(f.db);
    let locked = false;
    const archives: JournalArchiveReader = {
      async *read() {
        yield* events;
        locked = true;
      },
    };
    await expect(
      indexReportHistoryBatch(f.db, {
        archives,
        assertWritable: () => {
          if (locked) throw new Error("project-maintenance");
        },
      }),
    ).rejects.toThrow("project-maintenance");
    expect(reportHistoryScope(f.db)).toMatchObject({
      status: "running",
      indexed_through_seq: 0,
    });
    expect(search("needle").results).toEqual([]);
  });
  it("discards in-flight batches after project destruction and recreation", async () => {
    await append("old");
    const events = rawEvents();
    markArchived(f.db, 1);
    eraseIndex();
    startReportIndex(f.db);
    const archives: JournalArchiveReader = {
      async *read() {
        yield* events;
        truncateAllDomainTables({
          exec: (statement) => f.rawDb.exec(statement),
        });
        legacy(1);
        startReportIndex(f.db);
      },
    };
    await indexReportHistoryBatch(f.db, { archives });
    expect(search("needle").results).toEqual([]);
    expect(reportHistoryScope(f.db).indexed_through_seq).toBe(0);
  });
});

it("round-trips retained report documents and progress through snapshots and rebuilds FTS", async () => {
  await append("old");
  startReportIndex(f.db);
  await indexReportHistoryBatch(f.db);
  markArchived(f.db, 1);
  const storage = {
    exec(statement: string, ...bindings: unknown[]) {
      if (/^\s*(SELECT|PRAGMA)/i.test(statement))
        return {
          toArray: () =>
            f.rawDb.prepare(statement).all(...bindings) as Record<
              string,
              unknown
            >[],
        };
      if (bindings.length) f.rawDb.prepare(statement).run(...bindings);
      else f.rawDb.exec(statement);
      return { toArray: () => [] };
    },
  };
  const rows = Object.fromEntries(
    transfer.PROJECT_BACKUP_TABLES.map((table) => [
      table,
      transfer.readSnapshotPage(storage, table, { limit: 100 }).rows,
    ]),
  );
  const digest = await transfer.semanticDigest(storage);
  f.rawDb.transaction(() => transfer.replaceSnapshotRows(storage, rows, 2))();
  expect(await transfer.semanticDigest(storage)).toBe(digest);
  expect(search("needle").results).toMatchObject([{ type: "report", seq: 1 }]);
  expect(reportHistoryScope(f.db).status).toBe("complete");
  const legacyRows = Object.fromEntries(
    Object.entries(rows).filter(
      ([table]) =>
        table !== "report_search_docs" && table !== "report_search_state",
    ),
  );
  f.rawDb.transaction(() =>
    transfer.replaceSnapshotRows(storage, legacyRows, 2),
  )();
  expect(reportHistoryScope(f.db).status).toBe("pending");
  expect(search("needle").results).toEqual([]);
});
