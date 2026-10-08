import {
  journalArchiveOps,
  type schema,
  storeCountsOps,
  sweepOps,
} from "@tila/ops-sqlite";
import type Database from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { StoreSample } from "../types";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

const ARCHIVE_MAX_ROWS = 500_000;
const ARCHIVE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Row counts per domain table plus the on-disk/in-memory page footprint. */
export function sampleSqlite(db: Db, sqlite: Database.Database): StoreSample {
  const pageCount = Number(sqlite.pragma("page_count", { simple: true }));
  const pageSize = Number(sqlite.pragma("page_size", { simple: true }));
  const counts = storeCountsOps.countStoreRows(db);
  return {
    db_bytes: pageCount * pageSize,
    counts: { ...counts.domain, _schema_history: counts.schemaHistory },
  };
}

/**
 * Run the per-project sweep step and measure the journal-archive scan, which
 * loads every archivable row into memory (the cost a soak is looking for).
 */
export function sweepSqlite(db: Db): Record<string, number> {
  const t0 = performance.now();
  const heap0 = process.memoryUsage().heapUsed;
  const result = sweepOps.sweep(db);
  const sweepMs = performance.now() - t0;
  const t1 = performance.now();
  const archivable = journalArchiveOps.getArchivableEvents(db, {
    maxRows: ARCHIVE_MAX_ROWS,
    maxAgeMs: ARCHIVE_MAX_AGE_MS,
  });
  const archiveScanMs = performance.now() - t1;
  return {
    claims_deleted: result.claimsDeleted,
    presence_deleted: result.presenceDeleted,
    signals_deleted: result.signalsDeleted,
    tombstoned_pointers_deleted: result.tombstonedPointersDeleted,
    do_idempotency_deleted: result.doIdempotencyDeleted,
    sweep_ms: Math.round(sweepMs * 1000) / 1000,
    archivable_rows: archivable.events.length,
    archive_scan_ms: Math.round(archiveScanMs * 1000) / 1000,
    archive_scan_heap_delta_bytes: process.memoryUsage().heapUsed - heap0,
  };
}
