import type { Entity } from "@tila/schemas";
import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

export function computeReadyEntities(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  opts?: {
    type?: string;
    parent?: string; // matches json_extract(data, '$.parent_id')
    limit?: number;
    includeSoftBlocked?: boolean; // default false
  },
  now: number = Date.now(),
): Entity[] {
  const includeSoftBlocked = opts?.includeSoftBlocked ?? false;

  // Guard against invalid limit values (NaN from Number("abc"))
  if (opts?.limit !== undefined && !Number.isFinite(opts.limit)) {
    throw new Error("Invalid limit parameter: must be a finite number");
  }

  // Build the blocking type set:
  // - includeSoftBlocked=false (default) means soft-blocked entities are EXCLUDED
  //   from the ready set, so 'soft-blocks' IS included in the blocking type filter
  // - includeSoftBlocked=true means soft-blocked entities ARE included in the
  //   ready set, so 'soft-blocks' is NOT in the blocking type filter
  const blockingTypes = includeSoftBlocked
    ? sql.raw(`('blocks')`)
    : sql.raw(`('blocks', 'soft-blocks')`);

  // Optional WHERE fragments -- each produces either a sql fragment or empty
  const typeFilter =
    opts?.type !== undefined ? sql` AND e.type = ${opts.type}` : sql.raw("");
  const parentFilter =
    opts?.parent !== undefined
      ? sql` AND json_extract(e.data, '$.parent_id') = ${opts.parent}`
      : sql.raw("");
  const limitClause =
    opts?.limit !== undefined
      ? sql.raw(` LIMIT ${Math.floor(opts.limit)}`)
      : sql.raw("");

  const rows = db.all<{
    id: string;
    type: string;
    schema_version: number;
    data: string;
    archived: number;
    created_at: number;
    updated_at: number;
    created_by: string;
  }>(sql`
    WITH RECURSIVE blockers(id) AS (
      -- Seed: entities that have at least one open blocking predecessor
      SELECT DISTINCT er.to_id
      FROM entity_relationships er
      JOIN entities blocker ON blocker.id = er.from_id
      WHERE er.type IN ${blockingTypes}
        AND json_extract(blocker.data, '$.status') != 'closed'
        AND blocker.archived = 0
      UNION
      -- Expand: anything blocked by a known blocker is also blocked
      SELECT er2.to_id
      FROM entity_relationships er2
      JOIN blockers b ON b.id = er2.from_id
      WHERE er2.type IN ${blockingTypes}
    )
    SELECT e.id, e.type, e.schema_version, e.data, e.archived,
           e.created_at, e.updated_at, e.created_by
    FROM entities e
    WHERE e.archived = 0
      AND json_extract(e.data, '$.status') != 'closed'
      AND NOT EXISTS (SELECT 1 FROM blockers WHERE blockers.id = e.id)
      AND NOT EXISTS (
        SELECT 1 FROM gates g
        WHERE g.resource = e.id
          AND g.resolved_at IS NULL
          AND (g.timeout_at IS NULL OR g.timeout_at > ${now})
      )
      ${typeFilter}
      ${parentFilter}
    ${limitClause}
  `);

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    schema_version: row.schema_version,
    data: JSON.parse(row.data) as Record<string, unknown>,
    archived: row.archived,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    tags: [], // ready-ops does not enrich tags; callers use entity-ops.get/list for that
  }));
}
