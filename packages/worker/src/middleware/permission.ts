import type { MiddlewareHandler } from "hono";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const PERMISSION_LEVELS: Record<string, number> = {
  read: 1,
  write: 2,
  admin: 3,
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
      // Map cookie-session scopes onto the PERMISSION_LEVELS hierarchy.
      // "full" → admin level (preserves existing "full passes every guard" behavior,
      //           including admin routes — must NOT be mapped to write).
      // "read" → read level (allows read-only viewers to use read-guarded routes).
      // anything else → 0 (deny).
      let sessionLevel: number;
      if (tokenResult.scopes === "full") {
        sessionLevel = PERMISSION_LEVELS.admin;
      } else if (tokenResult.scopes === "read") {
        sessionLevel = PERMISSION_LEVELS.read;
      } else {
        sessionLevel = 0;
      }

      if (sessionLevel >= (PERMISSION_LEVELS[level] ?? 0)) {
        return next();
      }

      return c.json(
        {
          ok: false,
          error: {
            code: "permission-denied",
            message: "Insufficient session scope",
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
