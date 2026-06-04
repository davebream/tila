import { z } from "zod";

export const SignalKindSchema = z.enum([
  "conflict",
  "ready",
  "info",
  "request",
]);
export type SignalKind = z.infer<typeof SignalKindSchema>;

export const SignalSchema = z.object({
  id: z.string(),
  target: z.string(),
  kind: SignalKindSchema,
  resource: z.string().nullish(),
  payload: z.unknown(),
  created_by: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  acked_at: z.number().nullable(),
});
export type Signal = z.infer<typeof SignalSchema>;

export const SendSignalRequestSchema = z.object({
  target: z.string().min(1),
  kind: SignalKindSchema,
  resource: z.string().optional(),
  payload: z.unknown().optional(),
  ttl_ms: z.number().int().min(1000).max(86_400_000).optional(),
});
export type SendSignalRequest = z.infer<typeof SendSignalRequestSchema>;

export const SendSignalResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
});
export type SendSignalResponse = z.infer<typeof SendSignalResponseSchema>;

export const InboxResponseSchema = z.object({
  ok: z.literal(true),
  signals: z.array(SignalSchema),
});
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

export const AckSignalResponseSchema = z.object({
  ok: z.literal(true),
});
export type AckSignalResponse = z.infer<typeof AckSignalResponseSchema>;
