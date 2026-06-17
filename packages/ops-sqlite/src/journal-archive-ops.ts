import { and, count, eq, lt, max } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

export interface ArchiveWatermark {
  lastArchivedSeq: number;
  archivedAt: number;
}

export interface JournalRow {
  seq: number;
  t: number;
  kind: string;
  resource: string;
  actor: string;
  token_id: string | null;
  fence: number | null;
  data: Record<string, unknown>;
  source: string | null;
  source_version: string | null;
}

export interface ArchivableEventsResult {
  events: JournalRow[];
  throughSeq: number;
}

/**
 * Return the current archive watermark, or null if no archival has run yet.
 */
export function getArchiveWatermark(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): ArchiveWatermark | null {
  const row = db
    .select()
    .from(schema.journalArchiveWatermark)
    .where(eq(schema.journalArchiveWatermark.id, 1))
    .get();

  if (!row) return null;

  return {
    lastArchivedSeq: row.last_archived_seq,
    archivedAt: row.archived_at,
  };
}

/**
 * Select journal rows eligible for archival.
 *
 * Selection strategy:
 * - If maxAgeMs is set: select rows where t < Date.now() - maxAgeMs
 * - If maxRows is set: additionally cap to the oldest N rows (to keep total
 *   journal size under control even when many rows are older than the threshold)
 *
 * Returns the matching events and the highest seq in the batch (throughSeq).
 * Returns { events: [], throughSeq: 0 } when nothing qualifies.
 */
export function getArchivableEvents(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  opts: {
    maxAgeMs?: number;
    maxRows?: number;
  } = {},
): ArchivableEventsResult {
  const { maxAgeMs, maxRows } = opts;

  // Base query: select events older than maxAgeMs
  const cutoffT =
    maxAgeMs !== undefined ? Date.now() - maxAgeMs : Number.MAX_SAFE_INTEGER;

  const baseRows = db
    .select()
    .from(schema.journal)
    .where(lt(schema.journal.t, cutoffT))
    .orderBy(schema.journal.seq)
    .all();

  // If maxRows is specified and total journal count exceeds the cap,
  // we take only the oldest batch to bring the count under the cap.
  let rows = baseRows;
  if (maxRows !== undefined) {
    const total = db.select({ total: count() }).from(schema.journal).get();
    const totalCount = total?.total ?? 0;
    if (totalCount > maxRows) {
      const excess = totalCount - maxRows;
      // Keep only up to excess oldest rows from baseRows
      rows = baseRows.slice(0, excess);
    }
  }

  if (rows.length === 0) {
    return { events: [], throughSeq: 0 };
  }

  const events: JournalRow[] = rows.map((row) => ({
    seq: row.seq ?? 0,
    t: row.t,
    kind: row.kind,
    resource: row.resource,
    actor: row.actor,
    token_id: row.token_id ?? null,
    fence: row.fence ?? null,
    data: JSON.parse(row.data) as Record<string, unknown>,
    source: row.source ?? null,
    source_version: row.source_version ?? null,
  }));

  const throughSeq = Math.max(...events.map((e) => e.seq));

  return { events, throughSeq };
}

/**
 * Mark journal events as archived. In a single transaction:
 *   1. UPSERT the watermark row to max(current, throughSeq) — monotonic, never
 *      goes backward.
 *   2. DELETE only the rows archived THIS cycle: seq <= the PASSED throughSeq.
 *
 * The delete uses the PASSED `throughSeq`, NOT the (possibly higher) watermark.
 * Deleting down to the watermark would be a correctness trap: a call with a
 * throughSeq BELOW the current watermark would delete rows in the
 * (throughSeq, watermark] gap that were never written to R2 this cycle, losing
 * un-backed-up events. The watermark still advances monotonically for the
 * "already archived" read guard (listJournal), but row deletion is scoped to
 * exactly what this cycle confirmed. (The sweep always confirms with the
 * throughSeq it just wrote, so the gap is unreachable in normal operation — this
 * is defense-in-depth against a future caller passing a stale throughSeq.)
 *
 * This is atomic: either both succeed or neither does.
 */
export function markArchived(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  throughSeq: number,
): void {
  db.transaction((tx) => {
    // Read current watermark to enforce monotonicity
    const current = tx
      .select()
      .from(schema.journalArchiveWatermark)
      .where(eq(schema.journalArchiveWatermark.id, 1))
      .get();

    const newSeq = current
      ? Math.max(current.last_archived_seq, throughSeq)
      : throughSeq;

    // UPSERT the single watermark row (id = 1) — advances monotonically.
    tx.insert(schema.journalArchiveWatermark)
      .values({
        id: 1,
        last_archived_seq: newSeq,
        archived_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: schema.journalArchiveWatermark.id,
        set: {
          last_archived_seq: newSeq,
          archived_at: Date.now(),
        },
      })
      .run();

    // Delete ONLY what this cycle archived: seq <= throughSeq (i.e. seq <
    // throughSeq + 1). Scoped to the PASSED throughSeq, never the watermark, so
    // a stale low call cannot delete un-archived rows above it.
    tx.delete(schema.journal)
      .where(lt(schema.journal.seq, throughSeq + 1))
      .run();
  });
}
