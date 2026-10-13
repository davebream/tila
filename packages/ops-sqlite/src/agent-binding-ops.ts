import { bindingDetailVisible, summarizeBinding } from "@tila/core";
import {
  type Agent,
  type AgentArchivePreview,
  type AgentArchiveResult,
  type AgentRegistration,
  type AgentRuntimePage,
  AgentSchema,
  type ArchiveAgent,
  type AttachAgentBinding,
  type ConsumerBinding,
  ConsumerBindingSchema,
  RUNTIME_WORK_ATTEMPT_LIMIT,
  type RuntimeIdentity,
  type UpdateAgent,
} from "@tila/schemas";
import { and, asc, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  checkRevision,
  nextRevision,
  refreshRestoredRevisions,
} from "./config-revision-ops";
import {
  clearLease,
  invalidateRestoredConversations,
  rearm,
} from "./conversation-state-ops";
import { type DoIdempotency, withDoIdempotency } from "./do-idempotency-ops";
import { appendJournal } from "./journal-ops";
import { canonicalJson } from "./project-transfer-ops";
import { invalidateAgentQuestions } from "./question-state-ops";
import * as schema from "./schema";

type DB = BaseSQLiteDatabase<"sync", unknown, typeof schema>;
type BindingRow = typeof schema.agentBindings.$inferSelect;
export interface AgentAuthority {
  principal_id: string;
  /** Journal attribution for management writes; defaults to the principal. */
  participant_id?: string;
  can_manage: boolean;
  runtime: RuntimeIdentity | null;
  acting_runtime?: RuntimeIdentity | null;
  terminal_run_id?: string | null;
}
export class AgentBindingError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 403 | 404 | 409 = 403,
  ) {
    super(message);
  }
}
function fail(
  code: string,
  message: string,
  status: 400 | 403 | 404 | 409 = 403,
): never {
  throw new AgentBindingError(code, message, status);
}
function agent(db: DB, id: string) {
  const row = db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, id))
    .get();
  if (!row || row.archived)
    fail("permission-denied", "Agent is not accessible");
  return AgentSchema.parse(row);
}
/** Management reads see archived agents; only managers reach this. */
function managed(db: DB, id: string) {
  const row = db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, id))
    .get();
  if (!row) fail("not-found", "Agent not found", 404);
  return AgentSchema.parse(row);
}
function requireManage(authority: AgentAuthority) {
  if (!authority.can_manage)
    fail("permission-denied", "Managing agents requires agents:manage");
}
function journal(
  tx: Parameters<Parameters<DB["transaction"]>[0]>[0],
  kind:
    | "agent.registered"
    | "agent.updated"
    | "agent.archived"
    | "agent.unarchived",
  id: string,
  authority: AgentAuthority,
  data: Record<string, unknown>,
) {
  appendJournal(tx, {
    kind,
    resource: `agent:${id}`,
    actor: "",
    principalId: authority.principal_id,
    participantId: authority.participant_id ?? authority.principal_id,
    environment: {},
    data,
  });
}
function binding(row: BindingRow): ConsumerBinding {
  return ConsumerBindingSchema.parse({
    ...JSON.parse(row.attachment_json),
    ...row,
    host_ref: row.enrollment_id,
    holder: {
      kind: "run",
      run_id: row.run_id,
      enrollment_id: row.enrollment_id,
      workload_binding_id: row.workload_binding_id,
    },
  });
}
export function authorizeRun(db: DB, id: string, principal: string): void {
  const value = agent(db, id);
  if (
    value.owner_principal_id !== principal &&
    !value.bind_policy.some(
      (grant) => grant.principal_id === principal && grant.agent_id === id,
    )
  )
    fail("permission-denied", "Principal is not permitted to bind this agent");
}
export function register(
  db: DB,
  input: AgentRegistration,
  authority: AgentAuthority,
  now = Date.now(),
) {
  requireManage(authority);
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, input.id))
      .get();
    if (existing) {
      if (existing.archived)
        fail(
          "agent-archived",
          "Agent ID belongs to an archived agent; unarchive it instead",
          409,
        );
      if (
        existing.owner_principal_id !== authority.principal_id ||
        existing.name !== input.name ||
        canonicalJson(existing.bind_policy) !== canonicalJson(input.bind_policy)
      )
        fail(
          "conflict",
          "Agent ID is already registered with different settings; use agent update to change them",
          409,
        );
      return AgentSchema.parse(existing);
    }
    const revision = nextRevision(tx);
    tx.insert(schema.agents)
      .values({
        ...input,
        owner_principal_id: authority.principal_id,
        revision,
        created_at: now,
        updated_at: now,
      })
      .run();
    journal(tx, "agent.registered", input.id, authority, { revision });
    return agent(tx, input.id);
  });
}
/**
 * Revision-checked change of the configured identity/policy. Never touches the
 * active binding: narrowing `bind_policy` takes effect at the holder's next
 * mailbox operation, a profile selection at the next new attach.
 */
