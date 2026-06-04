import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaClient } from "tila-sdk";
import { toMcpError } from "../errors";

export function registerSummaryTool(
  server: McpServer,
  client: TilaClient,
  projectId: string,
): void {
  const base = `/projects/${projectId}/summary`;

  server.tool(
    "tila_summary",
    "Get a compact project summary: entity counts by type and status, active claims, ready count, online machines, recent journal events, and estimated token count.",
    {},
    async () => {
      try {
        const result = await client.get(base);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
