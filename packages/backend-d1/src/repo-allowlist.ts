import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { projectRepos } from "./schema";

export interface RepoAllowlistRow {
  project_id: string;
  github_host: string;
  github_owner: string;
  github_repo: string;
  github_repo_id: number;
  min_read_permission: string;
  min_write_permission: string;
  oidc_permission: string;
  enabled: number;
  created_at: number;
  created_by: string;
}

export interface RegisterParams {
  projectId: string;
  githubHost: string;
  githubOwner: string;
  githubRepo: string;
  githubRepoId: number;
  minReadPermission?: string;
  minWritePermission?: string;
  createdBy: string;
}

export class RepoAllowlistStore {
  private drizzle;

  constructor(private db: D1Database) {
    this.drizzle = drizzle(this.db);
  }

  /**
   * Check if a repo is registered and enabled for a project.
   * Returns the row or null if absent/disabled.
   */
  async isRegistered(
    projectId: string,
    githubHost: string,
    githubRepoId: number,
  ): Promise<RepoAllowlistRow | null> {
    const rows = await this.drizzle
      .select()
      .from(projectRepos)
      .where(
        and(
          eq(projectRepos.project_id, projectId),
          eq(projectRepos.github_host, githubHost),
          eq(projectRepos.github_repo_id, githubRepoId),
          eq(projectRepos.enabled, 1),
        ),
      )
      .limit(1);

    return (rows[0] as RepoAllowlistRow) ?? null;
  }

  /**
   * List all enabled repos for a project.
   * Used by the exchange endpoint to iterate and check GitHub permissions.
   */
  async listForProject(projectId: string): Promise<RepoAllowlistRow[]> {
    const rows = await this.drizzle
      .select()
      .from(projectRepos)
      .where(
        and(
          eq(projectRepos.project_id, projectId),
          eq(projectRepos.enabled, 1),
        ),
      );

    return rows as RepoAllowlistRow[];
  }

  /**
   * Register a repo in the allowlist (admin path).
   */
  async register(params: RegisterParams): Promise<void> {
    await this.drizzle
      .insert(projectRepos)
      .values({
        project_id: params.projectId,
        github_host: params.githubHost,
        github_owner: params.githubOwner,
        github_repo: params.githubRepo,
        github_repo_id: params.githubRepoId,
        min_read_permission: params.minReadPermission ?? "write",
        min_write_permission: params.minWritePermission ?? "write",
        enabled: 1,
        created_at: Math.floor(Date.now() / 1000),
        created_by: params.createdBy,
      })
      .onConflictDoNothing();
  }

  /**
   * Remove a repo from the allowlist (hard delete).
   * No-op if the repo is not registered.
   */
  async remove(
    projectId: string,
    githubHost: string,
    githubRepoId: number,
  ): Promise<void> {
    await this.drizzle
      .delete(projectRepos)
      .where(
        and(
          eq(projectRepos.project_id, projectId),
          eq(projectRepos.github_host, githubHost),
          eq(projectRepos.github_repo_id, githubRepoId),
        ),
      );
  }
}