export function update(
  db: DB,
  id: string,
  input: UpdateAgent,
  authority: AgentAuthority,
  idempotency?: DoIdempotency<Agent>,
  now = Date.now(),
): Agent {
  requireManage(authority);
  if (input.bind_policy?.some((grant) => grant.agent_id !== id))
    fail("validation-error", "Binding grants must name this agent", 400);
  return db.transaction(
    (tx) =>
      withDoIdempotency(tx, idempotency, () => {
        const row = managed(tx, id);
        checkRevision(`agent:${id}`, row.revision, input.expected_revision);
        if (row.archived)
          fail("agent-archived", "Unarchive the agent before editing it", 409);
        const changed: Partial<
          Pick<Agent, "name" | "bind_policy" | "profile_selection">
        > = {};
        if (input.name !== undefined && input.name !== row.name)
          changed.name = input.name;
        if (
          input.bind_policy !== undefined &&
          canonicalJson(input.bind_policy) !== canonicalJson(row.bind_policy)
        )
          changed.bind_policy = input.bind_policy;
        if (
          input.profile_selection !== undefined &&
          canonicalJson(input.profile_selection) !==
            canonicalJson(row.profile_selection)
        )
          changed.profile_selection = input.profile_selection;
        const fields = Object.keys(changed);
        if (!fields.length) return row;
        const revision = nextRevision(tx);
        tx.update(schema.agents)
          .set({ ...changed, revision, updated_at: now })
          .where(eq(schema.agents.id, id))
          .run();
        journal(tx, "agent.updated", id, authority, {
          revision,
          changed: fields,
        });
        return managed(tx, id);
      }).result,
  );
}
function pendingDeliveries(db: DB, id: string, now: number) {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.messageRecipients)
      .where(
        and(
          eq(schema.messageRecipients.agent_id, id),
          eq(schema.messageRecipients.state, "pending"),
          gt(schema.messageRecipients.expires_at, now),
        ),
      )
      .get()?.n ?? 0
  );
}
/** Effects of archiving now, for the confirmation a manager reviews. */
export function archivePreview(
  db: DB,
  id: string,
  authority: AgentAuthority,
  now = Date.now(),
): AgentArchivePreview {
  requireManage(authority);
  const row = managed(db, id);
  const active = current(db, id);
  return {
    agent_id: id,
    revision: row.revision,
    archived: row.archived,
    binding: active ? summarizeBinding(active) : null,
    pending_deliveries: pendingDeliveries(db, id, now),
    rooms: db
      .select({ room: schema.roomMembers.room_id })
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.member, `agent:${id}`))
      .orderBy(schema.roomMembers.room_id)
      .all()
      .map(({ room }) => room),
    open_questions: db
      .select({ snapshot: schema.workQuestions.snapshot })
      .from(schema.workQuestions)
      .where(eq(schema.workQuestions.state, "open"))
      .all()
      .filter(
        ({ snapshot }) =>
          snapshot.requester_binding?.agent_id === id &&
          !snapshot.invalidation_reason,
      ).length,
    unfinished_attempts: active ? (workFor(db, active)?.total ?? 0) : 0,
  };
}
/**
 * Archive in one transaction: release the active binding (the reviewed
 * occupant, `expected_epoch`) and advance the epoch so the running session
 * loses agent authority immediately; supersede its open questions and stop
 * dispatch. Pending deliveries remain as evidence until their TTL; attempts
 * keep their own lifecycle and need an explicit cancel or reassignment.
 */
