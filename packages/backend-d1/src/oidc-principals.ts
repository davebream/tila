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

export interface OidcRegisterParams {
  projectId: string;
  issuer: string;
  subject: string;
  permission?: string;
  createdBy: string;
}

export class OidcPrincipalsStore {
  private drizzle;

  constructor(private db: D1Database) {
    this.drizzle = drizzle(this.db);
  }

  /**
   * Check if an OIDC principal is allowed for a project.
   * Looks up by (project_id, issuer, subject) where enabled=1.
   * Returns the row (carrying permission) or null if absent/disabled.
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

  /**
   * List all enabled principals for a project.
   */
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

  /**
   * Register an OIDC principal in the allowlist (admin path).
   * Idempotent via onConflictDoNothing on the (project_id, issuer, subject) unique index.
   * permission defaults to 'read' (least privilege per design §C1).
   */
  async register(params: OidcRegisterParams): Promise<void> {
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

  /**
   * Remove an OIDC principal from the allowlist (hard delete).
   * No-op if the triple is not registered.
   */
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
