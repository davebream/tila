import {
  type MembershipPrincipal,
  type MembershipSource,
  type MembershipSubjectKind,
  PROJECT_ROLE_RANK,
  type ProjectMembership,
  type ProjectMembershipMode,
  type ProjectRole,
} from "@tila/schemas";
import { and, count, eq, isNull, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { user as humanUsers } from "./human-schema";
import { canonicalizePrincipal } from "./principal";
import { projectMemberships } from "./schema";

export interface EffectiveMembership {
  role: ProjectRole;
  /** Authority independently granted by current Tila membership policy. */
  explicitRole?: ProjectRole;
  sources: MembershipSource[];
  explicitMembershipId?: string;
  mirroredRepoId?: number;
}

export interface MirroredMembershipCandidate {
  role: Exclude<ProjectRole, "owner">;
  githubRepoId: number;
}

export interface MembershipEventRow {
  event_id: string;
  project_id: string;
  principal_id: string | null;
  actor_principal_id: string;
  action: string;
  source: string;
  role: string | null;
  github_repo_id: number | null;
  details_json: string;
  occurred_at: number;
}

function canonicalIssuer(raw: string): string {
  const issuer = new URL(raw);
  issuer.protocol = issuer.protocol.toLowerCase();
  issuer.hostname = issuer.hostname.toLowerCase();
  issuer.search = "";
  issuer.hash = "";
  return issuer.toString().replace(/\/$/, "");
}

export function canonicalMembershipPrincipal(principal: MembershipPrincipal): {
  principalId: string;
  provider: "github" | "oidc" | "service" | "user";
  identityHost: string;
  subjectId: string;
  displayName: string | null;
} {
  if (principal.provider === "service" || principal.provider === "user")
    return {
      principalId: `${principal.provider}:${principal.id}`,
      provider: principal.provider,
      identityHost: "tila",
      subjectId: principal.id,
      displayName: null,
    };
  if (principal.provider === "github") {
    const { identityHost, subjectId } = canonicalizePrincipal(
      principal.host,
      principal.user_id,
    );
    return {
      principalId: `github:${identityHost}:${subjectId}`,
      provider: "github",
      identityHost,
      subjectId,
      displayName: principal.login ?? null,
    };
  }

  const issuer = canonicalIssuer(principal.issuer);
  const { subjectId } = canonicalizePrincipal(issuer, principal.subject);
  return {
    principalId: `oidc:${issuer}:${subjectId}`,
    provider: "oidc",
    identityHost: issuer,
    subjectId,
    displayName: subjectId,
  };
}

function strongerRole(a: ProjectRole, b: ProjectRole): ProjectRole {
  return PROJECT_ROLE_RANK[a] >= PROJECT_ROLE_RANK[b] ? a : b;
}

export class ProjectMembershipStore {
  constructor(private db: D1Database) {}

  async getMode(projectId: string): Promise<ProjectMembershipMode | null> {
    const row = await this.db
      .prepare(
        "SELECT membership_mode FROM _projects WHERE project_id = ? AND archived = 0",
      )
      .bind(projectId)
      .first<{ membership_mode: ProjectMembershipMode }>();
    return row?.membership_mode ?? null;
  }

  async setMode(
    projectId: string,
    mode: ProjectMembershipMode,
    actorPrincipalId: string,
  ): Promise<boolean> {
    const now = Date.now();
    const eventId = crypto.randomUUID();
    const results = await this.db.batch([
      this.db
        .prepare(
          "UPDATE _projects SET membership_mode = ? WHERE project_id = ? AND archived = 0",
        )
        .bind(mode, projectId),
      this.db
        .prepare(
          "INSERT INTO _membership_events (event_id, project_id, principal_id, actor_principal_id, action, source, role, details_json, occurred_at) VALUES (?, ?, NULL, ?, 'policy-change', 'explicit', NULL, ?, ?)",
        )
        .bind(
          eventId,
          projectId,
          actorPrincipalId,
          JSON.stringify({ mode }),
          now,
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) > 0;
  }

  async getActive(
    projectId: string,
    principalId: string,
  ): Promise<ProjectMembership | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM _project_memberships WHERE project_id = ? AND principal_id = ? AND revoked_at IS NULL LIMIT 1",
      )
      .bind(projectId, principalId)
      .first<ProjectMembership>();
    return row ?? null;
  }

  async resolve(
    projectId: string,
    principalId: string,
    mirrored: MirroredMembershipCandidate | null = null,
  ): Promise<EffectiveMembership | null> {
    const mode = await this.getMode(projectId);
    if (!mode) return null;
    const explicit = await this.getActive(projectId, principalId);

    const explicitAllowed =
      explicit !== null &&
      (mode === "explicit" ||
        mode === "hybrid" ||
        (mode === "github-mirrored" && explicit.role === "owner") ||
        (mode === "service-only" && explicit.subject_kind === "service"));
    const mirroredAllowed =
      mirrored !== null && (mode === "github-mirrored" || mode === "hybrid");

    if (!explicitAllowed && !mirroredAllowed) return null;
    if (explicitAllowed && mirroredAllowed) {
      return {
        role: strongerRole(explicit.role, mirrored.role),
        explicitRole: explicit.role,
        sources: ["explicit", "github-mirrored"],
        explicitMembershipId: explicit.membership_id,
        mirroredRepoId: mirrored.githubRepoId,
      };
    }
    if (explicitAllowed) {
      return {
        role: explicit.role,
        explicitRole: explicit.role,
        sources: ["explicit"],
        explicitMembershipId: explicit.membership_id,
      };
    }
    return {
      role: mirrored?.role ?? "viewer",
      sources: ["github-mirrored"],
      mirroredRepoId: mirrored?.githubRepoId,
    };
  }

  async list(
    projectId: string,
    includeRevoked = false,
  ): Promise<ProjectMembership[]> {
    const sql = includeRevoked
      ? "SELECT * FROM _project_memberships WHERE project_id = ? ORDER BY granted_at DESC, membership_id DESC"
      : "SELECT * FROM _project_memberships WHERE project_id = ? AND revoked_at IS NULL ORDER BY granted_at DESC, membership_id DESC";
    const result = await this.db
      .prepare(sql)
      .bind(projectId)
      .all<ProjectMembership>();
    return result.results;
  }

  async listProjectsForPrincipal(
    principalId: string,
  ): Promise<
    Array<{ projectId: string; displayName: string; role: ProjectRole }>
  > {
    const result = await this.db
      .prepare(
        `SELECT m.project_id, COALESCE(p.display_name, m.project_id) AS display_name, m.role
           FROM _project_memberships m
           JOIN _projects p ON p.project_id = m.project_id AND p.archived = 0
          WHERE m.principal_id = ? AND m.revoked_at IS NULL
            AND (p.membership_mode IN ('explicit', 'hybrid')
              OR (p.membership_mode = 'github-mirrored' AND m.role = 'owner')
              OR (p.membership_mode = 'service-only' AND m.subject_kind = 'service'))
          ORDER BY m.project_id`,
      )
      .bind(principalId)
      .all<{ project_id: string; display_name: string; role: ProjectRole }>();
    return result.results.map((row) => ({
      projectId: row.project_id,
      displayName: row.display_name,
      role: row.role,
    }));
  }

  async grant(params: {
    projectId: string;
    principal: MembershipPrincipal;
    subjectKind: MembershipSubjectKind;
    role: ProjectRole;
    displayName?: string;
    actorPrincipalId: string;
  }): Promise<{ membership: ProjectMembership; created: boolean }> {
    if (params.principal.provider === "user") {
      const [user] = await drizzle(this.db)
        .select({ id: humanUsers.id })
        .from(humanUsers)
        .where(
          and(
            eq(humanUsers.id, params.principal.id),
            eq(humanUsers.disabled, false),
          ),
        );
      if (!user) throw new Error("Active tila account required");
    }
    const canonical = canonicalMembershipPrincipal(params.principal);
    const existing = await this.getActive(
      params.projectId,
      canonical.principalId,
    );
    if (existing) return { membership: existing, created: false };

    const membershipId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const now = Date.now();
    const displayName = params.displayName ?? canonical.displayName;
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO _project_memberships (membership_id, project_id, principal_id, provider, identity_host, subject_id, subject_kind, role, display_name, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          membershipId,
          params.projectId,
          canonical.principalId,
          canonical.provider,
          canonical.identityHost,
          canonical.subjectId,
          params.subjectKind,
          params.role,
          displayName,
          params.actorPrincipalId,
          now,
        ),
      this.eventStatement({
        eventId,
        projectId: params.projectId,
        principalId: canonical.principalId,
        actorPrincipalId: params.actorPrincipalId,
        action: "grant",
        source: "explicit",
        role: params.role,
        occurredAt: now,
      }),
    ]);
    const membership = await this.getActive(
      params.projectId,
      canonical.principalId,
    );
    if (!membership) throw new Error("Membership grant was not persisted");
    return { membership, created: true };
  }

  /**
   * SQL condition that another active, enabled owner remains besides
   * `membership_id = ?`. Evaluated inside the same write statement, so two
   * concurrent removals of the last two owners cannot both succeed.
   */
  private static readonly OTHER_OWNER = `EXISTS (
    SELECT 1 FROM _project_memberships AS o
    LEFT JOIN _human_users AS u ON u.id = o.subject_id
    WHERE o.project_id = _project_memberships.project_id
      AND o.membership_id <> _project_memberships.membership_id
      AND o.role = 'owner' AND o.revoked_at IS NULL
      AND (o.provider <> 'user' OR u.disabled = 0)
  )`;

  /**
   * Change a role. Demoting an owner fails with `last-owner` unless another
   * active owner remains at write time (`allowLastOwner` is the full
   * bootstrap-credential escape hatch). The audit event commits only with a
   * changed row.
   */
  async updateRole(params: {
    projectId: string;
    membershipId: string;
    role: ProjectRole;
    actorPrincipalId: string;
    allowLastOwner?: boolean;
  }): Promise<ProjectMembership | { status: "last-owner" } | null> {
    const current = await this.getById(params.projectId, params.membershipId);
    if (!current || current.revoked_at !== null) return null;
    if (current.role === params.role) return current;
    const guarded =
      current.role === "owner" &&
      params.role !== "owner" &&
      !params.allowLastOwner;
    const now = Date.now();
    // Same batch, same connection: changes() reports the UPDATE above.
    const event = this.eventStatement(
      {
        eventId: crypto.randomUUID(),
        projectId: params.projectId,
        principalId: current.principal_id,
        actorPrincipalId: params.actorPrincipalId,
        action: "role-change",
        source: "explicit",
        role: params.role,
        details: { previous_role: current.role },
        occurredAt: now,
      },
      { sql: "changes() > 0", bindings: [] },
    );
    const [updated] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE _project_memberships SET role = ? WHERE project_id = ? AND membership_id = ? AND revoked_at IS NULL AND role = ?${
            guarded ? ` AND ${ProjectMembershipStore.OTHER_OWNER}` : ""
          }`,
        )
        .bind(params.role, params.projectId, params.membershipId, current.role),
      event,
    ]);
    if ((updated?.meta.changes ?? 0) === 0) {
      const latest = await this.getById(params.projectId, params.membershipId);
      if (!latest || latest.revoked_at !== null) return null;
      if (guarded && latest.role === "owner") return { status: "last-owner" };
      return latest;
    }
    return this.getById(params.projectId, params.membershipId);
  }

  /**
   * Revoke a membership. Revoking an owner fails with `last-owner` unless
   * another active owner remains at write time (`allowLastOwner` bypasses for
   * the full bootstrap credential). Subject revocation, session deletion and
   * the audit event apply only when this call revoked the row.
   */
  async revoke(params: {
    projectId: string;
    membershipId: string;
    actorPrincipalId: string;
    allowLastOwner?: boolean;
  }): Promise<
    | {
        membership: ProjectMembership;
        revokedSessions: number;
      }
    | { status: "last-owner" }
    | null
  > {
    const current = await this.getById(params.projectId, params.membershipId);
    if (!current || current.revoked_at !== null) return null;
    const guarded = current.role === "owner" && !params.allowLastOwner;
    const now = Date.now();
    // True only after this batch's UPDATE revoked the row.
    const revokedHere =
      "EXISTS (SELECT 1 FROM _project_memberships WHERE project_id = ? AND membership_id = ? AND revoked_at = ? AND revoked_by = ?)";
    const mine = [
      params.projectId,
      params.membershipId,
      now,
      params.actorPrincipalId,
    ];
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE _project_memberships SET revoked_at = ?, revoked_by = ? WHERE project_id = ? AND membership_id = ? AND revoked_at IS NULL${
            guarded ? ` AND ${ProjectMembershipStore.OTHER_OWNER}` : ""
          }`,
        )
        .bind(
          now,
          params.actorPrincipalId,
          params.projectId,
          params.membershipId,
        ),
      this.db
        .prepare(
          `INSERT INTO _revoked_subjects (project_id, identity_host, subject_id, revoked_before) SELECT ?, ?, ?, ? WHERE ${revokedHere} ON CONFLICT (project_id, identity_host, subject_id) DO UPDATE SET revoked_before = MAX(revoked_before, excluded.revoked_before)`,
        )
        .bind(
          params.projectId,
          current.identity_host,
          current.subject_id,
          now,
          ...mine,
        ),
      this.db
        .prepare(
          `DELETE FROM _sessions WHERE project_id = ? AND principal_id = ? AND ${revokedHere}`,
        )
        .bind(params.projectId, current.principal_id, ...mine),
      this.eventStatement(
        {
          eventId: crypto.randomUUID(),
          projectId: params.projectId,
          principalId: current.principal_id,
          actorPrincipalId: params.actorPrincipalId,
          action: "revoke",
          source: "explicit",
          role: current.role,
          occurredAt: now,
        },
        { sql: revokedHere, bindings: mine },
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) {
      const latest = await this.getById(params.projectId, params.membershipId);
      if (!latest || latest.revoked_at !== null) return null;
      return guarded ? { status: "last-owner" } : null;
    }
    return {
      membership: {
        ...current,
        revoked_at: now,
        revoked_by: params.actorPrincipalId,
      },
      revokedSessions: results[2]?.meta.changes ?? 0,
    };
  }

  async countActiveOwners(projectId: string): Promise<number> {
    const [row] = await drizzle(this.db)
      .select({ count: count() })
      .from(projectMemberships)
      .leftJoin(humanUsers, eq(humanUsers.id, projectMemberships.subject_id))
      .where(
        and(
          eq(projectMemberships.project_id, projectId),
          eq(projectMemberships.role, "owner"),
          isNull(projectMemberships.revoked_at),
          or(
            ne(projectMemberships.provider, "user"),
            eq(humanUsers.disabled, false),
          ),
        ),
      );
    return row?.count ?? 0;
  }

  async getById(
    projectId: string,
    membershipId: string,
  ): Promise<ProjectMembership | null> {
    return (
      (await this.db
        .prepare(
          "SELECT * FROM _project_memberships WHERE project_id = ? AND membership_id = ? LIMIT 1",
        )
        .bind(projectId, membershipId)
        .first<ProjectMembership>()) ?? null
    );
  }

  async recordMirroredAdmission(params: {
    projectId: string;
    principalId: string;
    role: ProjectRole;
    githubRepoId: number;
  }): Promise<void> {
    await this.eventStatement({
      eventId: crypto.randomUUID(),
      projectId: params.projectId,
      principalId: params.principalId,
      actorPrincipalId: params.principalId,
      action: "admit",
      source: "github-mirrored",
      role: params.role,
      githubRepoId: params.githubRepoId,
      occurredAt: Date.now(),
    }).run();
  }

  async listEvents(
    projectId: string,
    cursor: number | null,
    limit: number,
  ): Promise<MembershipEventRow[]> {
    const sql =
      cursor === null
        ? "SELECT * FROM _membership_events WHERE project_id = ? ORDER BY occurred_at DESC, rowid DESC LIMIT ?"
        : "SELECT * FROM _membership_events WHERE project_id = ? AND occurred_at < ? ORDER BY occurred_at DESC, rowid DESC LIMIT ?";
    const statement =
      cursor === null
        ? this.db.prepare(sql).bind(projectId, limit)
        : this.db.prepare(sql).bind(projectId, cursor, limit);
    return (await statement.all<MembershipEventRow>()).results;
  }

  private eventStatement(
    params: {
      eventId: string;
      projectId: string;
      principalId: string | null;
      actorPrincipalId: string;
      action: string;
      source: MembershipSource;
      role?: ProjectRole;
      githubRepoId?: number;
      details?: Record<string, unknown>;
      occurredAt: number;
    },
    when?: { sql: string; bindings: unknown[] },
  ): D1PreparedStatement {
    const columns =
      "INSERT INTO _membership_events (event_id, project_id, principal_id, actor_principal_id, action, source, role, github_repo_id, details_json, occurred_at)";
    return this.db
      .prepare(
        when
          ? `${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${when.sql}`
          : `${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.eventId,
        params.projectId,
        params.principalId,
        params.actorPrincipalId,
        params.action,
        params.source,
        params.role ?? null,
        params.githubRepoId ?? null,
        JSON.stringify(params.details ?? {}),
        params.occurredAt,
        ...(when?.bindings ?? []),
      );
  }
}
