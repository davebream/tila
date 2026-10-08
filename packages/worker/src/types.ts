import type { TokenResult } from "@tila/backend-d1";
import type { CredentialPolicy } from "@tila/schemas";
import type {
  EnvironmentMetadata,
  MembershipSource,
  ProjectRole,
} from "@tila/schemas";
import type { RequestTiming } from "./lib/server-timing";

export interface Env {
  DB: D1Database;
  PROJECT: DurableObjectNamespace;
  ARTIFACTS: R2Bucket;
  ANALYTICS: AnalyticsEngineDataset;
  CORS_ALLOWED_ORIGINS?: string;
  UI_ORIGIN?: string;
  GITHUB_SESSION_HMAC_KEY?: string;
  // Optional secret: when set, bearer/session tokens are hashed with keyed
  // HMAC-SHA-256 instead of plain SHA-256 (see lib/hash-token.ts).
  HASH_PEPPER?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_OIDC_AUDIENCE?: string;
  SWEEP_SECRET?: string;
  // Optional infra-owner admin secret. When set, the infra admin sub-router
  // accepts a matching bearer to operate on ANY project by slug (no per-project
  // token). When unset, those endpoints return 404 (invisible). See routes/infra.ts.
  INFRA_ADMIN_TOKEN?: string;
  // Optional override (seconds) for the step-up reauthentication window applied
  // to high-impact membership/credential mutations from cookie sessions. See
  // STEP_UP_MAX_AGE_SECONDS_DEFAULT in config.ts and middleware/protected-operation.ts.
  STEP_UP_MAX_AGE_SECONDS?: string;
}

// Re-export for convenience
export type { TokenResult };

export interface ScopedAuth {
  principalId?: string;
  credentialId?: string;
  policy?: CredentialPolicy;
  expiresAt?: number | null;
  cnfJkt?: string | null;
}

export interface D1TokenResult extends ScopedAuth {
  kind: "d1-token";
  projectId: string;
  name: string;
  scopes: string;
  tokenId: string;
}

export interface SessionTokenResult {
  kind: "session";
  projectId: string;
  name: string;
  scopes: string;
  tokenId: string;
  githubRepoId: number;
  githubLogin: string;
  permission: string;
  expiresAt: number;
  // Optional immutable identity from the verified JWT payload, used by the
  // admin-grants roster lookup. Optional so existing kind:"session" test
  // factories stay valid; production always populates both from parsed.data.
  githubUserId?: number;
  githubHost?: string;
  // JWT ID from the verified payload. Used by the permission re-check helper
  // (Layer B, WI-H) to key the per-isolate rate-limit cache, and threaded by the
  // WI-C subject-revocation gate. Optional so existing test factories that don't
  // set a jti stay valid.
  jti?: string;
  role?: ProjectRole;
  membershipSources?: MembershipSource[];
}

export interface CookieSessionTokenResult
  extends Omit<ScopedAuth, "expiresAt"> {
  kind: "cookie-session";
  projectId: string;
  name: string;
  scopes: string;
  tokenId: string; // "" for cookie sessions
  sessionHash: string;
  expiresAt: number;
  permission: string;
  principalId?: string;
  role?: ProjectRole;
  membershipSources?: MembershipSource[];
  sourceRepoId?: number;
  /** Unix ms of the last interactive authentication (step-up reauth, #102). */
  authenticatedAt?: number;
  /** How the holder authenticated: GitHub OAuth or a presented project token. */
  authMethod?: "github" | "token";
}

export interface WorkspaceSessionTokenResult {
  kind: "workspace-session";
  projectId: string; // "" until project selected
  name: string; // GitHub login (same as actorName in _sessions)
  scopes: string; // "" until project selected
  tokenId: string; // ""
  sessionHash: string;
  githubLogin: string; // derived from name/actorName
  expiresAt: number; // milliseconds
  principalId?: string;
  /** Unix ms of the last interactive authentication (carried into the project session). */
  authenticatedAt?: number;
}

/**
 * Token result for a generic (non-GitHub) OIDC session.
 * Carries no GitHub fields by construction — an OIDC principal is structurally
 * unreachable from the admin-roster path (require-project-admin.ts).
 * Created by the /api/auth/oidc/exchange route (Phase 4).
 */
export interface OidcSessionTokenResult {
  kind: "oidc-session";
  projectId: string;
  name: string;
  scopes: string;
  tokenId: ""; // always empty — OIDC sessions have no D1 token row
  permission: string;
  expiresAt: number;
  oidcIssuer: string;
  oidcSubject: string;
  jti?: string;
  role?: ProjectRole;
  membershipSources?: MembershipSource[];
}

export type UnifiedTokenResult =
  | D1TokenResult
  | SessionTokenResult
  | CookieSessionTokenResult
  | WorkspaceSessionTokenResult
  | OidcSessionTokenResult;

export interface HonoVariables {
  requestTiming?: RequestTiming;
  tokenResult: UnifiedTokenResult;
  projectId: string;
  doStub: DurableObjectStub;
  authKind?: "bearer" | "cookie" | "workspace";
  requestId?: string;
  source?: string;
  sourceVersion?: string | null;
  principalId?: string;
  participantId?: string;
  environment?: EnvironmentMetadata;
  effectiveRole?: ProjectRole;
  explicitRole?: ProjectRole;
  protectedRoleChecked?: ProjectRole;

  credentialPolicy?: CredentialPolicy;
  authorizationChecked?: boolean;
  membershipSources?: MembershipSource[];
  membershipRepoId?: number;
  // Caller-scoped idempotency key + request-body hash, computed by the
  // idempotency middleware and forwarded to the DO so it can dedup the
  // fence-mutating write inside its own transaction (audit B1). Present only
  // for write requests that carried an Idempotency-Key.
  idempotencyKey?: string;
  idempotencyHash?: string;
}
