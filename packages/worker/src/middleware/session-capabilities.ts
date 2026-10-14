import type { Capability, SessionCapabilities } from "@tila/schemas";
import type { Context } from "hono";
import type { Env, HonoVariables } from "../types";
import { scopedPolicy } from "./capability";
import { resolveTokenMembership } from "./membership";
import { stepUpMaxAgeMs } from "./protected-operation";
import { principalIdFor } from "./request-identity";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/**
 * Server-computed management capabilities for the current session (#102).
 *
 * The browser renders membership and credential controls only when the
 * matching flag is true. The rules mirror the route guards exactly:
 *
 * - `memberships_manage`: `requireProjectOwner` + `capabilityMiddleware`
 *   (`memberships:manage`) on `/projects/:id/memberships*`.
 * - `credentials_manage`: `credentialManagementGuard(c, "tokens:revoke")`
 *   on `/api/tokens/:name`.
 *
 * Both require explicit owner authority. A role mirrored from GitHub can never
 * grant ownership (`authorizeProtectedOperation`), a legacy `scopes:"full"`
 * cookie session without an explicit owner membership is not an owner, and
 * `permission === "admin"` is never consulted. A full D1 bootstrap token passes
 * both guards and therefore reports both flags true.
 *
 * Fails closed: when membership resolution throws, both flags are false and
 * `membership_available` is false so the UI can render an "unavailable" state
 * instead of silently hiding controls.
 */
export async function computeSessionCapabilities(
  c: Context<AppEnv>,
): Promise<SessionCapabilities> {
  const token = c.get("tokenResult");
  const base: SessionCapabilities = {
    memberships_manage: false,
    credentials_manage: false,
    ...NO_OWNER_EDITORS,
    membership_available: true,
    step_up_max_age_seconds: Math.floor(stepUpMaxAgeMs(c.env) / 1000),
  };
  if (token.kind === "cookie-session") {
    base.auth_method = token.authMethod;
    base.authenticated_at = token.authenticatedAt;
  }
  if (token.kind === "workspace-session" || !token.projectId) return base;
  if (token.kind === "d1-token" && !token.policy) {
    const full = token.scopes === "full";
    return full ? { ...base, ...ownerEditors(() => true) } : base;
  }
  // Sessions without a canonical identity cannot pass the protected-operation
  // guards (`requireRevocableSession` / `principalIdFor`).
  try {
    principalIdFor(token);
  } catch {
    return base;
  }
  if (token.kind === "cookie-session" && !token.sessionHash) return base;

  let membership: Awaited<ReturnType<typeof resolveTokenMembership>>;
  try {
    membership = await resolveTokenMembership(
      c.env.DB,
      token,
      token.projectId,
      c.env.GITHUB_ACTIONS_TRUSTED_ISSUERS,
    );
  } catch {
    return { ...base, membership_available: false };
  }
  if (!membership || membership.role !== "owner") return base;

  const policy = scopedPolicy(c);
  if (policy) {
    // Scoped credential: owner membership plus the capability in its policy.
    if (policy.role !== "owner") return base;
    return {
      ...base,
      ...ownerEditors((cap) => policy.capabilities.includes(cap)),
      // Runtime administration requires an interactive or bootstrap owner.
      runtime_access_manage: false,
    };
  }
  // Interactive session: ownership must be explicit, never mirrored.
  if (membership.explicitRole !== "owner") return base;
  return { ...base, ...ownerEditors(() => true) };
}

const NO_OWNER_EDITORS = {
  credentials_read: false,
  credentials_issue: false,
  credentials_rotate: false,
  credentials_revoke: false,
  service_accounts_manage: false,
  workload_bindings_manage: false,
  repository_policy_manage: false,
  project_configure: false,
  runtime_access_manage: false,
} satisfies Partial<SessionCapabilities>;

/** Owner-level editor flags, each tied to the capability its route checks. */
function ownerEditors(has: (cap: Capability) => boolean) {
  return {
    memberships_manage: has("memberships:manage"),
    credentials_manage: has("tokens:revoke"),
    credentials_read: has("tokens:read"),
    credentials_issue: has("tokens:issue"),
    credentials_rotate: has("tokens:rotate"),
    credentials_revoke: has("tokens:revoke"),
    service_accounts_manage: has("service-accounts:manage"),
    workload_bindings_manage: has("workload-bindings:manage"),
    repository_policy_manage: has("repository-policy:manage"),
    project_configure: has("project:configure"),
    runtime_access_manage: true,
  };
}
