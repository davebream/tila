import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { registerArtifactTools } from "./artifacts";
import { registerClaimTools } from "./claims";
import { registerEntityTools } from "./entities";
import { registerGateTools } from "./gates";
import { registerJournalTools } from "./journal";
import { registerPresenceTools } from "./presence";
import { registerRecordTools } from "./records";
import { registerSchemaTools } from "./schema";
import { registerSignalTools } from "./signals";
import { registerSummaryTool } from "./summary";
import { registerTemplateTools } from "./templates";
import { parseToolGroups, resolveGroups } from "./tool-groups";

/** Default registration order when all groups are active. */
const ALL_REGISTER_FNS = [
  registerEntityTools,
  registerClaimTools,
  registerArtifactTools,
  registerGateTools,
  registerRecordTools,
  registerSummaryTool,
  registerSignalTools,
  registerJournalTools,
  registerSchemaTools,
  registerTemplateTools,
  registerPresenceTools,
];

/**
 * Register MCP tools for the given server and client.
 *
 * @param groups - Optional explicit group list. When omitted, defaults to
 *   `parseToolGroups(process.env.TILA_MCP_TOOLS)`. Undefined means all groups.
 *   Unknown group names cause a fail-fast throw with an actionable error message.
 */
export function registerAllTools(
  server: McpServer,
  facade: TilaFacade,
  projectId: string,
  groups?: string[],
): void {
  const resolved = groups ?? parseToolGroups(process.env.TILA_MCP_TOOLS);

  if (resolved === undefined) {
    // Register all groups in default order
    for (const fn of ALL_REGISTER_FNS) {
      fn(server, facade, projectId);
    }
    return;
  }

  // Resolve group names to register functions (throws on unknown groups)
  const fns = resolveGroups(resolved);
  for (const fn of fns) {
    fn(server, facade, projectId);
  }
}
