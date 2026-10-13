import { QuestionSchema } from "@tila/schemas";
import {
  AttemptCorrectionSchema,
  QueueEntrySchema,
  QueuePolicySchema,
  WorkAttemptSchema,
} from "@tila/schemas";
import { eq, ne } from "drizzle-orm";
import { z } from "zod";
import * as attempts from "./attempt-ops";
import { invalidateQuestions } from "./question-state-ops";
import { type ProjectDatabase, QueueError, event } from "./queue-internals";
import * as schema from "./schema";

const boolean = z.union([z.literal(0), z.literal(1)]).transform((n) => n === 1);
const json = (value: unknown) => JSON.parse(z.string().parse(value));
export function validateQueueBackupRow(
  table: string,
  row: Record<string, unknown>,
): void {
  if (table === "attempt_corrections") AttemptCorrectionSchema.parse(row);
  if (table === "work_questions") {
    const q = QuestionSchema.parse(json(row.snapshot));
    if (
      q.id !== row.id ||
      q.task_id !== row.task_id ||
      q.attempt_id !== row.attempt_id ||
      q.requester.principal_id !== row.requester_principal_id ||
      q.responder_principal_id !== row.responder_principal_id ||
      q.state !== row.state
    )
      throw new Error("Question projection does not match its snapshot");
  }
  if (table === "question_receipts") {
    z.tuple([z.string(), z.string(), z.string(), z.string()]).parse(
      json(row.key),
    );
    z.object({ idempotency_key: z.string().min(1) }).parse(json(row.request));
    const q = QuestionSchema.parse(json(row.result));
    if (q.id !== row.question_id)
      throw new Error("Question receipt does not match its question");
    z.number().int().parse(row.created_at);
  }
  if (table === "queue_policy") {
    z.literal(1).parse(row.singleton);
    QueuePolicySchema.parse({
      ...row,
      enabled: boolean.parse(row.enabled),
      paused: boolean.parse(row.paused),
    });
    boolean.parse(row.revision_required);
    if (row.enabled === 1 && row.execution_limit === null)
      throw new Error("Enabled queue requires execution capacity");
  }
  if (table === "queue_entries")
    QueueEntrySchema.parse({
      ...row,
      required_capabilities: json(row.required_capabilities),
      retry_policy: json(row.retry_policy),
    });
  if (table === "work_attempts") {
    const attempt = WorkAttemptSchema.parse({
      ...row,
      session: row.session === null ? null : json(row.session),
      checkpoint: row.checkpoint === null ? null : json(row.checkpoint),
      outcome: row.outcome === null ? null : json(row.outcome),
      revisions:
        row.revisions === null || row.revisions === undefined
          ? null
          : json(row.revisions),
      cancellation_requested: boolean.parse(row.cancellation_requested),
      suspension_requested: boolean.parse(row.suspension_requested),
    });
    if (
      attempt.state === "terminal"
        ? attempt.outcome === null || attempt.finished_at === null
        : attempt.outcome !== null || attempt.finished_at !== null
    )
      throw new Error("Attempt terminal history is incomplete");
  }
  if (table === "execution_reservations") {
    z.object({
      task_id: z.string().min(1),
      entry_id: z.string().min(1),
      attempt_id: z.string().min(1),
      execution_held: boolean,
      wip_held: boolean,
      updated_at: z.number().int(),
    }).parse(row);
    if (row.execution_held === 1 && row.wip_held !== 1)
      throw new Error("Execution reservation requires WIP");
  }
  if (table === "queue_operation_receipts") {
    z.tuple([z.string(), z.string(), z.string(), z.string()]).parse(
      json(row.key),
    );
    z.object({ idempotency_key: z.string().min(1) }).parse(json(row.request));
    z.record(z.string(), z.unknown()).parse(json(row.result));
  }
}
/** Call under the destination transfer lock, before any snapshot rows are cleared. */
export function assertRestoreQuiescent(db: ProjectDatabase): void {
  if (
    db
      .select({ id: schema.workAttempts.id })
      .from(schema.workAttempts)
      .where(ne(schema.workAttempts.state, "terminal"))
      .limit(1)
      .get() ||
    db
      .select({ id: schema.executionReservations.task_id })
      .from(schema.executionReservations)
      .limit(1)
      .get()
  )
    throw new QueueError(
      "queue-conflict",
      "Restore requires a quiescent destination: reconcile and finish managed executions, including suspended work and pending retries, before replacing the database",
    );
}
export function readFenceWatermarks(
  db: ProjectDatabase,
): Record<string, number> {
  const result: Record<string, number> = Object.create(null);
  const resources = new Set(
    db
      .select({ resource: schema.workAttempts.resource })
      .from(schema.workAttempts)
      .all()
      .map((a) => a.resource),
  );
  for (const fence of db.select().from(schema.fences).all())
    if (resources.has(fence.resource))
      result[fence.resource] = fence.current_fence;
  return result;
}
export function preserveRestoreFences(db: ProjectDatabase): void {
  const state = db.select().from(schema.projectTransferState).get();
  if (!state || state.applying) return;
  assertRestoreQuiescent(db);
  db.update(schema.projectTransferState)
    .set({ queue_fences_json: JSON.stringify(readFenceWatermarks(db)) })
    .where(eq(schema.projectTransferState.singleton, 1))
    .run();
}
/** Run after semantic verification, before releasing the import lock. */
export function invalidateRestoredExecutions(
  db: ProjectDatabase,
  destinationFences?: Record<string, number>,
  now = Date.now(),
): void {
  const state = db.select().from(schema.projectTransferState).get();
  const saved =
    destinationFences ??
    z
      .record(z.string(), z.number().int().nonnegative())
      .parse(JSON.parse(state?.queue_fences_json ?? "{}"));
  db.transaction((tx) => {
    if (state)
      tx.update(schema.projectTransferState)
        .set({ applying: 1 })
        .where(eq(schema.projectTransferState.singleton, 1))
        .run();
    const entries = tx.select().from(schema.queueEntries).all();
    const allAttempts = tx.select().from(schema.workAttempts).all();
    const byEntry = new Map(entries.map((entry) => [entry.id, entry]));
    const byAttempt = new Map(
      allAttempts.map((attempt) => [attempt.id, attempt]),
    );
    for (const link of tx.select().from(schema.attemptCorrections).all()) {
      if (byAttempt.get(link.attempt_id)?.state !== "terminal")
        throw new QueueError(
          "queue-conflict",
          "Restored correction must reference a finished attempt",
        );
      if (
        !tx
          .select({ id: schema.entities.id })
          .from(schema.entities)
          .where(eq(schema.entities.id, link.task_id))
          .get()
      )
        throw new QueueError(
          "queue-conflict",
          "Restored correction references a missing task",
        );
    }
    for (const entry of entries) {
      if (
        entry.state === "admitted" &&
        !allAttempts.some(
          (attempt) =>
            attempt.entry_id === entry.id && attempt.state !== "terminal",
        )
      )
        throw new QueueError(
          "queue-conflict",
          "Admitted enrollment requires a live attempt",
        );
    }
    for (const reservation of tx
      .select()
      .from(schema.executionReservations)
      .all()) {
      const entry = byEntry.get(reservation.entry_id);
      const attempt = byAttempt.get(reservation.attempt_id);
      if (
        !entry ||
        !attempt ||
        entry.task_id !== reservation.task_id ||
        attempt.task_id !== reservation.task_id ||
        attempt.entry_id !== entry.id ||
        !reservation.wip_held ||
        (entry.state !== "admitted" && entry.state !== "queued") ||
        (entry.state === "queued" &&
          (attempt.state !== "terminal" || reservation.execution_held))
      )
        throw new QueueError(
          "queue-conflict",
          "Restored reservation is inconsistent",
        );
    }
    for (const attempt of allAttempts) {
      if (attempt.predecessor_id) {
        const predecessor = byAttempt.get(attempt.predecessor_id);
        if (
          !predecessor ||
          predecessor.task_id !== attempt.task_id ||
          predecessor.entry_id !== attempt.entry_id ||
          predecessor.state !== "terminal" ||
          predecessor.fence >= attempt.fence
        )
          throw new QueueError(
            "queue-conflict",
            "Restored attempt predecessor is inconsistent",
          );
      }
    }
    for (const row of tx.select().from(schema.workQuestions).all()) {
      const q = QuestionSchema.parse(row.snapshot);
      const attempt = byAttempt.get(q.attempt_id);
      if (
        !attempt ||
        q.task_id !== attempt.task_id ||
        q.id !== row.id ||
        q.task_id !== row.task_id ||
        q.attempt_id !== row.attempt_id ||
        q.state !== row.state ||
        q.requester.principal_id !== row.requester_principal_id ||
        q.responder_principal_id !== row.responder_principal_id
      )
        throw new Error("Restored question context is inconsistent");
      if (q.predecessor_id) {
        const prior = tx
          .select()
          .from(schema.workQuestions)
          .where(eq(schema.workQuestions.id, q.predecessor_id))
          .get();
        if (!prior || prior.task_id !== q.task_id || prior.id === q.id)
          throw new Error("Invalid question predecessor");
      }
    }
    for (const receipt of tx
      .select()
      .from(schema.queueOperationReceipts)
      .all()) {
      if (
        (receipt.entry_id && !byEntry.has(receipt.entry_id)) ||
        (receipt.attempt_id && !byAttempt.has(receipt.attempt_id))
      )
        throw new QueueError(
          "queue-conflict",
          "Restored receipt history is incomplete",
        );
    }
    const resources = new Set([
      ...Object.keys(saved),
      ...allAttempts.map((a) => a.resource),
    ]);
    for (const resource of resources) {
      const current =
        tx
          .select()
          .from(schema.fences)
          .where(eq(schema.fences.resource, resource))
          .get()?.current_fence ?? 0;
      const maximum = Math.max(
        current,
        Object.hasOwn(saved, resource) ? saved[resource] : 0,
        ...allAttempts
          .filter((a) => a.resource === resource)
          .map((a) => a.fence),
      );
      tx.insert(schema.fences)
        .values({ resource, current_fence: maximum + 1 })
        .onConflictDoUpdate({
          target: schema.fences.resource,
          set: { current_fence: maximum + 1 },
        })
        .run();
      tx.delete(schema.claims)
        .where(eq(schema.claims.resource, resource))
        .run();
    }
    const origin = {
      principalId: "queue-restore",
      participantId: "queue-restore",
      actor: "queue-restore",
      environment: {},
    };
    for (const attempt of allAttempts) {
      const entry = byEntry.get(attempt.entry_id);
      if (!entry || entry.task_id !== attempt.task_id)
        throw new QueueError(
          "queue-conflict",
          "Restored attempt does not match enrollment",
        );
      const task = tx
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.id, attempt.task_id))
        .get();
      if (!task || attempt.resource !== `${task.type}:${task.id}`)
        throw new QueueError(
          "queue-conflict",
          "Restored execution resource is inconsistent",
        );
      invalidateQuestions(
        tx,
        attempt.id,
        "project restored",
        {
          principalId: "system:restore",
          participantId: "restore",
          actor: "restore",
          environment: {},
        },
        now,
      );
      if (attempt.state === "terminal") continue;
      if (entry.state !== "admitted")
        throw new QueueError(
          "queue-conflict",
          "Live attempt requires admitted enrollment",
        );
      attempts.change(
        tx,
        attempt,
        { state: "uncertain", lease_expires_at: null },
        now,
      );
      tx.insert(schema.executionReservations)
        .values({
          task_id: attempt.task_id,
          entry_id: entry.id,
          attempt_id: attempt.id,
          execution_held: true,
          wip_held: true,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: schema.executionReservations.task_id,
          set: {
            entry_id: entry.id,
            attempt_id: attempt.id,
            execution_held: true,
            wip_held: true,
            updated_at: now,
          },
        })
        .run();
      event(
        tx,
        "attempt.uncertain",
        attempt.resource,
        origin,
        {
          attempt_id: attempt.id,
          reason:
            "Restored snapshot does not establish current external execution state",
          previous_state: attempt.state,
        },
        attempt.fence,
      );
    }
    const policy = tx.select().from(schema.queuePolicy).get();
    if (policy)
      tx.update(schema.queuePolicy)
        .set({
          paused: true,
          revision: policy.revision + 1,
          revision_required:
            policy.revision_required || policy.enabled || entries.length > 0,
        })
        .where(eq(schema.queuePolicy.singleton, 1))
        .run();
    else if (entries.length)
      tx.insert(schema.queuePolicy)
        .values({
          singleton: 1,
          enabled: false,
          paused: true,
          revision: 1,
          revision_required: true,
        })
        .run();
    if (policy || entries.length)
      event(tx, "queue.policy_changed", "queue", origin, {
        paused: true,
        reason:
          "Project restored; reconcile execution before enabling admission",
      });
    if (state)
      tx.update(schema.projectTransferState)
        .set({ applying: state.applying })
        .where(eq(schema.projectTransferState.singleton, 1))
        .run();
  });
}
