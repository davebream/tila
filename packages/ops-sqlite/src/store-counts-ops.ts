import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

/**
 * Canonical list of domain tables that must be zero after a project destroy + reconstruction.
 * Raw `*_fts` virtual tables are NOT included — they have no Drizzle model.
 * `_schema_history` is excluded from the domain set and returned separately as a diagnostic.
 */
export const DOMAIN_TABLE_NAMES = [
  "entities",
  "entity_relationships",
  "artifact_pointers",
  "entity_artifact_references",
  "artifact_relationships",
  "journal",
  "_journal_archive_watermark",
  "claims",
  "fences",
  "presence",
  "gates",
  "signals",
  "records",
  "record_tags",
  "record_revisions",
  "artifact_search_docs",
  "entity_search_docs",
  "record_search_docs",
] as const;

export type DomainTableName = (typeof DOMAIN_TABLE_NAMES)[number];

export type StoreCountsResult = {
  /** Per-table row counts for every domain table. Must all be 0 after a successful destroy. */
  domain: Record<DomainTableName, number>;
  /** Row count for _schema_history — diagnostic only, NOT required to be 0. */
  schemaHistory: number;
};

/**
 * Count rows in a single named table using raw SQL.
 * Avoids complex Drizzle generic variance for the per-table helper.
 */
function countTable(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  tableName: string,
): number {
  const row = db.get<{ n: number }>(
    sql.raw(`SELECT COUNT(*) AS n FROM "${tableName}"`),
  );
  return row?.n ?? 0;
}

/**
 * Returns row counts for every domain table in the DO SQLite database.
 * Used by the project destroy read-back verification: after destroy + reconstruction,
 * all `domain` counts must be 0. `schemaHistory` is returned separately because a
 * freshly-migrated DO may legitimately carry a schema-version row.
 */
export function countStoreRows(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): StoreCountsResult {
  return {
    domain: {
      entities: countTable(db, "entities"),
      entity_relationships: countTable(db, "entity_relationships"),
      artifact_pointers: countTable(db, "artifact_pointers"),
      entity_artifact_references: countTable(db, "entity_artifact_references"),
      artifact_relationships: countTable(db, "artifact_relationships"),
      journal: countTable(db, "journal"),
      _journal_archive_watermark: countTable(db, "_journal_archive_watermark"),
      claims: countTable(db, "claims"),
      fences: countTable(db, "fences"),
      presence: countTable(db, "presence"),
      gates: countTable(db, "gates"),
      signals: countTable(db, "signals"),
      records: countTable(db, "records"),
      record_tags: countTable(db, "record_tags"),
      record_revisions: countTable(db, "record_revisions"),
      artifact_search_docs: countTable(db, "artifact_search_docs"),
      entity_search_docs: countTable(db, "entity_search_docs"),
      record_search_docs: countTable(db, "record_search_docs"),
    },
    schemaHistory: countTable(db, "_schema_history"),
  };
}
