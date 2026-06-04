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
}
