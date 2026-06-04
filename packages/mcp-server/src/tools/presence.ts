import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaClient } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

export function registerPresenceTools(
  server: McpServer,
  client: TilaClient,
  projectId: string,
): void {
  const base = `/projects/${projectId}/presence`;

  server.tool(
    "tila_presence_heartbeat",
    "Record a heartbeat to mark this agent as online. Machine identity is derived from the API token server-side. Call periodically (e.g. every 60s) to maintain presence visibility.",
    {
      info: z
        .record(z.unknown())
        .default({})
        .describe("Optional metadata (e.g. current task ID, status)"),
    },
    async ({ info }) => {
      try {
        const result = await client.post(`${base}/heartbeat`, {
          machine: "mcp-agent",
          info,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
