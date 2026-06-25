import { z } from "zod";

export const SessionPermissionSchema = z.enum(["read", "write", "admin"]);
export type SessionPermission = z.infer<typeof SessionPermissionSchema>;

/**
 * Claims shared by every minted tila session token, regardless of how the
 * principal authenticated. The session JWT always carries iss/aud="tila"
 * (stamped by mintSessionToken); `jti` is the per-token revocation nonce (C9);
 * `instance_id` binds the token to a specific deployment (B2 replay defense).
 */
const SessionBaseSchema = z.object({
  project_id: z.string().min(1),
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
   * `_deployment_meta` D1 singleton. Minted into every bearer session JWT to
   * allow cross-deployment replay detection (B2). Optional for backward
   * compatibility with tokens minted before instance binding; legacy tokens
   * without the claim are still accepted during the transition window.
   */
  instance_id: z.string().optional(),
});

/**
 * Session minted from a GitHub-scoped exchange (Actions OIDC, App user token,
 * or PAT). Carries the GitHub repo/user identity consumed by the admin-grants
 * roster. `sub_type` is the discriminator; legacy tokens minted before the
 * discriminator existed omit it and are treated as "github" by the auth
 * middleware before parsing.
 */
export const GitHubSessionPayloadSchema = SessionBaseSchema.extend({
  sub_type: z.literal("github"),
  github_host: z.string().min(1),
  github_repo_id: z.number().int(),
  github_login: z.string().min(1),
  github_user_id: z.number().int(),
});
export type GitHubSessionPayload = z.infer<typeof GitHubSessionPayloadSchema>;

/**
 * Session minted from a generic (non-GitHub) OIDC exchange (WI-B2). Carries the
 * upstream OIDC issuer + subject and a display actor name, but deliberately NO
 * GitHub identity — this makes it structurally impossible for an OIDC principal
 * to reach the GitHub-coupled admin-grants roster.
 */
export const OidcSessionPayloadSchema = SessionBaseSchema.extend({
  sub_type: z.literal("oidc"),
  oidc_issuer: z.string().min(1),
  oidc_subject: z.string().min(1).max(255),
  actor_name: z.string().min(1).max(255),
});
export type OidcSessionPayload = z.infer<typeof OidcSessionPayloadSchema>;

/**
 * The minted-and-verified session JWT payload. A discriminated union on
 * `sub_type` so a GitHub session and an OIDC session never share a shape and a
 * single safeParse narrows to the correct variant. The auth middleware
 * default-fills an absent `sub_type` to "github" before parsing so that legacy
 * GitHub tokens (minted before the discriminator) keep validating.
 */
export const SessionPayloadSchema = z.discriminatedUnion("sub_type", [
  GitHubSessionPayloadSchema,
  OidcSessionPayloadSchema,
]);
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

export const OidcExchangeResponseSchema = z.object({
  ok: z.literal(true),
  session_token: z.string(),
  expires_at: z.number().int(),
  project_id: z.string(),
  oidc_issuer: z.string(),
  oidc_subject: z.string(),
  permission: SessionPermissionSchema,
  /**
   * Stable deployment instance id (parity with GitHubExchangeResponseSchema),
   * so multi-instance clients can key stored credentials by deployment id.
   * Optional for the same idempotency-replay transition reason.
   */
  instance_id: z.string().optional(),
});
export type OidcExchangeResponse = z.infer<typeof OidcExchangeResponseSchema>;
