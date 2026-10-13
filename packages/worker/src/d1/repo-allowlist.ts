import {
  type GitHubRepositoryPermission,
  type RepoAccessPolicy,
  type RepoAccessPolicyRequest,
  RepoAccessPolicySchema,
  type RepoOidcPolicy,
  RepoOidcPolicySchema,
  type SessionPermission,
} from "@tila/schemas";
import { type SQL, and, eq, sql } from "drizzle-orm";
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
  max_permission: string;
  membership_enabled?: number;
  membership_role_cap?: string;
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
  access_policy_revision?: number;
  oidc_policy_revision?: number;
}

export interface RegisterParams {
  projectId: string;
  githubHost: string;
  githubOwner: string;
  githubRepo: string;
  githubRepoId: number;
  minReadPermission?: GitHubRepositoryPermission;
  minWritePermission?: GitHubRepositoryPermission;
  maxPermission?: SessionPermission;
  membershipEnabled?: boolean;
  membershipRoleCap?: "viewer" | "participant" | "maintainer";
  createdBy: string;
}

/** A stale `expected_revision`; `revision` is the current one. */
type Conflict = { status: "conflict"; revision: number };

export type RepoAccessPolicyResult =
  | {
      status: "ok";
      policy: RepoAccessPolicy;
      repo: RepoAllowlistRow;
      revision: number;
    }
  | { status: "not-found" }
  | { status: "invalid-policy" }
  | Conflict;

export type RepoOidcPolicyResult =
  | {
      status: "ok";
      policy: RepoOidcPolicy;
      repo: RepoAllowlistRow;
      revision: number;
    }
  | { status: "not-found" }
  | { status: "invalid-policy" }
  | Conflict;

export type RepoRemoveResult = { status: "removed" | "not-found" } | Conflict;

