import type { MiddlewareHandler } from "hono";
import { parseSourceHeader } from "./version-check";

/**
 * Middleware that resolves source provenance from the X-Tila-Source header.
 *
 * Resolution logic:
 * - cookie/workspace authKind → source="dashboard", sourceVersion=null (anti-spoofing)
 * - bearer + header present and valid → source=clientId, sourceVersion=version
 * - bearer + header absent or malformed → source="unknown", sourceVersion=null
 *
 * Must run after createAuthMiddleware() so authKind is set on context.
 */
export function sourceResolution(): MiddlewareHandler {
  return async (c, next) => {
    const authKind = c.get("authKind");

    // Anti-spoofing: browser sessions always resolve to "dashboard"
    // regardless of X-Tila-Source header value.
    if (authKind === "cookie" || authKind === "workspace") {
      c.set("source", "dashboard");
      c.set("sourceVersion", null);
      return next();
    }

    const header = c.req.header("X-Tila-Source");
    if (header) {
      const parsed = parseSourceHeader(header);
      if (parsed) {
        c.set("source", parsed.clientId);
        c.set("sourceVersion", parsed.version);
        return next();
      }
    }

    // No header or malformed header for bearer auth
    c.set("source", "unknown");
    c.set("sourceVersion", null);
    return next();
  };
}
