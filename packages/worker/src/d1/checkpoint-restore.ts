import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  projects,
  projectSettingsRevisionWatermarks as watermarks,
} from "./schema";

/** Access-bearing columns and tables deliberately never enter this update. */
export async function preserveAccessRestore(
  database: D1Database,
  projectId: string,
  snapshot: { displayName: string | null; schemaVersion: number },
): Promise<void> {
  const db = drizzle(database);
  const current = db
    .select({ value: projects.settings_revision })
    .from(projects)
    .where(eq(projects.project_id, projectId));
  await db.batch([
    db
      .insert(watermarks)
      .values({
        project_id: projectId,
        revision: sql`coalesce((${current}), 1) + 1`,
      })
      .onConflictDoUpdate({
        target: watermarks.project_id,
        set: {
          revision: sql`max(${watermarks.revision}, coalesce((${current}), 1)) + 1`,
        },
      }),
    db
      .update(projects)
      .set({
        display_name: snapshot.displayName,
        schema_version: snapshot.schemaVersion,
        settings_revision: sql`(SELECT revision FROM ${watermarks} WHERE project_id = ${projectId})`,
      })
      .where(eq(projects.project_id, projectId)),
  ]);
}
