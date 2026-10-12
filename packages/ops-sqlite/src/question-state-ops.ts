import type { Question } from "@tila/schemas";
import { eq } from "drizzle-orm";
import type { RequestOrigin } from "./journal-ops";
import { type ProjectTransaction, event } from "./queue-internals";
import * as schema from "./schema";

export function saveQuestion(tx: ProjectTransaction, question: Question): void {
  tx.update(schema.workQuestions)
    .set({
      state: question.state,
      responder_principal_id: question.responder_principal_id,
      snapshot: question,
    })
    .where(eq(schema.workQuestions.id, question.id))
    .run();
}

/** Called from attempt mutations in their transaction, never from read paths. */
export function invalidateQuestions(
  tx: ProjectTransaction,
  attemptId: string,
  reason: string,
  origin: RequestOrigin,
  now: number,
): void {
  const attempt = tx
    .select({ resource: schema.workAttempts.resource })
    .from(schema.workAttempts)
    .where(eq(schema.workAttempts.id, attemptId))
    .get();
  if (!attempt) throw new Error("Question attempt is missing");
  for (const { snapshot: q } of tx
    .select()
    .from(schema.workQuestions)
    .where(eq(schema.workQuestions.attempt_id, attemptId))
    .all()) {
    if (q.invalidation_reason) continue;
    const updated: Question = {
      ...q,
      state: q.state === "open" ? "superseded" : q.state,
      invalidation_reason: reason,
      revision: q.revision + 1,
      updated_at: now,
    };
    saveQuestion(tx, updated);
    event(
      tx,
      q.state === "open" ? "question.superseded" : "question.invalidated",
      attempt.resource,
      origin,
      {
        question_id: q.id,
        attempt_id: q.attempt_id,
        revision: updated.revision,
        reason,
      },
      q.attempt_fence,
    );
  }
}

/** A replacement agent session cannot inherit decisions even before attempt rebinding. */
export function invalidateAgentQuestions(
  tx: ProjectTransaction,
  agentId: string,
  origin: RequestOrigin,
  now: number,
): void {
  const attempts = new Set(
    tx
      .select()
      .from(schema.workQuestions)
      .all()
      .filter(
        (row) =>
          row.snapshot.requester_binding?.agent_id === agentId &&
          !row.snapshot.invalidation_reason,
      )
      .map((row) => row.attempt_id),
  );
  for (const id of attempts)
    invalidateQuestions(
      tx,
      id,
      "requesting agent binding replaced",
      origin,
      now,
    );
}
