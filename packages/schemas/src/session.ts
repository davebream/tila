import { z } from "zod";

export const SessionPermissionSchema = z.enum(["read", "write", "admin"]);
export type SessionPermission = z.infer<typeof SessionPermissionSchema>;

export const SessionPayloadSchema = z.object({
  project_id: z.string().min(1),
  github_host: z.string().min(1),
  github_repo_id: z.number().int(),
  github_login: z.string().min(1),
  github_user_id: z.number().int(),
  permission: SessionPermissionSchema,
  expires_at: z.number().int(),
  issued_at: z.number().int(),
  iss: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  /**
   * JWT ID — a random nonce added to every newly minted session token (C9).
   * Optional for backward compatibility with tokens minted before this field
   * was added. Tokens without jti are not revocable via the revocation store.
   */
  jti: z.string().optional(),
  /**
   * Stable deployment instance id — a crypto.randomUUID() stored in
   * `_deployment_meta` D1 singleton. Minted into every bearer session JWT
   * (kind: "session") to allow cross-deployment replay detection (B2).
   * Optional for backward compatibility with tokens minted before this WI;
   * legacy tokens without the claim are still accepted during the transition.
   */
  instance_id: z.string().optional(),
});
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

export const GitHubExchangeRequestSchema = z.object({
  project_id: z.string().min(1),
  github_token: z.string().min(1),
});
export type GitHubExchangeRequest = z.infer<typeof GitHubExchangeRequestSchema>;

export const GitHubExchangeResponseSchema = z.object({
  ok: z.literal(true),
  session_token: z.string(),
  expires_at: z.number().int(),
  project_id: z.string(),
  github_login: z.string(),
  github_repo_id: z.number().int(),
  permission: SessionPermissionSchema,
  /**
   * Stable deployment instance id. Included in the login response so clients
   * can key stored credentials by deployment id rather than by URL (US-CLIENT).
   * Optional for backward compatibility: a stale _idempotency cache entry
   * created before this WI deploys will replay a response WITHOUT instance_id
   * for up to the JWT TTL window. The JWT claim itself is always present for
   * freshly minted tokens. (WI-J2/T11 consumers should expect a possible
   * transient miss on the response-body field.)
   */
  instance_id: z.string().optional(),
});
export type GitHubExchangeResponse = z.infer<
  typeof GitHubExchangeResponseSchema
>;

export const GitHubAppInstallationConfigSchema = z.object({
  project_id: z.string().min(1),
  installation_id: z.number().int().positive(),
});
export type GitHubAppInstallationConfig = z.infer<
  typeof GitHubAppInstallationConfigSchema
>;

export const GitHubAppExchangeRequestSchema = z.object({
  project_id: z.string().min(1),
  user_token: z.string().min(1),
  auth_method: z.literal("user_token"),
});
export type GitHubAppExchangeRequest = z.infer<
  typeof GitHubAppExchangeRequestSchema
>;

export const GitHubAppInfoResponseSchema = z.object({
  app_id: z.number().int(),
  client_id: z.string().min(1),
});
export type GitHubAppInfoResponse = z.infer<typeof GitHubAppInfoResponseSchema>;

export const OidcExchangeRequestSchema = z.object({
  project_id: z.string().min(1),
  oidc_token: z.string().min(1),
});
export type OidcExchangeRequest = z.infer<typeof OidcExchangeRequestSchema>;
