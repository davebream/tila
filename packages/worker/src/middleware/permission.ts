import { PROJECT_ROLE_RANK, type ProjectRole } from "@tila/schemas";
import type { MiddlewareHandler } from "hono";
import type { Env, HonoVariables } from "../types";
import {
  authorizeProtectedOperation,
  isProtectedMutation,
  withRequiredRole,
} from "./protected-operation";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/**
 * Single source of truth for the admin-tier label.
 * Used by PERMISSION_LEVELS (below) and by the auto-admin helper in
 * require-project-admin.ts to keep the tier vocabulary in sync.
 */
export const ADMIN_PERMISSION = "admin";

const PERMISSION_LEVELS: Record<string, number> = {
  read: 1,
  write: 2,
  [ADMIN_PERMISSION]: 3,
};

const REQUIRED_ROLE: Record<"read" | "write" | "admin", ProjectRole> = {
  read: "viewer",
  write: "participant",
  admin: "maintainer",
};

/** All mutations and administrative reads require current protected authority. */
export function recheckInScope(
  level: "read" | "write" | "admin",
  method: string,
  path = "",
): boolean {
  return level === "admin" || isProtectedMutation(method, path);
}

/**
 * Route-level permission gate.
 * For D1 tokens: scopes === "full" grants all access.
 * For sessions: checks current membership role, then requires independent
 * explicit authority or a verified GitHub grant for protected operations.
 */
export function requirePermission(
  level: "read" | "write" | "admin",
): MiddlewareHandler<AppEnv> {
  return withRequiredRole(REQUIRED_ROLE[level], async (c, next) => {
    const tokenResult = c.get("tokenResult");
    if (c.get("authorizationChecked")) return next();

    if (tokenResult.kind === "workspace-session") {
      return c.json(
        {
          ok: false,
          error: {
            code: "project-required",
            message: "Select a project first",
            retryable: false,
          },
        },
        403,
      );
    }

    if (tokenResult.kind === "d1-token") {
      // D1 tokens with "full" scope pass all permission checks
      if (tokenResult.scopes === "full") {
        return next();
      }
      // Non-full D1 tokens: forward-compat with T5 scopes model
      return c.json(
        {
          ok: false,
          error: {
            code: "permission-denied",
            message: "Insufficient token scope",
            retryable: false,
          },
        },
        403,
      );
    }

    const snapshotPermission =
      tokenResult.kind === "session" ||
      tokenResult.kind === "cookie-session" ||
      tokenResult.kind === "oidc-session"
        ? tokenResult.permission
        : "";
    // Directly-mounted route tests and compatibility integrations may invoke
    // the guard without projectMembershipMiddleware. Production project routes
    // always set effectiveRole, so request-time membership remains authoritative.
    const effectiveRole =
      c.get("effectiveRole") ??
      (snapshotPermission === "read"
        ? "viewer"
        : snapshotPermission === "write"
          ? "participant"
          : snapshotPermission === "admin"
            ? "maintainer"
            : undefined);
    const requiredRole = REQUIRED_ROLE[level];
    if (
      !effectiveRole ||
      PROJECT_ROLE_RANK[effectiveRole] < PROJECT_ROLE_RANK[requiredRole]
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: "permission-denied",
            message: `Requires ${requiredRole} role`,
            retryable: false,
          },
        },
        403,
      );
    }

    if (recheckInScope(level, c.req.method, c.req.path)) {
      const denied = await authorizeProtectedOperation(c, requiredRole);
      if (denied) return denied;
    }
    if (
      tokenResult.kind === "session" ||
      tokenResult.kind === "oidc-session" ||
      tokenResult.kind === "cookie-session"
    )
      return next();

    // Unknown token kind -- deny
    return c.json(
      {
        ok: false,
        error: {
          code: "permission-denied",
          message: "Unknown authentication type",
          retryable: false,
        },
      },
      403,
    );
  });
}
