import { Hono } from "hono";
import { ensureDeploymentInstanceId } from "../lib/deployment-instance";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";

type WhoamiEnv = { Bindings: Env; Variables: HonoVariables };

export const whoami = new Hono<WhoamiEnv>();

whoami.get("/whoami", async (c) => {
  const token = c.get("tokenResult") as UnifiedTokenResult;

  // Resolve the deployment's own stable instance id (for client credential keying).
  // Best-effort: if the deployment id is unavailable (D1 outage on a cold isolate),
  // return the response without the field rather than failing the request.
  let instanceId: string | undefined;
  try {
    instanceId = await ensureDeploymentInstanceId(c.env.DB);
  } catch {
    // Non-fatal — whoami still returns all other fields
  }

  // Build response conditionally based on token kind
  const response: {
    ok: true;
    project_id: string;
    token_name: string;
    scopes: string;
    token_id: string;
    auth_kind?:
      | "d1-token"
      | "session"
      | "cookie-session"
      | "workspace-session"
      | "oidc-session";
    github_login?: string;
    permission?: string;
    expires_at?: number;
    instance_id?: string;
  } = {
    ok: true as const,
    project_id: token.projectId,
    token_name: token.name,
    scopes: token.scopes,
    token_id: token.tokenId,
    auth_kind: token.kind,
  };

  if (instanceId !== undefined) {
    response.instance_id = instanceId;
  }

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
