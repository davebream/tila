import {
  type CredentialPolicy,
  CredentialPolicySchema,
  GITHUB_ACTIONS_ISSUER,
  type GitHubActionsContext,
  GitHubActionsContextSchema,
  type ProjectRole,
  type WorkloadBindingRequest,
  delegablePolicy,
  effectiveCredentialPolicy,
  hasRootCapabilities,
  intersectCredentialPolicies,
} from "@tila/schemas";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  not,
  notExists,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ProjectMembershipStore } from "./project-memberships";
import {
  credentialEvents,
  credentialVersions,
  credentials,
  membershipEvents,
  projectMemberships,
  serviceAccounts,
  sessions,
  tokens,
  workloadBindings,
} from "./schema";
import { resolveActionsPolicy } from "./workload-policy";

export interface CredentialActor {
  principalId: string;
  tokenId?: string;
}
export class CredentialConflict extends Error {}
export class CredentialDenied extends Error {}
export const SCOPED_TOKEN_MARKER = "scoped-v1";

export class CredentialStore {
  private db;
  constructor(private binding: D1Database) {
    this.db = drizzle(binding);
  }
  private event(
    projectId: string,
    actor: CredentialActor,
    target: string,
    action: string,
    details: unknown = {},
  ) {
    return this.db.insert(credentialEvents).values({
      event_id: crypto.randomUUID(),
      project_id: projectId,
      actor_principal_id: actor.principalId,
      actor_token_id: actor.tokenId ?? null,
      target_id: target,
      action,
      occurred_at: Math.floor(Date.now() / 1000),
      details_json: JSON.stringify(details),
    });
  }
  async createService(
    projectId: string,
    input: { name: string; display_name: string; role: ProjectRole },
    actor: CredentialActor,
  ) {
    const id = crypto.randomUUID();
    const principalId = `service:${id}`;
    const row = {
      principal_id: principalId,
      project_id: projectId,
      name: input.name,
      display_name: input.display_name,
      created_at: Math.floor(Date.now() / 1000),
      created_by: actor.principalId,
      revoked_at: null,
    };
    await this.db.batch([
      this.db.insert(serviceAccounts).values(row),
      this.db.insert(projectMemberships).values({
        membership_id: crypto.randomUUID(),
        project_id: projectId,
        principal_id: principalId,
        provider: "service",
        identity_host: "tila",
        subject_id: id,
        subject_kind: "service",
        role: input.role,
        display_name: input.display_name,
        granted_by: actor.principalId,
        granted_at: Date.now(),
      }),
      this.db.insert(membershipEvents).values({
        event_id: crypto.randomUUID(),
        project_id: projectId,
        principal_id: principalId,
        actor_principal_id: actor.principalId,
        action: "grant",
        source: "explicit",
        role: input.role,
        occurred_at: Date.now(),
      }),
      this.event(projectId, actor, principalId, "service-created", {
        role: input.role,
      }),
    ]);
    return row;
  }
  listServices(projectId: string) {
    return this.db
      .select()
      .from(serviceAccounts)
      .where(eq(serviceAccounts.project_id, projectId))
      .all();
  }
  async updateService(
    projectId: string,
    principalId: string,
    displayName: string,
    actor: CredentialActor,
  ) {
    const [rows] = await this.db.batch([
      this.db
        .update(serviceAccounts)
        .set({ display_name: displayName })
        .where(
          and(
            eq(serviceAccounts.project_id, projectId),
            eq(serviceAccounts.principal_id, principalId),
            isNull(serviceAccounts.revoked_at),
          ),
        )
        .returning(),
      this.event(projectId, actor, principalId, "service-updated", {
        display_name: displayName,
      }),
    ]);
    return rows[0] ?? null;
  }
  async revokeService(
    projectId: string,
    principalId: string,
    actor: CredentialActor,
  ) {
    const now = Math.floor(Date.now() / 1000);
    // The NOT EXISTS predicate is evaluated inside the same transaction as the
    // revocation, so concurrent owner removals cannot both remove the last owner.
    const lastOwner = and(
      exists(
        this.db
          .select({ id: projectMemberships.membership_id })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.project_id, projectId),
              eq(projectMemberships.principal_id, principalId),
              eq(projectMemberships.role, "owner"),
              isNull(projectMemberships.revoked_at),
            ),
          ),
      ),
      notExists(
        this.db
          .select({ id: projectMemberships.membership_id })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.project_id, projectId),
              ne(projectMemberships.principal_id, principalId),
              eq(projectMemberships.role, "owner"),
              isNull(projectMemberships.revoked_at),
            ),
          ),
      ),
    );
    const revoked = exists(
      this.db
        .select({ id: serviceAccounts.principal_id })
        .from(serviceAccounts)
        .where(
          and(
            eq(serviceAccounts.project_id, projectId),
            eq(serviceAccounts.principal_id, principalId),
            eq(serviceAccounts.revoked_at, now),
          ),
        ),
    );
    const credentialIds = this.db
      .select({ id: credentials.credential_id })
      .from(credentials)
      .where(
        and(
          eq(credentials.project_id, projectId),
          eq(credentials.principal_id, principalId),
        ),
      );
    const tokenIds = this.db
      .select({ id: credentialVersions.token_id })
      .from(credentialVersions)
      .where(inArray(credentialVersions.credential_id, credentialIds));
    const [rows] = await this.db.batch([
      this.db
        .update(serviceAccounts)
        .set({ revoked_at: now })
        .where(
          and(
            eq(serviceAccounts.project_id, projectId),
            eq(serviceAccounts.principal_id, principalId),
            isNull(serviceAccounts.revoked_at),
            not(lastOwner ?? sql`0`),
          ),
        )
        .returning(),
      this.db
        .update(projectMemberships)
        .set({ revoked_at: Date.now(), revoked_by: actor.principalId })
        .where(
          and(
            eq(projectMemberships.project_id, projectId),
            eq(projectMemberships.principal_id, principalId),
            isNull(projectMemberships.revoked_at),
            revoked,
          ),
        ),
      this.db
        .update(credentials)
        .set({ revoked_at: now, revoked_by: actor.principalId })
        .where(
          and(
            inArray(credentials.credential_id, credentialIds),
            isNull(credentials.revoked_at),
            revoked,
          ),
        ),
      this.db
        .update(tokens)
        .set({ revoked_at: now, revoked_by: actor.principalId })
        .where(
          and(
            inArray(tokens.token_id, tokenIds),
            isNull(tokens.revoked_at),
            revoked,
          ),
        ),
      this.db
        .update(workloadBindings)
        .set({ revoked_at: now })
        .where(
          and(
            eq(workloadBindings.project_id, projectId),
            eq(workloadBindings.principal_id, principalId),
            isNull(workloadBindings.revoked_at),
            revoked,
          ),
        ),
      this.event(projectId, actor, principalId, "service-revocation-requested"),
    ]);
    if (!rows.length)
      throw new CredentialConflict("Service not active or last project owner");
    return rows[0];
  }
  async servicePolicy(
    projectId: string,
    principalId: string,
    policy: CredentialPolicy,
  ) {
    const account = await this.db
      .select()
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.project_id, projectId),
          eq(serviceAccounts.principal_id, principalId),
          isNull(serviceAccounts.revoked_at),
        ),
      )
      .get();
    const membership = await new ProjectMembershipStore(this.binding).resolve(
      projectId,
      principalId,
    );
    if (!account || !membership)
      throw new CredentialDenied("Active service membership required");
    return effectiveCredentialPolicy(
      CredentialPolicySchema.parse(policy),
      membership.role,
    );
  }
  async issue(
    params: {
      projectId: string;
      principalId: string;
      name: string;
      note?: string;
      policy: CredentialPolicy;
      tokenHash: string;
      expiresAt?: number | null;
      cnfJkt?: string | null;
      workloadBindingId?: string;
      workloadContext?: GitHubActionsContext;
    },
    actor: CredentialActor,
  ) {
    const now = Math.floor(Date.now() / 1000);
    let policy = CredentialPolicySchema.parse(params.policy);
    if (hasRootCapabilities(policy))
      throw new CredentialDenied("Root capabilities are not delegable");
    const service = await this.db
      .select()
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.principal_id, params.principalId),
          eq(serviceAccounts.project_id, params.projectId),
          isNull(serviceAccounts.revoked_at),
        ),
      )
      .get();
    const membership = await new ProjectMembershipStore(this.binding).resolve(
      params.projectId,
      params.principalId,
    );
    if (!service || !membership)
      throw new CredentialDenied("Active service membership required");
    policy = effectiveCredentialPolicy(policy, membership.role);
    const credentialId = crypto.randomUUID();
    const tokenId = crypto.randomUUID();
    const expiresAt =
      params.expiresAt === undefined ? now + 90 * 86400 : params.expiresAt;
    if (expiresAt !== null && expiresAt <= now)
      throw new CredentialDenied("Expiry must be in the future");
    await this.db.batch([
      this.db.insert(credentials).values({
        credential_id: credentialId,
        project_id: params.projectId,
        principal_id: params.principalId,
        name: params.name,
        note: params.note ?? null,
        policy_json: JSON.stringify(policy),
        current_token_id: tokenId,
        created_at: now,
        created_by: actor.principalId,
        workload_binding_id: params.workloadBindingId ?? null,
        workload_context_json: params.workloadContext
          ? JSON.stringify(
              GitHubActionsContextSchema.parse(params.workloadContext),
            )
          : null,
      }),
      this.db.insert(tokens).values({
        token_hash: params.tokenHash,
        project_id: params.projectId,
        name: `version-${tokenId}`,
        scopes: SCOPED_TOKEN_MARKER,
        token_id: tokenId,
        created_at: now,
        created_by: actor.principalId,
        cnf_jkt: params.cnfJkt ?? null,
      }),
      this.db.insert(credentialVersions).values({
        token_id: tokenId,
        credential_id: credentialId,
        expires_at: expiresAt,
      }),
      this.event(params.projectId, actor, credentialId, "credential-issued", {
        token_id: tokenId,
        principal_id: params.principalId,
        policy,
      }),
    ]);
    return {
      credential_id: credentialId,
      token_id: tokenId,
      principal_id: params.principalId,
      name: params.name,
      created_at: now,
      expires_at: expiresAt,
      policy,
      legacy: false as const,
    };
  }
  async resolve(tokenId: string) {
    const row = await this.db
      .select({
        credential: credentials,
        version: credentialVersions,
        token: tokens,
        service: serviceAccounts,
      })
      .from(credentialVersions)
      .innerJoin(
        credentials,
        eq(credentials.credential_id, credentialVersions.credential_id),
      )
      .innerJoin(tokens, eq(tokens.token_id, credentialVersions.token_id))
      .innerJoin(
        serviceAccounts,
        eq(serviceAccounts.principal_id, credentials.principal_id),
      )
      .where(eq(credentialVersions.token_id, tokenId))
      .get();
    const now = Math.floor(Date.now() / 1000);
    if (
      !row ||
      row.token.revoked_at !== null ||
      row.credential.revoked_at !== null ||
      row.service.revoked_at !== null ||
      (row.version.expires_at !== null && row.version.expires_at <= now) ||
      (row.version.retire_at !== null && row.version.retire_at <= now)
    )
      return null;
    const membership = await new ProjectMembershipStore(this.binding).resolve(
      row.credential.project_id,
      row.credential.principal_id,
    );
    if (!membership) return null;
    let policy = CredentialPolicySchema.parse(
      JSON.parse(row.credential.policy_json),
    );
    if (row.credential.workload_binding_id) {
      const binding = await this.db
        .select()
        .from(workloadBindings)
        .where(
          eq(workloadBindings.binding_id, row.credential.workload_binding_id),
        )
        .get();
      if (
        !binding ||
        binding.revoked_at !== null ||
        binding.project_id !== row.credential.project_id ||
        binding.principal_id !== row.credential.principal_id
      )
        return null;
      if (binding.provider === "github-actions") {
        const parsed = GitHubActionsContextSchema.safeParse(
          JSON.parse(row.credential.workload_context_json ?? "null"),
        );
        if (
          !parsed.success ||
          binding.issuer !== GITHUB_ACTIONS_ISSUER ||
          binding.subject !== parsed.data.sub
        )
          return null;
        const current = await resolveActionsPolicy(
          this.binding,
          row.credential.project_id,
          parsed.data,
        );
        if (!current) return null;
        policy = effectiveCredentialPolicy(policy, current.role);
      }
      policy = intersectCredentialPolicies(
        policy,
        CredentialPolicySchema.parse(JSON.parse(binding.policy_json)),
      );
    }
    return {
      principalId: row.credential.principal_id,
      credentialId: row.credential.credential_id,
      name: row.credential.name,
      policy: delegablePolicy(
        effectiveCredentialPolicy(policy, membership.role),
      ),
      expiresAt: row.version.expires_at,
      retireAt: row.version.retire_at,
      membership,
      workloadBindingId: row.credential.workload_binding_id,
    };
  }
  async find(projectId: string, name: string) {
    return this.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.project_id, projectId),
          eq(credentials.name, name),
          isNull(credentials.revoked_at),
        ),
      )
      .get();
  }
  async hasWorkloadExchange(projectId: string, name: string) {
    return !!(await this.db
      .select({ id: credentials.credential_id })
      .from(credentials)
      .where(
        and(eq(credentials.project_id, projectId), eq(credentials.name, name)),
      )
      .get());
  }
  async rotate(
    projectId: string,
    name: string,
    expectedTokenId: string,
    tokenHash: string,
    overlap: number,
    actor: CredentialActor,
  ) {
    const credential = await this.find(projectId, name);
    if (!credential || credential.workload_binding_id)
      throw new CredentialConflict("No rotatable credential");
    const old = await this.db
      .select({ version: credentialVersions, token: tokens })
      .from(credentialVersions)
      .innerJoin(tokens, eq(tokens.token_id, credentialVersions.token_id))
      .where(eq(credentialVersions.token_id, expectedTokenId))
      .get();
    if (!old || old.version.credential_id !== credential.credential_id)
      throw new CredentialConflict("Credential version changed");
    const tokenId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const won = and(
      eq(credentials.credential_id, credential.credential_id),
      eq(credentials.current_token_id, tokenId),
      isNull(credentials.revoked_at),
    );
    const wonExists = exists(
      this.db
        .select({ id: credentials.credential_id })
        .from(credentials)
        .where(won),
    );
    const [updated] = await this.db.batch([
      this.db
        .update(credentials)
        .set({ current_token_id: tokenId })
        .where(
          and(
            eq(credentials.credential_id, credential.credential_id),
            eq(credentials.current_token_id, expectedTokenId),
            isNull(credentials.revoked_at),
          ),
        )
        .returning(),
      this.db.insert(tokens).select(
        this.db
          .select({
            token_hash: sql<string>`${tokenHash}`.as("token_hash"),
            project_id: credentials.project_id,
            name: sql<string>`${`version-${tokenId}`}`.as("name"),
            note: sql<string | null>`NULL`.as("note"),
            scopes: sql<string>`${SCOPED_TOKEN_MARKER}`.as("scopes"),
            created_at: sql<number>`${now}`.as("created_at"),
            created_by: sql<string>`${actor.principalId}`.as("created_by"),
            last_used_at: sql<number | null>`NULL`.as("last_used_at"),
            revoked_at: sql<number | null>`NULL`.as("revoked_at"),
            revoked_by: sql<string | null>`NULL`.as("revoked_by"),
            token_id: sql<string>`${tokenId}`.as("token_id"),
            cnf_jkt: sql<string | null>`${old.token.cnf_jkt}`.as("cnf_jkt"),
          })
          .from(credentials)
          .where(won),
      ),
      this.db.insert(credentialVersions).select(
        this.db
          .select({
            token_id: sql<string>`${tokenId}`.as("token_id"),
            credential_id: credentials.credential_id,
            expires_at: sql<number | null>`${old.version.expires_at}`.as(
              "expires_at",
            ),
            retire_at: sql<number | null>`NULL`.as("retire_at"),
          })
          .from(credentials)
          .where(won),
      ),
      this.db
        .update(credentialVersions)
        .set({ retire_at: now + overlap })
        .where(
          and(
            eq(credentialVersions.token_id, expectedTokenId),
            isNull(credentialVersions.retire_at),
            wonExists,
          ),
        ),
      this.db.insert(credentialEvents).select(
        this.db
          .select({
            event_id: sql<string>`${crypto.randomUUID()}`.as("event_id"),
            project_id: credentials.project_id,
            actor_principal_id: sql<string>`${actor.principalId}`.as(
              "actor_principal_id",
            ),
            actor_token_id: sql<string | null>`${actor.tokenId ?? null}`.as(
              "actor_token_id",
            ),
            target_id: credentials.credential_id,
            action: sql<string>`'credential-rotated'`.as("action"),
            occurred_at: sql<number>`${now}`.as("occurred_at"),
            details_json:
              sql<string>`${JSON.stringify({ token_id: tokenId, previous_token_id: expectedTokenId, retire_at: now + overlap })}`.as(
                "details_json",
              ),
          })
          .from(credentials)
          .where(won),
      ),
    ]);
    if (!updated.length)
      throw new CredentialConflict("Credential version changed");
    return {
      credential_id: credential.credential_id,
      token_id: tokenId,
      principal_id: credential.principal_id,
      name,
      created_at: now,
      expires_at: old.version.expires_at,
      policy: CredentialPolicySchema.parse(JSON.parse(credential.policy_json)),
      legacy: false as const,
    };
  }
  async revoke(projectId: string, name: string, actor: CredentialActor) {
    const row = await this.find(projectId, name);
    if (!row) return false;
    const versions = this.db
      .select({ id: credentialVersions.token_id })
      .from(credentialVersions)
      .where(eq(credentialVersions.credential_id, row.credential_id));
    const hashes = this.db
      .select({ hash: tokens.token_hash })
      .from(tokens)
      .where(inArray(tokens.token_id, versions));
    const now = Math.floor(Date.now() / 1000);
    await this.db.batch([
      this.db
        .update(credentials)
        .set({ revoked_at: now, revoked_by: actor.principalId })
        .where(eq(credentials.credential_id, row.credential_id)),
      this.db
        .update(tokens)
        .set({ revoked_at: now, revoked_by: actor.principalId })
        .where(
          and(inArray(tokens.token_id, versions), isNull(tokens.revoked_at)),
        ),
      this.db.delete(sessions).where(inArray(sessions.token_hash, hashes)),
      this.event(projectId, actor, row.credential_id, "credential-revoked"),
    ]);
    return true;
  }
  async revokeProjectCredentials(projectId: string, actor: CredentialActor) {
    const now = Math.floor(Date.now() / 1000);
    const ids = this.db
      .select({ id: credentials.credential_id })
      .from(credentials)
      .where(eq(credentials.project_id, projectId));
    const versions = this.db
      .select({ id: credentialVersions.token_id })
      .from(credentialVersions)
      .where(inArray(credentialVersions.credential_id, ids));
    const hashes = this.db
      .select({ hash: tokens.token_hash })
      .from(tokens)
      .where(inArray(tokens.token_id, versions));
    await this.db.batch([
      this.db
        .update(credentials)
        .set({ revoked_at: now, revoked_by: actor.principalId })
        .where(
          and(
            eq(credentials.project_id, projectId),
            isNull(credentials.revoked_at),
          ),
        ),
      this.db
        .update(tokens)
        .set({ revoked_at: now, revoked_by: actor.principalId })
        .where(
          and(inArray(tokens.token_id, versions), isNull(tokens.revoked_at)),
        ),
      this.db.delete(sessions).where(inArray(sessions.token_hash, hashes)),
      this.event(
        projectId,
        actor,
        projectId,
        "credentials-revoked-for-restore",
      ),
    ]);
  }
  async list(projectId: string) {
    const rows = await this.db
      .select()
      .from(credentials)
      .where(eq(credentials.project_id, projectId))
      .all();
    return Promise.all(
      rows.map(async (row) => {
        const versions = await this.db
          .select({
            token_id: credentialVersions.token_id,
            expires_at: credentialVersions.expires_at,
            retire_at: credentialVersions.retire_at,
            revoked_at: tokens.revoked_at,
            last_used_at: tokens.last_used_at,
          })
          .from(credentialVersions)
          .innerJoin(tokens, eq(tokens.token_id, credentialVersions.token_id))
          .where(eq(credentialVersions.credential_id, row.credential_id))
          .all();
        const effective = await this.resolve(row.current_token_id);
        const now = Math.floor(Date.now() / 1000);
        const current = versions.find(
          (v) => v.token_id === row.current_token_id,
        );
        const status =
          row.revoked_at !== null
            ? "revoked"
            : current?.expires_at !== null &&
                current?.expires_at !== undefined &&
                current.expires_at <= now
              ? "expired"
              : effective
                ? "active"
                : "disabled";
        return {
          token_id: row.current_token_id,
          credential_id: row.credential_id,
          principal_id: row.principal_id,
          name: row.name,
          note: row.note,
          scopes: SCOPED_TOKEN_MARKER,
          policy: CredentialPolicySchema.parse(JSON.parse(row.policy_json)),
          effective_policy: effective?.policy ?? null,
          status,
          expires_at:
            versions.find((v) => v.token_id === row.current_token_id)
              ?.expires_at ?? null,
          created_at: row.created_at,
          created_by: row.created_by,
          last_used_at: versions.reduce<number | null>(
            (latest, version) =>
              version.last_used_at === null
                ? latest
                : Math.max(latest ?? 0, version.last_used_at),
            null,
          ),
          revoked_at: row.revoked_at,
          revoked_by: row.revoked_by,
          legacy: false,
          versions,
        };
      }),
    );
  }
  async createBinding(
    projectId: string,
    principalId: string,
    input: WorkloadBindingRequest,
    actor: CredentialActor,
  ) {
    const account = await this.db
      .select()
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.project_id, projectId),
          eq(serviceAccounts.principal_id, principalId),
          isNull(serviceAccounts.revoked_at),
        ),
      )
      .get();
    if (!account) throw new CredentialDenied("Active service account required");
    const membership = await new ProjectMembershipStore(this.binding).resolve(
      projectId,
      principalId,
    );
    if (!membership)
      throw new CredentialDenied("Active service membership required");
    if (hasRootCapabilities(input.policy))
      throw new CredentialDenied("Root capabilities are not delegable");
    const policy = effectiveCredentialPolicy(input.policy, membership.role);
    const row = {
      binding_id: crypto.randomUUID(),
      project_id: projectId,
      principal_id: principalId,
      name: input.name,
      provider: input.provider,
      issuer: input.issuer,
      subject: input.subject,
      policy_json: JSON.stringify(policy),
      created_at: Math.floor(Date.now() / 1000),
      created_by: actor.principalId,
      revoked_at: null,
    };
    await this.db.batch([
      this.db.insert(workloadBindings).values(row),
      this.event(projectId, actor, row.binding_id, "workload-binding-created", {
        ...input,
        policy,
      }),
    ]);
    return { ...row, policy, policy_json: undefined };
  }
  async updateBinding(
    projectId: string,
    principalId: string,
    bindingId: string,
    requestedPolicy: CredentialPolicy,
    actor: CredentialActor,
  ) {
    const membership = await new ProjectMembershipStore(this.binding).resolve(
      projectId,
      principalId,
    );
    if (!membership)
      throw new CredentialDenied("Active service membership required");
    if (hasRootCapabilities(requestedPolicy))
      throw new CredentialDenied("Root capabilities are not delegable");
    const policy = effectiveCredentialPolicy(
      CredentialPolicySchema.parse(requestedPolicy),
      membership.role,
    );
    const [rows] = await this.db.batch([
      this.db
        .update(workloadBindings)
        .set({ policy_json: JSON.stringify(policy) })
        .where(
          and(
            eq(workloadBindings.project_id, projectId),
            eq(workloadBindings.principal_id, principalId),
            eq(workloadBindings.binding_id, bindingId),
            isNull(workloadBindings.revoked_at),
          ),
        )
        .returning(),
      this.event(projectId, actor, bindingId, "workload-policy-updated", {
        policy,
      }),
    ]);
    if (!rows[0]) return null;
    const { policy_json, ...row } = rows[0];
    return { ...row, policy };
  }
  async listBindings(projectId: string, principalId: string) {
    const rows = await this.db
      .select()
      .from(workloadBindings)
      .where(
        and(
          eq(workloadBindings.project_id, projectId),
          eq(workloadBindings.principal_id, principalId),
        ),
      )
      .all();
    return rows.map(({ policy_json, ...row }) => ({
      ...row,
      policy: CredentialPolicySchema.parse(JSON.parse(policy_json)),
    }));
  }
  async findBinding(
    projectId: string,
    provider: string,
    issuer: string,
    subject: string,
  ) {
    // Return tombstones too: disabling scoped exchange must never fall back to
    // the less restricted legacy exchange for the same external subject.
    return this.db
      .select()
      .from(workloadBindings)
      .where(
        and(
          eq(workloadBindings.project_id, projectId),
          eq(workloadBindings.provider, provider),
          eq(workloadBindings.issuer, issuer),
          eq(workloadBindings.subject, subject),
        ),
      )
      .get();
  }
  async revokeBinding(
    projectId: string,
    principalId: string,
    bindingId: string,
    actor: CredentialActor,
  ) {
    const [rows] = await this.db.batch([
      this.db
        .update(workloadBindings)
        .set({ revoked_at: Math.floor(Date.now() / 1000) })
        .where(
          and(
            eq(workloadBindings.project_id, projectId),
            eq(workloadBindings.principal_id, principalId),
            eq(workloadBindings.binding_id, bindingId),
            isNull(workloadBindings.revoked_at),
          ),
        )
        .returning(),
      this.event(
        projectId,
        actor,
        bindingId,
        "workload-binding-revocation-requested",
      ),
    ]);
    return rows.length > 0;
  }
}
