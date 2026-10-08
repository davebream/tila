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

/**
 * Management capabilities the server computed for the current session (#102).
 * The browser renders membership/credential controls only from these flags;
 * it never infers them from `permission`, `canManageTokens` or token scopes.
 */
export const SessionCapabilitiesSchema = z.object({
  /** Caller may grant, change and revoke project memberships. */
  memberships_manage: z.boolean(),
  /** Caller may list and revoke scoped credentials. */
  credentials_manage: z.boolean(),
  /** False when the membership store could not be consulted (fail closed). */
  membership_available: z.boolean(),
  /** How an interactive cookie session authenticated; absent for bearer auth. */
  auth_method: z.enum(["github", "token"]).optional(),
  /** Unix ms of the last interactive authentication; absent for bearer auth. */
  authenticated_at: z.number().optional(),
  /** Step-up window applied to high-impact mutations from cookie sessions. */
  step_up_max_age_seconds: z.number().int().positive(),
});
export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;

export const SessionStatusResponseSchema = z.object({
  ok: z.literal(true),
  projectId: z.string(),
  /** Legacy snapshot; not a management signal. Use `capabilities`. */
  permission: z.string(),
  /** Legacy, inferred from permission. Use `capabilities.credentials_manage`. */
  canManageTokens: z.boolean(),
  capabilities: SessionCapabilitiesSchema,
});
export type SessionStatusResponse = z.infer<typeof SessionStatusResponseSchema>;
