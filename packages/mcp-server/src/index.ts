#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TilaClient } from "tila-sdk";
import { resolveServerConfig } from "./config";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { registerAllPrompts } from "./prompts/index";
import { registerAllResources } from "./resources/index";
import { registerAllTools } from "./tools/index";

const require = createRequire(import.meta.url);
const MCP_VERSION: string = (require("../package.json") as { version: string })
  .version;

async function main(): Promise<void> {
  // Fail-fast: resolve config before starting transport.
  // Throws with actionable error if token, URL, or project ID is missing.
  const config = await resolveServerConfig();
  const token = await config.getToken();

  const client = new TilaClient({
    baseUrl: config.apiUrl,
    token,
    extraHeaders: { "X-Tila-Source": `mcp-server/${MCP_VERSION}` },
  });

  const server = new McpServer(
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

  // Register all MCP primitives
  registerAllTools(server, client, config.projectId);
  await registerAllResources(server, client, config.projectId);
  registerAllPrompts(server, client, config.projectId);

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
