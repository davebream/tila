import { type RepoOidcPolicy, RepoOidcPolicySchema } from "@tila/schemas";
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
  oidc_enabled: number;
  oidc_max_permission: string;
  oidc_subject_pattern: string | null;
  oidc_allowed_events: string;
  oidc_allowed_refs: string;
  oidc_allowed_environments: string;
  oidc_allowed_workflows: string;
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

export type RepoOidcPolicyResult =
  | { status: "ok"; policy: RepoOidcPolicy; repo: RepoAllowlistRow }
  | { status: "not-found" }
  | { status: "invalid-policy" };

function decodeOidcPolicy(row: RepoAllowlistRow): RepoOidcPolicyResult {
  try {
    const parsed = RepoOidcPolicySchema.safeParse({
      enabled: row.oidc_enabled === 1,
      max_permission: row.oidc_max_permission,
      subject_pattern: row.oidc_subject_pattern,
      allowed_events: JSON.parse(row.oidc_allowed_events),
      allowed_refs: JSON.parse(row.oidc_allowed_refs),
      allowed_environments: JSON.parse(row.oidc_allowed_environments),
      allowed_workflows: JSON.parse(row.oidc_allowed_workflows),
    });
    return parsed.success
      ? { status: "ok", policy: parsed.data, repo: row }
      : { status: "invalid-policy" };
  } catch {
    return { status: "invalid-policy" };
  }
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

  /** Read and validate a repository's complete GitHub Actions OIDC policy. */
  async getOidcPolicy(
    projectId: string,
    githubHost: string,
    githubRepoId: number,
  ): Promise<RepoOidcPolicyResult> {
    const row = await this.isRegistered(projectId, githubHost, githubRepoId);
    return row ? decodeOidcPolicy(row) : { status: "not-found" };
  }

  /** Atomically replace a repository's complete GitHub Actions OIDC policy. */
  async setOidcPolicy(
    projectId: string,
    githubHost: string,
    githubRepoId: number,
    policy: RepoOidcPolicy,
  ): Promise<RepoOidcPolicyResult> {
    const validated = RepoOidcPolicySchema.parse(policy);
    const updated = await this.drizzle
      .update(projectRepos)
      .set({
        oidc_enabled: validated.enabled ? 1 : 0,
        oidc_max_permission: validated.max_permission,
        oidc_subject_pattern: validated.subject_pattern,
        oidc_allowed_events: JSON.stringify(validated.allowed_events),
        oidc_allowed_refs: JSON.stringify(validated.allowed_refs),
        oidc_allowed_environments: JSON.stringify(
          validated.allowed_environments,
        ),
        oidc_allowed_workflows: JSON.stringify(validated.allowed_workflows),
      })
      .where(
        and(
          eq(projectRepos.project_id, projectId),
          eq(projectRepos.github_host, githubHost),
          eq(projectRepos.github_repo_id, githubRepoId),
          eq(projectRepos.enabled, 1),
        ),
      )
      .returning();

    const row = updated[0] as RepoAllowlistRow | undefined;
    return row ? decodeOidcPolicy(row) : { status: "not-found" };
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
        oidc_enabled: 0,
        oidc_max_permission: "read",
        oidc_subject_pattern: null,
        oidc_allowed_events: "[]",
        oidc_allowed_refs: "[]",
        oidc_allowed_environments: "[]",
        oidc_allowed_workflows: "[]",
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
