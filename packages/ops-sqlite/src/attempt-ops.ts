import {
  type AttemptAuthorityCommand,
  AttemptAuthorityCommandSchema,
  type AttemptCorrection,
  type AttemptFinishCommand,
  AttemptFinishCommandSchema,
  type AttemptListQuery,
  AttemptListQuerySchema,
  type AttemptOutcome,
  type AttemptRevisionSnapshot,
  type AttemptRevisions,
  type AttemptStartedCommand,
  AttemptStartedCommandSchema,
  type AttemptView,
  type QueueEntry,
  type WorkAttempt,
} from "@tila/schemas";
import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { SchemaWriteError, resolveCurrentSchema } from "./constraint-ops";
import { acquireInTransaction } from "./coordination-ops";
import { updateInTransaction } from "./entity-ops";
import type { RequestOrigin } from "./journal-ops";
import { invalidateQuestions } from "./question-state-ops";
import {
  type ProjectDatabase,
  type ProjectTransaction,
  QueueError,
  checkRevision,
  command,
  event,
} from "./queue-internals";
import * as schema from "./schema";

export function get(db: ProjectDatabase, id: string): WorkAttempt {
  const row = db
    .select()
    .from(schema.workAttempts)
    .where(eq(schema.workAttempts.id, id))
    .get();
  if (!row)
    throw new QueueError("queue-not-found", `Attempt ${id} does not exist`);
  return row;
}
export function list(
  db: ProjectDatabase,
  raw: AttemptListQuery = {},
  allowsTask: (id: string) => boolean = () => true,
): WorkAttempt[] {
  const options = AttemptListQuerySchema.parse(raw);
  const a = schema.workAttempts;
  const where = and(
    options.state ? eq(a.state, options.state) : undefined,
    options.task_id ? eq(a.task_id, options.task_id) : undefined,
    options.entry_id ? eq(a.entry_id, options.entry_id) : undefined,
    options.principal_id ? eq(a.principal_id, options.principal_id) : undefined,
    options.participant_id
      ? eq(a.participant_id, options.participant_id)
      : undefined,
    options.active === undefined
      ? undefined
      : options.active
        ? ne(a.state, "terminal")
        : eq(a.state, "terminal"),
  );
  // Resource access is applied before pagination; scan bounded batches so a
  // mostly hidden history never loads every attempt at once.
  const wanted = options.offset + options.limit;
  const rows: WorkAttempt[] = [];
  for (let skip = 0; rows.length < wanted; skip += LIST_BATCH) {
    const batch = db
      .select()
      .from(a)
      .where(where)
      .orderBy(desc(a.fence), desc(a.created_at), desc(a.id))
      .limit(LIST_BATCH)
      .offset(skip)
      .all();
    rows.push(...batch.filter((attempt) => allowsTask(attempt.task_id)));
    if (batch.length < LIST_BATCH) break;
  }
  return rows.slice(options.offset, wanted);
}
const LIST_BATCH = 200;
/** Definition and policy revisions in force now. Audit evidence, never authority. */
export function governingRevisions(
  db: ProjectDatabase,
  now: number,
): AttemptRevisionSnapshot {
  const definition = db
    .select({
      version: sql<number | null>`max(${schema.schemaHistory.version})`,
    })
    .from(schema.schemaHistory)
    .get();
  const policy = db
    .select({ revision: schema.queuePolicy.revision })
    .from(schema.queuePolicy)
    .where(eq(schema.queuePolicy.singleton, 1))
    .get();
  return {
    definition_version: definition?.version ?? null,
    policy_revision: policy?.revision ?? 0,
    at: now,
  };
}
export function captureRevisions(
  attempt: WorkAttempt,
  key: keyof AttemptRevisions,
  snapshot: AttemptRevisionSnapshot,
): AttemptRevisions {
  return { ...(attempt.revisions ?? {}), [key]: snapshot };
}
export function revisionData(snapshot: AttemptRevisionSnapshot) {
  return {
    definition_version: snapshot.definition_version,
    policy_revision: snapshot.policy_revision,
  };
}
export function grantValid(
  db: ProjectDatabase,
  attempt: WorkAttempt,
  origin: RequestOrigin,
  now = Date.now(),
): boolean {
  if (
    !["reserved", "starting", "running"].includes(attempt.state) ||
    !attempt.lease_expires_at ||
    attempt.lease_expires_at <= now ||
    attempt.principal_id !== origin.principalId ||
    attempt.participant_id !== origin.participantId
  )
    return false;
  const claim = db
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.resource, attempt.resource))
    .get();
  const fence = db
    .select()
    .from(schema.fences)
    .where(eq(schema.fences.resource, attempt.resource))
    .get();
  return (
    !!claim &&
    claim.fence === attempt.fence &&
    fence?.current_fence === attempt.fence &&
    claim.principal_id === origin.principalId &&
    claim.participant_id === origin.participantId &&
    claim.expires_at > now
  );
}
export function view(
  db: ProjectDatabase,
  id: string,
  origin: RequestOrigin,
  now = Date.now(),
): AttemptView {
  const attempt = get(db, id);
  const entry = db
    .select({ assigner: schema.queueEntries.enrolled_by_principal })
    .from(schema.queueEntries)
    .where(eq(schema.queueEntries.id, attempt.entry_id))
    .get();
  const { at: _at, ...current } = governingRevisions(db, now);
  return {
    attempt,
    grant_valid: grantValid(db, attempt, origin, now),
    assigner_principal_id: entry?.assigner ?? null,
    current_revisions: current,
    corrections: corrections(db, attempt.id),
  };
}
/** Corrective work linked to an attempt, oldest first. */
export function corrections(
  db: ProjectDatabase,
  attemptId: string,
): AttemptCorrection[] {
  return db
    .select()
    .from(schema.attemptCorrections)
    .where(eq(schema.attemptCorrections.attempt_id, attemptId))
    .orderBy(
      asc(schema.attemptCorrections.created_at),
      asc(schema.attemptCorrections.id),
    )
    .all();
}
export function assertOwner(
  attempt: WorkAttempt,
  origin: RequestOrigin,
  fence?: number,
): void {
  if (
    attempt.principal_id !== origin.principalId ||
    attempt.participant_id !== origin.participantId ||
    (fence !== undefined && fence !== attempt.fence)
  )
    throw new QueueError(
      "queue-authority-lost",
      "Attempt belongs to another execution authority",
    );
}
export function assertAuthority(
  db: ProjectDatabase,
  attempt: WorkAttempt,
  input: AttemptAuthorityCommand,
  origin: RequestOrigin,
  now: number,
): void {
  assertOwner(attempt, origin, input.fence);
  if (!grantValid(db, attempt, origin, now))
    throw new QueueError(
      "queue-authority-lost",
      "Execution authority expired or was revoked; reconcile before external actions",
    );
  checkRevision(attempt.revision, input.expected_revision);
}
export function revoke(tx: ProjectTransaction, attempt: WorkAttempt): void {
  // Never remove a different grant. Bump the fence so downstream fence-only
  // writers also reject the previous execution after suspension/expiry/result.
  tx.delete(schema.claims)
    .where(
      and(
        eq(schema.claims.resource, attempt.resource),
        eq(schema.claims.fence, attempt.fence),
      ),
    )
    .run();
  tx.update(schema.fences)
    .set({ current_fence: sql`${schema.fences.current_fence} + 1` })
    .where(
      and(
        eq(schema.fences.resource, attempt.resource),
        eq(schema.fences.current_fence, attempt.fence),
      ),
    )
    .run();
}
export function change(
  tx: ProjectTransaction,
  attempt: WorkAttempt,
  values: Partial<typeof schema.workAttempts.$inferInsert>,
  now: number,
): WorkAttempt {
  tx.update(schema.workAttempts)
    .set({ ...values, revision: attempt.revision + 1, updated_at: now })
    .where(eq(schema.workAttempts.id, attempt.id))
    .run();
  return get(tx, attempt.id);
}
export function transitionTask(
  tx: ProjectTransaction,
  attempt: WorkAttempt,
  origin: RequestOrigin,
  transition: "start" | "success" | "failure" | "cancelled" | "abandoned",
  now: number,
): void {
  const task = tx
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.id, attempt.task_id))
    .get();
  if (!task || task.archived)
    throw new QueueError(
      "queue-conflict",
      "Task is missing or archived; reconcile its execution result",
    );
  const lifecycle = resolveCurrentSchema(tx)?.work_units[task.type]?.lifecycle;
  if (!lifecycle)
    throw definitionConflict(
      tx,
      attempt,
      transition,
      "Task lifecycle configuration was removed",
      now,
    );
  const target =
    transition === "start"
      ? lifecycle.on_start
      : lifecycle.outcomes?.[transition];
  if (target === undefined) return;
  try {
    updateInTransaction(
      tx,
      task.id,
      { [lifecycle.field]: target },
      attempt.fence,
      origin,
      undefined,
      now,
      attempt.id,
    );
  } catch (error) {
    if (!(error instanceof SchemaWriteError)) throw error;
    // Keep the constraint-violation contract; only add the revision context.
    throw new SchemaWriteError(
      definitionConflict(tx, attempt, transition, error.message, now).message,
    );
  }
}
/**
 * Transitions validate against the current definition. A captured revision is
 * reported for diagnosis; it never selects older rules.
 */
