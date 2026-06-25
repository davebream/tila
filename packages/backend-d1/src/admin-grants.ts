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

import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { canonicalizePrincipal } from "./principal";
import { adminGrants } from "./schema";

export class AdminGrantsStore {
  private drizzle;

  constructor(private db: D1Database) {
    this.drizzle = drizzle(this.db);
  }

  /**
   * Idempotent grant. Uses a raw parameterized SQL string with the partial
   * conflict-target predicate in the correct position (before DO NOTHING).
   *
   * IMPORTANT: Do NOT switch to Drizzle's onConflictDoNothing() — in
   * drizzle-orm 0.45.2 it emits the predicate AFTER DO NOTHING, which is a
   * SQLite syntax error and does not bind the partial index.
   *
   * Conflict target uses canonical (identity_host, subject_id) columns per
   * migration 0013 (WI-C). Legacy github_host / github_user_id are still
   * populated because they remain NOT NULL.
   */
  async grant(params: GrantParams): Promise<void> {
    const host = params.githubHost ?? "github.com";
    const grantedAt = Math.floor(Date.now() / 1000); // seconds (flag-only; never numerically compared)
    const { identityHost, subjectId } = canonicalizePrincipal(
      host,
      params.githubUserId,
    );

    await this.db
      .prepare(
        "INSERT INTO _admin_grants (project_id, github_host, github_user_id, github_login_snapshot, granted_by_user_id, granted_at, identity_host, subject_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, identity_host, subject_id) WHERE revoked_at IS NULL DO NOTHING",
      )
      .bind(
        params.projectId,
        host,
        params.githubUserId,
        params.githubLoginSnapshot ?? null,
        params.grantedByUserId ?? null,
        grantedAt,
        identityHost,
        subjectId,
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
    const revokedAt = Math.floor(Date.now() / 1000); // seconds (flag-only; never numerically compared)

    await this.drizzle
      .update(adminGrants)
      .set({
        revoked_at: revokedAt,
        revoked_by_user_id: revokedByUserId ?? null,
      })
      .where(
        and(
          eq(adminGrants.project_id, projectId),
          eq(adminGrants.github_host, githubHost),
          eq(adminGrants.github_user_id, githubUserId),
          isNull(adminGrants.revoked_at),
        ),
      );
  }

  /**
   * List all active (non-revoked) grants for a project.
   */
  async list(projectId: string): Promise<AdminGrantRow[]> {
    const rows = await this.drizzle
      .select()
      .from(adminGrants)
      .where(
        and(
          eq(adminGrants.project_id, projectId),
          isNull(adminGrants.revoked_at),
        ),
      );

    return rows as AdminGrantRow[];
  }

  /**
   * Check if a GitHub user has an active admin grant for a project.
   */
  async isActiveAdmin(
    projectId: string,
    githubHost: string,
    githubUserId: number,
  ): Promise<boolean> {
    const rows = await this.drizzle
      .select()
      .from(adminGrants)
      .where(
        and(
          eq(adminGrants.project_id, projectId),
          eq(adminGrants.github_host, githubHost),
          eq(adminGrants.github_user_id, githubUserId),
          isNull(adminGrants.revoked_at),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }
}
