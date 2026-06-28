import { z } from "zod";

export const SessionPermissionSchema = z.enum(["read", "write", "admin"]);
export type SessionPermission = z.infer<typeof SessionPermissionSchema>;

/**
 * Shared base fields common to all session payload types.
 * `issued_at` has a lower bound (~year 2001 in Unix seconds) as defense-in-depth
 * against a wrong-unit mint bug: a future mint that passed Date.now() (ms) instead
 * of nowSeconds() would otherwise produce an issued_at ~1000x too large, making
 * the token look issued far in the future and silently bypassing the
 * subject-revocation kill-switch comparison (WI-C). Anything below ~1e9 is a
 * clear seconds-vs-ms mistake; fail the schema parse instead of failing open.
 */
const SessionBaseSchema = z.object({
  project_id: z.string().min(1),
  permission: SessionPermissionSchema,
  expires_at: z.number().int(),
  issued_at: z.number().int().min(1_000_000_000),
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
  /**
   * DPoP sender-constraint (WI-G, RFC 9449 §6). When present, the bearer
   * must attach a valid DPoP proof on every request. Optional for backward
   * compatibility — sessions minted before this WI omit the claim and follow
   * the legacy accept path (absent binding ⇒ no DPoP check).
   */
  cnf: z.object({ jkt: z.string().min(1) }).optional(),
});

/**
 * GitHub-backed session payload. All GitHub identity fields are required.
 * `sub_type` must be present and equal `"github"` for the discriminated union.
 * Back-compat note: tokens minted before this field was added carry no `sub_type`.
 * The auth middleware (auth.ts) default-fills `sub_type: "github"` on the raw
 * payload before the discriminated parse so legacy GitHub sessions keep validating.
 */
export const GitHubSessionPayloadSchema = SessionBaseSchema.extend({
  sub_type: z.literal("github"),
  github_host: z.string().min(1),
  github_repo_id: z.number().int(),
  github_login: z.string().min(1),
  github_user_id: z.number().int(),
});

/**
 * Generic OIDC session payload. Carries no GitHub fields by construction.
 * This makes it type-impossible for an OIDC principal to reach GitHub-coupled
 * authorization (the admin roster), which already fails closed on a missing
 * GitHub identity.
 *
 * Security A-4: `oidc_subject` max(255) is enforced at the schema layer as the
 * canonical point. The route handler also has a defense-in-depth guard.
 */
export const OidcSessionPayloadSchema = SessionBaseSchema.extend({
  sub_type: z.literal("oidc"),
  oidc_issuer: z.string().min(1),
  oidc_subject: z.string().min(1).max(255),
  actor_name: z.string().min(1).max(255),
});

/**
 * Discriminated union on `sub_type`. Callers that consume tokens minted before
 * this change must default-fill `sub_type: "github"` before parsing (auth.ts).
 */
export const SessionPayloadSchema = z.discriminatedUnion("sub_type", [
  GitHubSessionPayloadSchema,
  OidcSessionPayloadSchema,
]);
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

export const GitHubExchangeRequestSchema = z.object({
  project_id: z.string().min(1),
  github_token: z.string().min(1),
  /**
   * Optional DPoP JWK thumbprint (WI-G). When present, the minted session
   * will carry a `cnf: { jkt }` claim. The bearer must then attach a DPoP
   * proof on every request.
   */
  jkt: z.string().min(1).optional(),
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

/**
 * Response body for the generic OIDC exchange route (`POST /api/auth/oidc/exchange`).
 * Mirrors `GitHubExchangeResponseSchema` but carries OIDC identity fields instead of
 * GitHub fields.
 */
export const OidcExchangeResponseSchema = z.object({
  ok: z.literal(true),
  session_token: z.string(),
  expires_at: z.number().int(),
  project_id: z.string(),
  oidc_issuer: z.string(),
  oidc_subject: z.string(),
  permission: SessionPermissionSchema,
  /**
   * Stable deployment instance id. Optional for the same back-compat reason as
   * `GitHubExchangeResponseSchema.instance_id`.
   */
  instance_id: z.string().optional(),
});
export type OidcExchangeResponse = z.infer<typeof OidcExchangeResponseSchema>;

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
  /**
   * Optional DPoP JWK thumbprint (WI-G). When present, the minted session
   * will carry a `cnf: { jkt }` claim. OIDC exchange (`OidcExchangeRequestSchema`)
   * does NOT accept `jkt` — CI runners have no persistent key holder.
   */
  jkt: z.string().min(1).optional(),
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
