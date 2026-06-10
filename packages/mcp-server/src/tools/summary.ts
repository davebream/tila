import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { toMcpError } from "../errors";

export function registerSummaryTool(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const summary = facade.summary;

  server.tool(
    "tila_summary",
    "Get a compact project summary: entity counts by type and status, active claims, ready count, online machines, recent journal events, and estimated token count.",
    {},
    async () => {
      try {
        const result = await summary.get();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
