import type { MembershipSource, ProjectRole } from "@tila/schemas";
import { Hono } from "hono";
import { ensureDeploymentInstanceId } from "../lib/deployment-instance";
import { compatibilityPolicy, scopedPolicy } from "../middleware/capability";
import { resolveTokenMembership } from "../middleware/membership";
import { principalIdFor } from "../middleware/request-identity";
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
      | "oidc-session"
      | "github-actions-session";
    github_login?: string;
    permission?: string;
    expires_at?: number | null;
    instance_id?: string;
    role?: ProjectRole;
    explicit_role?: ProjectRole;
    membership_sources?: MembershipSource[];
    mirrored_repo_id?: number;
    principal_id?: string;
    credential_id?: string;
    policy?: import("@tila/schemas").CredentialPolicy;
    legacy?: boolean;
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

  if (token.projectId) {
    try {
      const membership = await resolveTokenMembership(
        c.env.DB,
        token,
        token.projectId,
      );
      if (membership) {
        response.role = membership.role;
        response.membership_sources = membership.sources;
        if (membership.explicitRole)
          response.explicit_role = membership.explicitRole;
        if (membership.mirroredRepoId !== undefined)
          response.mirrored_repo_id = membership.mirroredRepoId;
      }
    } catch {
      // Best-effort identity inspection; guarded project routes still fail closed.
    }
  }

  // Add session-specific fields
  if (token.kind === "session") {
    response.github_login = token.githubLogin;
    response.permission = token.permission;
    response.expires_at = token.expiresAt;
  } else if (
    token.kind === "cookie-session" ||
    token.kind === "oidc-session" ||
    token.kind === "github-actions-session" ||
    (token.kind === "d1-token" && token.policy)
  ) {
    response.expires_at = token.expiresAt;
  }

  try {
    response.principal_id = principalIdFor(token);
  } catch {
    /* Legacy sessions may lack canonical identity; they cannot mutate. */
  }
  const policy = scopedPolicy(c);
  response.policy =
    policy ?? (response.role ? compatibilityPolicy(response.role) : undefined);
  response.legacy = !policy;
  if (
    (token.kind === "d1-token" || token.kind === "cookie-session") &&
    token.credentialId
  )
    response.credential_id = token.credentialId;
  return c.json(response);
});
