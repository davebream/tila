import {
  CREDENTIAL_PRESETS,
  type CredentialPolicy,
  CredentialPolicyReadSchema,
  CredentialPolicySchema,
  GitHubActionsContextSchema,
  INVITATION_TTL_SECONDS,
  PROJECT_ROLE_RANK,
  RUNTIME_PROTOCOL,
  RUNTIME_RUN_CEILING,
  RUN_LEASE_SECONDS,
  RUN_OVERLAP_SECONDS,
  RUN_TOKEN_TTL_SECONDS,
  RuntimeContextSchema,
  type RuntimeEnrollmentRequest,
  type RuntimeRunRequest,
  effectiveCredentialPolicy,
  intersectCredentialPolicies,
  permissionToRole,
  policyContains,
} from "@tila/schemas";
import { and, eq, gt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { D1DeploymentMetaStore } from "./deployment-meta";
import {
  type MirroredMembershipCandidate,
  ProjectMembershipStore,
} from "./project-memberships";
import { RepoAllowlistStore } from "./repo-allowlist";
import {
  credentialEvents,
  projectMemberships,
  revokedSubjects,
  runtimeAssertions,
  runtimeCredentials,
  runtimeEnrollments,
  runtimeInvitations,
  runtimeProofs,
  runtimeRuns,
  serviceAccounts,
  tokens,
  workloadBindings,
} from "./schema";
import { resolveActionsPolicy } from "./workload-policy";

export const RUNTIME_TOKEN_MARKER = "runtime-v1";
export class RuntimeDenied extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 401 | 403 | 409 = 403,
  ) {
    super(message);
  }
}
type EnrollmentRow = typeof runtimeEnrollments.$inferSelect;
type RunRow = typeof runtimeRuns.$inferSelect;
export interface RuntimeSecret {
  hash: string;
  id: string;
}

