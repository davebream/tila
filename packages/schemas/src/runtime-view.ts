import { z } from "zod";
import { AgentIdSchema, AgentSchema } from "./agent";
import {
  AgentBindingSummarySchema,
  AgentRunRoleSchema,
  ConsumerBindingSchema,
} from "./agent-binding";
import { EnvironmentMetadataSchema, ParticipantIdSchema } from "./identity";
import { PresenceSchema } from "./presence";

/** Two run IDs per row keep a page within one or two D1 lookups. */
export const RUNTIME_VIEW_MAX_LIMIT = 50;
export const RUNTIME_VIEW_DEFAULT_LIMIT = 25;
/** Presence rows older than this are stale; matches the presence API TTL. */
export const RUNTIME_PRESENCE_TTL_MS = 60_000;

export const RuntimeViewQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(RUNTIME_VIEW_MAX_LIMIT)
      .default(RUNTIME_VIEW_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(200).optional(),
    agent: AgentIdSchema.optional(),
  })
  .strict();

export const RuntimeSourceStatusSchema = z.enum([
  "ok",
  "unavailable",
  "forbidden",
]);

export const RuntimeBindingSummarySchema = AgentBindingSummarySchema.extend({
  updated_at: z.number(),
});
export const RuntimeBindingSchema = z.discriminatedUnion("detail", [
  ConsumerBindingSchema.extend({ detail: z.literal("full") }),
  RuntimeBindingSummarySchema.extend({ detail: z.literal("redacted") }),
]);

/**
 * Authority facts that decide whether the occupant still holds the mailbox.
 * D1 owns run state and leases; the binding lease is only a snapshot. These
 * fields carry no identities, so they are safe on redacted rows.
 */
export const RuntimeAuthoritySchema = z.object({
  /** Where the lease came from. Anything but "run" is a stale DO snapshot. */
  source: z.enum(["run", "run-source-unavailable", "run-not-found"]),
  run_state: z.enum(["active", "closed", "revoked", "unknown"]),
  /** Unix seconds. */
  lease_expires_at: z.number().nullable(),
  enrollment_revoked: z.boolean().nullable(),
});

const UnknownReasonSchema = z.enum(["source-unavailable", "not-found"]);

export const RuntimeRunObservationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("visible"),
    run_id: z.string().uuid(),
    run_role: AgentRunRoleSchema,
    enrollment_id: z.string().uuid().nullable(),
    workload_binding_id: z.string().nullable(),
    principal_id: z.string(),
    participant_id: ParticipantIdSchema,
    state: z.enum(["active", "closed", "revoked"]),
    lease_expires_at: z.number(),
    created_at: z.number(),
  }),
  z.object({ status: z.literal("redacted") }),
  z.object({ status: z.literal("unknown"), reason: UnknownReasonSchema }),
]);

export const RuntimeHostObservationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("enrollment"),
    enrollment_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    name: z.string(),
    kind: z.enum(["personal", "shared"]),
    created_at: z.number(),
    revoked_at: z.number().nullable(),
  }),
  z.object({ status: z.literal("workload"), workload_binding_id: z.string() }),
  z.object({ status: z.literal("redacted") }),
  z.object({ status: z.literal("unknown"), reason: UnknownReasonSchema }),
]);

export const RuntimePresenceObservationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("reported"),
    /** Milliseconds. */
    last_seen: z.number(),
    active: z.boolean(),
    environment: EnvironmentMetadataSchema,
  }),
  z.object({ status: z.literal("not-reported") }),
  z.object({ status: z.literal("redacted") }),
  z.object({ status: z.literal("forbidden") }),
]);

/** Mailbox occupancy. Never describes task progress or completion. */
export const RuntimeLifecycleSchema = z.enum([
  "attached",
  "expired",
  "replaced",
  "released",
  "unbound",
  "unknown",
]);
export const RuntimeHostLivenessSchema = z.enum([
  "online",
  "stale",
  "offline",
  "unknown",
]);
export const RuntimeObservationReasonSchema = z.enum([
  "run-lease-lapsed",
  "run-closed",
  "run-revoked",
  "host-enrollment-revoked",
  "run-source-unavailable",
  "run-not-found",
  "epoch-mismatch",
  "replaced-run-still-active",
]);
export const RuntimeObservationSchema = z.object({
  lifecycle: RuntimeLifecycleSchema,
  detail: z.enum(["full", "redacted"]),
  host_liveness: RuntimeHostLivenessSchema,
  liveness_basis: z.enum(["presence", "run-lease", "none"]),
  reasons: z.array(RuntimeObservationReasonSchema),
  /** Milliseconds: latest binding change or heartbeat. */
  last_observed_at: z.number().nullable(),
  /** Milliseconds: next clock-driven transition, if any. */
  changes_at: z.number().nullable(),
});