function definitionConflict(
  tx: ProjectTransaction,
  attempt: WorkAttempt,
  transition: string,
  reason: string,
  now: number,
): QueueError {
  const current = governingRevisions(tx, now).definition_version;
  const captured = (
    attempt.revisions?.authorized ?? attempt.revisions?.reserved
  )?.definition_version;
  return new QueueError(
    "queue-conflict",
    `Current definition v${current ?? "none"} rejects the ${transition} transition for task ${attempt.task_id}${
      captured === undefined ? "" : ` (attempt captured v${captured ?? "none"})`
    }: ${reason}. Repair the definition, then retry or reconcile.`,
    {
      transition,
      current_definition_version: current,
      captured_definition_version: captured ?? null,
    },
  );
}

/** Only admission calls this primitive, inside the capacity/eligibility transaction. */
export function reserveInTransaction(
  tx: ProjectTransaction,
  entry: QueueEntry,
  origin: RequestOrigin,
  leaseMs: number,
  now = Date.now(),
  predecessorId?: string,
): WorkAttempt {
  const task = tx
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.id, entry.task_id))
    .get();
  if (!task)
    throw new QueueError("queue-not-found", "Enrolled task no longer exists");
  const prior = tx
    .select()
    .from(schema.executionReservations)
    .where(eq(schema.executionReservations.task_id, entry.task_id))
    .get();
  if (prior && (prior.execution_held || prior.entry_id !== entry.id))
    throw new QueueError(
      "queue-conflict",
      "Task has an unresolved execution reservation",
    );
  const resource = `${task.type}:${task.id}`;
  const liveClaim = tx
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.resource, resource))
    .get();
  if (liveClaim && liveClaim.expires_at > now)
    throw new QueueError("queue-conflict", "Task already has a live claim");
  const id = crypto.randomUUID();
  const snapshot = governingRevisions(tx, now);
  const grant = acquireInTransaction(
    tx,
    resource,
    origin,
    "exclusive",
    leaseMs,
    { attempt_id: id },
    now,
  );
  if (!grant.acquired)
    throw new QueueError("queue-conflict", "Task already claimed");
  tx.insert(schema.workAttempts)
    .values({
      id,
      entry_id: entry.id,
      task_id: entry.task_id,
      resource,
      principal_id: origin.principalId,
      participant_id: origin.participantId,
      state: "reserved",
      fence: grant.fence,
      lease_expires_at: grant.expires_at,
      predecessor_id: predecessorId ?? null,
      created_at: now,
      updated_at: now,
      revisions: { reserved: snapshot },
    })
    .run();
  tx.insert(schema.executionReservations)
    .values({
      task_id: entry.task_id,
      entry_id: entry.id,
      attempt_id: id,
      execution_held: true,
      wip_held: true,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: schema.executionReservations.task_id,
      set: {
        attempt_id: id,
        execution_held: true,
        wip_held: true,
        updated_at: now,
      },
    })
    .run();
  tx.update(schema.queueEntries)
    .set({ state: "admitted", revision: entry.revision + 1, updated_at: now })
    .where(eq(schema.queueEntries.id, entry.id))
    .run();
  event(
    tx,
    "attempt.reserved",
    resource,
    origin,
    { attempt_id: id, entry_id: entry.id, ...revisionData(snapshot) },
    grant.fence,
  );
  return get(tx, id);
}

