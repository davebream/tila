import type { ProjectSummary } from "@tila/core";
import { count, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as coordinationOps from "./coordination-ops";
import { listJournal } from "./journal-ops";
import { computeReadyEntities } from "./ready-ops";
import * as schema from "./schema";

export function getSummary(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  now = Date.now(),
): ProjectSummary {
  const typeCounts = db
    .select({ type: schema.entities.type, count: count() })
    .from(schema.entities)
    .where(eq(schema.entities.archived, 0))
    .groupBy(schema.entities.type)
    .all();
  const status = sql<
    string | null
  >`json_extract(${schema.entities.data}, '$.status')`;
  const statusCounts = db
    .select({ status, count: count() })
    .from(schema.entities)
    .where(eq(schema.entities.archived, 0))
    .groupBy(status)
    .all();
  const result: ProjectSummary = {
    entity_count: typeCounts.reduce((sum, row) => sum + row.count, 0),
    entity_counts: Object.fromEntries(
      typeCounts.map((row) => [row.type, row.count]),
    ),
    status_counts: Object.fromEntries(
      statusCounts.map((row) => [row.status ?? "null", row.count]),
    ),
    active_claims: coordinationOps.listClaims(db, now).length,
    ready_count: computeReadyEntities(db).length,
    online_participants: coordinationOps
      .listPresence(db)
      .map((row) => row.participant_id),
    token_estimate: 0,
    recent_events: listJournal(db, { limit: 10 }).map(
      ({
        seq,
        t,
        kind,
        resource,
        principal_id,
        participant_id,
        environment,
      }) => ({
        seq,
        t,
        kind,
        resource,
        principal_id,
        participant_id,
        environment,
      }),
    ),
  };
  result.token_estimate = Math.ceil(JSON.stringify(result).length / 4);
  return result;
}
