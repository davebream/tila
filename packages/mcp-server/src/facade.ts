import { createRequire } from "node:module";
import type { TilaProjectConfig } from "@tila/schemas";
import { type TilaFacade, createTila } from "tila-sdk";
import type { McpServerConfig } from "./config";

const require = createRequire(import.meta.url);

/** The MCP server's published version (used for X-Tila-Source attribution). */
export const MCP_VERSION: string = (
  require("../package.json") as { version: string }
).version;

/**
 * Build the uniform {@link TilaFacade} data layer from a resolved server config.
 *
 * Both branches go through `createTila`, so local and remote tools share ONE
 * code path:
 *  - `mode === "local"`: constructs a synthetic `backend: "local"` config and
 *    lets `createTila` DYNAMICALLY import `tila-sdk/local` (better-sqlite3 +
 *    node:fs). No token is needed.
 *  - `mode === "remote"`: constructs a `backend: "cloudflare"` config from the
 *    resolved apiUrl/projectId and the auth token, wiring the HTTP backend, and
 *    attributes traffic as `mcp-server/<version>` via `X-Tila-Source`.
 *
 * `schema_version` / `tila_version` / `created_at` are required by the
 * `TilaProjectConfig` schema but unused by `createTila`; they are filled with
 * inert placeholders.
 */
export async function buildFacade(
  config: McpServerConfig,
): Promise<TilaFacade> {
  if (config.mode === "local") {
    const tilaConfig: TilaProjectConfig = {
      project_id: config.projectId,
      backend: "local",
      local: {
        db_path: config.dbPath,
        artifacts_path: config.artifactsPath,
        org: config.org,
      },
      schema_version: 0,
      tila_version: MCP_VERSION,
      created_at: new Date(0).toISOString(),
    };
    return createTila(tilaConfig);
  }

  const token = await config.getToken();
  const tilaConfig: TilaProjectConfig = {
    project_id: config.projectId,
    backend: "cloudflare",
    worker_url: config.apiUrl,
    schema_version: 0,
    tila_version: MCP_VERSION,
    created_at: new Date(0).toISOString(),
  };
  // Attribute remote MCP traffic as mcp-server/<version> (the same value/format
  // the pre-facade TilaClient used via extraHeaders). The repo standardizes on
  // X-Tila-Source for client attribution, so this preserves the MCP's identity
  // on the remote path. Local mode makes no HTTP requests, so no header applies.
  return createTila(tilaConfig, token, {
    extraHeaders: { "X-Tila-Source": `mcp-server/${MCP_VERSION}` },
  });
}
