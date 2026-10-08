import {
  PROJECT_ROLE_RANK,
  type ProjectRole,
  roleToPermission,
} from "@tila/schemas";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { STEP_UP_MAX_AGE_SECONDS_DEFAULT } from "../config";
import {
  permissionRecheckResponse,
  reverifySessionPermission,
} from "../lib/permission-recheck";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };
const requiredRoles = new WeakMap<MiddlewareHandler<AppEnv>, ProjectRole>();

/** Record authorization requirements so response replay cannot bypass route guards. */
export function withRequiredRole(
  role: ProjectRole,
  guard: MiddlewareHandler<AppEnv>,
): MiddlewareHandler<AppEnv> {
  requiredRoles.set(guard, role);
  return guard;
}

export function isProtectedMutation(method: string, path: string): boolean {
  return (
    ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    !(method === "POST" && /^\/projects\/[^/]+\/schema\/preview\/?$/.test(path))
  );
}

export function requireRevocableSession(c: Context<AppEnv>): Response | null {
  const token = c.get("tokenResult");
  if (
    ((token.kind === "session" || token.kind === "oidc-session") &&
      !token.jti) ||
    (token.kind === "cookie-session" &&
      (!token.sessionHash || !token.principalId))
  ) {
    return c.json(
      {
        ok: false,
        error: {
          code: "unauthorized",
          message: "Session has no revocation identity; sign in again.",
          retryable: false,
        },
      },
      401,
    );
  }
  return null;
}

/** Current explicit authority is sufficient on its own; mirrored authority needs GitHub. */
export async function authorizeProtectedOperation(
  c: Context<AppEnv>,
  required: ProjectRole,
): Promise<Response | null> {
  const token = c.get("tokenResult");
  const denied = () =>
    c.json(
      {
        ok: false,
        error: {
          code: "permission-denied",
          message: `Requires ${required} role`,
          retryable: false,
        },
      },
      403,
    );
  if (
    (token.kind === "d1-token" || token.kind === "cookie-session") &&
    token.policy &&
    c.get("credentialPolicy")
  ) {
    return PROJECT_ROLE_RANK[token.policy.role] >= PROJECT_ROLE_RANK[required]
      ? null
      : denied();
  }
  if (token.kind === "d1-token")
    return token.scopes === "full" ? null : denied();
  const invalid = requireRevocableSession(c);
  if (invalid) return invalid;
  const checked = c.get("protectedRoleChecked");
  if (checked && PROJECT_ROLE_RANK[checked] >= PROJECT_ROLE_RANK[required])
    return null;
  const role = c.get("effectiveRole");
  if (role && PROJECT_ROLE_RANK[role] < PROJECT_ROLE_RANK[required])
    return denied();
  const explicit = c.get("explicitRole");
  if (explicit && PROJECT_ROLE_RANK[explicit] >= PROJECT_ROLE_RANK[required]) {
    c.set("protectedRoleChecked", required);
    return null;
  }
  // GitHub cannot grant ownership, and OIDC authority comes exclusively from Tila.
  if (
    required === "owner" ||
    (token.kind !== "session" && token.kind !== "cookie-session")
  )
    return denied();
  const verdict = await reverifySessionPermission(
    c,
    token,
    roleToPermission(required),
  );
  if (verdict.decision === "deny") return permissionRecheckResponse(c, verdict);
  c.set("protectedRoleChecked", required);
  return null;
}

/** Mounted before maintenance, idempotency and response caching. */
export function protectedOperationMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get("authorizationChecked")) return next();
    let required: ProjectRole | undefined = isProtectedMutation(
      c.req.method,
      c.req.path,
    )
      ? "participant"
      : undefined;
    for (const route of matchedRoutes(c)) {
      const role = requiredRoles.get(
        route.handler as MiddlewareHandler<AppEnv>,
      );
      if (
        role &&
        (required || PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK.maintainer) &&
        (!required || PROJECT_ROLE_RANK[role] > PROJECT_ROLE_RANK[required])
      )
        required = role;
    }
    if (required) {
      const denied = await authorizeProtectedOperation(c, required);
      if (denied) return denied;
    }
    return next();
  };
}

// ─── Step-up reauthentication (#102) ────────────────────────────────────────
//
// High-impact membership and credential mutations made from an interactive
// cookie session require a recent authentication. Bearer credentials (D1
// tokens, scoped credentials, GitHub/OIDC JWT sessions) and cookie sessions
// exchanged from a scoped credential cannot re-authenticate interactively, so
// they are exempt; their protection is the explicit-owner/capability gate.

/** Routes that call `requireFreshAuthentication` / mount `stepUpGuard`. */
export const STEP_UP_PROTECTED = [
  "POST /projects/:projectId/memberships",
  "PATCH /projects/:projectId/memberships/:membershipId",
  "DELETE /projects/:projectId/memberships/:membershipId",
  "PUT /projects/:projectId/membership-policy",
  "POST /projects/:projectId/admins",
  "DELETE /projects/:projectId/admins/:githubUserId",
  "POST|PATCH|DELETE /projects/:projectId/service-accounts/**",
  "POST /api/tokens",
  "DELETE /api/tokens/:name",
  "POST /api/tokens/:name/rotate",
] as const;

export function stepUpMaxAgeMs(
  env: Pick<Env, "STEP_UP_MAX_AGE_SECONDS">,
): number {
  const raw = env.STEP_UP_MAX_AGE_SECONDS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const seconds =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : STEP_UP_MAX_AGE_SECONDS_DEFAULT;
  return seconds * 1000;
}

/**
 * Deny with 403 `step-up-required` when an interactive cookie session last
 * authenticated longer ago than the configured window. Returns null when the
 * session is fresh or the token kind is exempt. A cookie session with no
 * recorded authentication time is treated as stale (fail closed).
 */
export function requireFreshAuthentication(
  c: Context<AppEnv>,
): Response | null {
  const token = c.get("tokenResult");
  if (token.kind !== "cookie-session" || token.policy) return null;
  const maxAgeMs = stepUpMaxAgeMs(c.env);
  const authenticatedAt = token.authenticatedAt;
  const fresh =
    typeof authenticatedAt === "number" &&
    Date.now() - authenticatedAt <= maxAgeMs;
  if (fresh) return null;
  return c.json(
    {
      ok: false,
      error: {
        code: "step-up-required",
        message: "Re-authenticate to continue",
        retryable: false,
        details: {
          max_age_seconds: Math.floor(maxAgeMs / 1000),
          authenticated_at: authenticatedAt ?? null,
        },
      },
    },
    403,
  );
}

/** Mount after the owner/capability guard so a non-owner never learns the window. */
export const stepUpGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    const stale = requireFreshAuthentication(c);
    if (stale) return stale;
  }
  return next();
};
