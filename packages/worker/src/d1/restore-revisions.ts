import { ServiceAccountSchema } from "@tila/schemas";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  projectRepos,
  projects,
  serviceAccounts,
  projectSettingsRevisionWatermarks as watermarks,
  workloadBindings,
} from "./schema";

const SnapshotRevisionSchema = ServiceAccountSchema.shape.revision.max(
  Number.MAX_SAFE_INTEGER - 1,
);

/** Older metadata archives omit revisions; invalid maxima cannot be restored. */
export function serviceIdentitySnapshotRevision(
  sections: Record<string, Record<string, unknown>[]>,
): number | null {
  let revision = 1;
  for (const table of ["_service_accounts", "_workload_bindings"]) {
    for (const row of sections[table] ?? []) {
      if (row.revision === undefined) continue;
      const parsed = SnapshotRevisionSchema.safeParse(row.revision);
      if (!parsed.success) return null;
      revision = Math.max(revision, parsed.data);
    }
  }
  return revision;
}

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
  snapshotRevision = 1,
): { advance: D1PreparedStatement; assign: D1PreparedStatement[] } {
  const orm = drizzle(db);
  const prepare = (query: { toSQL(): { sql: string; params: unknown[] } }) => {
    const compiled = query.toSQL();
    return db.prepare(compiled.sql).bind(...compiled.params);
  };
  const advance = prepare(
    orm
      .insert(watermarks)
      .values({
        project_id: projectId,
        revision: Math.max(1, snapshotRevision) + 1,
      })
      .onConflictDoUpdate({
        target: watermarks.project_id,
        set: {
          revision: sql`max(${watermarks.revision}, ${snapshotRevision}) + 1`,
        },
      }),
  );
  const currentRevision = orm
    .select({ revision: watermarks.revision })
    .from(watermarks)
    .where(eq(watermarks.project_id, projectId));
  const assign = [
    prepare(
      orm
        .update(serviceAccounts)
        .set({ revision: sql`(${currentRevision})` })
        .where(eq(serviceAccounts.project_id, projectId)),
    ),
    prepare(
      orm
        .update(workloadBindings)
        .set({ revision: sql`(${currentRevision})` })
        .where(eq(workloadBindings.project_id, projectId)),
    ),
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
