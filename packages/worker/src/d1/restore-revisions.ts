import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  projectRepos,
  projects,
  projectSettingsRevisionWatermarks as watermarks,
} from "./schema";

/**
 * Enclose the row replacement in the same D1 batch as these statements:
 * advance, delete/import rows, assign. No revision is read into application
 * memory, so intervening policy writes cannot make the restore reuse it.
 * All restored settings may share a revision; each is checked independently.
 */
export function createRestoreRevisionStatements(
  db: D1Database,
  projectId: string,
  restoreProjectSettings: boolean,
): { advance: D1PreparedStatement; assign: D1PreparedStatement[] } {
  const orm = drizzle(db);
  const prepare = (query: { toSQL(): { sql: string; params: unknown[] } }) => {
    const compiled = query.toSQL();
    return db.prepare(compiled.sql).bind(...compiled.params);
  };
  const advance = prepare(
    orm
      .insert(watermarks)
      .values({ project_id: projectId, revision: 2 })
      .onConflictDoUpdate({
        target: watermarks.project_id,
        set: { revision: sql`${watermarks.revision} + 1` },
      }),
  );
  const currentRevision = orm
    .select({ revision: watermarks.revision })
    .from(watermarks)
    .where(eq(watermarks.project_id, projectId));
  const assign = [
    prepare(
      orm
        .update(projectRepos)
        .set({
          access_policy_revision: sql`(${currentRevision})`,
          oidc_policy_revision: sql`(${currentRevision})`,
        })
        .where(eq(projectRepos.project_id, projectId)),
    ),
  ];
  if (restoreProjectSettings) {
    assign.push(
      prepare(
        orm
          .update(projects)
          .set({ settings_revision: sql`(${currentRevision})` })
          .where(eq(projects.project_id, projectId)),
      ),
    );
  }
  return { advance, assign };
}
