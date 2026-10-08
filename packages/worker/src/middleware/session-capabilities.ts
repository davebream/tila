import type { SessionCapabilities } from "@tila/schemas";
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
    return { ...base, memberships_manage: full, credentials_manage: full };
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
    membership = await resolveTokenMembership(c.env.DB, token, token.projectId);
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
      memberships_manage: policy.capabilities.includes("memberships:manage"),
      credentials_manage: policy.capabilities.includes("tokens:revoke"),
    };
  }
  // Interactive session: ownership must be explicit, never mirrored.
  if (membership.explicitRole !== "owner") return base;
  return { ...base, memberships_manage: true, credentials_manage: true };
}
