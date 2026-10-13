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
  /** Assigner identity; null for enrollments recorded before it was captured. */
  enrolled_by_principal: z.string().nullable().default(null),
  enrolled_by_participant: z.string().nullable().default(null),
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
  /** Principal that enrolled the work; it may request cancellation and recovery. */
  assigner_principal_id: z.string().nullable().optional(),
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
  task_id: z.string().optional(),
  state: z
    .enum(["backlog", "active", "suspended", "uncertain", "terminal"])
    .optional(),
  type: z.string().optional(),
  target_principal: z.string().optional(),
  capability: z.string().optional(),
  priority: z.number().int().optional(),
  /** `expired`: the latest attempt is starting or running past its lease. */
  lease: z.literal("expired").optional(),
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
export const QueueDiagnosticsSchema = z.object({
  since: z.number().int(),
  until: z.number().int(),
  source: z.literal("retained_journal"),
  grant_denials: z.record(z.string(), z.number().int().nonnegative()),
  expired_reservations: z.number().int().nonnegative(),
  uncertainty_events: z.number().int().nonnegative(),
  reconciliations: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  forced_abandonments: z.number().int().nonnegative(),
  expired_execution_leases: z.number().int().nonnegative(),
});
export const QueueInspectionSchema = z.object({
  diagnostics: QueueDiagnosticsSchema.optional(),
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

export const AttemptSuspendCommandSchema = AttemptAuthorityCommandSchema.extend(
  {
    execution_quiescent: z.literal(true),
    checkpoint: z.record(z.string(), z.unknown()),
  },
);
export const AttemptResumeCommandSchema = QueueRevisionCommandSchema.extend({
  capabilities: CapabilitiesSchema.default([]),
});
export const AttemptReconcileCommandSchema = QueueRevisionCommandSchema.extend({
  observation: z.enum(["unknown", "running", "stopped", "suspended"]),
  execution_quiescent: z.literal(true).optional(),
  checkpoint: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().min(1),
  session: AttemptSessionSchema.optional(),
  outcome: AttemptOutcomeSchema.optional(),
});
export const AttemptRebindCommandSchema = QueueRevisionCommandSchema.extend({
  reason: z.string().min(1),
  principal_id: z.string().min(1),
  participant_id: z.string().min(1),
  session: AttemptSessionSchema,
});
export const AttemptForceCommandSchema = QueueRevisionCommandSchema.extend({
  reason: z.string().min(1),
});
export const AttemptRetryCommandSchema = QueueRevisionCommandSchema.extend({
  reason: z.string().min(1),
});
export const AttemptResumeResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("granted"), ...AttemptViewSchema.shape }),
  z.object({
    kind: z.literal("no_grant"),
    reason: z.enum(["disabled", "paused", "blocked", "execution_capacity"]),
    ...AttemptViewSchema.shape,
  }),
]);
export type AttemptSuspendCommand = z.infer<typeof AttemptSuspendCommandSchema>;
export type AttemptResumeCommand = z.input<typeof AttemptResumeCommandSchema>;
export type AttemptReconcileCommand = z.infer<
  typeof AttemptReconcileCommandSchema
>;
export type AttemptRebindCommand = z.infer<typeof AttemptRebindCommandSchema>;
export type AttemptForceCommand = z.infer<typeof AttemptForceCommandSchema>;
export type AttemptRetryCommand = z.infer<typeof AttemptRetryCommandSchema>;
export type AttemptResumeResult = z.infer<typeof AttemptResumeResultSchema>;

export const AttemptListQuerySchema = z.object({
  task_id: z.string().optional(),
  entry_id: z.string().optional(),
  state: AttemptStateSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});
