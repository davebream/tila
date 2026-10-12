import {
  type Question,
  type QuestionAnswerCommand,
  QuestionAnswerCommandSchema,
  type QuestionAskCommand,
  QuestionAskCommandSchema,
  type QuestionCancelCommand,
  QuestionCancelCommandSchema,
  type QuestionCommand,
  type QuestionDiscussion,
  type QuestionEscalateCommand,
  QuestionEscalateCommandSchema,
  type QuestionLinkCommand,
  QuestionLinkCommandSchema,
  type QuestionListQuery,
  QuestionListQuerySchema,
  type QuestionListResult,
  type QuestionView,
  canonicalJson,
} from "@tila/schemas";
import { and, eq, gt } from "drizzle-orm";
import * as attempts from "./attempt-ops";
import {
  type ConversationAuthority,
  activeBinding,
  getRoom,
} from "./conversation-ops";
import type { RequestOrigin } from "./journal-ops";
import { saveQuestion } from "./question-state-ops";
import {
  type ProjectDatabase,
  type ProjectTransaction,
  event,
} from "./queue-internals";
import * as schema from "./schema";

export class QuestionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 403 | 404 | 409 = 409,
  ) {
    super(message);
    this.name = "QuestionError";
  }
}
export interface QuestionAuthority {
  origin: RequestOrigin;
  can_manage: boolean;
  is_owner: boolean;
  conversation: ConversationAuthority;
}
const actor = (a: QuestionAuthority) => ({
  principal_id: a.origin.principalId,
  participant_id: a.origin.participantId,
});
const deny = (): never => {
  throw new QuestionError(
    "permission-denied",
    "Question operation is not authorized",
    403,
  );
};
export function get(db: ProjectDatabase, id: string): Question {
  const row = db
    .select()
    .from(schema.workQuestions)
    .where(eq(schema.workQuestions.id, id))
    .get();
  if (!row)
    throw new QuestionError(
      "question-not-found",
      "Question does not exist",
      404,
    );
  return row.snapshot;
}
function applicable(
  db: ProjectDatabase,
  q: Question,
  a: QuestionAuthority,
  now: number,
): boolean {
  const current = get(db, q.id);
  const attempt = attempts.get(db, q.attempt_id);
  return (
    q.state === "answered" &&
    current.state === "answered" &&
    !current.invalidation_reason &&
    !attempt.cancellation_requested &&
    attempt.fence === q.attempt_fence &&
    q.requester.principal_id === a.origin.principalId &&
    q.requester.participant_id === a.origin.participantId &&
    attempts.grantValid(db, attempt, a.origin, now)
  );
}
export function view(
  db: ProjectDatabase,
  id: string,
  a: QuestionAuthority,
  now = Date.now(),
): QuestionView {
  const question = get(db, id);
  return { question, answer_applicable: applicable(db, question, a, now) };
}
export function list(
  db: ProjectDatabase,
  raw: QuestionListQuery,
  a: QuestionAuthority,
  allowsTask: (id: string) => boolean = () => true,
): QuestionListResult {
  const q = QuestionListQuerySchema.parse(raw);
  const rows: Array<typeof schema.workQuestions.$inferSelect> = [];
  let after = q.after_id;
  // Bound each SQLite page, including when authorization filters out most rows.
  while (rows.length <= q.limit) {
    const batch = db
      .select()
      .from(schema.workQuestions)
      .where(
        and(
          q.task_id ? eq(schema.workQuestions.task_id, q.task_id) : undefined,
          q.attempt_id
            ? eq(schema.workQuestions.attempt_id, q.attempt_id)
            : undefined,
          q.requester_principal_id
            ? eq(
                schema.workQuestions.requester_principal_id,
                q.requester_principal_id,
              )
            : undefined,
          q.responder_principal_id
            ? eq(
                schema.workQuestions.responder_principal_id,
                q.responder_principal_id,
              )
            : undefined,
          q.state ? eq(schema.workQuestions.state, q.state) : undefined,
          after ? gt(schema.workQuestions.id, after) : undefined,
        ),
      )
      .orderBy(schema.workQuestions.id)
      .limit(200)
      .all();
    rows.push(...batch.filter((row) => allowsTask(row.task_id)));
    if (batch.length < 200) break;
    after = batch.at(-1)?.id;
  }
  const page = rows.slice(0, q.limit);
  return {
    questions: page.map((row) => view(db, row.id, a)),
    next_after_id: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
function receipt(
  tx: ProjectTransaction,
  operation: string,
  input: { idempotency_key: string },
  a: QuestionAuthority,
  run: () => Question,
  now: number,
): QuestionView {
  const key = canonicalJson([
    a.origin.principalId,
    a.origin.participantId,
    operation,
    input.idempotency_key,
  ]);
  const request = canonicalJson(input);
  const prior = tx
    .select()
    .from(schema.questionReceipts)
    .where(eq(schema.questionReceipts.key, key))
    .get();
  if (prior) {
    if (prior.request !== request)
      throw new QuestionError(
        "question-idempotency-conflict",
        "Operation key was used for a different request",
      );
    return {
      question: prior.result,
      answer_applicable: applicable(tx, prior.result, a, now),
    };
  }
  const result = run();
  tx.insert(schema.questionReceipts)
    .values({ key, request, question_id: result.id, result, created_at: now })
    .run();
  return {
    question: result,
    answer_applicable: applicable(tx, result, a, now),
  };
}
function discussion(
  db: ProjectDatabase,
  q: Question,
  ref: QuestionDiscussion,
  a: QuestionAuthority,
): void {
  getRoom(db, ref.room_id, a.conversation);
  const message = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, ref.message_id))
    .get();
  if (
    !message ||
    message.room_id !== ref.room_id ||
    message.message.task_id !== q.task_id ||
    message.message.attempt_id !== q.attempt_id ||
    message.message.correlation_id !== q.id
  )
    throw new QuestionError(
      "question-correlation-conflict",
      "Message must reference this question, task and attempt",
    );
}
export function ask(
  db: ProjectDatabase,
  raw: QuestionAskCommand,
  a: QuestionAuthority,
  now = Date.now(),
): QuestionView {
  const input = QuestionAskCommandSchema.parse(raw);
  return db.transaction((tx) => {
    const attempt = attempts.get(tx, input.attempt_id);
    // Current authority precedes receipts; the stale command revision does not.
    attempts.assertOwner(attempt, a.origin, input.fence);
    if (!attempts.grantValid(tx, attempt, a.origin, now)) deny();
    return receipt(
      tx,
      "ask",
      input,
      a,
      () => {
        attempts.assertAuthority(tx, attempt, input, a.origin, now);
        if (attempt.accepted_at === null || attempt.cancellation_requested)
          throw new QuestionError(
            "question-invalid-state",
            "Questions require an accepted, uncancelled attempt",
          );
        if (
          tx
            .select()
            .from(schema.workQuestions)
            .where(eq(schema.workQuestions.id, input.id))
            .get()
        )
          throw new QuestionError(
            "question-conflict",
            "Question ID already exists",
          );
        if (input.predecessor_id) {
          const prior = get(tx, input.predecessor_id);
          if (prior.task_id !== attempt.task_id || prior.state === "open")
            throw new QuestionError(
              "question-conflict",
              "Predecessor must be a closed question for the same task",
            );
        }
        const binding = a.conversation.runtime
          ? activeBinding(
              tx,
              a.conversation.runtime.agent_id ?? "",
              a.conversation,
              now,
            )
          : null;
        const question: Question = {
          id: input.id,
          text: input.text,
          task_id: attempt.task_id,
          attempt_id: attempt.id,
          attempt_revision: attempt.revision,
          attempt_fence: attempt.fence,
          requester: actor(a),
          session: attempt.session
            ? { provider: attempt.session.provider, id: attempt.session.id }
            : null,
          requester_binding: binding
            ? {
                agent_id: binding.agent_id,
                consumer_binding_id: binding.consumer_binding_id,
                binding_epoch: binding.binding_epoch,
              }
            : null,
          responder_principal_id: input.responder_principal_id,
          escalated: false,
          state: "open",
          revision: 1,
          answer: null,
          routing: [
            {
              responder_principal_id: input.responder_principal_id,
              escalated: false,
              reason: null,
              actor: actor(a),
              revision: 1,
              at: now,
            },
          ],
          discussion: input.discussion,
          predecessor_id: input.predecessor_id ?? null,
          invalidation_reason: null,
          created_at: now,
          updated_at: now,
        };
        for (const ref of question.discussion) discussion(tx, question, ref, a);
        tx.insert(schema.workQuestions)
          .values({
            id: question.id,
            task_id: question.task_id,
            attempt_id: question.attempt_id,
            requester_principal_id: question.requester.principal_id,
            responder_principal_id: question.responder_principal_id,
            state: question.state,
            snapshot: question,
          })
          .run();
        event(
          tx,
          "question.asked",
          attempt.resource,
          a.origin,
          { question_id: question.id, attempt_id: attempt.id, revision: 1 },
          attempt.fence,
        );
        return question;
      },
      now,
    );
  });
}
function requester(
  db: ProjectDatabase,
  q: Question,
  a: QuestionAuthority,
  now: number,
): boolean {
  const attempt = attempts.get(db, q.attempt_id);
  return (
    q.attempt_fence === attempt.fence &&
    q.requester.principal_id === a.origin.principalId &&
    q.requester.participant_id === a.origin.participantId &&
    attempts.grantValid(db, attempt, a.origin, now)
  );
}
function mutate(
  db: ProjectDatabase,
  id: string,
  operation: "answer" | "escalate" | "cancel" | "link-discussion",
  input: QuestionCommand,
  a: QuestionAuthority,
  run: (tx: ProjectTransaction, q: Question) => Question,
  now: number,
): QuestionView {
  return db.transaction((tx) => {
    const q = get(tx, id);
    const responder =
      q.responder_principal_id === a.origin.principalId &&
      (!q.escalated || a.is_owner);
    if (
      operation === "answer"
        ? !responder
        : operation === "escalate"
          ? !responder && !a.can_manage
          : !responder && !a.can_manage && !requester(tx, q, a, now)
    ) {
      // An escalation transfers ownership. Its original, still-authorized caller
      // may retrieve their receipt, but cannot perform another escalation.
      const prior =
        operation === "escalate"
          ? tx
              .select()
              .from(schema.questionReceipts)
              .where(
                eq(
                  schema.questionReceipts.key,
                  canonicalJson([
                    a.origin.principalId,
                    a.origin.participantId,
                    `${operation}:${id}`,
                    input.idempotency_key,
                  ]),
                ),
              )
              .get()
          : undefined;
      if (!prior) return deny();
      if (prior.request !== canonicalJson(input))
        throw new QuestionError(
          "question-idempotency-conflict",
          "Operation key was used for a different request",
        );
    }
    if (
      q.id !== input.question_id ||
      q.attempt_id !== input.attempt_id ||
      q.attempt_revision !== input.attempt_revision ||
      q.attempt_fence !== input.attempt_fence
    )
      throw new QuestionError(
        "question-correlation-conflict",
        "Question attempt correlation does not match",
      );
    return receipt(
      tx,
      `${operation}:${id}`,
      input,
      a,
      () => {
        if (q.revision !== input.expected_revision)
          throw new QuestionError(
            "question-precondition",
            `Current question revision is ${q.revision}`,
          );
        if (
          operation !== "link-discussion" &&
          (q.state !== "open" || q.invalidation_reason)
        )
          throw new QuestionError(
            "question-invalid-state",
            "Question is no longer open",
          );
        const updated = run(tx, {
          ...q,
          revision: q.revision + 1,
          updated_at: now,
        });
        saveQuestion(tx, updated);
        const kinds = {
          answer: "question.answered",
          escalate: "question.escalated",
          cancel: "question.cancelled",
          "link-discussion": "question.discussion_linked",
        } as const;
        event(
          tx,
          kinds[operation],
          attempts.get(tx, q.attempt_id).resource,
          a.origin,
          {
            question_id: id,
            attempt_id: q.attempt_id,
            revision: updated.revision,
          },
          q.attempt_fence,
        );
        return updated;
      },
      now,
    );
  });
}
export function answer(
  db: ProjectDatabase,
  id: string,
  raw: QuestionAnswerCommand,
  a: QuestionAuthority,
  now = Date.now(),
) {
  const input = QuestionAnswerCommandSchema.parse(raw);
  return mutate(
    db,
    id,
    "answer",
    input,
    a,
    (_tx, q) => ({
      ...q,
      state: "answered",
      answer: {
        text: input.text,
        actor: actor(a),
        revision: q.revision,
        at: now,
      },
    }),
    now,
  );
}
export function escalate(
  db: ProjectDatabase,
  id: string,
  raw: QuestionEscalateCommand,
  a: QuestionAuthority,
  now = Date.now(),
) {
  const input = QuestionEscalateCommandSchema.parse(raw);
  return mutate(
    db,
    id,
    "escalate",
    input,
    a,
    (_tx, q) => ({
      ...q,
      escalated: true,
      responder_principal_id: input.responder_principal_id,
      routing: [
        ...q.routing,
        {
          responder_principal_id: input.responder_principal_id,
          escalated: true,
          reason: input.reason,
          actor: actor(a),
          revision: q.revision,
          at: now,
        },
      ],
    }),
    now,
  );
}
export function cancel(
  db: ProjectDatabase,
  id: string,
  raw: QuestionCancelCommand,
  a: QuestionAuthority,
  now = Date.now(),
) {
  const input = QuestionCancelCommandSchema.parse(raw);
  return mutate(
    db,
    id,
    "cancel",
    input,
    a,
    (_tx, q) => ({
      ...q,
      state: "cancelled",
      invalidation_reason: input.reason,
    }),
    now,
  );
}
export function linkDiscussion(
  db: ProjectDatabase,
  id: string,
  raw: QuestionLinkCommand,
  a: QuestionAuthority,
  now = Date.now(),
) {
  const input = QuestionLinkCommandSchema.parse(raw);
  return mutate(
    db,
    id,
    "link-discussion",
    input,
    a,
    (tx, q) => {
      discussion(tx, q, input.discussion, a);
      if (
        q.discussion.some((r) => r.message_id === input.discussion.message_id)
      )
        return q;
      if (q.discussion.length >= 100)
        throw new QuestionError(
          "question-conflict",
          "Question already has 100 discussion references",
        );
      return { ...q, discussion: [...q.discussion, input.discussion] };
    },
    now,
  );
}
