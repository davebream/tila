import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { oidcPrincipals } from "./schema";

export interface OidcPrincipalRow {
  project_id: string;
  issuer: string;
  subject: string;
  permission: string;
  enabled: number;
  created_at: number;
  created_by: string;
}

export interface RegisterOidcPrincipalParams {
  projectId: string;
  issuer: string;
  subject: string;
  permission?: string;
  createdBy: string;
}

/**
 * Data-access for the generic OIDC principal allowlist (WI-B2). Non-GitHub
 * analog of RepoAllowlistStore. Authorization is keyed on the
 * (project_id, issuer, subject) triple — `subject` (the upstream `sub` claim)
 * is only locally unique to its issuer, so the issuer is part of the key.
 */
export class OidcPrincipalsStore {
  private drizzle;

  constructor(private db: D1Database) {
    this.drizzle = drizzle(this.db);
  }

  /**
   * Return the enabled principal row for (project, issuer, subject), or null
   * if absent or disabled. Carries the granted `permission`.
   */
  async isAllowed(
    projectId: string,
    issuer: string,
    subject: string,
  ): Promise<OidcPrincipalRow | null> {
    const rows = await this.drizzle
      .select()
      .from(oidcPrincipals)
      .where(
        and(
          eq(oidcPrincipals.project_id, projectId),
          eq(oidcPrincipals.issuer, issuer),
          eq(oidcPrincipals.subject, subject),
          eq(oidcPrincipals.enabled, 1),
        ),
      )
      .limit(1);

    return (rows[0] as OidcPrincipalRow) ?? null;
  }

  /** List all enabled principals for a project. */
  async listForProject(projectId: string): Promise<OidcPrincipalRow[]> {
    const rows = await this.drizzle
      .select()
      .from(oidcPrincipals)
      .where(
        and(
          eq(oidcPrincipals.project_id, projectId),
          eq(oidcPrincipals.enabled, 1),
        ),
      );

    return rows as OidcPrincipalRow[];
  }

  /** Register a principal in the allowlist (admin path). Idempotent. */
  async register(params: RegisterOidcPrincipalParams): Promise<void> {
    await this.drizzle
      .insert(oidcPrincipals)
      .values({
        project_id: params.projectId,
        issuer: params.issuer,
        subject: params.subject,
        permission: params.permission ?? "read",
        enabled: 1,
        created_at: Math.floor(Date.now() / 1000),
        created_by: params.createdBy,
      })
      .onConflictDoNothing();
  }

  /** Remove a principal from the allowlist (hard delete). No-op if absent. */
  async remove(
    projectId: string,
    issuer: string,
    subject: string,
  ): Promise<void> {
    await this.drizzle
      .delete(oidcPrincipals)
      .where(
        and(
          eq(oidcPrincipals.project_id, projectId),
          eq(oidcPrincipals.issuer, issuer),
          eq(oidcPrincipals.subject, subject),
        ),
      );
  }
}
