import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { parseAllowedOrigins } from "../lib/parse-allowed-origins";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/**
 * Creates a CORS middleware configured from CORS_ALLOWED_ORIGINS env var.
 * Origins are comma-separated. Wildcards ("*") are rejected.
 * If the env var is empty or unset, no origins are allowed
 * (effectively disabling cross-origin access).
 *
 * Production runs with CORS_ALLOWED_ORIGINS unset (same-origin Static Assets deployment —
 * the UI is served from the same Worker origin so no CORS headers are needed).
 * Local Vite dev sets it via .dev.vars to allow the :5173 dev server.
 */
export function createCorsMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const raw = c.env.CORS_ALLOWED_ORIGINS ?? "";
    const allowedOrigins = parseAllowedOrigins(raw);

    if (allowedOrigins.length === 0) {
      // No allowed origins configured — skip CORS headers entirely
      return next();
    }

    const handler = cors({
      origin: allowedOrigins,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // The dashboard sends participant/client headers on project mutations
      // (#102); production is same-origin, this list only matters for local dev.
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "X-Tila-Participant-Id",
        "X-Tila-Client-Name",
      ],
      exposeHeaders: [
        "Server-Timing",
        "X-Tila-Token-Estimate",
        "X-Tila-Artifact-Review-State",
        "X-Tila-Artifact-Review-Revision",
      ],
      maxAge: 86400,
    });

    return handler(c, next);
  };
}
