import {
  type AttemptCorrectCommand,
  AttemptCorrectCommandSchema,
  type AttemptView,
} from "@tila/schemas";
import { and, eq } from "drizzle-orm";
import * as attempts from "./attempt-ops";
import type { RequestOrigin } from "./journal-ops";
import {
  type ProjectDatabase,
  QueueError,
  command,
  event,
} from "./queue-internals";
import * as schema from "./schema";

/**
 * Link corrective work to a terminal attempt, for example a hotfix task opened
 * after a regression in an accepted result. The original attempt, outcome and
 * evidence are never changed; the link is append-only.
 */
export function correct(
  db: ProjectDatabase,
  attemptId: string,
  raw: AttemptCorrectCommand,
  origin: RequestOrigin,
  now = Date.now(),
): AttemptView {
  const input = AttemptCorrectCommandSchema.parse(raw);
  return db.transaction((tx) => {
    const attempt = attempts.get(tx, attemptId);
    command(
      tx,
      `correct:${attemptId}`,
      origin,
      input,
      () => {
        if (attempt.state !== "terminal")
          throw new QueueError(
            "queue-invalid-state",
            "Only a finished attempt can be corrected; finish or cancel it first",
          );
        const task = tx
          .select({ archived: schema.entities.archived })
          .from(schema.entities)
          .where(eq(schema.entities.id, input.task_id))
          .get();
        if (!task || task.archived)
          throw new QueueError(
            "queue-not-found",
            `Corrective task ${input.task_id} is missing or archived`,
          );
        if (
          tx
            .select({ id: schema.attemptCorrections.id })
            .from(schema.attemptCorrections)
            .where(
              and(
                eq(schema.attemptCorrections.attempt_id, attemptId),
                eq(schema.attemptCorrections.task_id, input.task_id),
              ),
            )
            .get()
        )
          throw new QueueError(
            "queue-conflict",
            `Task ${input.task_id} is already linked as a correction of this attempt`,
          );
        const id = crypto.randomUUID();
        tx.insert(schema.attemptCorrections)
          .values({
            id,
            attempt_id: attemptId,
            task_id: input.task_id,
            reason: input.reason,
            principal_id: origin.principalId,
            participant_id: origin.participantId,
            created_at: now,
          })
          .run();
        event(tx, "attempt.corrected", attempt.resource, origin, {
          attempt_id: attemptId,
          correction_id: id,
          task_id: input.task_id,
          reason: input.reason,
          outcome_status: attempt.outcome?.status ?? null,
        });
        return { attempt_id: attemptId, correction_id: id };
      },
      { attempt_id: attemptId, entry_id: attempt.entry_id },
      now,
    );
    return attempts.view(tx, attemptId, origin, now);
  });
}
