#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveServerConfig } from "./config";
import { MCP_VERSION, buildFacade } from "./facade";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { registerAllPrompts } from "./prompts/index";
import { guardRemoteOnlyTools } from "./remote-only";
import { registerAllResources } from "./resources/index";
import { registerAllTools } from "./tools/index";

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
