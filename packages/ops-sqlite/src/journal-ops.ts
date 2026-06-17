import type { JournalEventKind } from "@tila/schemas";
import type { TablesRelationalConfig } from "drizzle-orm";
import { type SQL, and, count, desc, eq, gt, inArray, max } from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

/**
 * Bundles actor identity and client provenance for all ops functions.
 * Replaces the separate actor + ProvenanceCtx parameter pair.
 */
export interface RequestOrigin {
  actor: string;
  tokenId?: string | null;
  source?: string | null;
  sourceVersion?: string | null;
  machine?: string | null;
}

/**
 * Append a journal entry. MUST be called inside the same db.transaction()
 * as the state change that triggers it. Never call outside a transaction.
 */
export function appendJournal(
  tx: SQLiteTransaction<"sync", unknown, typeof schema, TablesRelationalConfig>,
  entry: {
    kind: JournalEventKind;
    resource: string;
    actor: string;
    tokenId?: string | null;
    fence?: number | null;
    data?: Record<string, unknown>;
    source?: string | null;
    sourceVersion?: string | null;
  },
): void {
  tx.insert(schema.journal)
    .values({
      t: Date.now(),
      kind: entry.kind,
      resource: entry.resource,
      actor: entry.actor,
      token_id: entry.tokenId ?? null,
      fence: entry.fence ?? null,
      data: JSON.stringify(entry.data ?? {}),
      source: entry.source ?? null,
      source_version: entry.sourceVersion ?? null,
    })
    .run();
}

/**
 * List journal entries with optional filters.
 *
 * When `watermark` is provided and `query.after_seq` is less than
 * `watermark.lastArchivedSeq`, the requested range has been archived to R2
 * and deleted from DO SQLite. Returns an empty array in that case — callers
 * should surface an "archived" indicator to the client.
 */
export function listJournal(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  query: {
    resource?: string;
    kind?: string | string[];
    source?: string | string[];
    after_seq?: number;
    limit?: number;
  },
  watermark?: { lastArchivedSeq: number },
): {
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
}[] {
  // When the requested range falls entirely within the archived region,
  // return an empty array — the caller surfaces an "archived" indicator.
  if (
    watermark !== undefined &&
    query.after_seq !== undefined &&
    query.after_seq < watermark.lastArchivedSeq
  ) {
    return [];
  }

  const conditions: SQL[] = [];

  if (query.resource) {
    conditions.push(eq(schema.journal.resource, query.resource));
  }
  if (query.kind) {
    if (Array.isArray(query.kind)) {
      conditions.push(inArray(schema.journal.kind, query.kind));
    } else {
      conditions.push(eq(schema.journal.kind, query.kind));
    }
  }
  if (query.source) {
    if (Array.isArray(query.source)) {
      conditions.push(inArray(schema.journal.source, query.source));
    } else {
      conditions.push(eq(schema.journal.source, query.source));
    }
  }
  if (query.after_seq !== undefined) {
    conditions.push(gt(schema.journal.seq, query.after_seq));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db
    .select()
    .from(schema.journal)
    .where(whereClause)
    .orderBy(desc(schema.journal.seq))
    .limit(query.limit ?? 100)
    .all();

  return rows.map((row) => ({
    seq: row.seq ?? 0,
    t: row.t,
    kind: row.kind,
    resource: row.resource,
    actor: row.actor,
    token_id: row.token_id ?? null,
    fence: row.fence,
    data: JSON.parse(row.data) as Record<string, unknown>,
    source: row.source ?? null,
    source_version: row.source_version ?? null,
  }));
}

/**
 * Compute the archive-range indicator for a journal read, given the requested
 * cursor and the current archival watermark.
 *
 * `archived` is true only when a cursor (`after_seq`) is supplied AND it falls
 * below the archival watermark — i.e. the requested range was archived to R2 and
 * deleted from DO SQLite, so an empty `listJournal` result means "archived", not
 * "caught up". Recent `{limit:N}` reads (no cursor) are never flagged archived.
 *
 * `lastArchivedSeq` echoes the watermark (or null when no archival has run) so a
 * client knows where the archived boundary sits.
 *
 * This is a pure helper so the route layer can surface `{ archived, lastArchivedSeq }`
 * as a sibling field on its response envelope without changing `listJournal`'s
 * array return type.
 */
export function journalArchiveState(
  afterSeq: number | undefined,
  watermark: { lastArchivedSeq: number } | null | undefined,
): { archived: boolean; lastArchivedSeq: number | null } {
  if (!watermark) {
    return { archived: false, lastArchivedSeq: null };
  }
  const archived =
    afterSeq !== undefined && afterSeq < watermark.lastArchivedSeq;
  return { archived, lastArchivedSeq: watermark.lastArchivedSeq };
}

/**
 * Return aggregate journal statistics: total row count and max sequence number.
 */
export function journalStats(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): {
  journalRows: number;
  maxSeq: number;
} {
  const result = db
    .select({
      total: count(),
      maxSeq: max(schema.journal.seq),
    })
    .from(schema.journal)
    .get();
  return {
    journalRows: result?.total ?? 0,
    maxSeq: result?.maxSeq ?? 0,
  };
}
