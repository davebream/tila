import type { TokenResult } from "@tila/backend-d1";

export interface Env {
  DB: D1Database;
  PROJECT: DurableObjectNamespace;
  ARTIFACTS: R2Bucket;
  ANALYTICS: AnalyticsEngineDataset;
  CORS_ALLOWED_ORIGINS?: string;
  UI_ORIGIN?: string;
  GITHUB_SESSION_HMAC_KEY?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_OIDC_AUDIENCE?: string;
  SWEEP_SECRET?: string;
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
}

export interface CookieSessionTokenResult {
  kind: "cookie-session";
  projectId: string;
  name: string;
  scopes: string;
  tokenId: string; // "" for cookie sessions
  sessionHash: string;
  expiresAt: number;
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

export type UnifiedTokenResult =
  | D1TokenResult
  | SessionTokenResult
  | CookieSessionTokenResult
  | WorkspaceSessionTokenResult;

export interface HonoVariables {
  tokenResult: UnifiedTokenResult;
  projectId: string;
  doStub: DurableObjectStub;
  authKind?: "bearer" | "cookie" | "workspace";
  requestId?: string;
  source?: string;
  sourceVersion?: string | null;
}
