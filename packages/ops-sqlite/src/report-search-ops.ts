import {
  ContinuityError,
  type JournalArchiveReader,
  resolveReplayEvents,
} from "@tila/core";
import {
  JournalReportedEventSchema,
  type ReportHistoryScope,
  type ReportSearchResult,
} from "@tila/schemas";
import { and, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { highSequence, replayWindow } from "./continuity-ops";
import * as schema from "./schema";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;
export const REPORT_INDEX_BATCH_SIZE = 1000;

/** Only values are searchable: keys, provenance and artifact contents are not. */
export function reportText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return "";
  return Object.values(value).map(reportText).filter(Boolean).join("\n");
}

export function indexReport(db: Db, raw: unknown): void {
  const event = JournalReportedEventSchema.parse(raw);
  const row = {
    seq: event.seq,
    t: event.t,
    resource: event.resource,
    principal_id: event.principal_id,
    event_name: event.data.event_name,
    correlation_id: event.data.correlation_id ?? null,
    corrects_seq: event.data.corrects_seq ?? null,
    body_text: reportText(event.data.data),
    indexed_at: Date.now(),
  };
  db.insert(schema.reportSearchDocs)
    .values(row)
    .onConflictDoUpdate({
      target: schema.reportSearchDocs.seq,
      set: row,
    })
    .run();
}

export function reportHistoryScope(db: Db): ReportHistoryScope {
  const state = db
    .select()
    .from(schema.reportSearchState)
    .where(eq(schema.reportSearchState.id, 1))
    .get();
  return {
    archived: "included",
    status: (state?.status ?? "pending") as ReportHistoryScope["status"],
    indexed_through_seq: state?.indexed_through_seq ?? 0,
    target_through_seq: state?.target_through_seq ?? highSequence(db),
    ...(state?.error ? { error: state.error } : {}),
  };
}

/** Automatic reads never restart failed/completed work; explicit reindex does. */
export function startReportIndex(db: Db, restart = false): ReportHistoryScope {
  return db.transaction((tx) => {
    const state = tx
      .select()
      .from(schema.reportSearchState)
      .where(eq(schema.reportSearchState.id, 1))
      .get();
    if (!state || (restart && state.status !== "running")) {
      const resume = state?.status === "failed";
      const target = resume ? state.target_through_seq : highSequence(tx);
      const cursor = resume ? state.indexed_through_seq : 0;
      const row = {
        id: 1,
        status: cursor === target ? "complete" : "running",
        indexed_through_seq: cursor,
        target_through_seq: target,
        generation: crypto.randomUUID(),
        error: null,
      };
      tx.insert(schema.reportSearchState)
        .values(row)
        .onConflictDoUpdate({ target: schema.reportSearchState.id, set: row })
        .run();
    }
    return reportHistoryScope(tx);
  });
}

/** Archive I/O is outside the transaction; compare-and-set prevents stale batches. */
export async function indexReportHistoryBatch(
  db: Db,
  options: {
    archives?: JournalArchiveReader;
    assertWritable?: () => void;
  } = {},
): Promise<ReportHistoryScope> {
  const state = db
    .select()
    .from(schema.reportSearchState)
    .where(eq(schema.reportSearchState.id, 1))
    .get();
  if (!state || state.status !== "running") return reportHistoryScope(db);
  const end = Math.min(
    state.indexed_through_seq + REPORT_INDEX_BATCH_SIZE,
    state.target_through_seq,
  );
  const snapshot = db.transaction((tx) =>
    replayWindow(tx, state.indexed_through_seq, end, state.target_through_seq),
  );
  const unchanged = () =>
    and(
      eq(schema.reportSearchState.id, 1),
      eq(schema.reportSearchState.generation, state.generation),
      eq(
        schema.reportSearchState.indexed_through_seq,
        state.indexed_through_seq,
      ),
      eq(schema.reportSearchState.status, "running"),
    );
  try {
    const events = await resolveReplayEvents(snapshot, options.archives);
    db.transaction((tx) => {
      options.assertWritable?.();
      if (!tx.select().from(schema.reportSearchState).where(unchanged()).get())
        return;
      for (const event of events)
        if (event.kind === "custom.reported") indexReport(tx, event);
      tx.update(schema.reportSearchState)
        .set({
          indexed_through_seq: end,
          status: end === state.target_through_seq ? "complete" : "running",
          error: null,
        })
        .where(unchanged())
        .run();
    });
  } catch (error) {
    // Maintenance is retried by the scheduler without changing the frozen snapshot.
    options.assertWritable?.();
    db.update(schema.reportSearchState)
      .set({
        status: "failed",
        error:
          error instanceof ContinuityError ? error.code : "report-index-failed",
      })
      .where(unchanged())
      .run();
  }
  return reportHistoryScope(db);
}

export function searchReports(
  db: Db,
  query: { q: string; limit: number; offset: number; tagFilter?: string[] },
): ReportSearchResult[] {
  if (query.tagFilter?.length) return [];
  const d = schema.reportSearchDocs;
  return db
    .select({
      seq: d.seq,
      t: d.t,
      resource: d.resource,
      principal_id: d.principal_id,
      event_name: d.event_name,
      correlation_id: d.correlation_id,
      corrects_seq: d.corrects_seq,
      indexed_at: d.indexed_at,
      snippet: sql<
        string | null
      >`snippet(report_search_docs_fts, -1, '<b>', '</b>', '...', 10)`,
    })
    .from(d)
    .innerJoin(
      sql`report_search_docs_fts`,
      sql`${d.seq} = report_search_docs_fts.rowid`,
    )
    .where(sql`report_search_docs_fts MATCH ${query.q}`)
    .orderBy(sql`bm25(report_search_docs_fts)`, d.seq)
    .limit(query.limit)
    .offset(query.offset)
    .all();
}
