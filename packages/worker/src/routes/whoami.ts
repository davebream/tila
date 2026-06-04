import { Hono } from "hono";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";

type WhoamiEnv = { Bindings: Env; Variables: HonoVariables };

export const whoami = new Hono<WhoamiEnv>();

whoami.get("/whoami", (c) => {
  const token = c.get("tokenResult") as UnifiedTokenResult;

  // Build response conditionally based on token kind
  const response: {
    ok: true;
    project_id: string;
    token_name: string;
    scopes: string;
    token_id: string;
    auth_kind?: "d1-token" | "session" | "cookie-session" | "workspace-session";
    github_login?: string;
    permission?: string;
    expires_at?: number;
  } = {
    ok: true as const,
    project_id: token.projectId,
    token_name: token.name,
    scopes: token.scopes,
    token_id: token.tokenId,
    auth_kind: token.kind,
  };

  // Add session-specific fields
  if (token.kind === "session") {
    response.github_login = token.githubLogin;
    response.permission = token.permission;
    response.expires_at = token.expiresAt;
  } else if (token.kind === "cookie-session") {
    response.expires_at = token.expiresAt;
  }

  return c.json(response);
});