function decodeAccessPolicy(row: RepoAllowlistRow): RepoAccessPolicyResult {
  const parsed = RepoAccessPolicySchema.safeParse({
    min_read_permission: row.min_read_permission,
    min_write_permission: row.min_write_permission,
    max_permission: row.max_permission,
    membership_enabled: row.membership_enabled === 1,
    membership_role_cap: row.membership_role_cap ?? "participant",
  });
  return parsed.success
    ? {
        status: "ok",
        policy: parsed.data,
        repo: row,
        revision: row.access_policy_revision ?? 1,
      }
    : { status: "invalid-policy" };
}

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
      ? {
          status: "ok",
          policy: parsed.data,
          repo: row,
          revision: row.oidc_policy_revision ?? 1,
        }
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

  /**
   * Human access policy for every enabled repository of a project, for the
   * membership administration surface (#102). Rows with an invalid stored
   * policy are skipped rather than failing the whole listing.
   */
  async listAccessPolicies(
    projectId: string,
  ): Promise<Array<{ repo: RepoAllowlistRow; policy: RepoAccessPolicy }>> {
    const rows = await this.listForProject(projectId);
    const result: Array<{ repo: RepoAllowlistRow; policy: RepoAccessPolicy }> =
      [];
    for (const row of rows) {
      const decoded = decodeAccessPolicy(row);
      if (decoded.status === "ok")
        result.push({ repo: decoded.repo, policy: decoded.policy });
    }
    return result;
  }

  /** Read and validate a repository's complete human access policy. */
  async getAccessPolicy(
    projectId: string,
    githubHost: string,
    githubRepoId: number,
  ): Promise<RepoAccessPolicyResult> {
    const row = await this.isRegistered(projectId, githubHost, githubRepoId);
    return row ? decodeAccessPolicy(row) : { status: "not-found" };
  }

  private link(projectId: string, githubHost: string, githubRepoId: number) {
    return and(
      eq(projectRepos.project_id, projectId),
      eq(projectRepos.github_host, githubHost),
      eq(projectRepos.github_repo_id, githubRepoId),
      eq(projectRepos.enabled, 1),
    );
  }

  /**
   * Every enabled repository link with both policies and their revisions,
   * optionally for one host (owner settings surface, #298).
   */
  async listLinks(projectId: string, githubHost?: string) {
    const rows = (await this.listForProject(projectId)).filter(
      (row) => githubHost === undefined || row.github_host === githubHost,
    );
    return rows.map((row) => {
      const access = decodeAccessPolicy(row);
      const oidc = decodeOidcPolicy(row);
      return {
        github_host: row.github_host,
        github_owner: row.github_owner,
        github_repo: row.github_repo,
        github_repo_id: row.github_repo_id,
        created_at: row.created_at,
        created_by: row.created_by,
        access_policy: access.status === "ok" ? access.policy : null,
        access_policy_revision: row.access_policy_revision ?? 1,
        oidc_policy: oidc.status === "ok" ? oidc.policy : null,
        oidc_policy_revision: row.oidc_policy_revision ?? 1,
      };
    });
  }

  /**
   * Replace a policy in one conditional UPDATE. With `expectedRevision`, the
   * write applies only to that revision; otherwise it is unconditional
   * (legacy). Zero changed rows distinguishes a stale revision from a missing
   * link by reading the row again.
   */
  private async conditionalPolicyWrite(
    projectId: string,
    githubHost: string,
    githubRepoId: number,
    revisionColumn:
      | typeof projectRepos.access_policy_revision
      | typeof projectRepos.oidc_policy_revision,
    values: Partial<typeof projectRepos.$inferInsert>,
    expectedRevision: number | undefined,
  ): Promise<RepoAllowlistRow | Conflict | null> {
    const where: SQL[] = [
      this.link(projectId, githubHost, githubRepoId) as SQL,
    ];
    if (expectedRevision !== undefined)
      where.push(eq(revisionColumn, expectedRevision));
    const updated = await this.drizzle
      .update(projectRepos)
      .set({ ...values, [revisionColumn.name]: sql`${revisionColumn} + 1` })
      .where(and(...where))
      .returning();
    const row = updated[0] as RepoAllowlistRow | undefined;
    if (row) return row;
    const current = await this.isRegistered(
      projectId,
      githubHost,
      githubRepoId,
    );
    if (!current) return null;
    return {
      status: "conflict",
      revision:
        (revisionColumn.name === "access_policy_revision"
          ? current.access_policy_revision
          : current.oidc_policy_revision) ?? 1,
    };
  }

  /** Atomically replace a repository's complete human access policy. */
  async setAccessPolicy(
    projectId: string,
    githubHost: string,
    githubRepoId: number,
    policy: RepoAccessPolicyRequest,
    expectedRevision?: number,
  ): Promise<RepoAccessPolicyResult> {
    const current = await this.getAccessPolicy(
      projectId,
      githubHost,
      githubRepoId,
    );
    if (current.status !== "ok") return current;
    if (expectedRevision !== undefined && current.revision !== expectedRevision)
      return { status: "conflict", revision: current.revision };
    const validated = RepoAccessPolicySchema.parse({
      ...current.policy,
      ...policy,
    });
    const result = await this.conditionalPolicyWrite(
      projectId,
      githubHost,
      githubRepoId,
      projectRepos.access_policy_revision,
      {
        min_read_permission: validated.min_read_permission,
        min_write_permission: validated.min_write_permission,
        max_permission: validated.max_permission,
        membership_enabled: validated.membership_enabled ? 1 : 0,
        membership_role_cap: validated.membership_role_cap,
      },
      // The merge above read `current`; never apply it over a newer revision.
      current.revision,
    );
    if (!result) return { status: "not-found" };
    return "status" in result ? result : decodeAccessPolicy(result);
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
    expectedRevision?: number,
  ): Promise<RepoOidcPolicyResult> {
    const validated = RepoOidcPolicySchema.parse(policy);
    const result = await this.conditionalPolicyWrite(
      projectId,
      githubHost,
      githubRepoId,
      projectRepos.oidc_policy_revision,
      {
        oidc_enabled: validated.enabled ? 1 : 0,
        oidc_max_permission: validated.max_permission,
        oidc_subject_pattern: validated.subject_pattern,
        oidc_allowed_events: JSON.stringify(validated.allowed_events),
        oidc_allowed_refs: JSON.stringify(validated.allowed_refs),
        oidc_allowed_environments: JSON.stringify(
          validated.allowed_environments,
        ),
        oidc_allowed_workflows: JSON.stringify(validated.allowed_workflows),
      },
      expectedRevision,
    );
    if (!result) return { status: "not-found" };
    return "status" in result ? result : decodeOidcPolicy(result);
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
        max_permission: params.maxPermission ?? "write",
        membership_enabled: params.membershipEnabled ? 1 : 0,
        membership_role_cap: params.membershipRoleCap ?? "participant",
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
    expectedAccessRevision?: number,
  ): Promise<RepoRemoveResult> {
    const where = [
      eq(projectRepos.project_id, projectId),
      eq(projectRepos.github_host, githubHost),
      eq(projectRepos.github_repo_id, githubRepoId),
    ];
    if (expectedAccessRevision !== undefined)
      where.push(
        eq(projectRepos.access_policy_revision, expectedAccessRevision),
      );
    const removed = await this.drizzle
      .delete(projectRepos)
      .where(and(...where))
      .returning({ id: projectRepos.github_repo_id });
    if (removed.length) return { status: "removed" };
    if (expectedAccessRevision === undefined) return { status: "not-found" };
    const current = await this.isRegistered(
      projectId,
      githubHost,
      githubRepoId,
    );
    return current
      ? { status: "conflict", revision: current.access_policy_revision ?? 1 }
      : { status: "not-found" };
  }
}
