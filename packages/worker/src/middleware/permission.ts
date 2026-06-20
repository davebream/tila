import type { MiddlewareHandler } from "hono";
import type { Env, HonoVariables } from "../types";

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

/**
 * Route-level permission gate.
 * For D1 tokens: scopes === "full" grants all access.
 * For session tokens: checks permission hierarchy.
 */
export function requirePermission(
  level: "read" | "write" | "admin",
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tokenResult = c.get("tokenResult");

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

    if (tokenResult.kind === "session") {
      const userLevel = PERMISSION_LEVELS[tokenResult.permission] ?? 0;
      const requiredLevel = PERMISSION_LEVELS[level] ?? 0;

      if (userLevel >= requiredLevel) {
        return next();
      }

      return c.json(
        {
          ok: false,
          error: {
            code: "permission-denied",
            message: `Requires ${level} permission`,
            retryable: false,
          },
        },
        403,
      );
    }

    if (tokenResult.kind === "cookie-session") {
      // Map cookie-session normalized permission onto the PERMISSION_LEVELS hierarchy.
      // Uses the persisted GitHub-derived permission tier ("read"/"write"/"admin"),
      // same as the bearer session branch above — closes the privilege-escalation gap
      // where a GitHub *write* user could previously reach admin routes via cookie
      // (because the old code mapped scopes:"full" → admin unconditionally).
      const userLevel = PERMISSION_LEVELS[tokenResult.permission] ?? 0;

      if (userLevel >= (PERMISSION_LEVELS[level] ?? 0)) {
        return next();
      }

      return c.json(
        {
          ok: false,
          error: {
            code: "permission-denied",
            message: `Requires ${level} permission`,
            retryable: false,
          },
        },
        403,
      );
    }

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
  };
}
