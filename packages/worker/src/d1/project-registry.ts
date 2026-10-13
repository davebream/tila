import type { ProjectSettings } from "@tila/schemas";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { projects } from "./schema";

export type ProjectRenameResult =
  | { status: "ok"; settings: ProjectSettings }
  | { status: "conflict"; revision: number }
  | { status: "not-found" };

export class D1ProjectRegistry {
  private drizzle;

  constructor(private db: D1Database) {
    this.drizzle = drizzle(this.db);
  }

  /** Browser-editable metadata with its revision; IDs and provenance are read-only. */
  async settings(projectId: string): Promise<ProjectSettings | null> {
    const row = await this.drizzle
      .select({
        project_id: projects.project_id,
        display_name: projects.display_name,
        created_at: projects.created_at,
        created_by: projects.created_by,
        revision: projects.settings_revision,
      })
      .from(projects)
      .where(and(eq(projects.project_id, projectId), eq(projects.archived, 0)))
      .get();
    return row ?? null;
  }

  /**
   * Rename against the reviewed revision in one batch: the audit event is
   * written only when the conditional update changed the row.
   */
  async rename(params: {
    projectId: string;
    expectedRevision: number;
    displayName: string | null;
    actorPrincipalId: string;
  }): Promise<ProjectRenameResult> {
    const previous = await this.settings(params.projectId);
    if (!previous) return { status: "not-found" };
    const [updated] = await this.db.batch([
      this.db
        .prepare(
          "UPDATE _projects SET display_name = ?, settings_revision = settings_revision + 1 WHERE project_id = ? AND archived = 0 AND settings_revision = ?",
        )
        .bind(params.displayName, params.projectId, params.expectedRevision),
      this.db
        .prepare(
          "INSERT INTO _membership_events (event_id, project_id, principal_id, actor_principal_id, action, source, role, github_repo_id, details_json, occurred_at) SELECT ?, ?, NULL, ?, 'project-rename', 'explicit', NULL, NULL, ?, ? WHERE changes() > 0",
        )
        .bind(
          crypto.randomUUID(),
          params.projectId,
          params.actorPrincipalId,
          JSON.stringify({
            previous_display_name: previous.display_name,
            display_name: params.displayName,
          }),
          Date.now(),
        ),
    ]);
    const current = await this.settings(params.projectId);
    if (!current) return { status: "not-found" };
    return (updated?.meta.changes ?? 0) > 0
      ? { status: "ok", settings: current }
      : { status: "conflict", revision: current.revision };
  }

  async get(
    projectId: string,
  ): Promise<{ displayName: string; cloudflareAccountId: string } | null> {
    const rows = await this.drizzle
      .select({
        displayName: projects.display_name,
        cloudflareAccountId: projects.cloudflare_account_id,
      })
      .from(projects)
      .where(and(eq(projects.project_id, projectId), eq(projects.archived, 0)))
      .limit(1);

    if (!rows[0]) return null;

    return {
      displayName: rows[0].displayName ?? "",
      cloudflareAccountId: rows[0].cloudflareAccountId,
    };
  }

  /**
   * Like {@link get}, but matches archived projects too. Used by cross-project
   * admin paths (e.g. destroy) that must reach archived projects, which the
   * normal {@link get} filters out. Returns the same shape as {@link get}.
   */
  async getIncludingArchived(
    projectId: string,
  ): Promise<{ displayName: string; cloudflareAccountId: string } | null> {
    const rows = await this.drizzle
      .select({
        displayName: projects.display_name,
        cloudflareAccountId: projects.cloudflare_account_id,
      })
      .from(projects)
      .where(eq(projects.project_id, projectId))
      .limit(1);

    if (!rows[0]) return null;

    return {
      displayName: rows[0].displayName ?? "",
      cloudflareAccountId: rows[0].cloudflareAccountId,
    };
  }

  async listAll(): Promise<{ projectId: string }[]> {
    const rows = await this.drizzle
      .select({ projectId: projects.project_id })
      .from(projects)
      .where(eq(projects.archived, 0));

    return rows;
  }

  /**
   * Returns ALL projects including archived ones.
   * Used by the reference-counted GC in project destroy to ensure blobs
   * referenced by archived (but not yet destroyed) projects are not deleted.
   */
  async listAllIncludingArchived(): Promise<{ projectId: string }[]> {
    const rows = await this.drizzle
      .select({ projectId: projects.project_id })
      .from(projects);

    return rows;
  }

  /** Per-project repo-admin auto-admin opt-in. Returns false for unknown or
   *  archived projects (fail-closed; archived projects never auto-admit). */
  async getRepoAdminAutoAdmin(projectId: string): Promise<boolean> {
    const rows = await this.drizzle
      .select({ flag: projects.repo_admin_auto_admin })
      .from(projects)
      .where(and(eq(projects.project_id, projectId), eq(projects.archived, 0)))
      .limit(1);
    return rows[0]?.flag === 1;
  }

  /** Operator/test setter. Targets by project_id (no archived filter, so the flag
   *  may be pre-set on a not-yet-active project); a non-matching projectId updates
   *  zero rows. Note the intentional asymmetry with getRepoAdminAutoAdmin, which
   *  filters archived=0: setting the flag on an archived project is a silent no-op
   *  at read time (archived projects do not serve), by design. */
  async setRepoAdminAutoAdmin(
    projectId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.drizzle
      .update(projects)
      .set({ repo_admin_auto_admin: enabled ? 1 : 0 })
      .where(eq(projects.project_id, projectId));
  }
}