export function archive(
  db: DB,
  id: string,
  input: ArchiveAgent,
  authority: AgentAuthority,
  idempotency?: DoIdempotency<AgentArchiveResult>,
  now = Date.now(),
): AgentArchiveResult {
  requireManage(authority);
  return db.transaction(
    (tx) =>
      withDoIdempotency(tx, idempotency, () => {
        const row = managed(tx, id);
        checkRevision(`agent:${id}`, row.revision, input.expected_revision);
        if (row.archived)
          return {
            agent: row,
            released: null,
            pending_deliveries: pendingDeliveries(tx, id, now),
          };
        const active = current(tx, id);
        if (active && input.expected_epoch !== active.binding_epoch)
          fail(
            "stale-binding",
            "The active binding changed; review it before archiving",
            409,
          );
        if (active)
          tx.update(schema.agentBindings)
            .set({ state: "released", updated_at: now })
            .where(
              eq(
                schema.agentBindings.consumer_binding_id,
                active.consumer_binding_id,
              ),
            )
            .run();
        invalidateAgentQuestions(
          tx,
          id,
          {
            principalId: authority.principal_id,
            participantId: authority.participant_id ?? authority.principal_id,
            actor: authority.principal_id,
            environment: {},
          },
          now,
          "requesting agent archived",
        );
        tx.update(schema.dispatchOutbox)
          .set({ state: "quiet", ...clearLease, updated_at: now })
          .where(eq(schema.dispatchOutbox.agent_id, id))
          .run();
        const revision = nextRevision(tx);
        tx.update(schema.agents)
          .set({
            archived: true,
            revision,
            binding_epoch: row.binding_epoch + 1,
            updated_at: now,
          })
          .where(eq(schema.agents.id, id))
          .run();
        const released = active
          ? {
              consumer_binding_id: active.consumer_binding_id,
              binding_epoch: active.binding_epoch,
            }
          : null;
        journal(tx, "agent.archived", id, authority, {
          revision,
          released_binding_epoch: released?.binding_epoch ?? null,
        });
        return {
          agent: managed(tx, id),
          released,
          pending_deliveries: pendingDeliveries(tx, id, now),
        };
      }).result,
  );
}
/** Restores the identity only. No lease, binding or expired delivery revives. */
export function unarchive(
  db: DB,
  id: string,
  expectedRevision: number,
  authority: AgentAuthority,
  idempotency?: DoIdempotency<Agent>,
  now = Date.now(),
): Agent {
  requireManage(authority);
  return db.transaction(
    (tx) =>
      withDoIdempotency(tx, idempotency, () => {
        const row = managed(tx, id);
        checkRevision(`agent:${id}`, row.revision, expectedRevision);
        if (!row.archived) return row;
        const revision = nextRevision(tx);
        tx.update(schema.agents)
          .set({ archived: false, revision, updated_at: now })
          .where(eq(schema.agents.id, id))
          .run();
        journal(tx, "agent.unarchived", id, authority, { revision });
        return managed(tx, id);
      }).result,
  );
}
export function current(db: DB, id: string) {
  const row = db
    .select()
    .from(schema.agentBindings)
    .where(
      and(
        eq(schema.agentBindings.agent_id, id),
        eq(schema.agentBindings.state, "active"),
      ),
    )
    .get();
  return row ? binding(row) : null;
}
function viewer(authority: AgentAuthority) {
  return {
    principal_id: authority.principal_id,
    can_manage: authority.can_manage,
    run_id: authority.runtime?.run_id ?? null,
  };
}
export function view(
  db: DB,
  id: string,
  authority: AgentAuthority,
  options: { includeArchived?: boolean } = {},
) {
  const value =
    options.includeArchived && authority.can_manage
      ? managed(db, id)
      : agent(db, id);
  const active = current(db, id);
  const full = bindingDetailVisible(
    value.owner_principal_id,
    active,
    viewer(authority),
  );
  return {
    agent: full
      ? value
      : { ...value, bind_policy: [], profile_selection: null },
    binding: !active || full ? active : summarizeBinding(active),
  };
}
export function list(
  db: DB,
  authority: AgentAuthority,
  options: { includeArchived?: boolean } = {},
) {
  const archived = options.includeArchived && authority.can_manage;
  return db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(archived ? undefined : eq(schema.agents.archived, false))
    .orderBy(schema.agents.id)
    .all()
    .map(({ id }) => view(db, id, authority, { includeArchived: archived }));
}
function actingRun(
  id: string,
  input: AttachAgentBinding,
  authority: AgentAuthority,
  now: number,
) {
  const caller = authority.runtime;
  if (!caller) fail("runtime-required", "An authenticated run is required");
  if (
    caller.agent_id !== id ||
    caller.principal_id !== authority.principal_id ||
    caller.lease_expires_at * 1000 <= now
  )
    fail("stale-binding", "Run is not active for this agent", 409);
  const acting =
    caller.run_role === "relay" ? authority.acting_runtime : caller;
  if (
    !acting ||
    acting.run_role !== "acting" ||
    acting.agent_id !== id ||
    acting.lease_expires_at * 1000 <= now
  )
    fail("runtime-required", "An active acting run is required");
  if (
    caller.run_role === "relay" &&
    (!caller.enrollment_id ||
      caller.enrollment_id !== acting.enrollment_id ||
      input.acting_run_id !== acting.run_id)
  )
    fail(
      "permission-denied",
      "Relay may only attach an acting run from its own enrollment",
    );
  if (
    caller.run_role === "acting" &&
    input.acting_run_id &&
    input.acting_run_id !== caller.run_id
  )
    fail("permission-denied", "Acting runs cannot attach another run");
  return acting;
}
export function attach(
  db: DB,
  id: string,
  input: AttachAgentBinding,
  authority: AgentAuthority,
  now = Date.now(),
): ConsumerBinding {
  const runtime = actingRun(id, input, authority, now);
  const {
    expected_epoch: _expected,
    acting_run_id: _acting,
    ...details
  } = input;
  if (
    details.native_session_ref &&
    (details.native_session_ref.host_ref !== runtime.enrollment_id ||
      details.native_session_ref.harness !== details.harness ||
      details.native_session_ref.profile_id !== details.profile?.profile_id)
  )
    fail(
      "profile-mismatch",
      "Native session does not match the enrolled host, harness and profile",
    );
  const request = canonicalJson(details);
  return db.transaction((tx) => {
    const value = agent(tx, id);
    authorizeRun(tx, id, runtime.principal_id);
    const prior = tx
      .select()
      .from(schema.agentBindings)
      .where(
        and(
          eq(schema.agentBindings.agent_id, id),
          eq(schema.agentBindings.run_id, runtime.run_id),
        ),
      )
      .get();
    if (prior) {
      if (
        prior.state !== "active" ||
        prior.binding_epoch !== value.binding_epoch
      )
        fail(
          "stale-binding",
          "This run's binding was replaced or released",
          409,
        );
      if (prior.attachment_json !== request)
        fail(
          "profile-mismatch",
          "An attached run cannot change its session or profile",
        );
      tx.update(schema.agentBindings)
        .set({ lease_expires_at: runtime.lease_expires_at, updated_at: now })
        .where(
          eq(
            schema.agentBindings.consumer_binding_id,
            prior.consumer_binding_id,
          ),
        )
        .run();
      return binding({
        ...prior,
        lease_expires_at: runtime.lease_expires_at,
        updated_at: now,
      });
    }
    if (input.expected_epoch !== value.binding_epoch)
      fail("stale-binding", "Agent binding epoch changed", 409);
    // A configured selection governs new bindings only; the renewal above keeps
    // an attached run's recorded evidence unchanged.
    const selection = value.profile_selection;
    if (
      selection &&
      (details.profile?.profile_id !== selection.profile_id ||
        (selection.account_ref !== null &&
          details.profile?.account_ref !== selection.account_ref) ||
        (selection.host_ref !== null &&
          runtime.enrollment_id !== selection.host_ref))
    )
      fail(
        "profile-mismatch",
        "This attach does not match the agent's selected profile, account or host",
      );
    const previous = current(tx, id);
    if (
      previous &&
      !(
        authority.can_manage ||
        value.owner_principal_id === authority.principal_id ||
        (runtime.enrollment_id !== null &&
          runtime.enrollment_id === previous.holder.enrollment_id) ||
        authority.terminal_run_id === previous.holder.run_id
      )
    )
      fail(
        "permission-denied",
        "Replacing another host requires owner authority or a terminal run",
      );
    if (previous)
      tx.update(schema.agentBindings)
        .set({ state: "replaced", updated_at: now })
        .where(
          eq(
            schema.agentBindings.consumer_binding_id,
            previous.consumer_binding_id,
          ),
        )
        .run();
    invalidateAgentQuestions(
      tx,
      id,
      {
        principalId: authority.principal_id,
        participantId: runtime.participant_id,
        actor: authority.principal_id,
        environment: {},
      },
      now,
    );
    const epoch = value.binding_epoch + 1;
    tx.update(schema.agents)
      .set({ binding_epoch: epoch, updated_at: now })
      .where(eq(schema.agents.id, id))
      .run();
    const row: BindingRow = {
      consumer_binding_id: crypto.randomUUID(),
      agent_id: id,
      run_id: runtime.run_id,
      binding_epoch: epoch,
      enrollment_id: runtime.enrollment_id,
      workload_binding_id: runtime.workload_binding_id,
      principal_id: runtime.principal_id,
      participant_id: runtime.participant_id,
      state: "active",
      attachment_json: request,
      lease_expires_at: runtime.lease_expires_at,
      created_at: now,
      updated_at: now,
    };
    tx.insert(schema.agentBindings).values(row).run();
    rearm(tx, id, now, false);
    return binding(row);
  });
}
/** Holder (live acting run), agent manager or agent owner. */
export function releaseAuthorized(
  ownerPrincipalId: string,
  active: ConsumerBinding,
  authority: AgentAuthority,
  now: number,
) {
  const holder =
    authority.runtime?.run_role === "acting" &&
    authority.runtime.run_id === active.holder.run_id &&
    authority.runtime.lease_expires_at * 1000 > now;
  return (
    holder ||
    authority.can_manage ||
    authority.principal_id === ownerPrincipalId
  );
}
export function release(
  db: DB,
  id: string,
  epoch: number,
  authority: AgentAuthority,
  now = Date.now(),
) {
  return db.transaction((tx) => {
    const active = current(tx, id);
    if (!active) fail("no-active-binding", "No active binding exists", 409);
    if (active.binding_epoch !== epoch)
      fail("stale-binding", "Binding epoch changed", 409);
    const value = agent(tx, id);
    if (!releaseAuthorized(value.owner_principal_id, active, authority, now))
      fail(
        "permission-denied",
        "Only the holder or agent manager can release a binding",
      );
    tx.update(schema.agentBindings)
      .set({ state: "released", updated_at: now })
      .where(
        eq(
          schema.agentBindings.consumer_binding_id,
          active.consumer_binding_id,
        ),
      )
      .run();
  });
}
function latestEnded(db: DB, id: string) {
  const row = db
    .select()
    .from(schema.agentBindings)
    .where(
      and(
        eq(schema.agentBindings.agent_id, id),
        ne(schema.agentBindings.state, "active"),
      ),
    )
    .orderBy(
      desc(schema.agentBindings.updated_at),
      desc(schema.agentBindings.binding_epoch),
    )
    .limit(1)
    .get();
  return row ? binding(row) : null;
}
/** Unfinished attempts held by the binding's participant, newest first. */
function workFor(db: DB, value: ConsumerBinding) {
  const owner = and(
    eq(schema.workAttempts.principal_id, value.principal_id),
    eq(schema.workAttempts.participant_id, value.participant_id),
    ne(schema.workAttempts.state, "terminal"),
  );
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.workAttempts)
      .where(owner)
      .get()?.n ?? 0;
  if (total === 0) return null;
  return {
    total,
    attempts: db
      .select({
        id: schema.workAttempts.id,
        task_id: schema.workAttempts.task_id,
        state: schema.workAttempts.state,
        fence: schema.workAttempts.fence,
        lease_expires_at: schema.workAttempts.lease_expires_at,
      })
      .from(schema.workAttempts)
      .where(owner)
      .orderBy(
        desc(schema.workAttempts.updated_at),
        desc(schema.workAttempts.id),
      )
      .limit(RUNTIME_WORK_ATTEMPT_LIMIT)
      .all(),
  };
}
function presenceOf(db: DB, value: ConsumerBinding) {
  const row = db
    .select()
    .from(schema.presence)
    .where(
      and(
        eq(schema.presence.principal_id, value.principal_id),
        eq(schema.presence.participant_id, value.participant_id),
      ),
    )
    .get();
  return row
    ? {
        principal_id: row.principal_id,
        participant_id: row.participant_id,
        environment: JSON.parse(row.environment),
        last_seen: row.last_seen,
      }
    : null;
}
/**
 * One page of non-archived agents with the active binding and the latest
 * binding that no longer holds the mailbox. Bindings are unredacted; `detail`
 * tells the Worker what the caller may see.
 */
