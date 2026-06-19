import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { entitySearchText } from "./entity-search-text";
import type * as schema from "./schema";

export type ReindexBatchResult = {
  done: boolean;
  processed: number;
};

/**
 * Clear all entity search docs so a subsequent reindex re-populates (and thus
 * repairs) every entity. The esd_ad AFTER DELETE trigger keeps the FTS table in
 * sync. Used by the reindex job to perform a full entity rebuild (issue #412).
 */
export function resetEntitySearchDocs(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): void {
  db.run(sql`DELETE FROM entity_search_docs`);
}

/**
 * Reindex a batch of un-indexed artifacts or entities into their FTS search doc tables.
 *
 * Finds rows in the source table (artifact_pointers or entities) that do NOT yet have
 * a corresponding search doc row, ordered deterministically, up to batchSize.
 *
 * For artifacts: inserts a minimal search doc row so the artifact is discoverable via FTS.
 *   Uses INSERT OR REPLACE for idempotency. body_text defaults to empty string.
 *
 * For entities: inserts a search doc row with the entity_id, entity_type, and name
 *   (extracted from the data JSON column), indexed_at timestamp.
 *
 * Returns { done, processed } where done=true means no more unindexed rows remain.
 */
export function reindexBatch(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  opts: {
    kind: "artifact" | "entity";
    batchSize: number;
  },
): ReindexBatchResult {
  if (opts.kind === "artifact") {
    return reindexArtifactBatch(db, opts.batchSize);
  }
  return reindexEntityBatch(db, opts.batchSize);
}

function reindexArtifactBatch(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  batchSize: number,
): ReindexBatchResult {
  // Find artifact_pointers rows without a search doc, not tombstoned, ordered by r2_key
  const rows = db.all<{
    r2_key: string;
    kind: string;
    mime_type: string;
    resource: string | null;
    sha256: string;
  }>(sql`
    SELECT ap.r2_key, ap.kind, ap.mime_type, ap.resource, ap.sha256
    FROM artifact_pointers ap
    WHERE ap.tombstoned = 0
      AND NOT EXISTS (
        SELECT 1 FROM artifact_search_docs asd WHERE asd.artifact_key = ap.r2_key
      )
    ORDER BY ap.r2_key
    LIMIT ${batchSize}
  `);

  if (rows.length === 0) {
    return { done: true, processed: 0 };
  }

  const indexedAt = Date.now();
  db.transaction((tx) => {
    for (const row of rows) {
      tx.run(sql`
        INSERT OR REPLACE INTO artifact_search_docs(
          artifact_key, kind, mime_type, resource, title, body_text,
          indexed_at, source_sha256, tombstoned
        ) VALUES(
          ${row.r2_key}, ${row.kind}, ${row.mime_type}, ${row.resource},
          NULL, '', ${indexedAt}, ${row.sha256}, 0
        )
      `);
    }
  });

  // Determine completion via batch size: if we got fewer rows than requested,
  // there are no more unindexed artifacts (no extra COUNT query needed).
  const done = rows.length < batchSize;

  return { done, processed: rows.length };
}

function reindexEntityBatch(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  batchSize: number,
): ReindexBatchResult {
  // Find entities without a search doc, not archived, ordered by id
  const rows = db.all<{
    id: string;
    type: string;
    data: string;
  }>(sql`
    SELECT e.id, e.type, e.data
    FROM entities e
    WHERE e.archived = 0
      AND NOT EXISTS (
        SELECT 1 FROM entity_search_docs esd WHERE esd.entity_id = e.id
      )
    ORDER BY e.id
    LIMIT ${batchSize}
  `);

  if (rows.length === 0) {
    return { done: true, processed: 0 };
  }

  const indexedAt = Date.now();
  db.transaction((tx) => {
    for (const row of rows) {
      let name: string | null = null;
      try {
        const parsed = JSON.parse(row.data) as Record<string, unknown>;
        name = entitySearchText(parsed);
      } catch {
        // malformed data -- skip name extraction
      }

      tx.run(sql`
        INSERT OR REPLACE INTO entity_search_docs(
          entity_id, entity_type, name, indexed_at
        ) VALUES(
          ${row.id}, ${row.type}, ${name}, ${indexedAt}
        )
      `);
    }
  });

  // Check if more work remains
  const remaining = db.get<{ cnt: number }>(sql`
    SELECT COUNT(*) as cnt
    FROM entities e
    WHERE e.archived = 0
      AND NOT EXISTS (
        SELECT 1 FROM entity_search_docs esd WHERE esd.entity_id = e.id
      )
  `);
  const done = (remaining?.cnt ?? 0) === 0;

  return { done, processed: rows.length };
}
