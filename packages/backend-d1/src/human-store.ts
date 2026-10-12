import type { ProjectRole } from "@tila/schemas";
import { hashPassword } from "better-auth/crypto";
import { and, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as h from "./human-schema";
import { membershipEvents, projectMemberships, projects } from "./schema";

export async function humanSecretHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function humanSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export class HumanAccountError extends Error {}
export class HumanStore {
  readonly db;
  constructor(database: D1Database) {
    this.db = drizzle(database);
  }

  async live(sessionId: string) {
    const [row] = await this.db
      .select({ session: h.session, user: h.user })
      .from(h.session)
      .innerJoin(h.user, eq(h.session.userId, h.user.id))
      .where(
        and(
          eq(h.session.id, sessionId),
          gt(h.session.expiresAt, new Date()),
          eq(h.user.disabled, false),
        ),
      );
    if (!row) return null;
    if (row.session.parentSessionId) {
      const [parent] = await this.db
        .select()
        .from(h.session)
        .where(
          and(
            eq(h.session.id, row.session.parentSessionId),
            eq(h.session.userId, row.user.id),
            eq(h.session.device, true),
            gt(h.session.expiresAt, new Date()),
          ),
        );
      if (!parent) return null;
    }
    return row;
  }
  async listSessions(userId: string) {
    return this.db
      .select({
        id: h.session.id,
        device: h.session.device,
        name: h.session.deviceName,
        createdAt: h.session.createdAt,
        expiresAt: h.session.expiresAt,
        userAgent: h.session.userAgent,
      })
      .from(h.session)
      .where(
        and(eq(h.session.userId, userId), gt(h.session.expiresAt, new Date())),
      );
  }
  async revokeSession(userId: string, id: string) {
    await this.db
      .delete(h.session)
      .where(
        and(
          eq(h.session.userId, userId),
          or(eq(h.session.id, id), eq(h.session.parentSessionId, id)),
        ),
      );
  }
  async selectProject(sessionId: string, projectId: string) {
    await this.db
      .update(h.session)
      .set({ projectId })
      .where(eq(h.session.id, sessionId));
  }
  async handoff(sessionId: string) {
    const current = await this.live(sessionId);
    if (!current?.session.device)
      throw new HumanAccountError("A CLI login session is required");
    const token = humanSecret();
    await this.db.insert(h.handoffs).values({
      hash: await humanSecretHash(token),
      sessionId,
      expiresAt: Date.now() + 60_000,
    });
    return token;
  }
  async consumeHandoff(token: string) {
    const [row] = await this.db
      .delete(h.handoffs)
      .where(
        and(
          eq(h.handoffs.hash, await humanSecretHash(token)),
          gt(h.handoffs.expiresAt, Date.now()),
        ),
      )
      .returning();
    if (!row) return null;
    const current = await this.live(row.sessionId);
    return current?.session.device ? current : null;
  }
  async inspectHandoff(token: string) {
    const [row] = await this.db
      .select()
      .from(h.handoffs)
      .where(
        and(
          eq(h.handoffs.hash, await humanSecretHash(token)),
          gt(h.handoffs.expiresAt, Date.now()),
        ),
      );
    return row ? this.live(row.sessionId) : null;
  }
  async recovery(email: string) {
    const [user] = await this.db
      .select()
      .from(h.user)
      .where(and(eq(h.user.email, email), eq(h.user.disabled, false)));
    if (!user) throw new HumanAccountError("Active account not found");
    const token = humanSecret();
    await this.db.batch([
      this.db.delete(h.recoveries).where(eq(h.recoveries.userId, user.id)),
      this.db.insert(h.recoveries).values({
        hash: await humanSecretHash(token),
        userId: user.id,
        expiresAt: Date.now() + 3600_000,
      }),
    ]);
    return token;
  }
  async resetPassword(token: string, password: string) {
    const hash = await humanSecretHash(token);
    const passwordHash = await hashPassword(password);
    const claim = crypto.randomUUID();
    const claimedUser = this.db
      .select({ id: h.recoveries.userId })
      .from(h.recoveries)
      .where(eq(h.recoveries.claim, claim));
    const [result] = await this.db.batch([
      this.db
        .update(h.recoveries)
        .set({ claim })
        .where(
          and(
            eq(h.recoveries.hash, hash),
            isNull(h.recoveries.claim),
            gt(h.recoveries.expiresAt, Date.now()),
          ),
        )
        .returning(),
      this.db
        .update(h.account)
        .set({ password: passwordHash, updatedAt: new Date() })
        .where(
          and(
            eq(h.account.providerId, "credential"),
            sql`${h.account.userId} IN (${claimedUser})`,
          ),
        ),
      this.db
        .delete(h.session)
        .where(sql`${h.session.userId} IN (${claimedUser})`),
    ]);
    if (!result.length)
      throw new HumanAccountError("Recovery link expired or already used");
  }
  async invitation(input: {
    email: string;
    role: "admin" | "user";
    projectId?: string;
    projectRole: ProjectRole;
    createdBy: string;
  }) {
    if (input.projectId) {
      const [project] = await this.db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.project_id, input.projectId),
            eq(projects.archived, 0),
          ),
        );
      if (!project || project.membership_mode === "service-only")
        throw new HumanAccountError("Project does not accept human members");
    }
    const [existing] = await this.db
      .select()
      .from(h.user)
      .where(eq(h.user.email, input.email));
    if (existing)
      throw new HumanAccountError(
        "Account already exists; manage their project membership instead",
      );
    const token = humanSecret();
    await this.db.insert(h.invitations).values({
      hash: await humanSecretHash(token),
      email: input.email,
      role: input.role,
      projectId: input.projectId ?? null,
      projectRole: input.projectRole,
      createdBy: input.createdBy,
      expiresAt: Date.now() + 7 * 86400_000,
    });
    return token;
  }
  async inspectInvitation(token: string) {
    const [row] = await this.db
      .select()
      .from(h.invitations)
      .where(
        and(
          eq(h.invitations.hash, await humanSecretHash(token)),
          gt(h.invitations.expiresAt, Date.now()),
          isNull(h.invitations.acceptedUserId),
        ),
      );
    return row ?? null;
  }
  async listInvitations() {
    return this.db
      .select({
        id: h.invitations.hash,
        email: h.invitations.email,
        role: h.invitations.role,
        projectId: h.invitations.projectId,
        expiresAt: h.invitations.expiresAt,
      })
      .from(h.invitations)
      .where(
        and(
          isNull(h.invitations.acceptedUserId),
          gt(h.invitations.expiresAt, Date.now()),
        ),
      );
  }
  async revokeInvitation(id: string) {
    await this.db
      .delete(h.invitations)
      .where(
        and(eq(h.invitations.hash, id), isNull(h.invitations.acceptedUserId)),
      );
  }
  async acceptInvitation(token: string, name: string, password: string) {
    const invite = await this.inspectInvitation(token);
    if (!invite)
      throw new HumanAccountError("Invitation is expired or already used");
    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();
    const principal = `user:${id}`;
    const now = new Date();
    const claimed = eq(h.invitations.acceptedUserId, id);
    // D1 batch is atomic. Each insert is conditional on this attempt winning
    // the invitation claim; a concurrent redemption cannot create another user.
    await this.db.batch([
      this.db
        .update(h.invitations)
        .set({ acceptedUserId: id })
        .where(
          and(
            eq(h.invitations.hash, invite.hash),
            isNull(h.invitations.acceptedUserId),
            gt(h.invitations.expiresAt, now.getTime()),
          ),
        ),
      this.db.insert(h.user).select(
        this.db
          .select({
            id: sql<string>`${id}`.as("id"),
            name: sql<string>`${name}`.as("name"),
            email: h.invitations.email,
            emailVerified: sql<boolean>`0`.as("emailVerified"),
            image: sql<string>`NULL`.as("image"),
            createdAt: sql<Date>`${now.getTime()}`.as("createdAt"),
            updatedAt: sql<Date>`${now.getTime()}`.as("updatedAt"),
            role: h.invitations.role,
            disabled: sql<boolean>`0`.as("disabled"),
          })
          .from(h.invitations)
          .where(claimed),
      ),
      this.db.insert(h.account).select(
        this.db
          .select({
            id: sql<string>`${crypto.randomUUID()}`.as("id"),
            accountId: sql<string>`${id}`.as("accountId"),
            providerId: sql<string>`'credential'`.as("providerId"),
            userId: sql<string>`${id}`.as("userId"),
            accessToken: sql<string>`NULL`.as("accessToken"),
            refreshToken: sql<string>`NULL`.as("refreshToken"),
            idToken: sql<string>`NULL`.as("idToken"),
            accessTokenExpiresAt: sql<Date>`NULL`.as("accessTokenExpiresAt"),
            refreshTokenExpiresAt: sql<Date>`NULL`.as("refreshTokenExpiresAt"),
            scope: sql<string>`NULL`.as("scope"),
            password: sql<string>`${passwordHash}`.as("password"),
            createdAt: sql<Date>`${now.getTime()}`.as("createdAt"),
            updatedAt: sql<Date>`${now.getTime()}`.as("updatedAt"),
          })
          .from(h.invitations)
          .where(claimed),
      ),
      this.db.insert(projectMemberships).select(
        this.db
          .select({
            membership_id: sql<string>`${crypto.randomUUID()}`.as(
              "membership_id",
            ),
            project_id: sql<string>`${invite.projectId ?? ""}`.as("project_id"),
            principal_id: sql<string>`${principal}`.as("principal_id"),
            provider: sql<string>`'user'`.as("provider"),
            identity_host: sql<string>`'tila'`.as("identity_host"),
            subject_id: sql<string>`${id}`.as("subject_id"),
            subject_kind: sql<string>`'human'`.as("subject_kind"),
            role: h.invitations.projectRole,
            display_name: sql<string>`${name}`.as("display_name"),
            granted_by: h.invitations.createdBy,
            granted_at: sql<number>`${now.getTime()}`.as("granted_at"),
            revoked_by: sql<string>`NULL`.as("revoked_by"),
            revoked_at: sql<number>`NULL`.as("revoked_at"),
          })
          .from(h.invitations)
          .where(and(claimed, sql`${h.invitations.projectId} IS NOT NULL`)),
      ),
      this.db.insert(membershipEvents).select(
        this.db
          .select({
            event_id: sql<string>`${crypto.randomUUID()}`.as("event_id"),
            project_id: sql<string>`${invite.projectId ?? ""}`.as("project_id"),
            principal_id: sql<string>`${principal}`.as("principal_id"),
            actor_principal_id: h.invitations.createdBy,
            action: sql<string>`'grant'`.as("action"),
            source: sql<string>`'explicit'`.as("source"),
            role: h.invitations.projectRole,
            github_repo_id: sql<number>`NULL`.as("github_repo_id"),
            details_json: sql<string>`'{}'`.as("details_json"),
            occurred_at: sql<number>`${now.getTime()}`.as("occurred_at"),
          })
          .from(h.invitations)
          .where(and(claimed, sql`${h.invitations.projectId} IS NOT NULL`)),
      ),
    ]);
    const [created] = await this.db
      .select({ id: h.user.id })
      .from(h.user)
      .where(eq(h.user.id, id));
    if (!created)
      throw new HumanAccountError("Invitation is expired or already used");
    return invite.email;
  }
  async users() {
    return this.db
      .select({
        id: h.user.id,
        email: h.user.email,
        name: h.user.name,
        role: h.user.role,
        disabled: h.user.disabled,
      })
      .from(h.user);
  }
  async updateUser(
    id: string,
    update: { role?: "admin" | "user"; disabled?: boolean },
  ) {
    // A single guarded write protects against concurrent last-admin demotions.
    const [changed] = await this.db
      .update(h.user)
      .set({ ...update, updatedAt: new Date() })
      .where(
        and(
          eq(h.user.id, id),
          update.disabled || update.role === "user"
            ? sql`(${h.user.role} != 'admin' OR ${h.user.disabled} = 1 OR EXISTS (SELECT 1 FROM ${h.user} other WHERE other.id != ${id} AND other.role = 'admin' AND other.disabled = 0))`
            : sql`1`,
          update.disabled
            ? sql`NOT EXISTS (SELECT 1 FROM ${projectMemberships} m WHERE m.principal_id = ${`user:${id}`} AND m.role = 'owner' AND m.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM ${projectMemberships} other WHERE other.project_id = m.project_id AND other.principal_id != m.principal_id AND other.role = 'owner' AND other.revoked_at IS NULL AND (other.provider != 'user' OR EXISTS (SELECT 1 FROM ${h.user} active_owner WHERE active_owner.id = other.subject_id AND active_owner.disabled = 0))))`
            : sql`1`,
        ),
      )
      .returning({ id: h.user.id });
    if (!changed)
      throw new HumanAccountError(
        "Keep at least one active administrator and an owner for every project",
      );
    if (update.disabled)
      await this.db.delete(h.session).where(eq(h.session.userId, id));
  }
}
