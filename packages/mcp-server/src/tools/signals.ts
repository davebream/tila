import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

export function registerSignalTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const signals = facade.signals;

  server.tool(
    "tila_signal_send",
    "Send a signal to another agent or broadcast to all. Signals enable agent-to-agent coordination within a project.",
    {
      target: z.string().describe("Target token name or '*' for broadcast"),
      kind: z
        .string()
        .describe("Signal kind (e.g. 'assignment', 'review-request')"),
      resource: z
        .string()
        .optional()
        .describe("Entity ID this signal relates to"),
      payload: z
        .record(z.unknown())
        .optional()
        .describe("Arbitrary signal payload"),
      ttl_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Time-to-live in milliseconds"),
    },
    async ({ target, kind, resource, payload, ttl_ms }) => {
      try {
        const result = await signals.send({
          target,
          kind,
          resource,
          payload,
          ttl_ms,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_signal_list",
    "List unacknowledged signals in the current agent's inbox. The inbox is filtered by the bearer token identity -- no parameters needed.",
    {},
    async () => {
      try {
        const result = await signals.inbox();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_signal_ack",
    "Acknowledge a signal, removing it from the inbox.",
    {
      id: z.string().describe("Signal ID to acknowledge"),
    },
    async ({ id }) => {
      try {
        const result = await signals.ack(id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
