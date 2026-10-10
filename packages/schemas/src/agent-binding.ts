import { z } from "zod";
import { AgentIdSchema, AgentSchema } from "./agent";

export const AgentRunRoleSchema = z.enum(["acting", "relay"]);
export const CapabilityReportSchema = z.object({
  protocol: z.literal(1),
  adapter_version: z.string().max(100),
  harness_version: z.string().max(100).optional(),
  runtime_version: z.string().max(100).optional(),
  capabilities: z.record(
    z.string().regex(/^io\.tila\/[a-z0-9._-]+$/),
    z.boolean(),
  ),
});
export const ProfileEvidenceSchema = z
  .object({
    profile_id: AgentIdSchema,
    profile_revision: z.number().int().positive(),
    account_ref: z.string().min(1).max(256),
    verification: z.enum(["declared", "unknown"]),
  })
  .strict();
export const NativeSessionRefSchema = z
  .object({
    host_ref: z.string().min(1).max(256),
    harness: z.string().min(1).max(100),
    profile_id: AgentIdSchema,
    session_id: z.string().min(1).max(512),
  })
  .strict();
export const AttachAgentBindingSchema = z
  .object({
    expected_epoch: z.number().int().nonnegative(),
    acting_run_id: z.string().uuid().optional(),
    harness: z.string().min(1).max(100),
    native_session_ref: NativeSessionRefSchema.nullable().default(null),
    profile: ProfileEvidenceSchema.nullable().default(null),
    capability_report: CapabilityReportSchema,
    mechanism: z
      .enum(["poll", "native-peer", "native-queue", "terminal"])
      .default("poll"),
    attended: z.boolean().default(true),
    allow_idle_start: z.boolean().default(false),
  })
  .strict();

// Internal Worker-to-DO envelope. Never accepted from a public request body or
// merged into IdentityContextSchema. Lease timestamps use runtime seconds.
export const RuntimeIdentitySchema = z
  .object({
    run_id: z.string().uuid(),
    agent_id: AgentIdSchema.nullable(),
    run_role: AgentRunRoleSchema,
    principal_id: z.string(),
    participant_id: z.string(),
    enrollment_id: z.string().uuid().nullable(),
    workload_binding_id: z.string().nullable(),
    lease_expires_at: z.number(),
  })
  .strict();
export const ConsumerBindingSchema = z.object({
  consumer_binding_id: z.string().uuid(),
  agent_id: AgentIdSchema,
  binding_epoch: z.number().int().positive(),
  holder: z.object({
    kind: z.literal("run"),
    run_id: z.string().uuid(),
    enrollment_id: z.string().uuid().nullable(),
    workload_binding_id: z.string().nullable(),
  }),
  principal_id: z.string(),
  participant_id: z.string(),
  host_ref: z.string().nullable(),
  harness: z.string(),
  native_session_ref: NativeSessionRefSchema.nullable(),
  profile: ProfileEvidenceSchema.nullable(),
  capability_report: CapabilityReportSchema,
  mechanism: AttachAgentBindingSchema.shape.mechanism,
  attended: z.boolean(),
  allow_idle_start: z.boolean(),
  state: z.enum(["active", "replaced", "released", "expired"]),
  lease_expires_at: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;
export type ConsumerBinding = z.infer<typeof ConsumerBindingSchema>;
export type AttachAgentBinding = z.infer<typeof AttachAgentBindingSchema>;
export type ProfileEvidence = z.infer<typeof ProfileEvidenceSchema>;
export type CapabilityReport = z.infer<typeof CapabilityReportSchema>;

export const AgentBindingSummarySchema = ConsumerBindingSchema.pick({
  consumer_binding_id: true,
  agent_id: true,
  binding_epoch: true,
  state: true,
  mechanism: true,
  lease_expires_at: true,
});
export const AgentViewSchema = z.object({
  agent: AgentSchema,
  binding: z
    .union([ConsumerBindingSchema, AgentBindingSummarySchema])
    .nullable(),
});
export const AgentListResponseSchema = z.object({
  ok: z.literal(true),
  agents: z.array(AgentViewSchema),
});
export const AgentGetResponseSchema = AgentViewSchema.extend({
  ok: z.literal(true),
});
export const AgentRegistrationResponseSchema = z.object({
  ok: z.literal(true),
  agent: AgentSchema,
});
export const AgentBindingResponseSchema = z.object({
  ok: z.literal(true),
  binding: z.union([ConsumerBindingSchema, AgentBindingSummarySchema]),
});