/** Owns runtime authority. No plaintext credentials are accepted or persisted. */
export class RuntimeStore {
  private db;
  constructor(
    private binding: D1Database,
    private clock = () => Math.floor(Date.now() / 1000),
    private authorizeAgent?: (
      project: string,
      principal: string,
      agent: string,
    ) => Promise<void>,
  ) {
    this.db = drizzle(binding);
  }
  private deny(code: string, message: string): never {
    throw new RuntimeDenied(code, message);
  }
  private event(
    project: string,
    actor: string,
    target: string,
    action: string,
  ) {
    return this.db.insert(credentialEvents).values({
      event_id: crypto.randomUUID(),
      project_id: project,
      actor_principal_id: actor,
      target_id: target,
      action,
      occurred_at: this.clock(),
      details_json: "{}",
    });
  }
  private token(
    project: string,
    principal: string,
    jkt: string,
    secret: RuntimeSecret,
  ) {
    return this.db.insert(tokens).values({
      token_id: secret.id,
      token_hash: secret.hash,
      project_id: project,
      name: `runtime-${secret.id}`,
      scopes: RUNTIME_TOKEN_MARKER,
      created_at: this.clock(),
      created_by: principal,
      cnf_jkt: jkt,
    });
  }
  async enrollment(id: string) {
    return this.db
      .select()
      .from(runtimeEnrollments)
      .where(eq(runtimeEnrollments.enrollment_id, id))
      .get();
  }
  async run(id: string) {
    return this.db
      .select()
      .from(runtimeRuns)
      .where(eq(runtimeRuns.run_id, id))
      .get();
  }
  private async enrollmentPolicy(
    row: EnrollmentRow,
  ): Promise<CredentialPolicy> {
    if (row.revoked_at !== null)
      this.deny("enrollment-revoked", "Installation authorization was revoked");
    const memberships = new ProjectMembershipStore(this.binding);
    const service = await memberships.getActive(
      row.project_id,
      row.principal_id,
    );
    if (!(await memberships.getMode(row.project_id)))
      this.deny("enrollment-revoked", "Project is inactive");
    const account = await this.db
      .select()
      .from(serviceAccounts)
      .where(eq(serviceAccounts.principal_id, row.principal_id))
      .get();
    if (!service || !account || account.revoked_at !== null)
      this.deny("enrollment-revoked", "Installation membership is inactive");
    let policy = effectiveCredentialPolicy(
      CredentialPolicyReadSchema.parse(JSON.parse(row.policy_json)),
      service.role,
    );
    if (row.sponsor_id) {
      let mirrored: MirroredMembershipCandidate | null = null;
      if (row.sponsor_context_json) {
        const original = JSON.parse(
          row.sponsor_context_json,
        ) as MirroredMembershipCandidate;
        const current = await new RepoAllowlistStore(
          this.binding,
        ).getAccessPolicy(row.project_id, "github.com", original.githubRepoId);
        const revoked = await this.db
          .select()
          .from(revokedSubjects)
          .where(
            and(
              eq(revokedSubjects.project_id, row.project_id),
              eq(revokedSubjects.identity_host, "github.com"),
              eq(
                revokedSubjects.subject_id,
                row.sponsor_id.replace("github:github.com:", ""),
              ),
            ),
          )
          .get();
        if (revoked && revoked.revoked_before >= row.created_at * 1000)
          this.deny(
            "enrollment-revoked",
            "Personal sponsor authority was revoked",
          );
        if (
          current.status === "ok" &&
          current.policy.membership_enabled &&
          current.repo.enabled
        ) {
          const roles = [
            original.role,
            current.policy.membership_role_cap,
            permissionToRole(current.policy.max_permission),
          ];
          roles.sort((a, b) => PROJECT_ROLE_RANK[a] - PROJECT_ROLE_RANK[b]);
          mirrored = { githubRepoId: original.githubRepoId, role: roles[0] };
        }
      }
      const sponsor = await memberships.resolve(
        row.project_id,
        row.sponsor_id,
        mirrored,
      );
      if (!sponsor)
        this.deny(
          "enrollment-revoked",
          "Enrolling member no longer has access",
        );
      policy = effectiveCredentialPolicy(policy, sponsor.role);
    }
    return policy;
  }
  async runPolicy(row: RunRow) {
    if (row.state !== "active")
      this.deny("run-closed", "Run is closed or revoked");
    if (row.lease_expires_at <= this.clock())
      this.deny("run-expired", "Run lease expired; start a new run");
    let policy = CredentialPolicyReadSchema.parse(JSON.parse(row.policy_json));
    if (row.enrollment_id) {
      const enrollment = await this.enrollment(row.enrollment_id);
      if (
        !enrollment ||
        enrollment.project_id !== row.project_id ||
        enrollment.principal_id !== row.principal_id
      )
        this.deny("runtime-binding-mismatch", "Invalid run enrollment");
      policy = intersectCredentialPolicies(
        policy,
        await this.enrollmentPolicy(enrollment),
      );
    } else {
      const binding = await this.db
        .select()
        .from(workloadBindings)
        .where(eq(workloadBindings.binding_id, row.workload_binding_id ?? ""))
        .get();
      const member = await new ProjectMembershipStore(this.binding).resolve(
        row.project_id,
        row.principal_id,
      );
      const service = await this.db
        .select()
        .from(serviceAccounts)
        .where(eq(serviceAccounts.principal_id, row.principal_id))
        .get();
      if (
        !binding ||
        binding.revoked_at !== null ||
        binding.project_id !== row.project_id ||
        binding.principal_id !== row.principal_id ||
        !member ||
        !service ||
        service.revoked_at !== null
      )
        this.deny("enrollment-revoked", "Workload authorization is inactive");
      policy = intersectCredentialPolicies(
        policy,
        effectiveCredentialPolicy(
          CredentialPolicyReadSchema.parse(JSON.parse(binding.policy_json)),
          member.role,
        ),
      );
      if (binding.provider === "github-actions") {
        const context = GitHubActionsContextSchema.parse(
          JSON.parse(row.workload_context_json ?? "null"),
        );
        const current = await resolveActionsPolicy(
          this.binding,
          row.project_id,
          context,
        );
        if (!current)
          this.deny(
            "enrollment-revoked",
            "Repository no longer permits this workload",
          );
        policy = effectiveCredentialPolicy(policy, current.role);
      }
    }
    return policy;
  }
  async consumeAssertion(
    hash: string,
    bindingId: string,
    runId: string,
    expiresAt: number,
  ) {
    const inserted = await this.db
      .insert(runtimeAssertions)
      .values({
        assertion_hash: hash,
        binding_id: bindingId,
        run_id: runId,
        expires_at: expiresAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length)
      throw new RuntimeDenied(
        "workload-already-exchanged",
        "Obtain a fresh upstream assertion to exchange again",
        409,
      );
  }
  async consumeProof(hash: string) {
    const inserted = await this.db
      .insert(runtimeProofs)
      .values({
        proof_hash: hash,
        expires_at: this.clock() + 120,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length)
      throw new RuntimeDenied(
        "runtime-proof-replayed",
        "Use a fresh proof for each request",
        401,
      );
  }
  async pruneReplayState() {
    await this.db.batch([
      this.db
        .delete(runtimeProofs)
        .where(lte(runtimeProofs.expires_at, this.clock())),
      this.db
        .delete(runtimeAssertions)
        .where(lte(runtimeAssertions.expires_at, this.clock())),
    ]);
  }
  async recordDenial(
    project: string,
    principal: string,
    target: string,
    reason: string,
  ) {
    await this.event(project, principal, target, `runtime-denied:${reason}`);
  }
  async invite(
    project: string,
    actor: string,
    name: string,
    policy: CredentialPolicy,
    hash: string,
  ) {
    const expires_at = this.clock() + INVITATION_TTL_SECONDS;
    await this.db.batch([
      this.db.insert(runtimeInvitations).values({
        invitation_hash: hash,
        project_id: project,
        name,
        policy_json: JSON.stringify(policy),
        created_by: actor,
        expires_at,
      }),
      this.event(project, actor, hash, "runtime-invitation-created"),
    ]);
    return expires_at;
  }
  async invitation(hash: string) {
    return this.db
      .select()
      .from(runtimeInvitations)
      .where(eq(runtimeInvitations.invitation_hash, hash))
      .get();
  }
  async enroll(
    project: string,
    input: RuntimeEnrollmentRequest,
    sponsor: string | null,
    ceiling: CredentialPolicy,
    secret: RuntimeSecret,
    invitationHash?: string,
    sponsorContext?: MirroredMembershipCandidate | null,
  ) {
    const existing = await this.enrollment(input.operation_id);
    const policy =
      input.policy ??
      intersectCredentialPolicies(CREDENTIAL_PRESETS.worker, ceiling);
    if (
      !policyContains(ceiling, policy) ||
      !policyContains(RUNTIME_RUN_CEILING, policy)
    ) {
      await this.recordDenial(
        project,
        sponsor ?? "invitation",
        project,
        "enrollment-escalation",
      );
      this.deny(
        "runtime-policy-denied",
        "Enrollment exceeds the runtime or caller ceiling",
      );
    }
    if (existing) {
      if (
        existing.project_id !== project ||
        existing.installation_id !== input.installation_id ||
        existing.jkt !== input.jkt ||
        existing.sponsor_id !== sponsor ||
        existing.invitation_hash !== (invitationHash ?? null)
      )
        this.deny(
          "runtime-binding-mismatch",
          "Enrollment operation is already bound to another identity",
        );
      await this.enrollmentPolicy(existing);
      // A proven holder can recover an interrupted enrollment. Retire previous
      // authenticators atomically; the service identity never changes.
      await this.db.batch([
        this.db
          .update(runtimeCredentials)
          .set({ retire_at: this.clock() })
          .where(
            and(
              eq(runtimeCredentials.enrollment_id, existing.enrollment_id),
              eq(runtimeCredentials.purpose, "enrollment"),
            ),
          ),
        this.token(project, existing.principal_id, existing.jkt, secret),
        this.db.insert(runtimeCredentials).values({
          token_id: secret.id,
          purpose: "enrollment",
          enrollment_id: existing.enrollment_id,
        }),
        this.event(
          project,
          sponsor ?? existing.principal_id,
          existing.enrollment_id,
          "runtime-enrollment-recovered",
        ),
      ]);
    } else {
      if (invitationHash) {
        const invite = await this.invitation(invitationHash);
        if (
          !invite ||
          invite.project_id !== project ||
          invite.expires_at <= this.clock() ||
          !policyContains(
            CredentialPolicyReadSchema.parse(JSON.parse(invite.policy_json)),
            policy,
          )
        )
          this.deny("invitation-invalid", "Invitation is expired or invalid");
      }
      const principal = `service:${input.operation_id}`;
      await this.db.batch([
        this.db.insert(serviceAccounts).values({
          principal_id: principal,
          project_id: project,
          name: `machine-${input.operation_id}`,
          display_name: input.name,
          created_at: this.clock(),
          created_by: sponsor ?? "invitation",
        }),
        this.db.insert(projectMemberships).values({
          membership_id: crypto.randomUUID(),
          project_id: project,
          principal_id: principal,
          provider: "service",
          identity_host: "tila",
          subject_id: input.operation_id,
          subject_kind: "service",
          role: policy.role,
          display_name: input.name,
          granted_by: sponsor ?? "invitation",
          granted_at: this.clock() * 1000,
        }),
        this.db.insert(runtimeEnrollments).values({
          enrollment_id: input.operation_id,
          project_id: project,
          installation_id: input.installation_id,
          name: input.name,
          kind: sponsor ? "personal" : "shared",
          principal_id: principal,
          sponsor_id: sponsor,
          sponsor_context_json: sponsorContext
            ? JSON.stringify(sponsorContext)
            : null,
          invitation_hash: invitationHash,
          jkt: input.jkt,
          policy_json: JSON.stringify(policy),
          created_at: this.clock(),
        }),
        this.token(project, principal, input.jkt, secret),
        this.db.insert(runtimeCredentials).values({
          token_id: secret.id,
          purpose: "enrollment",
          enrollment_id: input.operation_id,
        }),
        this.event(
          project,
          sponsor ?? "invitation",
          input.operation_id,
          "runtime-enrollment-created",
        ),
      ]);
    }
    return this.context(secret.id);
  }
  async start(
    enrollmentId: string,
    input: RuntimeRunRequest,
    secret: RuntimeSecret,
  ) {
    const parent = await this.enrollment(enrollmentId);
    if (!parent) this.deny("enrollment-revoked", "Unknown enrollment");
    const ceiling = await this.enrollmentPolicy(parent);
    return this.startWithPolicy(
      parent.project_id,
      parent.principal_id,
      input,
      ceiling,
      secret,
      { enrollment_id: enrollmentId },
    );
  }
  async startWithPolicy(
    project: string,
    principal: string,
    input: RuntimeRunRequest,
    ceiling: CredentialPolicy,
    secret: RuntimeSecret,
    origin: {
      enrollment_id?: string;
      workload_binding_id?: string;
      workload_context_json?: string;
    },
    expiresAt = this.clock() + RUN_TOKEN_TTL_SECONDS,
  ) {
    const agent = input.agent_id ?? null;
    const role = input.run_role ?? "acting";
    if (role === "relay" && !agent)
      this.deny(
        "runtime-binding-mismatch",
        "A relay run must be pinned to an agent",
      );
    if (agent) {
      if (!this.authorizeAgent)
        this.deny(
          "runtime-policy-denied",
          "Agent authorization is required before issuing a run",
        );
      await this.authorizeAgent(project, principal, agent);
    }
    const policy =
      input.policy ??
      intersectCredentialPolicies(ceiling, CREDENTIAL_PRESETS.worker);
    if (
      !policyContains(ceiling, policy) ||
      !policyContains(RUNTIME_RUN_CEILING, policy) ||
      (role === "relay" &&
        policy.capabilities.some((cap) => cap !== "agent-bindings:attach"))
    ) {
      await this.recordDenial(
        project,
        principal,
        origin.enrollment_id ?? origin.workload_binding_id ?? project,
        "run-escalation",
      );
      this.deny("runtime-policy-denied", "Run exceeds its permission ceiling");
    }
    const existing = await this.run(input.operation_id);
    if (existing) {
      if (
        existing.project_id !== project ||
        existing.principal_id !== principal ||
        existing.jkt !== input.jkt ||
        existing.agent_id !== agent ||
        existing.run_role !== role ||
        existing.enrollment_id !== (origin.enrollment_id ?? null) ||
        existing.workload_binding_id !== (origin.workload_binding_id ?? null) ||
        existing.workload_context_json !==
          (origin.workload_context_json ?? null)
      )
        this.deny(
          "runtime-binding-mismatch",
          "Run operation is bound to another identity",
        );
      return this.renew(
        existing.run_id,
        existing.current_token_id,
        secret,
        expiresAt,
      );
    }
    const expiry = Math.min(expiresAt, this.clock() + RUN_TOKEN_TTL_SECONDS);
    await this.db.batch([
      this.db.insert(runtimeRuns).values({
        agent_id: agent,
        run_role: role,
        run_id: input.operation_id,
        project_id: project,
        ...origin,
        principal_id: principal,
        participant_id: crypto.randomUUID(),
        jkt: input.jkt,
        policy_json: JSON.stringify(policy),
        created_at: this.clock(),
        lease_expires_at: Math.min(expiry, this.clock() + RUN_LEASE_SECONDS),
        current_token_id: secret.id,
      }),
      this.token(project, principal, input.jkt, secret),
      this.db.insert(runtimeCredentials).values({
        token_id: secret.id,
        purpose: "run",
        run_id: input.operation_id,
        enrollment_id: origin.enrollment_id,
        expires_at: expiry,
      }),
      this.event(project, principal, input.operation_id, "runtime-run-created"),
    ]);
    return this.context(secret.id);
  }
  async renew(
    id: string,
    expected: string,
    secret: RuntimeSecret,
    expiresAt = this.clock() + RUN_TOKEN_TTL_SECONDS,
  ) {
    const run = await this.run(id);
    if (!run) this.deny("run-closed", "Unknown run");
    await this.runPolicy(run);
    if (run.current_token_id !== expected)
      throw new RuntimeDenied(
        "runtime-renewal-conflict",
        "Inspect the run and retry with its current token ID",
        409,
      );
    const expiry = Math.min(expiresAt, this.clock() + RUN_TOKEN_TTL_SECONDS);
    // A unique predecessor makes simultaneous renewal attempts transactional:
    // only one batch can publish a successor for this version.
    try {
      await this.db.batch([
        this.db.insert(runtimeCredentials).values({
          token_id: secret.id,
          purpose: "run",
          run_id: id,
          enrollment_id: run.enrollment_id,
          expires_at: expiry,
          predecessor_id: expected,
        }),
        this.token(run.project_id, run.principal_id, run.jkt, secret),
        this.db
          .update(runtimeCredentials)
          .set({ retire_at: this.clock() + RUN_OVERLAP_SECONDS })
          .where(eq(runtimeCredentials.token_id, expected)),
        this.db
          .update(runtimeRuns)
          .set({
            current_token_id: secret.id,
            lease_expires_at: Math.min(
              expiry,
              this.clock() + RUN_LEASE_SECONDS,
            ),
          })
          .where(
            and(
              eq(runtimeRuns.run_id, id),
              eq(runtimeRuns.current_token_id, expected),
              eq(runtimeRuns.state, "active"),
              gt(runtimeRuns.lease_expires_at, this.clock()),
            ),
          ),
        this.event(run.project_id, run.principal_id, id, "runtime-run-renewed"),
      ]);
    } catch (error) {
      // D1/Drizzle may wrap constraint failures. Re-read authoritative state
      // instead of depending on driver-specific error strings.
      const current = await this.run(id);
      if (current && current.current_token_id !== expected)
        throw new RuntimeDenied(
          "runtime-renewal-conflict",
          "Inspect the run and retry with its current token ID",
          409,
        );
      throw error;
    }
    return this.context(secret.id);
  }
  async heartbeat(id: string) {
    const run = await this.run(id);
    if (!run) this.deny("run-closed", "Unknown run");
    await this.runPolicy(run);
    const credential = await this.db
      .select()
      .from(runtimeCredentials)
      .where(eq(runtimeCredentials.token_id, run.current_token_id))
      .get();
    const deadline = Math.min(
      this.clock() + RUN_LEASE_SECONDS,
      credential?.expires_at ?? 0,
    );
    if (deadline <= this.clock())
      this.deny("run-expired", "Run credential expired");
    await this.db
      .update(runtimeRuns)
      .set({ lease_expires_at: deadline })
      .where(
        and(
          eq(runtimeRuns.run_id, id),
          eq(runtimeRuns.state, "active"),
          gt(runtimeRuns.lease_expires_at, this.clock()),
        ),
      );
    return deadline;
  }
  async finish(id: string, actor: string, state: "closed" | "revoked") {
    const run = await this.run(id);
    if (!run) this.deny("run-closed", "Unknown run");
    await this.db.batch([
      this.db
        .update(runtimeRuns)
        .set({ state })
        .where(eq(runtimeRuns.run_id, id)),
      this.event(run.project_id, actor, id, `runtime-run-${state}`),
    ]);
  }
  async revokeEnrollment(id: string, actor: string) {
    const row = await this.enrollment(id);
    if (!row) this.deny("enrollment-revoked", "Unknown enrollment");
    await this.db.batch([
      this.db
        .update(runtimeEnrollments)
        .set({ revoked_at: this.clock() })
        .where(eq(runtimeEnrollments.enrollment_id, id)),
      this.event(row.project_id, actor, id, "runtime-enrollment-revoked"),
    ]);
  }
  async revokeProject(project: string, actor: string) {
    await this.db.batch([
      this.db
        .delete(runtimeInvitations)
        .where(eq(runtimeInvitations.project_id, project)),
      this.db
        .update(runtimeEnrollments)
        .set({ revoked_at: this.clock() })
        .where(eq(runtimeEnrollments.project_id, project)),
      this.db
        .update(runtimeRuns)
        .set({ state: "revoked" })
        .where(eq(runtimeRuns.project_id, project)),
      this.event(project, actor, project, "runtime-project-revoked"),
    ]);
  }
  async listEnrollments(project: string, sponsor?: string) {
    const rows = await this.db
      .select()
      .from(runtimeEnrollments)
      .where(
        and(
          eq(runtimeEnrollments.project_id, project),
          sponsor ? eq(runtimeEnrollments.sponsor_id, sponsor) : undefined,
        ),
      );
    return rows.map(
      ({
        jkt: _jkt,
        invitation_hash: _invite,
        sponsor_context_json: _sponsor,
        policy_json,
        ...row
      }) => ({
        ...row,
        policy: CredentialPolicyReadSchema.parse(JSON.parse(policy_json)),
      }),
    );
  }
  async listRuns(project: string, enrollmentIds?: string[]) {
    const rows = await this.db
      .select()
      .from(runtimeRuns)
      .where(eq(runtimeRuns.project_id, project));
    return rows
      .filter(
        (row) =>
          enrollmentIds === undefined ||
          (row.enrollment_id && enrollmentIds.includes(row.enrollment_id)),
      )
      .map(
        ({
          jkt: _jkt,
          workload_context_json: _context,
          policy_json,
          ...row
        }) => ({
          ...row,
          state:
            row.state === "active" && row.lease_expires_at <= this.clock()
              ? "expired"
              : row.state,
          policy: CredentialPolicyReadSchema.parse(JSON.parse(policy_json)),
        }),
      );
  }
  async context(tokenId: string) {
    const version = await this.db
      .select()
      .from(runtimeCredentials)
      .where(eq(runtimeCredentials.token_id, tokenId))
      .get();
    const token = await this.db
      .select()
      .from(tokens)
      .where(eq(tokens.token_id, tokenId))
      .get();
    if (
      !version ||
      !token ||
      token.revoked_at !== null ||
      (version.expires_at !== null && version.expires_at <= this.clock()) ||
      (version.retire_at !== null && version.retire_at <= this.clock())
    )
      this.deny("run-expired", "Runtime credential is expired or revoked");
    let policy: CredentialPolicy;
    let run: RunRow | undefined;
    let principal: string;
    if (version.purpose === "run") {
      run = await this.run(version.run_id ?? "");
      if (!run) this.deny("run-closed", "Unknown run");
      if (
        token.project_id !== run.project_id ||
        token.cnf_jkt !== run.jkt ||
        version.enrollment_id !== run.enrollment_id ||
        (run.current_token_id !== tokenId && version.retire_at === null)
      )
        this.deny(
          "runtime-binding-mismatch",
          "Credential is not an active run version",
        );
      policy = await this.runPolicy(run);
      principal = run.principal_id;
    } else {
      const parent = await this.enrollment(version.enrollment_id ?? "");
      if (!parent) this.deny("enrollment-revoked", "Unknown enrollment");
      if (
        token.project_id !== parent.project_id ||
        token.cnf_jkt !== parent.jkt
      )
        this.deny(
          "runtime-binding-mismatch",
          "Credential does not match its installation",
        );
      policy = await this.enrollmentPolicy(parent);
      principal = parent.principal_id;
    }
    return RuntimeContextSchema.parse({
      ok: true,
      protocol: RUNTIME_PROTOCOL,
      instance_id: await new D1DeploymentMetaStore(this.binding).ensure(),
      project_id: token.project_id,
      purpose: version.purpose,
      principal_id: principal,
      enrollment_id: version.enrollment_id,
      workload_binding_id: run?.workload_binding_id ?? null,
      run_id: run?.run_id ?? null,
      agent_id: run?.agent_id ?? null,
      run_role: run?.run_role ?? "acting",
      participant_id: run?.participant_id ?? null,
      policy,
      token_id: tokenId,
      expires_at: version.expires_at,
      lease_expires_at: run?.lease_expires_at ?? null,
    });
  }
}