export const RuntimeOccupantSchema = z.object({
  binding: RuntimeBindingSchema,
  authority: RuntimeAuthoritySchema,
  run: RuntimeRunObservationSchema,
  host: RuntimeHostObservationSchema,
  presence: RuntimePresenceObservationSchema,
  observation: RuntimeObservationSchema,
});

const UnsupportedHostCommandSchema = z.object({
  supported: z.literal(false),
  reason: z.literal("no-host-adapter-command"),
});
export const RuntimeCommandsSchema = z.object({
  release: z.object({
    supported: z.literal(true),
    allowed: z.boolean(),
    expected_epoch: z.number().int().positive().nullable(),
    consumer_binding_id: z.string().uuid().nullable(),
    denied_reason: z
      .enum(["no-active-binding", "permission-denied", "capability-missing"])
      .nullable(),
  }),
  reconnect: UnsupportedHostCommandSchema,
  stop: UnsupportedHostCommandSchema,
});

export const RuntimeViewRowSchema = z.object({
  agent: z.object({
    id: AgentIdSchema,
    name: z.string(),
    binding_epoch: z.number().int().nonnegative(),
  }),
  current: RuntimeOccupantSchema.nullable(),
  /** Latest binding that no longer holds the mailbox. */
  previous: RuntimeOccupantSchema.nullable(),
  /** Reserved for work attempts (#303). Never inferred from runtime state. */
  work_attempt: z.null(),
  commands: RuntimeCommandsSchema,
});

export const RuntimeViewSourcesSchema = z.object({
  agents: RuntimeSourceStatusSchema,
  runs: RuntimeSourceStatusSchema,
  enrollments: RuntimeSourceStatusSchema,
  presence: RuntimeSourceStatusSchema,
});

export const RuntimeViewResponseSchema = z.object({
  ok: z.literal(true),
  /** Milliseconds. Clients derive clock skew from it. */
  server_now: z.number(),
  sources: RuntimeViewSourcesSchema,
  rows: z.array(RuntimeViewRowSchema),
  next_cursor: z.string().nullable(),
});

// Internal Worker-to-DO envelope. Bindings are unredacted here; the Worker
// redacts them before any response leaves it.
const RuntimePagePresenceSchema = PresenceSchema.omit({ info: true });
const RuntimePageOccupantSchema = z.object({
  binding: ConsumerBindingSchema,
  detail: z.enum(["full", "redacted"]),
  presence: RuntimePagePresenceSchema.nullable(),
});
export const AgentRuntimePageSchema = z.object({
  rows: z.array(
    z.object({
      agent: AgentSchema.pick({ id: true, name: true, binding_epoch: true }),
      current: RuntimePageOccupantSchema.extend({
        release_authorized: z.boolean(),
      }).nullable(),
      previous: RuntimePageOccupantSchema.nullable(),
    }),
  ),
  next_after: AgentIdSchema.nullable(),
});

export type RuntimeViewQuery = z.infer<typeof RuntimeViewQuerySchema>;
export type RuntimeSourceStatus = z.infer<typeof RuntimeSourceStatusSchema>;
export type RuntimeBinding = z.infer<typeof RuntimeBindingSchema>;
export type RuntimeBindingSummary = z.infer<typeof RuntimeBindingSummarySchema>;
export type RuntimeAuthority = z.infer<typeof RuntimeAuthoritySchema>;
export type RuntimeRunObservation = z.infer<typeof RuntimeRunObservationSchema>;
export type RuntimeHostObservation = z.infer<
  typeof RuntimeHostObservationSchema
>;
export type RuntimePresenceObservation = z.infer<
  typeof RuntimePresenceObservationSchema
>;
export type RuntimeLifecycle = z.infer<typeof RuntimeLifecycleSchema>;
export type RuntimeHostLiveness = z.infer<typeof RuntimeHostLivenessSchema>;
export type RuntimeObservationReason = z.infer<
  typeof RuntimeObservationReasonSchema
>;
export type RuntimeObservation = z.infer<typeof RuntimeObservationSchema>;
export type RuntimeOccupant = z.infer<typeof RuntimeOccupantSchema>;
export type RuntimeCommands = z.infer<typeof RuntimeCommandsSchema>;
export type RuntimeViewRow = z.infer<typeof RuntimeViewRowSchema>;
export type RuntimeViewSources = z.infer<typeof RuntimeViewSourcesSchema>;
export type RuntimeViewResponse = z.infer<typeof RuntimeViewResponseSchema>;
export type AgentRuntimePage = z.infer<typeof AgentRuntimePageSchema>;
