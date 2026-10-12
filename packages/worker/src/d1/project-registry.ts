import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { projects } from "./schema";

export class D1ProjectRegistry {
  private drizzle;

  constructor(private db: D1Database) {
    this.drizzle = drizzle(this.db);
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
