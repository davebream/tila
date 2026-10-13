import {
  type AttemptForceCommand,
  AttemptForceCommandSchema,
  type AttemptRebindCommand,
  AttemptRebindCommandSchema,
  type AttemptReconcileCommand,
  AttemptReconcileCommandSchema,
  type AttemptResumeCommand,
  AttemptResumeCommandSchema,
  type AttemptResumeResult,
  type AttemptRetryCommand,
  AttemptRetryCommandSchema,
  type AttemptSuspendCommand,
  AttemptSuspendCommandSchema,
  type AttemptView,
  type QueueRevisionCommand,
  QueueRevisionCommandSchema,
  type WorkAttempt,
  canonicalJson,
} from "@tila/schemas";
import { and, desc, eq, sql } from "drizzle-orm";
import * as attempts from "./attempt-ops";
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
import { getEntry, occupancy, policy } from "./queue-ops";
import { evaluateReadiness, readReadinessSnapshot } from "./ready-ops";
import * as schema from "./schema";

type Authorize = (tx: ProjectTransaction, attempt: WorkAttempt) => void;
/** `authorize` runs before receipt lookup, so a replay is rejected once authority is gone. */
function execute(
  db: ProjectDatabase,
  id: string,
  operation: string,
  input: QueueRevisionCommand,
  origin: RequestOrigin,
  run: (tx: ProjectTransaction, attempt: WorkAttempt) => void,
  now: number,
  authorize: Authorize,
): AttemptView {
  attempts.expire(db, now);
  return db.transaction((tx) => {
    const attempt = attempts.get(tx, id);
    authorize(tx, attempt);
    command(
      tx,
      `${operation}:${id}`,
      origin,
      input,
      () => {
        if (!(operation === "reconcile" && attempt.state === "terminal")) {
          checkRevision(attempt.revision, input.expected_revision);
          run(tx, attempt);
        }
        return { attempt_id: id };
      },
      { attempt_id: id, entry_id: attempt.entry_id },
      now,
    );
    return attempts.view(tx, id, origin, now);
  });
}
function requireState(
  attempt: WorkAttempt,
  states: WorkAttempt["state"][],
): void {
  if (!states.includes(attempt.state))
    throw new QueueError(
      "queue-invalid-state",
      `Operation is unavailable while ${attempt.state}`,
    );
}
/**
 * Control requests come from the current execution owner, the principal that
 * enrolled the work, or a maintainer. A former owner has none of these roles,
 * so it cannot steer a replacement attempt.
 */
export function assertControl(
  tx: ProjectTransaction,
  attempt: WorkAttempt,
  origin: RequestOrigin,
  canManage: boolean,
): void {
  if (canManage) return;
  if (
    attempt.principal_id === origin.principalId &&
    attempt.participant_id === origin.participantId
  )
    return;
  const assigner = getEntry(tx, attempt.entry_id).enrolled_by_principal;
  if (assigner !== null && assigner === origin.principalId) return;
  throw new QueueError(
    "queue-authority-lost",
    "Only the attempt owner, the principal that enrolled the work, or a maintainer can request this",
  );
}
const control =
  (origin: RequestOrigin, canManage: boolean): Authorize =>
  (tx, attempt) =>
    assertControl(tx, attempt, origin, canManage);
const ownerOnly =
  (origin: RequestOrigin): Authorize =>
  (_tx, attempt) =>
    attempts.assertOwner(attempt, origin);
