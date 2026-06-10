#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { TilaProjectConfig } from "@tila/schemas";
import { type TilaFacade, createTila } from "tila-sdk";
import { type McpServerConfig, resolveServerConfig } from "./config";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { registerAllPrompts } from "./prompts/index";
import { guardRemoteOnlyTools } from "./remote-only";
import { registerAllResources } from "./resources/index";
import { registerAllTools } from "./tools/index";

const require = createRequire(import.meta.url);
const MCP_VERSION: string = (require("../package.json") as { version: string })
  .version;

/**
 * Build the uniform {@link TilaFacade} data layer from a resolved server config.
 *
 * Both branches go through `createTila`, so local and remote tools share ONE
 * code path:
 *  - `mode === "local"`: constructs a synthetic `backend: "local"` config and
 *    lets `createTila` DYNAMICALLY import `tila-sdk/local` (better-sqlite3 +
 *    node:fs). No token is needed.
 *  - `mode === "remote"`: constructs a `backend: "cloudflare"` config from the
 *    resolved apiUrl/projectId and the auth token, wiring the HTTP backend.
 *
 * `schema_version` / `tila_version` / `created_at` are required by the
 * `TilaProjectConfig` schema but unused by `createTila`; they are filled with
 * inert placeholders.
 */
async function buildFacade(config: McpServerConfig): Promise<TilaFacade> {
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
  return createTila(tilaConfig, token);
}

async function main(): Promise<void> {
  // Fail-fast: resolve config before starting transport.
  // Throws with actionable error if token, URL, or project ID is missing.
  const config = await resolveServerConfig();

  const facade = await buildFacade(config);

  const baseServer = new McpServer(
    { name: "tila-mcp", version: MCP_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // In local mode, wrap the server so tools in REMOTE_ONLY_TOOLS register with a
  // clear "requires a remote backend" guard instead of their cloud-bound
  // implementation. In remote mode this is a transparent pass-through.
  const server = guardRemoteOnlyTools(baseServer, config.mode);

  // Register all MCP primitives against the uniform facade.
  registerAllTools(server, facade, config.projectId);
  await registerAllResources(server, facade, config.projectId);
  registerAllPrompts(server, facade, config.projectId);

  // Start stdio transport (connect on the real server, not the proxy).
  const transport = new StdioServerTransport();
  await baseServer.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