/** Expiry is an execution state transition, not a deletion of capacity evidence. */
export function expireInTransaction(
  tx: ProjectTransaction,
  now = Date.now(),
): number {
  const expired = tx
    .select()
    .from(schema.workAttempts)
    .where(
      and(
        inArray(schema.workAttempts.state, ["reserved", "starting", "running"]),
        lte(schema.workAttempts.lease_expires_at, now),
      ),
    )
    .all();
  for (const attempt of expired) {
    const origin: RequestOrigin = {
      principalId: attempt.principal_id,
      participantId: attempt.participant_id,
      actor: "queue-expiry",
      environment: {},
    };
    revoke(tx, attempt);
    const unaccepted = attempt.accepted_at === null;
    if (unaccepted && attempt.cancellation_requested) {
      finishInTransaction(
        tx,
        refence(tx, attempt, origin, now),
        {
          status: "cancelled",
          reason:
            "Reservation expired after cancellation, before execution was authorized",
          evidence: [],
          execution_stopped: true,
          unresolved_external_execution: false,
        },
        origin,
        now,
        false,
      );
      continue;
    }
    if (unaccepted) {
      change(
        tx,
        attempt,
        {
          state: "terminal",
          lease_expires_at: null,
          finished_at: now,
          revisions: captureRevisions(
            attempt,
            "finished",
            governingRevisions(tx, now),
          ),
          outcome: {
            status: "abandoned",
            reason:
              "Reservation expired before acceptance; execution was never authorized",
            evidence: [],
            execution_stopped: true,
            unresolved_external_execution: false,
          },
        },
        now,
      );
      if (
        attempt.predecessor_id &&
        tx
          .select()
          .from(schema.workAttempts)
          .where(
            and(
              eq(schema.workAttempts.entry_id, attempt.entry_id),
              sql`${schema.workAttempts.accepted_at} IS NOT NULL`,
            ),
          )
          .get()
      ) {
        tx.update(schema.executionReservations)
          .set({ execution_held: false, updated_at: now })
          .where(eq(schema.executionReservations.task_id, attempt.task_id))
          .run();
      } else {
        tx.delete(schema.executionReservations)
          .where(eq(schema.executionReservations.task_id, attempt.task_id))
          .run();
      }
      tx.update(schema.queueEntries)
        .set({
          state: "queued",
          revision: sql`${schema.queueEntries.revision} + 1`,
          updated_at: now,
        })
        .where(eq(schema.queueEntries.id, attempt.entry_id))
        .run();
    } else {
      change(tx, attempt, { state: "uncertain", lease_expires_at: null }, now);
    }
    event(
      tx,
      unaccepted ? "attempt.expired" : "attempt.uncertain",
      attempt.resource,
      origin,
      { attempt_id: attempt.id },
      attempt.fence,
    );
  }
  return expired.length;
}
export function expire(db: ProjectDatabase, now = Date.now()): number {
  return db.transaction((tx) => expireInTransaction(tx, now));
}

