import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

export function registerPresenceTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const presence = facade.presence;

  server.tool(
    "tila_presence_heartbeat",
    "Record a heartbeat for this MCP server participant. Call periodically (e.g. every 60s) to maintain presence visibility.",
    {
      info: z
        .record(z.unknown())
        .default({})
        .describe("Optional metadata (e.g. current task ID, status)"),
    },
    async ({ info }) => {
      try {
        const result = await presence.heartbeat(info);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
