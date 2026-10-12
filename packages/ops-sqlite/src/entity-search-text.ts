import {
  type TilaSchemaToml,
  type WorkPresentation,
  presentedTitle,
} from "@tila/schemas";
import { and, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

/**
 * Extract the full-text-searchable title for an entity from its open-schema
 * `data` blob. When the type declares `presentation.title`, that field is the
 * title; otherwise `data.title`, then `data.name` (backward-compatible
 * fallback). Returns null when there is no non-empty string title (FTS `name`
 * column is nullable).
 *
 * This is the single source of truth for entity title extraction -- used by
 * all three FTS writer sites (entity create, update, and reindex batch).
 * Never inline the precedence logic at a call site (issue #412).
 */
export function entitySearchText(
  data: Record<string, unknown>,
  presentation?: WorkPresentation,
): string | null {
  return presentedTitle(data, presentation);
}

/**
 * Re-derive indexed titles for every task type whose `presentation.title`
 * differs between two schema definitions. Runs inside the schema-apply
 * transaction so search titles never lag a presentation change (#300). The
 * FTS triggers keep `entity_search_docs_fts` in step with the updates.
 */
export function refreshPresentedSearchTitles(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  previous: TilaSchemaToml | null,
  next: TilaSchemaToml,
): void {
  const types = new Set([
    ...Object.keys(previous?.work_units ?? {}),
    ...Object.keys(next.work_units),
  ]);
  for (const type of types) {
    const before = previous?.work_units[type]?.presentation?.title;
    const after = next.work_units[type]?.presentation?.title;
    if (before === after) continue;
    const presentation = next.work_units[type]?.presentation;
    const rows = db
      .select({ id: schema.entities.id, data: schema.entities.data })
      .from(schema.entities)
      .innerJoin(
        schema.entitySearchDocs,
        eq(schema.entitySearchDocs.entity_id, schema.entities.id),
      )
      .where(eq(schema.entities.type, type))
      .all();
    for (const row of rows) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      db.update(schema.entitySearchDocs)
        .set({ name: entitySearchText(data, presentation) })
        .where(
          and(
            eq(schema.entitySearchDocs.entity_id, row.id),
            eq(schema.entitySearchDocs.entity_type, type),
          ),
        )
        .run();
    }
  }
}
