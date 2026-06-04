import { z } from "zod";

export const GateAwaitTypeSchema = z.enum([
  "ci",
  "pr",
  "timer",
  "human",
  "webhook",
]);
export type GateAwaitType = z.infer<typeof GateAwaitTypeSchema>;

export const GateStatusSchema = z.enum([
  "pending",
  "resolved",
  "timed_out",
  "cancelled",
]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const GateSchema = z.object({
  id: z.string(),
  resource: z.string(),
  await_type: GateAwaitTypeSchema,
  status: GateStatusSchema,
  fence: z.number().int(),
  timeout_at: z.number().int().nullable(),
  resolved_at: z.number().int().nullable(),
  resolution: z.string().nullable(),
  created_at: z.number().int(),
  created_by: z.string(),
  token_id: z.string().nullable().optional(),
  data: z.record(z.unknown()),
});
export type Gate = z.infer<typeof GateSchema>;

export const CreateGateRequestSchema = z.object({
  resource: z.string(),
  await_type: GateAwaitTypeSchema,
  fence: z.number().int(),
  timeout_at: z.number().int().optional(),
  data: z.record(z.unknown()).optional(),
});
export type CreateGateRequest = z.infer<typeof CreateGateRequestSchema>;

export const ResolveGateRequestSchema = z.object({
  resolution: z.string().optional(),
});
export type ResolveGateRequest = z.infer<typeof ResolveGateRequestSchema>;

export const GateResponseSchema = z.object({
  ok: z.literal(true),
  gate: GateSchema,
});
export type GateResponse = z.infer<typeof GateResponseSchema>;

export const GateListResponseSchema = z.object({
  ok: z.literal(true),
  gates: z.array(GateSchema),
});
export type GateListResponse = z.infer<typeof GateListResponseSchema>;
