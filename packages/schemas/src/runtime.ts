import { z } from "zod";
import { CredentialPolicySchema } from "./capability";
import { ParticipantIdSchema } from "./identity";

export const RUNTIME_PROTOCOL = 1;
export const RUN_TOKEN_TTL_SECONDS = 15 * 60;
export const RUN_LEASE_SECONDS = 5 * 60;
export const RUN_HEARTBEAT_SECONDS = 60;
export const RUN_RENEW_BEFORE_SECONDS = 120;
export const RUN_OVERLAP_SECONDS = 60;
export const INVITATION_TTL_SECONDS = 10 * 60;
export const RuntimePurposeSchema = z.enum(["enrollment", "run"]);
export const RuntimeEnrollmentRequestSchema = z
  .object({
    operation_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    name: z.string().min(1).max(100),
    jkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    policy: CredentialPolicySchema.optional(),
  })
  .strict();
export const RuntimeInvitationRequestSchema = z
  .object({
    name: z.string().min(1).max(100),
    policy: CredentialPolicySchema.optional(),
  })
  .strict();
export const RuntimeRedeemRequestSchema = RuntimeEnrollmentRequestSchema.extend(
  {
    invitation: z.string().min(32).max(512),
  },
);
export const RuntimeRunRequestSchema = z
  .object({
    operation_id: z.string().uuid(),
    jkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    policy: CredentialPolicySchema.optional(),
  })
  .strict();
export const RuntimeRenewRequestSchema = z
  .object({
    expected_token_id: z.string().uuid(),
  })
  .strict();
export const RuntimeEnrollmentSchema = z.object({
  enrollment_id: z.string().uuid(),
  project_id: z.string(),
  installation_id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(["personal", "shared"]),
  principal_id: z.string(),
  sponsor_id: z.string().nullable(),
  policy: CredentialPolicySchema,
  created_at: z.number(),
  revoked_at: z.number().nullable(),
});
export const RuntimeRunSchema = z.object({
  run_id: z.string().uuid(),
  project_id: z.string(),
  enrollment_id: z.string().uuid().nullable(),
  workload_binding_id: z.string().nullable(),
  principal_id: z.string(),
  participant_id: ParticipantIdSchema,
  policy: CredentialPolicySchema,
  state: z.enum(["active", "closed", "revoked", "expired"]),
  lease_expires_at: z.number(),
  created_at: z.number(),
  current_token_id: z.string().uuid(),
});
export const RuntimeContextSchema = z.object({
  ok: z.literal(true),
  protocol: z.literal(RUNTIME_PROTOCOL),
  instance_id: z.string().uuid(),
  project_id: z.string(),
  purpose: RuntimePurposeSchema,
  principal_id: z.string(),
  enrollment_id: z.string().uuid().nullable(),
  workload_binding_id: z.string().nullable(),
  run_id: z.string().uuid().nullable(),
  participant_id: ParticipantIdSchema.nullable(),
  policy: CredentialPolicySchema,
  token_id: z.string().uuid(),
  expires_at: z.number().nullable(),
  lease_expires_at: z.number().nullable(),
});
export const RuntimeRunContextSchema = RuntimeContextSchema.extend({
  purpose: z.literal("run"),
  run_id: z.string().uuid(),
  participant_id: ParticipantIdSchema,
  expires_at: z.number(),
  lease_expires_at: z.number(),
});
export type RuntimeRunContext = z.infer<typeof RuntimeRunContextSchema>;
export const RuntimeCredentialResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string(),
  context: RuntimeContextSchema,
});
export const RuntimeEnrollmentsResponseSchema = z.object({
  ok: z.literal(true),
  enrollments: z.array(RuntimeEnrollmentSchema),
});
export const RuntimeRunsResponseSchema = z.object({
  ok: z.literal(true),
  runs: z.array(RuntimeRunSchema),
});
export const RuntimeInvitationResponseSchema = z.object({
  ok: z.literal(true),
  invitation: z.string(),
  expires_at: z.number(),
});
export type RuntimeContext = z.infer<typeof RuntimeContextSchema>;
export type RuntimeEnrollment = z.infer<typeof RuntimeEnrollmentSchema>;
export type RuntimeRun = z.infer<typeof RuntimeRunSchema>;
export type RuntimeEnrollmentRequest = z.infer<
  typeof RuntimeEnrollmentRequestSchema
>;
export type RuntimeRunRequest = z.infer<typeof RuntimeRunRequestSchema>;
export type RuntimeCredentialResponse = z.infer<
  typeof RuntimeCredentialResponseSchema
>;

export const RuntimeRunCredentialResponseSchema =
  RuntimeCredentialResponseSchema.extend({ context: RuntimeRunContextSchema });