const anyone: Authorize = () => {};
function requireMaintainer(canManage: boolean): void {
  if (!canManage)
    throw new QueueError(
      "queue-authority-lost",
      "Maintainer authority is required for recovery or ownership rebinding",
    );
}
function ownedOrigin(
  attempt: WorkAttempt,
  actor: RequestOrigin,
): RequestOrigin {
  return {
    ...actor,
    principalId: attempt.principal_id,
    participantId: attempt.participant_id,
  };
}
export function requestCancellation(
  db: ProjectDatabase,
  id: string,
  raw: QueueRevisionCommand,
  origin: RequestOrigin,
  canManage = false,
  now = Date.now(),
): AttemptView {
  const input = QueueRevisionCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "request-cancellation",
    input,
    origin,
    (tx, attempt) => {
      if (attempt.state === "terminal") return;
      invalidateQuestions(
        tx,
        attempt.id,
        "attempt cancellation requested",
        origin,
        now,
      );
      attempts.change(tx, attempt, { cancellation_requested: true }, now);
      event(
        tx,
        "attempt.cancellation_requested",
        attempt.resource,
        origin,
        { attempt_id: id },
        attempt.fence,
      );
    },
    now,
    control(origin, canManage),
  );
}
export function requestSuspension(
  db: ProjectDatabase,
  id: string,
  raw: QueueRevisionCommand,
  origin: RequestOrigin,
  canManage = false,
  now = Date.now(),
): AttemptView {
  const input = QueueRevisionCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "request-suspension",
    input,
    origin,
    (tx, attempt) => {
      requireState(attempt, ["starting", "running"]);
      attempts.change(tx, attempt, { suspension_requested: true }, now);
      event(
        tx,
        "attempt.suspension_requested",
        attempt.resource,
        origin,
        { attempt_id: id },
        attempt.fence,
      );
    },
    now,
    control(origin, canManage),
  );
}
export function confirmSuspension(
  db: ProjectDatabase,
  id: string,
  raw: AttemptSuspendCommand,
  origin: RequestOrigin,
  now = Date.now(),
): AttemptView {
  const input = AttemptSuspendCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "confirm-suspension",
    input,
    origin,
    (tx, attempt) => {
      attempts.assertAuthority(tx, attempt, input, origin, now);
      requireState(attempt, ["running"]);
      if (!attempt.suspension_requested || attempt.cancellation_requested)
        throw new QueueError(
          "queue-invalid-state",
          "Suspension must be requested and cancellation must not be pending",
        );
      attempts.revoke(tx, attempt);
      attempts.change(
        tx,
        attempt,
        {
          state: "suspended",
          checkpoint: input.checkpoint,
          lease_expires_at: null,
          suspension_requested: false,
        },
        now,
      );
      tx.update(schema.executionReservations)
        .set({ execution_held: false, updated_at: now })
        .where(eq(schema.executionReservations.task_id, attempt.task_id))
        .run();
      event(
        tx,
        "attempt.suspended",
        attempt.resource,
        origin,
        {
          attempt_id: id,
          checkpoint: input.checkpoint,
          execution_quiescent: true,
        },
        attempt.fence,
      );
    },
    now,
    ownerOnly(origin),
  );
}
export function requestResume(
  db: ProjectDatabase,
  id: string,
  raw: QueueRevisionCommand,
  origin: RequestOrigin,
  canManage = false,
  now = Date.now(),
): AttemptView {
  const input = QueueRevisionCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "request-resume",
    input,
    origin,
    (tx, attempt) => {
      requireState(attempt, ["suspended"]);
      if (attempt.cancellation_requested)
        throw new QueueError("queue-invalid-state", "Cancellation is pending");
      attempts.change(tx, attempt, { state: "resume_pending" }, now);
      event(
        tx,
        "attempt.resume_requested",
        attempt.resource,
        origin,
        { attempt_id: id },
        attempt.fence,
      );
    },
    now,
    control(origin, canManage),
  );
}
export function claimResume(
  db: ProjectDatabase,
  id: string,
  raw: AttemptResumeCommand,
  origin: RequestOrigin,
  now = Date.now(),
): AttemptResumeResult {
  const input = AttemptResumeCommandSchema.parse(raw);
  attempts.expire(db, now);
  return db.transaction((tx) => {
    const attempt = attempts.get(tx, id);
    attempts.assertOwner(attempt, origin);
    const result = command(
      tx,
      `claim-resume:${id}`,
      origin,
      input,
      () => {
        checkRevision(attempt.revision, input.expected_revision);
        requireState(attempt, ["resume_pending"]);
        const current = policy(tx);
        const denied = (
          reason: "disabled" | "paused" | "blocked" | "execution_capacity",
        ) => ({ reason });
        if (!current.enabled) return denied("disabled");
        if (current.paused) return denied("paused");
        if (
          current.execution_limit === null ||
          occupancy(tx).execution >= current.execution_limit
        )
          return denied("execution_capacity");
        const entry = getEntry(tx, attempt.entry_id);
        const snapshot = readReadinessSnapshot(tx, now);
        const task = snapshot.entities.get(attempt.task_id);
        const lifecycle =
          task && snapshot.definition?.work_units[task.type]?.lifecycle;
        // Continuation may be in on_start's working state; it must still be nonterminal
        // and satisfy all current dependencies, gates, targeting and capabilities.
        const reasons = evaluateReadiness(
          snapshot,
          attempt.task_id,
          true,
        ).reasons.filter((reason) => reason.code !== "not-dispatchable");
        if (
          !task ||
          !lifecycle ||
          typeof task.data[lifecycle.field] !== "string" ||
          lifecycle.terminal.includes(String(task.data[lifecycle.field])) ||
          snapshot.definition?.work_units[task.type]?.fields[
            lifecycle.field
          ]?.values?.includes(String(task.data[lifecycle.field])) === false ||
          reasons.length ||
          attempt.cancellation_requested ||
          (entry.target_principal &&
            entry.target_principal !== origin.principalId) ||
          entry.required_capabilities.some(
            (cap) => !input.capabilities.includes(cap),
          )
        )
          return denied("blocked");
        const renewed = attempts.refence(tx, attempt, origin, now);
        attempts.change(tx, renewed, { state: "starting" }, now);
        tx.update(schema.executionReservations)
          .set({ execution_held: true, updated_at: now })
          .where(eq(schema.executionReservations.task_id, attempt.task_id))
          .run();
        event(
          tx,
          "attempt.resumed",
          attempt.resource,
          origin,
          { attempt_id: id, checkpoint: attempt.checkpoint },
          renewed.fence,
        );
        return { attempt_id: id, fence: renewed.fence };
      },
      { attempt_id: id, entry_id: attempt.entry_id },
      now,
    );
    const view = attempts.view(tx, id, origin, now);
    return "reason" in result
      ? { kind: "no_grant", reason: result.reason, ...view, grant_valid: false }
      : {
          kind: "granted",
          ...view,
          grant_valid: view.grant_valid && result.fence === view.attempt.fence,
        };
  });
}
export function reconcile(
  db: ProjectDatabase,
  id: string,
  raw: AttemptReconcileCommand,
  origin: RequestOrigin,
  canManage = false,
  now = Date.now(),
): AttemptView {
  const input = AttemptReconcileCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "reconcile",
    input,
    origin,
    (tx, attempt) => {
      if (attempt.state === "terminal") return;
      const owner = ownedOrigin(attempt, origin);
      if (input.observation === "unknown") {
        requireState(attempt, ["starting", "running", "uncertain"]);
        attempts.revoke(tx, attempt);
        attempts.change(
          tx,
          attempt,
          { state: "uncertain", lease_expires_at: null },
          now,
        );
        event(
          tx,
          "attempt.uncertain",
          attempt.resource,
          origin,
          { attempt_id: id, reason: input.reason },
          attempt.fence,
        );
        return;
      }
      if (input.observation === "suspended") {
        requireState(attempt, ["uncertain", "running", "suspended"]);
        if (
          !input.execution_quiescent ||
          !input.checkpoint ||
          !input.session ||
          (attempt.session &&
            canonicalJson(attempt.session) !== canonicalJson(input.session))
        )
          throw new QueueError(
            "queue-invalid-state",
            "Suspended reconciliation requires confirmed quiescence, checkpoint and the recorded session",
          );
        attempts.revoke(tx, attempt);
        attempts.change(
          tx,
          attempt,
          {
            state: "suspended",
            session: input.session,
            checkpoint: input.checkpoint,
            suspension_requested: false,
            lease_expires_at: null,
          },
          now,
        );
        tx.update(schema.executionReservations)
          .set({ execution_held: false, updated_at: now })
          .where(eq(schema.executionReservations.task_id, attempt.task_id))
          .run();
        event(
          tx,
          "attempt.suspended",
          attempt.resource,
          origin,
          {
            attempt_id: id,
            reason: input.reason,
            execution_quiescent: true,
            checkpoint: input.checkpoint,
          },
          attempt.fence,
        );
        return;
      }
      if (input.observation === "running") {
        requireState(attempt, ["starting", "running", "uncertain"]);
        if (
          !input.session ||
          (attempt.session &&
            canonicalJson(attempt.session) !== canonicalJson(input.session))
        )
          throw new QueueError(
            "queue-conflict",
            "Reconnection must identify the same recorded execution",
          );
        const rebound = attempts.refence(tx, attempt, owner, now, origin);
        attempts.change(tx, rebound, { session: input.session }, now);
        event(
          tx,
          "attempt.rebound",
          attempt.resource,
          origin,
          {
            attempt_id: id,
            reason: input.reason,
            session: input.session,
            previous_fence: attempt.fence,
          },
          rebound.fence,
        );
        return;
      }
      if (
        !input.outcome ||
        !input.outcome.execution_stopped ||
        input.outcome.unresolved_external_execution ||
        input.outcome.status === "abandoned"
      )
        throw new QueueError(
          "queue-invalid-state",
          "Stopped reconciliation requires an explicit stopped outcome",
        );
      // Same rule as finish: an unaccepted reservation never ran, so only a
      // requested cancellation can be recorded for it.
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
      const stopped = attempts.refence(tx, attempt, owner, now, origin);
      attempts.finishInTransaction(
        tx,
        stopped,
        input.outcome,
        owner,
        now,
        true,
        origin,
      );
      event(
        tx,
        "attempt.rebound",
        attempt.resource,
        origin,
        {
          attempt_id: id,
          observation: "stopped",
          reason: input.reason,
          previous_fence: attempt.fence,
        },
        stopped.fence,
      );
    },
    now,
    canManage ? anyone : ownerOnly(origin),
  );
}
export function rebind(
  db: ProjectDatabase,
  id: string,
  raw: AttemptRebindCommand,
  origin: RequestOrigin,
  canManage: boolean,
  now = Date.now(),
): AttemptView {
  requireMaintainer(canManage);
  const input = AttemptRebindCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "rebind",
    input,
    origin,
    (tx, attempt) => {
      requireState(attempt, ["starting", "running", "uncertain"]);
      if (
        !attempt.session ||
        canonicalJson(attempt.session) !== canonicalJson(input.session)
      )
        throw new QueueError(
          "queue-conflict",
          "Ownership rebinding must retain the recorded execution",
        );
      const rebound = attempts.refence(
        tx,
        attempt,
        {
          ...origin,
          principalId: input.principal_id,
          participantId: input.participant_id,
        },
        now,
        origin,
      );
      event(
        tx,
        "attempt.rebound",
        attempt.resource,
        origin,
        {
          attempt_id: id,
          reason: input.reason,
          previous_principal: attempt.principal_id,
          previous_participant: attempt.participant_id,
          principal_id: input.principal_id,
          participant_id: input.participant_id,
          previous_fence: attempt.fence,
        },
        rebound.fence,
      );
    },
    now,
    anyone,
  );
}
export function retry(
  db: ProjectDatabase,
  id: string,
  raw: AttemptRetryCommand,
  origin: RequestOrigin,
  canManage = false,
  now = Date.now(),
): AttemptView {
  const input = AttemptRetryCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "retry",
    input,
    origin,
    (tx, attempt) => {
      requireState(attempt, ["terminal"]);
      if (
        !attempt.outcome?.execution_stopped ||
        attempt.outcome.unresolved_external_execution ||
        attempt.outcome.status === "success"
      )
        throw new QueueError(
          "queue-invalid-state",
          "Explicit retry requires confirmed stopped unsuccessful execution",
        );
      const entry = getEntry(tx, attempt.entry_id);
      const latest = tx
        .select()
        .from(schema.workAttempts)
        .where(eq(schema.workAttempts.entry_id, entry.id))
        .orderBy(desc(schema.workAttempts.fence))
        .get();
      if (latest?.id !== id || entry.state !== "finished")
        throw new QueueError(
          "queue-conflict",
          "A newer attempt or pending retry already exists",
        );
      if (
        tx
          .select()
          .from(schema.queueEntries)
          .where(
            and(
              eq(schema.queueEntries.task_id, attempt.task_id),
              sql`${schema.queueEntries.state} IN ('queued', 'admitted')`,
            ),
          )
          .get()
      )
        throw new QueueError(
          "queue-conflict",
          "Task already has unfinished enrollment",
        );
      const current = policy(tx);
      if (current.wip_limit !== null && occupancy(tx).wip >= current.wip_limit)
        throw new QueueError(
          "queue-conflict",
          "Work-in-progress capacity is occupied",
        );
      attempts.scheduleRetryInTransaction(
        tx,
        attempt,
        origin,
        now,
        now,
        input.reason,
      );
    },
    now,
    control(origin, canManage),
  );
}
export function forceRecovery(
  db: ProjectDatabase,
  id: string,
  raw: AttemptForceCommand,
  origin: RequestOrigin,
  canManage: boolean,
  now = Date.now(),
): AttemptView {
  requireMaintainer(canManage);
  const input = AttemptForceCommandSchema.parse(raw);
  return execute(
    db,
    id,
    "force-recovery",
    input,
    origin,
    (tx, attempt) => {
      requireState(attempt, [
        "reserved",
        "starting",
        "running",
        "suspended",
        "resume_pending",
        "uncertain",
      ]);
      const owner = ownedOrigin(attempt, origin);
      const abandoned = attempts.refence(tx, attempt, owner, now, origin);
      attempts.finishInTransaction(
        tx,
        abandoned,
        {
          status: "abandoned",
          reason: input.reason,
          evidence: [],
          execution_stopped: false,
          unresolved_external_execution: true,
        },
        owner,
        now,
        false,
        origin,
      );
      // Maintainer explicitly accepts the risk of unresolved external execution.
      // Keep WIP for the replacement and retain abandonment evidence permanently.
      attempts.scheduleRetryInTransaction(
        tx,
        abandoned,
        origin,
        now,
        now,
        input.reason,
      );
    },
    now,
    anyone,
  );
}
