import { z } from "zod";

export const SessionExchangeRequestSchema = z.object({
  token: z.string().min(1),
  project_id: z.string().min(1),
});
export type SessionExchangeRequest = z.infer<
  typeof SessionExchangeRequestSchema
>;

export const SessionExchangeResponseSchema = z.object({ ok: z.literal(true) });
export type SessionExchangeResponse = z.infer<
  typeof SessionExchangeResponseSchema
>;

export const SessionStatusResponseSchema = z.object({
  ok: z.literal(true),
  projectId: z.string(),
  permission: z.string(),
  canManageTokens: z.boolean(),
});
export type SessionStatusResponse = z.infer<typeof SessionStatusResponseSchema>;
