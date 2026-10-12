import { z } from "zod";

export const QueueCommandSchema = z.object({
  idempotency_key: z.string().min(1).max(256),
});
export const QueueRevisionCommandSchema = QueueCommandSchema.extend({
  expected_revision: z.number().int().nonnegative(),
});
export const QueueRetryPolicySchema = z
  .object({
    retry_safe: z.boolean().default(false),
    max_attempts: z.number().int().min(1).max(100).default(3),
    initial_backoff_ms: z.number().int().min(1).default(5_000),
    max_backoff_ms: z.number().int().min(1).default(300_000),
  })
  .refine((value) => value.max_backoff_ms >= value.initial_backoff_ms, {
    message: "Maximum retry backoff must be at least the initial backoff",
  });
export const QueuePolicySchema = z.object({
  enabled: z.boolean(),
  paused: z.boolean(),
  execution_limit: z.number().int().positive().nullable(),
  wip_limit: z.number().int().positive().nullable(),
  lease_ms: z.number().int().min(1_000).max(86_400_000),
  revision: z.number().int().nonnegative(),
});
export const QueueEntrySchema = z.object({
  id: z.string(),
  task_id: z.string(),
  state: z.enum(["queued", "admitted", "finished", "withdrawn"]),
  priority: z.number().int(),
  enqueue_order: z.number().int(),
  required_capabilities: z.array(z.string()),
  target_principal: z.string().nullable(),
  retry_policy: QueueRetryPolicySchema,
  revision: z.number().int().positive(),
  available_at: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export const AttemptStateSchema = z.enum([
  "reserved",
  "starting",
  "running",
  "suspended",
  "resume_pending",
  "uncertain",
  "terminal",
]);
export const AttemptSessionSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  host_id: z.string().optional(),
  worktree: z.string().optional(),
  url: z.url().optional(),
});
export const AttemptOutcomeSchema = z.object({
  status: z.enum(["success", "failure", "cancelled", "abandoned"]),
  reason: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  /** True only after the adapter has established that execution has stopped. */
  execution_stopped: z.boolean(),
  unresolved_external_execution: z.boolean().default(false),
});
export const WorkAttemptSchema = z.object({
  id: z.string(),
  entry_id: z.string(),
  task_id: z.string(),
  resource: z.string(),
  principal_id: z.string(),
  participant_id: z.string(),
  state: AttemptStateSchema,
  revision: z.number().int().positive(),
  fence: z.number().int().positive(),
  lease_expires_at: z.number().int().nullable(),
  accepted_at: z.number().int().nullable(),
  session: AttemptSessionSchema.nullable(),
  checkpoint: z.record(z.string(), z.unknown()).nullable(),
  cancellation_requested: z.boolean(),
  suspension_requested: z.boolean(),
  predecessor_id: z.string().nullable(),
  outcome: AttemptOutcomeSchema.nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  finished_at: z.number().int().nullable(),
});
export const AttemptAuthorityCommandSchema = QueueRevisionCommandSchema.extend({
  fence: z.number().int().positive(),
});
export const AttemptStartedCommandSchema = AttemptAuthorityCommandSchema.extend(
  {
    session: AttemptSessionSchema,
  },
);
export const AttemptFinishCommandSchema = AttemptAuthorityCommandSchema.extend({
  outcome: AttemptOutcomeSchema,
});
export const AttemptViewSchema = z.object({
  attempt: WorkAttemptSchema,
  /** Current authority, recomputed even for a deduplicated command. */
  grant_valid: z.boolean(),
});
export type QueuePolicy = z.infer<typeof QueuePolicySchema>;
export type QueueEntry = z.infer<typeof QueueEntrySchema>;
export type QueueRetryPolicy = z.infer<typeof QueueRetryPolicySchema>;
export type AttemptState = z.infer<typeof AttemptStateSchema>;
export type AttemptSession = z.infer<typeof AttemptSessionSchema>;
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;
export type WorkAttempt = z.infer<typeof WorkAttemptSchema>;
export type AttemptView = z.infer<typeof AttemptViewSchema>;
export type QueueCommand = z.infer<typeof QueueCommandSchema>;
export type QueueRevisionCommand = z.infer<typeof QueueRevisionCommandSchema>;
export type AttemptAuthorityCommand = z.infer<
  typeof AttemptAuthorityCommandSchema
>;
export type AttemptStartedCommand = z.infer<typeof AttemptStartedCommandSchema>;
export type AttemptFinishCommand = z.infer<typeof AttemptFinishCommandSchema>;
