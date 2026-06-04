import { compareSemver } from "@tila/core";
import type { MiddlewareHandler } from "hono";
import { MIN_CLI_VERSION } from "../routes/health";

const UPGRADE_URL = "https://github.com/davebream/tila/releases";

export function parseSourceHeader(
  value: string,
): { clientId: string; version: string } | null {
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) return null;
  return {
    clientId: value.slice(0, slashIndex),
    version: value.slice(slashIndex + 1),
  };
}

/**
 * Middleware that checks the CLI version from X-Tila-Source or X-Tila-CLI-Version.
 *
 * - Reads X-Tila-Source first; if client-id is "cli", extracts the version.
 * - Falls back to legacy X-Tila-CLI-Version header.
 * - If neither header identifies a CLI client, the request passes through.
 * - If the CLI version is below MIN_CLI_VERSION, returns 426 Upgrade Required.
 * - GET /api/health is always exempt.
 */
export function versionCheckMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // Health endpoint is always reachable regardless of CLI version
    const path = new URL(c.req.url).pathname;
    if (path === "/api/health") {
      return next();
    }

    let cliVersion: string | undefined;

    const sourceHeader = c.req.header("X-Tila-Source");
    if (sourceHeader) {
      const parsed = parseSourceHeader(sourceHeader);
      if (parsed && parsed.clientId === "cli") {
        cliVersion = parsed.version;
      }
    }

    // Fall back to legacy header when X-Tila-Source is absent or non-CLI
    if (!cliVersion) {
      cliVersion = c.req.header("X-Tila-CLI-Version");
    }

    if (!cliVersion) {
      return next();
    }

    if (compareSemver(cliVersion, MIN_CLI_VERSION) === -1) {
      return c.json(
        {
          error: "CLI version too old",
          minCliVersion: MIN_CLI_VERSION,
          upgradeUrl: UPGRADE_URL,
        },
        426,
      );
    }

    return next();
  };
}