export type AttemptListQuery = z.input<typeof AttemptListQuerySchema>;
/** Shared transport contracts. Scheduling remains in the project backend. */
export const QueueMutationSchemas = {
  configure: QueueConfigureCommandSchema,
  enroll: QueueEnrollCommandSchema,
  edit: QueueEditCommandSchema,
  withdraw: QueueRevisionCommandSchema,
  claim: QueueClaimCommandSchema,
} as const;
export const AttemptMutationSchemas = {
  accept: AttemptAuthorityCommandSchema,
  started: AttemptStartedCommandSchema,
  heartbeat: AttemptAuthorityCommandSchema,
  finish: AttemptFinishCommandSchema,
  "request-suspension": QueueRevisionCommandSchema,
  "confirm-suspension": AttemptSuspendCommandSchema,
  "request-resume": QueueRevisionCommandSchema,
  "claim-resume": AttemptResumeCommandSchema,
  "request-cancellation": QueueRevisionCommandSchema,
  reconcile: AttemptReconcileCommandSchema,
  rebind: AttemptRebindCommandSchema,
  retry: AttemptRetryCommandSchema,
  "force-recovery": AttemptForceCommandSchema,
} as const;

export const QueueRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("policy") }),
  z.object({
    action: z.literal("inspect"),
    query: QueueListQuerySchema.prefault({}),
  }),
  z.object({
    action: z.literal("configure"),
    command: QueueConfigureCommandSchema,
  }),
  z.object({ action: z.literal("enroll"), command: QueueEnrollCommandSchema }),
  z.object({
    action: z.literal("edit"),
    id: z.string().min(1),
    command: QueueEditCommandSchema,
  }),
  z.object({
    action: z.literal("withdraw"),
    id: z.string().min(1),
    command: QueueRevisionCommandSchema,
  }),
  z.object({ action: z.literal("claim"), command: QueueClaimCommandSchema }),
]);
export const AttemptRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), id: z.string().min(1) }),
  z.object({
    action: z.literal("list"),
    query: AttemptListQuerySchema.prefault({}),
  }),
  z.object({
    action: z.literal("accept"),
    id: z.string().min(1),
    command: AttemptAuthorityCommandSchema,
  }),
  z.object({
    action: z.literal("started"),
    id: z.string().min(1),
    command: AttemptStartedCommandSchema,
  }),
  z.object({
    action: z.literal("heartbeat"),
    id: z.string().min(1),
    command: AttemptAuthorityCommandSchema,
  }),
  z.object({
    action: z.literal("finish"),
    id: z.string().min(1),
    command: AttemptFinishCommandSchema,
  }),
  z.object({
    action: z.literal("request-suspension"),
    id: z.string().min(1),
    command: QueueRevisionCommandSchema,
  }),
  z.object({
    action: z.literal("confirm-suspension"),
    id: z.string().min(1),
    command: AttemptSuspendCommandSchema,
  }),
  z.object({
    action: z.literal("request-resume"),
    id: z.string().min(1),
    command: QueueRevisionCommandSchema,
  }),
  z.object({
    action: z.literal("claim-resume"),
    id: z.string().min(1),
    command: AttemptResumeCommandSchema,
  }),
  z.object({
    action: z.literal("request-cancellation"),
    id: z.string().min(1),
    command: QueueRevisionCommandSchema,
  }),
  z.object({
    action: z.literal("reconcile"),
    id: z.string().min(1),
    command: AttemptReconcileCommandSchema,
  }),
  z.object({
    action: z.literal("rebind"),
    id: z.string().min(1),
    command: AttemptRebindCommandSchema,
  }),
  z.object({
    action: z.literal("retry"),
    id: z.string().min(1),
    command: AttemptRetryCommandSchema,
  }),
  z.object({
    action: z.literal("force-recovery"),
    id: z.string().min(1),
    command: AttemptForceCommandSchema,
  }),
]);
export const QueueResultSchema = z.union([
  QueuePolicySchema,
  QueueInspectionSchema,
  QueueEntrySchema,
  QueueClaimResultSchema,
]);
export const AttemptResultSchema = z.union([
  AttemptViewSchema,
  WorkAttemptSchema.array(),
  AttemptResumeResultSchema,
]);
export type QueueRequest = z.input<typeof QueueRequestSchema>;
export type AttemptRequest = z.input<typeof AttemptRequestSchema>;