function execute(
  db: ProjectDatabase,
  id: string,
  operation: string,
  input: AttemptAuthorityCommand,
  origin: RequestOrigin,
  run: (tx: ProjectTransaction, attempt: WorkAttempt) => void,
  now: number,
): AttemptView {
  // Expiry must persist even when the following command is rejected. Authority
  // is also checked in the write transaction; a late sweep is never required.
  expire(db, now);
  return db.transaction((tx) => {
    const attempt = get(tx, id);
    assertOwner(attempt, origin);
    command(
      tx,
      `${operation}:${id}`,
      origin,
      input,
      () => {
        run(tx, attempt);
        return { attempt_id: id };
      },
      { entry_id: attempt.entry_id, attempt_id: id },
      now,
    );
    const current = view(tx, id, origin, now);
    return {
      ...current,
      grant_valid: current.grant_valid && current.attempt.fence === input.fence,
    };
  });
}
export function accept(
  db: ProjectDatabase,
  id: string,
  raw: AttemptAuthorityCommand,
  origin: RequestOrigin,
  now = Date.now(),
): AttemptView {
  const input = AttemptAuthorityCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "accept",
    input,
    origin,
    (tx, attempt) => {
      assertAuthority(tx, attempt, input, origin, now);
      if (attempt.state !== "reserved")
        throw new QueueError(
          "queue-invalid-state",
          "Only a reservation can be accepted",
        );
      if (attempt.cancellation_requested)
        throw new QueueError(
          "queue-invalid-state",
          "Cancellation requested before acceptance",
        );
      transitionTask(tx, attempt, origin, "start", now);
      const snapshot = governingRevisions(tx, now);
      change(
        tx,
        attempt,
        {
          state: "starting",
          accepted_at: now,
          revisions: captureRevisions(attempt, "authorized", snapshot),
        },
        now,
      );
      event(
        tx,
        "attempt.accepted",
        attempt.resource,
        origin,
        { attempt_id: id, ...revisionData(snapshot) },
        attempt.fence,
      );
    },
    now,
  );
}
export function started(
  db: ProjectDatabase,
  id: string,
  raw: AttemptStartedCommand,
  origin: RequestOrigin,
  now = Date.now(),
): AttemptView {
  const input = AttemptStartedCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "started",
    input,
    origin,
    (tx, attempt) => {
      assertAuthority(tx, attempt, input, origin, now);
      if (attempt.state !== "starting")
        throw new QueueError(
          "queue-invalid-state",
          "A session can be bound only after acceptance",
        );
      change(tx, attempt, { state: "running", session: input.session }, now);
      event(
        tx,
        "attempt.started",
        attempt.resource,
        origin,
        { attempt_id: id, session: input.session },
        attempt.fence,
      );
    },
    now,
  );
}
export function heartbeat(
  db: ProjectDatabase,
  id: string,
  raw: AttemptAuthorityCommand,
  origin: RequestOrigin,
  now = Date.now(),
): AttemptView {
  const input = AttemptAuthorityCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "heartbeat",
    input,
    origin,
    (tx, attempt) => {
      assertAuthority(tx, attempt, input, origin, now);
      const policy = tx
        .select()
        .from(schema.queuePolicy)
        .where(eq(schema.queuePolicy.singleton, 1))
        .get();
      const expires = now + (policy?.lease_ms ?? 60_000);
      tx.update(schema.claims)
        .set({ expires_at: expires })
        .where(eq(schema.claims.resource, attempt.resource))
        .run();
      change(tx, attempt, { lease_expires_at: expires }, now);
      event(
        tx,
        "attempt.heartbeat",
        attempt.resource,
        origin,
        { attempt_id: id },
        attempt.fence,
      );
    },
    now,
  );
}
export function finish(
  db: ProjectDatabase,
  id: string,
  raw: AttemptFinishCommand,
  origin: RequestOrigin,
  now = Date.now(),
): AttemptView {
  const input = AttemptFinishCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "finish",
    input,
    origin,
    (tx, original) => {
      let attempt = original;
      // Competing valid terminal commands observe the first committed outcome.
      if (attempt.state === "terminal") return;
      if (attempt.state === "suspended" || attempt.state === "resume_pending") {
        // No live grant exists, so the recorded fence is the remaining authority proof.
        assertOwner(attempt, origin, input.fence);
        checkRevision(attempt.revision, input.expected_revision);
        attempt = refence(tx, attempt, origin, now);
      } else assertAuthority(tx, attempt, input, origin, now);
      if (
        attempt.accepted_at === null &&
        !(
          attempt.cancellation_requested && input.outcome.status === "cancelled"
        )
      )
        throw new QueueError(
          "queue-invalid-state",
          "Unaccepted execution cannot report a result",
        );
      if (
        !input.outcome.execution_stopped ||
        input.outcome.unresolved_external_execution ||
        input.outcome.status === "abandoned"
      )
        throw new QueueError(
          "queue-invalid-state",
          "Completion requires stopped execution; abandonment requires authorized force recovery",
        );
      finishInTransaction(tx, attempt, input.outcome, origin, now);
    },
    now,
  );
}

