import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";

const targetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("participant"),
    principal_id: z.string(),
    participant_id: z.string(),
  }),
  z.object({ type: z.literal("principal"), principal_id: z.string() }),
  z.object({ type: z.literal("group"), group_id: z.string() }),
  z.object({ type: z.literal("broadcast") }),
]);

function textResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export function registerSignalTools(
  server: McpServer,
  facade: TilaFacade,
  _projectId: string,
): void {
  const signals = facade.signals;

  server.tool(
    "tila_signal_send",
    "Send a participant-scoped signal. Principal, group, and broadcast targets snapshot active recipients at send time.",
    {
      target: targetSchema.describe("Typed signal destination"),
      kind: z.enum(["conflict", "ready", "info", "request"]),
      resource: z.string().optional(),
      payload: z.unknown().optional(),
      ttl_ms: z.number().int().min(1000).max(86_400_000).optional(),
    },
    async (input) => {
      try {
        return textResult(await signals.send(input));
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_signal_list",
    "List unacknowledged signal deliveries for this exact principal and participant.",
    {},
    async () => {
      try {
        return textResult(await signals.inbox());
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_signal_ack",
    "Acknowledge this participant's delivery of a signal.",
    { id: z.string().describe("Signal ID to acknowledge") },
    async ({ id }) => {
      try {
        return textResult(await signals.ack(id));
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_signal_history",
    "List signal delivery and acknowledgement history. Requires project admin permission.",
    {
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    },
    async (options) => {
      try {
        return textResult(await signals.history(options));
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_signal_group_list",
    "List named signal groups and their principal memberships.",
    {},
    async () => {
      try {
        return textResult(await signals.groups.list());
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_signal_group_get",
    "Get one named signal group.",
    { group_id: z.string() },
    async ({ group_id }) => {
      try {
        return textResult(await signals.groups.get(group_id));
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_signal_group_set",
    "Create or replace a named principal-based signal group. Requires project admin permission.",
    {
      group_id: z.string(),
      name: z.string(),
      principal_ids: z.array(z.string()).max(500),
    },
    async ({ group_id, name, principal_ids }) => {
      try {
        return textResult(
          await signals.groups.set(group_id, { name, principal_ids }),
        );
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    "tila_signal_group_delete",
    "Delete a named signal group. Requires project admin permission.",
    { group_id: z.string() },
    async ({ group_id }) => {
      try {
        return textResult(await signals.groups.delete(group_id));
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
