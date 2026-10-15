import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

/**
 * Canonical list of domain tables that must be zero after a project destroy + reconstruction.
 * Raw `*_fts` virtual tables are NOT included — they have no Drizzle model.
 * `_schema_history` is excluded from the domain set and returned separately as a diagnostic.
 */
export const DOMAIN_TABLE_NAMES = [
  "attempt_corrections",
  "question_receipts",
  "work_questions",
  "queue_operation_receipts",
  "execution_reservations",
  "work_attempts",
  "queue_entries",
  "queue_policy",
  "_conversation_state",
  "conversation_context",
  "dispatch_attempts",
  "dispatch_outbox",
  "message_recipients",
  "messages",
  "threads",
  "room_members",
  "rooms",

  "agent_bindings",
  "agents",
  "artifact_pointers",
  "entities",
  "entity_relationships",
  "artifact_lineages",
  "artifact_revision_operations",
  "artifact_revisions",
  "artifact_lifecycle_operations",
  "artifact_retention_state",
  "artifact_reviews",
  "entity_artifact_references",
  "artifact_relationships",
  "journal",
  "journal_cursors",
  "journal_report_receipts",
  "journal_report_rates",
  "handoffs",
  "handoff_references",
  "_journal_archive_watermark",
  "claims",
  "fences",
  "presence",
  "gates",
  "signal_groups",
  "signal_group_members",
  "signals",
  "signal_deliveries",
  "records",
  "record_tags",
  "record_revisions",
  "artifact_search_docs",
  "entity_search_docs",
  "record_search_docs",
  "report_search_docs",
  "report_search_state",
  "entity_tags",
  "artifact_tags",
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
      report_search_docs: countTable(db, "report_search_docs"),
      report_search_state: countTable(db, "report_search_state"),
      queue_policy: countTable(db, "queue_policy"),
      queue_entries: countTable(db, "queue_entries"),
      work_attempts: countTable(db, "work_attempts"),
      attempt_corrections: countTable(db, "attempt_corrections"),
      execution_reservations: countTable(db, "execution_reservations"),
      queue_operation_receipts: countTable(db, "queue_operation_receipts"),
      work_questions: countTable(db, "work_questions"),
      question_receipts: countTable(db, "question_receipts"),
      rooms: countTable(db, "rooms"),
      room_members: countTable(db, "room_members"),
      threads: countTable(db, "threads"),
      messages: countTable(db, "messages"),
      message_recipients: countTable(db, "message_recipients"),
      dispatch_outbox: countTable(db, "dispatch_outbox"),
      dispatch_attempts: countTable(db, "dispatch_attempts"),
      conversation_context: countTable(db, "conversation_context"),
      _conversation_state: countTable(db, "_conversation_state"),

      agents: countTable(db, "agents"),
      agent_bindings: countTable(db, "agent_bindings"),
      entities: countTable(db, "entities"),
      entity_relationships: countTable(db, "entity_relationships"),
      artifact_pointers: countTable(db, "artifact_pointers"),
      artifact_reviews: countTable(db, "artifact_reviews"),
      artifact_lineages: countTable(db, "artifact_lineages"),
      artifact_revisions: countTable(db, "artifact_revisions"),
      artifact_lifecycle_operations: countTable(
        db,
        "artifact_lifecycle_operations",
      ),
      artifact_retention_state: countTable(db, "artifact_retention_state"),
      artifact_revision_operations: countTable(
        db,
        "artifact_revision_operations",
      ),
      entity_artifact_references: countTable(db, "entity_artifact_references"),
      artifact_relationships: countTable(db, "artifact_relationships"),
      journal: countTable(db, "journal"),
      journal_cursors: countTable(db, "journal_cursors"),
      journal_report_receipts: countTable(db, "journal_report_receipts"),
      journal_report_rates: countTable(db, "journal_report_rates"),
      handoffs: countTable(db, "handoffs"),
      handoff_references: countTable(db, "handoff_references"),
      _journal_archive_watermark: countTable(db, "_journal_archive_watermark"),
      claims: countTable(db, "claims"),
      fences: countTable(db, "fences"),
      presence: countTable(db, "presence"),
      gates: countTable(db, "gates"),
      signal_groups: countTable(db, "signal_groups"),
      signal_group_members: countTable(db, "signal_group_members"),
      signals: countTable(db, "signals"),
      signal_deliveries: countTable(db, "signal_deliveries"),
      records: countTable(db, "records"),
      record_tags: countTable(db, "record_tags"),
      record_revisions: countTable(db, "record_revisions"),
      artifact_search_docs: countTable(db, "artifact_search_docs"),
      entity_search_docs: countTable(db, "entity_search_docs"),
      record_search_docs: countTable(db, "record_search_docs"),
      entity_tags: countTable(db, "entity_tags"),
      artifact_tags: countTable(db, "artifact_tags"),
    },
    schemaHistory: countTable(db, "_schema_history"),
  };
}
