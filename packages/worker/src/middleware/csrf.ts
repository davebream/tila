import type { MiddlewareHandler } from "hono";
import { parseAllowedOrigins } from "../lib/parse-allowed-origins";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authKind = c.get("authKind");
  // bearer tokens are exempt from CSRF checks (not a cookie-based credential).
  // workspace sessions are cookie-based and DO need CSRF protection (same as cookie).
  if (authKind !== "cookie" && authKind !== "workspace") return next();

  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS")
    return next();

  const origin = c.req.header("Origin");
  const host = new URL(c.req.url).host;

  if (!origin) {
    return c.json(
      {
        ok: false,
        error: {
          code: "csrf-missing-origin",
          message: "Origin header required for cookie-authenticated mutations",
          retryable: false,
        },
      },
      403,
    );
  }

  let originHost: string;
  let originUrl: string;
  try {
    const parsed = new URL(origin);
    originHost = parsed.host;
    originUrl = parsed.origin;
  } catch {
    return c.json(
      {
        ok: false,
        error: {
          code: "csrf-origin-mismatch",
          message: "Origin header is not a valid URL",
          retryable: false,
        },
      },
      403,
    );
  }

  // Accept same-origin requests
  if (originHost === host) {
    return next();
  }

  // Accept cross-origin requests from CORS-approved origins
  const allowedOrigins = parseAllowedOrigins(c.env?.CORS_ALLOWED_ORIGINS ?? "");
  if (allowedOrigins.includes(originUrl)) {
    return next();
  }

  return c.json(
    {
      ok: false,
      error: {
        code: "csrf-origin-mismatch",
        message: "Origin does not match the server host",
        retryable: false,
      },
    },
    403,
  );
};
