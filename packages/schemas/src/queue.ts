import { z } from "zod";
import { WorkBlockReasonSchema } from "./readiness";

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

export const QueueConfigureCommandSchema = QueueRevisionCommandSchema.extend({
  enabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  execution_limit: z.number().int().positive().optional(),
  wip_limit: z.number().int().positive().nullable().optional(),
  lease_ms: z.number().int().min(1_000).max(86_400_000).optional(),
});
const CapabilitiesSchema = z.array(z.string().min(1).max(128)).max(100);
export const QueueEnrollCommandSchema = QueueCommandSchema.extend({
  task_id: z.string().min(1),
  priority: z.number().int().default(0),
  required_capabilities: CapabilitiesSchema.default([]),
  target_principal: z.string().min(1).nullable().default(null),
  retry_policy: QueueRetryPolicySchema.prefault({}),
});
export const QueueEditCommandSchema = QueueRevisionCommandSchema.extend({
  priority: z.number().int().optional(),
  required_capabilities: CapabilitiesSchema.optional(),
  target_principal: z.string().min(1).nullable().optional(),
});
export const QueueClaimCommandSchema = QueueCommandSchema.extend({
  capabilities: CapabilitiesSchema.default([]),
  types: z.array(z.string().min(1)).optional(),
});
export const QueueListQuerySchema = z.object({
  state: z
    .enum(["backlog", "active", "suspended", "uncertain", "terminal"])
    .optional(),
  type: z.string().optional(),
  target_principal: z.string().optional(),
  capability: z.string().optional(),
  priority: z.number().int().optional(),
  capabilities: CapabilitiesSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});
export const QueueBlockReasonSchema = z.object({
  code: z.enum([
    ...WorkBlockReasonSchema.shape.code.options,
    "retry-backoff",
    "target-mismatch",
    "capability-mismatch",
    "live-claim",
    "attempt-active",
    "execution-unresolved",
  ]),
  resource: z.string(),
  state: z.string().optional(),
  path: z.array(z.string()).optional(),
});
export const QueueEntryViewSchema = z.object({
  entry: QueueEntrySchema,
  task: z
    .object({
      id: z.string(),
      type: z.string(),
      data: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  attempt: WorkAttemptSchema.nullable(),
  block_reasons: z.array(QueueBlockReasonSchema),
});
export const QueueCountsSchema = z.object({
  backlog: z.number().int(),
  active: z.number().int(),
  suspended: z.number().int(),
  uncertain: z.number().int(),
  terminal: z.number().int(),
  execution: z.number().int(),
  wip: z.number().int(),
  oldest_waiting_age_ms: z.number().int().nullable(),
});
export const QueueInspectionSchema = z.object({
  policy: QueuePolicySchema,
  counts: QueueCountsSchema,
  entries: z.array(QueueEntryViewSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  effective_capabilities: z.array(z.string()),
});
export const QueueClaimResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("granted"),
    entry: QueueEntrySchema,
    ...AttemptViewSchema.shape,
    policy_revision: z.number().int(),
  }),
  z.object({
    kind: z.literal("no_grant"),
    reason: z.enum([
      "disabled",
      "paused",
      "empty",
      "blocked",
      "execution_capacity",
      "wip_capacity",
    ]),
    message: z.string(),
    policy_revision: z.number().int(),
  }),
]);
export type QueueConfigureCommand = z.infer<typeof QueueConfigureCommandSchema>;
export type QueueEnrollCommand = z.input<typeof QueueEnrollCommandSchema>;
export type QueueEditCommand = z.infer<typeof QueueEditCommandSchema>;
export type QueueClaimCommand = z.input<typeof QueueClaimCommandSchema>;
export type QueueListQuery = z.input<typeof QueueListQuerySchema>;
export type QueueBlockReason = z.infer<typeof QueueBlockReasonSchema>;
export type QueueEntryView = z.infer<typeof QueueEntryViewSchema>;
export type QueueCounts = z.infer<typeof QueueCountsSchema>;
export type QueueInspection = z.infer<typeof QueueInspectionSchema>;
export type QueueClaimResult = z.infer<typeof QueueClaimResultSchema>;
