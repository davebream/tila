import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { githubAppConfig } from "./schema";

export interface GitHubAppConfigRow {
  project_id: string;
  installation_id: number;
  created_at: number;
  created_by: string;
}

export class GitHubAppConfigStore {
  private drizzle;

  constructor(private db: D1Database) {
    this.drizzle = drizzle(this.db);
  }

  /**
   * Set or update the GitHub App installation ID for a project.
   * Uses INSERT OR REPLACE pattern.
   */
  async setInstallation(
    projectId: string,
    installationId: number,
    createdBy: string,
  ): Promise<void> {
    await this.drizzle
      .insert(githubAppConfig)
      .values({
        project_id: projectId,
        installation_id: installationId,
        created_at: Math.floor(Date.now() / 1000),
        created_by: createdBy,
      })
      .onConflictDoUpdate({
        target: githubAppConfig.project_id,
        set: {
          installation_id: installationId,
          created_at: Math.floor(Date.now() / 1000),
          created_by: createdBy,
        },
      });
  }

  /**
   * Get the GitHub App installation ID for a project.
   * Returns the row or null if not configured.
   */
  async getInstallation(projectId: string): Promise<GitHubAppConfigRow | null> {
    const rows = await this.drizzle
      .select()
      .from(githubAppConfig)
      .where(eq(githubAppConfig.project_id, projectId))
      .limit(1);

    return (rows[0] as GitHubAppConfigRow) ?? null;
  }

  /**
   * Remove the GitHub App installation config for a project.
   * No-op if not configured.
   */
  async removeInstallation(projectId: string): Promise<void> {
    await this.drizzle
      .delete(githubAppConfig)
      .where(eq(githubAppConfig.project_id, projectId));
  }
}
