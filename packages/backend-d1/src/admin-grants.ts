export interface AdminGrantRow {
  project_id: string;
  github_host: string;
  github_user_id: number;
  github_login_snapshot: string | null;
  granted_by_user_id: number | null;
  granted_at: number;
  revoked_at: number | null;
  revoked_by_user_id: number | null;
}

export interface GrantParams {
  projectId: string;
  githubHost?: string;
  githubUserId: number;
  githubLoginSnapshot?: string;
  grantedByUserId?: number;
}

export class AdminGrantsStore {
  constructor(private db: D1Database) {}

  /**
   * Idempotent grant. Uses a raw parameterized SQL string with the partial
   * conflict-target predicate in the correct position (before DO NOTHING).
   *
   * IMPORTANT: Do NOT switch to Drizzle's onConflictDoNothing() — in
   * drizzle-orm 0.45.2 it emits the predicate AFTER DO NOTHING, which is a
   * SQLite syntax error and does not bind the partial index.
   */
  async grant(params: GrantParams): Promise<void> {
    const host = params.githubHost ?? "github.com";
    const grantedAt = Math.floor(Date.now() / 1000);

    await this.db
      .prepare(
        "INSERT INTO _admin_grants (project_id, github_host, github_user_id, github_login_snapshot, granted_by_user_id, granted_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, github_host, github_user_id) WHERE revoked_at IS NULL DO NOTHING",
      )
      .bind(
        params.projectId,
        host,
        params.githubUserId,
        params.githubLoginSnapshot ?? null,
        params.grantedByUserId ?? null,
        grantedAt,
      )
      .run();
  }

  /**
   * Soft-delete revoke. The `revoked_at IS NULL` guard in the WHERE clause
   * makes double-revoke a no-op. Revoked rows persist for the audit trail.
   */
  async revoke(
    projectId: string,
    githubHost: string,
    githubUserId: number,
    revokedByUserId?: number,
  ): Promise<void> {
    const revokedAt = Math.floor(Date.now() / 1000);

    await this.db
      .prepare(
        "UPDATE _admin_grants SET revoked_at = ?, revoked_by_user_id = ? WHERE project_id = ? AND github_host = ? AND github_user_id = ? AND revoked_at IS NULL",
      )
      .bind(
        revokedAt,
        revokedByUserId ?? null,
        projectId,
        githubHost,
        githubUserId,
      )
      .run();
  }

  /**
   * List all active (non-revoked) grants for a project.
   */
  async list(projectId: string): Promise<AdminGrantRow[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM _admin_grants WHERE project_id = ? AND revoked_at IS NULL",
      )
      .bind(projectId)
      .all<AdminGrantRow>();

    return result.results;
  }

  /**
   * Check if a GitHub user has an active admin grant for a project.
   */
  async isActiveAdmin(
    projectId: string,
    githubHost: string,
    githubUserId: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "SELECT 1 FROM _admin_grants WHERE project_id = ? AND github_host = ? AND github_user_id = ? AND revoked_at IS NULL LIMIT 1",
      )
      .bind(projectId, githubHost, githubUserId)
      .all();

    return result.results.length > 0;
  }
}
