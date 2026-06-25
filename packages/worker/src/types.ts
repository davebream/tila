import type { TokenResult } from "@tila/backend-d1";

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
}

// Re-export for convenience
export type { TokenResult };

export interface D1TokenResult {
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
}

export interface CookieSessionTokenResult {
  kind: "cookie-session";
  projectId: string;
  name: string;
  scopes: string;
  tokenId: string; // "" for cookie sessions
  sessionHash: string;
  expiresAt: number;
  permission: string;
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
}

export type UnifiedTokenResult =
  | D1TokenResult
  | SessionTokenResult
  | CookieSessionTokenResult
  | WorkspaceSessionTokenResult
  | OidcSessionTokenResult;

export interface HonoVariables {
  tokenResult: UnifiedTokenResult;
  projectId: string;
  doStub: DurableObjectStub;
  authKind?: "bearer" | "cookie" | "workspace";
  requestId?: string;
  source?: string;
  sourceVersion?: string | null;
  // Caller-scoped idempotency key + request-body hash, computed by the
  // idempotency middleware and forwarded to the DO so it can dedup the
  // fence-mutating write inside its own transaction (audit B1). Present only
  // for write requests that carried an Idempotency-Key.
  idempotencyKey?: string;
  idempotencyHash?: string;
}
