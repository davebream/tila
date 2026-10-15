import { z } from "zod";
import { JournalResponseSchema, SummaryResponseSchema } from "./api";
import { ClaimSchema } from "./claim";
import {
  CustomEventNameSchema,
  JournalCorrelationIdSchema,
} from "./custom-journal";
import { IdentityContextSchema } from "./identity";
import { SignalSchema } from "./signal";

export const JournalSequenceSchema = z.number().int().nonnegative().safe();
/**
 * Sequences one filtered replay request may examine, however few events match.
 * A whole number of maximum (200-event) pages, so clients page the whole
 * history by following `next_after_seq` while `has_more` is true.
 */
export const JOURNAL_REPLAY_SCAN_BUDGET = 1000;
const JournalReplayWindowSchema = z.object({
  after_seq: JournalSequenceSchema,
  through_seq: JournalSequenceSchema.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
/**
 * `event_name` and `correlation_id` select project reports (`custom.reported`)
 * by exact value after the examined range's history is verified complete. With
 * either filter `limit` caps returned matches, not examined sequences, and a
 * page may be empty while `has_more` is true.
 */
export const JournalReplayRequestSchema = JournalReplayWindowSchema.extend({
  event_name: CustomEventNameSchema.optional(),
  correlation_id: JournalCorrelationIdSchema.optional(),
});
export type JournalReplayRequest = z.input<typeof JournalReplayRequestSchema>;
// Replay includes archived history and never reports the list's watermark.
export const JournalReplayResponseSchema = JournalResponseSchema.omit({
  archived: true,
  lastArchivedSeq: true,
}).extend({
  next_after_seq: JournalSequenceSchema,
  through_seq: JournalSequenceSchema,
  has_more: z.boolean(),
});
export type JournalReplayResponse = z.infer<typeof JournalReplayResponseSchema>;
export const JournalCursorSchema = z.object({
  seq: JournalSequenceSchema,
  updated_at: z.number().int().nullable(),
});
export type JournalCursor = z.infer<typeof JournalCursorSchema>;
export const JournalAcknowledgeRequestSchema = z
  .object({ seq: JournalSequenceSchema })
  .strict();

const ReferenceId = z.string().min(1).max(2048);
export const HandoffReferenceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task"), id: ReferenceId }),
  z.object({
    type: z.literal("record"),
    record_type: ReferenceId,
    key: ReferenceId,
  }),
  z.object({ type: z.literal("artifact"), key: ReferenceId }),
  z.object({
    type: z.literal("claim"),
    resource: ReferenceId,
    fence: JournalSequenceSchema,
  }),
]);
export const HandoffCreateRequestSchema = z
  .object({
    // Caller-generated ID makes retries safe across transports and process restarts.
    id: z.string().uuid(),
    // Omission means work without changing legacy serialized retry requests.
    kind: z.enum(["work", "shutdown"]).optional(),
    summary: z.string().min(1).max(16384),
    current_state: z.record(z.string(), z.unknown()).default({}),
    findings: z.array(z.string().max(16384)).max(100).default([]),
    unresolved_questions: z.array(z.string().max(16384)).max(100).default([]),
    based_on_seq: JournalSequenceSchema,
    references: z.array(HandoffReferenceSchema).max(100).default([]),
    supersedes_id: z.string().uuid().optional(),
  })
  .strict();
export type HandoffCreateRequest = z.input<typeof HandoffCreateRequestSchema>;
export const HandoffSchema = HandoffCreateRequestSchema.extend({
  creator: IdentityContextSchema,
  created_at: z.number().int(),
  created_seq: JournalSequenceSchema,
  active_claims: z.array(ClaimSchema),
});
export type Handoff = z.infer<typeof HandoffSchema>;
export const HandoffListRequestSchema = z.object({
  resource: ReferenceId.optional(),
  before_seq: JournalSequenceSchema.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HandoffListRequest = z.input<typeof HandoffListRequestSchema>;
export const HandoffListResponseSchema = z.object({
  ok: z.literal(true),
  handoffs: z.array(HandoffSchema),
  next_before_seq: JournalSequenceSchema.nullable(),
});
export type HandoffListResponse = z.infer<typeof HandoffListResponseSchema>;
// Re-entry recovers context in order: it never takes replay filters.
export const ReentryRequestSchema = JournalReplayWindowSchema.partial()
  .extend({
    handoff_id: z.string().uuid().optional(),
    resource: ReferenceId.optional(),
  })
  .refine((value) => !(value.handoff_id && value.resource), {
    message: "Specify handoff_id or resource, not both",
  });
export type ReentryRequest = z.input<typeof ReentryRequestSchema>;
export const ReentryResponseSchema = z.object({
  ok: z.literal(true),
  summary: SummaryResponseSchema.shape.project,
  changes: JournalReplayResponseSchema,
  active_claims: z.array(ClaimSchema),
  pending_signals: z.array(SignalSchema),
  handoff: HandoffSchema.nullable(),
});
export type ReentryResponse = z.infer<typeof ReentryResponseSchema>;
