#!/usr/bin/env node
import { hasWorkflowTools } from "./tools/tool-groups";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveServerConfig } from "./config";
import { MCP_VERSION } from "./facade";
import { serverInstructions } from "./instructions";
import { lifecycleTools } from "./lifecycle";
import { registerAllPrompts } from "./prompts/index";
import { registerAllResources } from "./resources/index";
import { registerAllTools } from "./tools/index";

async function main(): Promise<void> {
  // Fail-fast: resolve config before starting transport.
  // Throws with actionable error if token, URL, or project ID is missing.
  const config = await resolveServerConfig();

  const baseServer = new McpServer(
    { name: "tila-mcp", version: MCP_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: serverInstructions(hasWorkflowTools()),
    },
  );

  const scoped = lifecycleTools(baseServer, config);
  registerAllTools(scoped.server, scoped.facade, config.projectId);
  await registerAllResources(scoped.server, scoped.facade, config.projectId);
  registerAllPrompts(scoped.server, scoped.facade, config.projectId);

  // Start stdio transport (connect on the real server, not the proxy).
  const transport = new StdioServerTransport();
  await baseServer.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
