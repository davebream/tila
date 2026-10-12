import { z } from "zod";
import {
  AttemptAuthorityCommandSchema,
  AttemptSessionSchema,
  QueueCommandSchema,
} from "./queue";

const Id = z.string().min(1).max(256);
const Text = z.string().min(1).max(16384);
const Revision = z.number().int().positive();
export const QuestionStateSchema = z.enum([
  "open",
  "answered",
  "cancelled",
  "superseded",
]);
export const QuestionDiscussionSchema = z
  .object({ room_id: Id, message_id: z.string().uuid() })
  .strict();
export const QuestionActorSchema = z.object({
  principal_id: Id,
  participant_id: Id,
});
export const QuestionRoutingSchema = z.object({
  responder_principal_id: Id,
  escalated: z.boolean(),
  reason: Text.nullable(),
  actor: QuestionActorSchema,
  revision: Revision,
  at: z.number().int(),
});
export const QuestionAnswerSchema = z.object({
  text: Text,
  actor: QuestionActorSchema,
  revision: Revision,
  at: z.number().int(),
});
export const QuestionSchema = z.object({
  id: z.string().uuid(),
  text: Text,
  task_id: Id,
  attempt_id: Id,
  attempt_revision: Revision,
  attempt_fence: Revision,
  requester: QuestionActorSchema,
  session: AttemptSessionSchema.pick({ provider: true, id: true }).nullable(),
  requester_binding: z
    .object({
      agent_id: Id,
      consumer_binding_id: z.string().uuid(),
      binding_epoch: Revision,
    })
    .nullable(),
  responder_principal_id: Id,
  escalated: z.boolean(),
  state: QuestionStateSchema,
  revision: Revision,
  answer: QuestionAnswerSchema.nullable(),
  routing: z.array(QuestionRoutingSchema),
  discussion: z.array(QuestionDiscussionSchema),
  predecessor_id: z.string().uuid().nullable(),
  invalidation_reason: Text.nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export const QuestionViewSchema = z.object({
  question: QuestionSchema,
  /** Computed for the caller's current execution grant; never cached authority. */
  answer_applicable: z.boolean(),
});
export const QuestionAskCommandSchema = AttemptAuthorityCommandSchema.extend({
  id: z.string().uuid(),
  attempt_id: Id,
  text: Text,
  responder_principal_id: Id,
  predecessor_id: z.string().uuid().optional(),
  discussion: z.array(QuestionDiscussionSchema).max(100).default([]),
}).strict();
export const QuestionCommandSchema = QueueCommandSchema.extend({
  question_id: z.string().uuid(),
  expected_revision: Revision,
  attempt_id: Id,
  attempt_revision: Revision,
  attempt_fence: Revision,
}).strict();
export const QuestionAnswerCommandSchema = QuestionCommandSchema.extend({
  text: Text,
});
export const QuestionEscalateCommandSchema = QuestionCommandSchema.extend({
  responder_principal_id: Id,
  reason: Text,
});
export const QuestionCancelCommandSchema = QuestionCommandSchema.extend({
  reason: Text,
});
export const QuestionLinkCommandSchema = QuestionCommandSchema.extend({
  discussion: QuestionDiscussionSchema,
});
export const QuestionListQuerySchema = z
  .object({
    task_id: Id.optional(),
    attempt_id: Id.optional(),
    requester_principal_id: Id.optional(),
    responder_principal_id: Id.optional(),
    state: QuestionStateSchema.optional(),
    after_id: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const QuestionListResultSchema = z.object({
  questions: z.array(QuestionViewSchema),
  next_after_id: z.string().uuid().nullable(),
});
export const QuestionMutationSchemas = {
  ask: QuestionAskCommandSchema,
  answer: QuestionAnswerCommandSchema,
  escalate: QuestionEscalateCommandSchema,
  cancel: QuestionCancelCommandSchema,
  "link-discussion": QuestionLinkCommandSchema,
} as const;
export const QuestionRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), id: z.string().uuid() }),
  z.object({
    action: z.literal("list"),
    query: QuestionListQuerySchema.prefault({}),
  }),
  z.object({ action: z.literal("ask"), command: QuestionAskCommandSchema }),
  z.object({
    action: z.literal("answer"),
    id: z.string().uuid(),
    command: QuestionAnswerCommandSchema,
  }),
  z.object({
    action: z.literal("escalate"),
    id: z.string().uuid(),
    command: QuestionEscalateCommandSchema,
  }),
  z.object({
    action: z.literal("cancel"),
    id: z.string().uuid(),
    command: QuestionCancelCommandSchema,
  }),
  z.object({
    action: z.literal("link-discussion"),
    id: z.string().uuid(),
    command: QuestionLinkCommandSchema,
  }),
]);
export const QuestionResultSchema = z.union([
  QuestionViewSchema,
  QuestionListResultSchema,
]);
export type Question = z.infer<typeof QuestionSchema>;
export type QuestionView = z.infer<typeof QuestionViewSchema>;
export type QuestionDiscussion = z.infer<typeof QuestionDiscussionSchema>;
export type QuestionCommand = z.infer<typeof QuestionCommandSchema>;
export type QuestionAskCommand = z.input<typeof QuestionAskCommandSchema>;
export type QuestionAnswerCommand = z.infer<typeof QuestionAnswerCommandSchema>;
export type QuestionEscalateCommand = z.infer<
  typeof QuestionEscalateCommandSchema
>;
export type QuestionCancelCommand = z.infer<typeof QuestionCancelCommandSchema>;
export type QuestionLinkCommand = z.infer<typeof QuestionLinkCommandSchema>;
export type QuestionListQuery = z.input<typeof QuestionListQuerySchema>;
export type QuestionListResult = z.infer<typeof QuestionListResultSchema>;
export type QuestionRequest = z.input<typeof QuestionRequestSchema>;
