import { z } from "zod";
import { EnvironmentMetadataSchema, ParticipantIdSchema } from "./identity";

const PrincipalIdSchema = z.string().min(1).max(2048);
export const SignalGroupIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const SignalKindSchema = z.enum([
  "conflict",
  "ready",
  "info",
  "request",
]);
export type SignalKind = z.infer<typeof SignalKindSchema>;

export const SignalTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("participant"),
    principal_id: PrincipalIdSchema,
    participant_id: ParticipantIdSchema,
  }),
  z.object({
    type: z.literal("principal"),
    principal_id: PrincipalIdSchema,
  }),
  z.object({ type: z.literal("group"), group_id: SignalGroupIdSchema }),
  z.object({ type: z.literal("broadcast") }),
]);
export type SignalTarget = z.infer<typeof SignalTargetSchema>;

export const SignalIdentitySchema = z.object({
  principal_id: PrincipalIdSchema,
  participant_id: ParticipantIdSchema,
  display_name: z.string().min(1).max(255).nullable().default(null),
  environment: EnvironmentMetadataSchema.default({}),
});
export type SignalIdentity = z.infer<typeof SignalIdentitySchema>;

export const SignalDeliverySchema = z.object({
  recipient: SignalIdentitySchema,
  acknowledged_at: z.number().nullable(),
  acknowledged_by: SignalIdentitySchema.nullable(),
});
export type SignalDelivery = z.infer<typeof SignalDeliverySchema>;

export const SignalSchema = z.object({
  id: z.string(),
  target: SignalTargetSchema,
  kind: SignalKindSchema,
  resource: z.string().nullish(),
  payload: z.unknown(),
  sender: SignalIdentitySchema,
  created_at: z.number(),
  expires_at: z.number(),
  deliveries: z.array(SignalDeliverySchema),
});
export type Signal = z.infer<typeof SignalSchema>;

export const SendSignalRequestSchema = z.object({
  target: SignalTargetSchema,
  kind: SignalKindSchema,
  resource: z.string().optional(),
  payload: z.unknown().optional(),
  ttl_ms: z.number().int().min(1000).max(86_400_000).optional(),
});
export type SendSignalRequest = z.infer<typeof SendSignalRequestSchema>;

export const SendSignalResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  recipient_count: z.number().int().nonnegative(),
});
export type SendSignalResponse = z.infer<typeof SendSignalResponseSchema>;

export const InboxResponseSchema = z.object({
  ok: z.literal(true),
  signals: z.array(SignalSchema),
});
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

export const SignalHistoryResponseSchema = z.object({
  ok: z.literal(true),
  signals: z.array(SignalSchema),
  next_cursor: z.string().nullable(),
});
export type SignalHistoryResponse = z.infer<typeof SignalHistoryResponseSchema>;

export const AckSignalResponseSchema = z.object({ ok: z.literal(true) });
export type AckSignalResponse = z.infer<typeof AckSignalResponseSchema>;

export const SignalGroupSchema = z.object({
  id: SignalGroupIdSchema,
  name: z.string().min(1).max(128),
  principal_ids: z.array(PrincipalIdSchema),
  created_at: z.number(),
  updated_at: z.number(),
});
export type SignalGroup = z.infer<typeof SignalGroupSchema>;

export const SetSignalGroupRequestSchema = z.object({
  name: z.string().min(1).max(128),
  principal_ids: z.array(PrincipalIdSchema).max(500),
});
export type SetSignalGroupRequest = z.infer<typeof SetSignalGroupRequestSchema>;

export const SignalGroupResponseSchema = z.object({
  ok: z.literal(true),
  group: SignalGroupSchema,
});
export type SignalGroupResponse = z.infer<typeof SignalGroupResponseSchema>;

export const SignalGroupsResponseSchema = z.object({
  ok: z.literal(true),
  groups: z.array(SignalGroupSchema),
});
export type SignalGroupsResponse = z.infer<typeof SignalGroupsResponseSchema>;
