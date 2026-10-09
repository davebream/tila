import {
  type AgentRegistration,
  AgentSchema,
  type AttachAgentBinding,
  type ConsumerBinding,
  ConsumerBindingSchema,
  type RuntimeIdentity,
} from "@tila/schemas";
import { and, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { canonicalJson } from "./project-transfer-ops";
import * as schema from "./schema";

type DB = BaseSQLiteDatabase<"sync", unknown, typeof schema>;
type BindingRow = typeof schema.agentBindings.$inferSelect;
export interface AgentAuthority {
  principal_id: string;
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
  if (!authority.can_manage)
    fail("permission-denied", "Managing agents requires agents:manage");
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, input.id))
      .get();
    if (existing) {
      if (
        existing.owner_principal_id !== authority.principal_id ||
        existing.name !== input.name ||
        canonicalJson(existing.bind_policy) !==
          canonicalJson(input.bind_policy) ||
        existing.archived
      )
        fail("conflict", "Agent ID is already registered", 409);
      return AgentSchema.parse(existing);
    }
    tx.insert(schema.agents)
      .values({
        ...input,
        owner_principal_id: authority.principal_id,
        created_at: now,
        updated_at: now,
      })
      .run();
    return agent(tx, input.id);
  });
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
export function view(db: DB, id: string, authority: AgentAuthority) {
  const value = agent(db, id);
  const active = current(db, id);
  const full =
    authority.can_manage ||
    value.owner_principal_id === authority.principal_id ||
    (active !== null && active.holder.run_id === authority.runtime?.run_id);
  return {
    agent: full ? value : { ...value, bind_policy: [] },
    binding:
      !active || full
        ? active
        : {
            consumer_binding_id: active.consumer_binding_id,
            agent_id: active.agent_id,
            binding_epoch: active.binding_epoch,
            state: active.state,
            mechanism: active.mechanism,
            lease_expires_at: active.lease_expires_at,
          },
  };
}
export function list(db: DB, authority: AgentAuthority) {
  return db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.archived, false))
    .orderBy(schema.agents.id)
    .all()
    .map(({ id }) => view(db, id, authority));
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
    return binding(row);
  });
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
    const holder =
      authority.runtime?.run_role === "acting" &&
      authority.runtime.run_id === active.holder.run_id &&
      authority.runtime.lease_expires_at * 1000 > now;
    if (
      !holder &&
      !authority.can_manage &&
      authority.principal_id !== value.owner_principal_id
    )
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
    if (state)
      tx.update(schema.projectTransferState)
        .set({ applying: state.applying })
        .where(eq(schema.projectTransferState.singleton, 1))
        .run();
  });
}
