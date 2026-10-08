import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { parseToolGroups, resolveGroups } from "./tool-groups";

/**
 * Register MCP tools for the given server and client.
 *
 * @param groups - Optional explicit group list. When omitted, defaults to
 *   `parseToolGroups(process.env.TILA_MCP_TOOLS)`. Undefined means the workflow group.
 *   Unknown group names cause a fail-fast throw with an actionable error message.
 */
export function registerAllTools(
  server: McpServer,
  facade: TilaFacade,
  projectId: string,
  groups?: string[],
): void {
  const resolved = groups ?? parseToolGroups(process.env.TILA_MCP_TOOLS);

  // Resolve group names to register functions (throws on unknown groups)
  const fns = resolveGroups(resolved ?? ["workflow"]);
  for (const fn of fns) {
    fn(server, facade, projectId);
  }
}