/**
 * Caller has established execution authority or a confirmed stopped observation.
 * Task writes run as the attempt owner; journal events record `actor`, which
 * differs from the owner when a maintainer recovers the attempt.
 */
export function finishInTransaction(
  tx: ProjectTransaction,
  attempt: WorkAttempt,
  outcome: AttemptOutcome,
  origin: RequestOrigin,
  now: number,
  allowRetry = true,
  actor: RequestOrigin = origin,
): void {
  transitionTask(tx, attempt, origin, outcome.status, now);
  invalidateQuestions(tx, attempt.id, "attempt finished", actor, now);
  const snapshot = governingRevisions(tx, now);
  change(
    tx,
    attempt,
    {
      state: "terminal",
      outcome,
      finished_at: now,
      lease_expires_at: null,
      revisions: captureRevisions(attempt, "finished", snapshot),
    },
    now,
  );
  revoke(tx, attempt);
  tx.delete(schema.executionReservations)
    .where(eq(schema.executionReservations.task_id, attempt.task_id))
    .run();
  tx.update(schema.queueEntries)
    .set({
      state: "finished",
      revision: sql`${schema.queueEntries.revision} + 1`,
      updated_at: now,
    })
    .where(eq(schema.queueEntries.id, attempt.entry_id))
    .run();
  event(
    tx,
    "attempt.finished",
    attempt.resource,
    actor,
    {
      attempt_id: attempt.id,
      outcome,
      ...ownerData(attempt, actor),
      ...revisionData(snapshot),
    },
    attempt.fence,
  );
  const entry = tx
    .select()
    .from(schema.queueEntries)
    .where(eq(schema.queueEntries.id, attempt.entry_id))
    .get();
  const count =
    tx
      .select({ n: sql<number>`count(*)` })
      .from(schema.workAttempts)
      .where(eq(schema.workAttempts.entry_id, attempt.entry_id))
      .get()?.n ?? 0;
  if (
    allowRetry &&
    outcome.status === "failure" &&
    outcome.execution_stopped &&
    !outcome.unresolved_external_execution &&
    !attempt.cancellation_requested &&
    entry?.retry_policy.retry_safe &&
    count < entry.retry_policy.max_attempts
  ) {
    const backoff = Math.min(
      entry.retry_policy.max_backoff_ms,
      entry.retry_policy.initial_backoff_ms * 2 ** Math.max(0, count - 1),
    );
    scheduleRetryInTransaction(
      tx,
      attempt,
      actor,
      now,
      now + backoff,
      "Configured retry-safe failure",
    );
  }
}
/** Names the execution owner on events recorded by a different actor. */
export function ownerData(
  attempt: WorkAttempt,
  actor: RequestOrigin,
): Record<string, string> {
  return attempt.principal_id === actor.principalId &&
    attempt.participant_id === actor.participantId
    ? {}
    : {
        owner_principal_id: attempt.principal_id,
        owner_participant_id: attempt.participant_id,
      };
}
export function scheduleRetryInTransaction(
  tx: ProjectTransaction,
  attempt: WorkAttempt,
  origin: RequestOrigin,
  now: number,
  availableAt: number,
  reason: string,
): void {
  tx.update(schema.queueEntries)
    .set({
      state: "queued",
      available_at: availableAt,
      revision: sql`${schema.queueEntries.revision} + 1`,
      updated_at: now,
    })
    .where(eq(schema.queueEntries.id, attempt.entry_id))
    .run();
  tx.insert(schema.executionReservations)
    .values({
      task_id: attempt.task_id,
      entry_id: attempt.entry_id,
      attempt_id: attempt.id,
      execution_held: false,
      wip_held: true,
      updated_at: now,
    })
    .run();
  event(
    tx,
    "attempt.retried",
    attempt.resource,
    origin,
    {
      attempt_id: attempt.id,
      entry_id: attempt.entry_id,
      available_at: availableAt,
      reason,
    },
    attempt.fence,
  );
}

/** Internal grant used only inside this transaction. A stopped-result path revokes it before commit. */
export function refence(
  tx: ProjectTransaction,
  attempt: WorkAttempt,
  owner: RequestOrigin,
  now: number,
  actor: RequestOrigin = owner,
  extra: Partial<typeof schema.workAttempts.$inferInsert> = {},
): WorkAttempt {
  invalidateQuestions(
    tx,
    attempt.id,
    "execution authority replaced",
    actor,
    now,
  );
  revoke(tx, attempt);
  const grant = acquireInTransaction(
    tx,
    attempt.resource,
    owner,
    "exclusive",
    tx.select().from(schema.queuePolicy).get()?.lease_ms ?? 60_000,
    { attempt_id: attempt.id },
    now,
  );
  if (!grant.acquired)
    throw new QueueError(
      "queue-conflict",
      "Another live claim prevents recovery",
    );
  return change(
    tx,
    attempt,
    {
      state: "running",
      fence: grant.fence,
      lease_expires_at: grant.expires_at,
      principal_id: owner.principalId,
      participant_id: owner.participantId,
      ...extra,
    },
    now,
  );
}