export function runtimePage(
  db: DB,
  authority: AgentAuthority,
  options: { after?: string; limit: number; agent?: string },
  now = Date.now(),
): AgentRuntimePage {
  const filters = [eq(schema.agents.archived, false)];
  if (options.agent) filters.push(eq(schema.agents.id, options.agent));
  else if (options.after) filters.push(gt(schema.agents.id, options.after));
  const agents = db
    .select()
    .from(schema.agents)
    .where(and(...filters))
    .orderBy(asc(schema.agents.id))
    .limit(options.limit + 1)
    .all();
  const page = agents.slice(0, options.limit);
  const who = viewer(authority);
  return {
    rows: page.map((row) => {
      const active = current(db, row.id);
      const ended = latestEnded(db, row.id);
      const occupant = (value: ConsumerBinding) => ({
        binding: value,
        detail: bindingDetailVisible(row.owner_principal_id, value, who)
          ? ("full" as const)
          : ("redacted" as const),
        presence: presenceOf(db, value),
      });
      return {
        agent: {
          id: row.id,
          name: row.name,
          binding_epoch: row.binding_epoch,
        },
        current: active
          ? {
              ...occupant(active),
              release_authorized: releaseAuthorized(
                row.owner_principal_id,
                active,
                authority,
                now,
              ),
            }
          : null,
        previous: ended ? occupant(ended) : null,
        work: active ? workFor(db, active) : null,
      };
    }),
    next_after:
      agents.length > options.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
export function expire(
  db: DB,
  selector: {
    run_id?: string;
    enrollment_id?: string;
    workload_binding_id?: string;
    principal_id?: string;
  },
  now = Date.now(),
) {
  const predicates = [eq(schema.agentBindings.state, "active")];
  if (selector.run_id)
    predicates.push(eq(schema.agentBindings.run_id, selector.run_id));
  else if (selector.enrollment_id)
    predicates.push(
      eq(schema.agentBindings.enrollment_id, selector.enrollment_id),
    );
  else if (selector.workload_binding_id)
    predicates.push(
      eq(
        schema.agentBindings.workload_binding_id,
        selector.workload_binding_id,
      ),
    );
  else if (selector.principal_id)
    predicates.push(
      eq(schema.agentBindings.principal_id, selector.principal_id),
    );
  else fail("validation-error", "A revocation target is required", 400);
  db.update(schema.agentBindings)
    .set({ state: "expired", updated_at: now })
    .where(and(...predicates))
    .run();
}

/** Keep the destination's high-water marks through an interrupted restore. */
export function preserveRestoreEpochs(db: DB) {
  const state = db.select().from(schema.projectTransferState).get();
  if (!state || state.applying) return;
  const epochs = Object.fromEntries(
    db
      .select({ id: schema.agents.id, epoch: schema.agents.binding_epoch })
      .from(schema.agents)
      .all()
      .map(({ id, epoch }) => [id, epoch]),
  );
  db.update(schema.projectTransferState)
    .set({ agent_epochs_json: JSON.stringify(epochs) })
    .where(eq(schema.projectTransferState.singleton, 1))
    .run();
}

/** Backup possession never grants a live mailbox binding. */
export function invalidateRestoredBindings(db: DB, now = Date.now()) {
  const state = db.select().from(schema.projectTransferState).get();
  const epochs = JSON.parse(state?.agent_epochs_json ?? "{}") as Record<
    string,
    number
  >;
  db.transaction((tx) => {
    if (state)
      tx.update(schema.projectTransferState)
        .set({ applying: 1 })
        .where(eq(schema.projectTransferState.singleton, 1))
        .run();
    for (const value of tx.select().from(schema.agents).all()) {
      tx.update(schema.agents)
        .set({
          binding_epoch:
            Math.max(
              value.binding_epoch,
              Object.hasOwn(epochs, value.id) ? epochs[value.id] : 0,
            ) + 1,
          updated_at: now,
        })
        .where(eq(schema.agents.id, value.id))
        .run();
    }
    tx.update(schema.agentBindings)
      .set({ state: "expired", updated_at: now })
      .run();
    invalidateRestoredConversations(tx, now);
    refreshRestoredRevisions(tx);
    if (state)
      tx.update(schema.projectTransferState)
        .set({ applying: state.applying })
        .where(eq(schema.projectTransferState.singleton, 1))
        .run();
  });
}
