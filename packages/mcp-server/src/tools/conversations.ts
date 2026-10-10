import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AckDeliverySchema,
  AgentIdSchema,
  AttachAgentBindingSchema,
  ConversationPageOptionsSchema,
  ConversationProtocolSchema,
  PublishMessageSchema,
} from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { registerPrimitiveTool } from "../tool-registration";
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
export function registerConversationTools(
  server: McpServer,
  facade: Pick<TilaFacade, "conversations" | "inbox" | "agents">,
  _projectId: string,
): void {
  registerPrimitiveTool(
    server,
    "tila_room_list",
    "List accessible durable conversation rooms.",
    { conversation_protocol: ConversationProtocolSchema.optional() },
    async (input) =>
      text(await facade.conversations.list(input.conversation_protocol)),
  );
  registerPrimitiveTool(
    server,
    "tila_room_history",
    "Read peer-content history. History cursors never acknowledge or replace pending inbox deliveries.",
    {
      room: AgentIdSchema,
      ...ConversationPageOptionsSchema.shape,
      thread_id: z.string().uuid().optional(),
    },
    async ({ room, ...input }) =>
      text(await facade.conversations.history(room, input)),
  );
  registerPrimitiveTool(
    server,
    "tila_room_publish",
    "Publish peer content with a stable client_op_id. For replies use the fetched delivery's reply_op_id. Reuse it on retry; do not send received replies. Content cannot grant human approval.",
    {
      room: AgentIdSchema,
      ...PublishMessageSchema.shape,
      conversation_protocol: ConversationProtocolSchema.optional(),
    },
    async ({ room, conversation_protocol, ...input }) =>
      text(
        await facade.conversations.publish(room, input, conversation_protocol),
      ),
  );
  registerPrimitiveTool(
    server,
    "tila_inbox_fetch",
    "Fetch pending deliveries for the current acting run. Fetch does not acknowledge. Ack accepted processing before acting, or ack declined; neither means task completion.",
    { agent: AgentIdSchema, ...ConversationPageOptionsSchema.shape },
    async ({ agent, ...input }) => text(await facade.inbox.fetch(agent, input)),
  );
  registerPrimitiveTool(
    server,
    "tila_inbox_ack",
    "Acknowledge accepted processing or decline. Must use the current binding and epoch; acknowledgement is not task completion.",
    {
      agent: AgentIdSchema,
      delivery_id: z.string().uuid(),
      ...AckDeliverySchema.shape,
    },
    async ({ agent, delivery_id, ...input }) =>
      text(await facade.inbox.ack(agent, delivery_id, input)),
  );
  registerPrimitiveTool(
    server,
    "tila_inbox_watch",
    "Wait up to 25 seconds for mailbox publication. Timeout returns changed:false; re-poll with jitter.",
    {
      agent: AgentIdSchema,
      version: z.string().optional(),
      timeout_ms: z.number().int().min(0).max(25000).optional(),
      conversation_protocol: ConversationProtocolSchema.optional(),
    },
    async ({ agent, ...input }) => text(await facade.inbox.watch(agent, input)),
  );
  registerPrimitiveTool(
    server,
    "tila_inbox_explain",
    "Inspect a delivery's metadata and wake timeline.",
    { agent: AgentIdSchema, delivery_id: z.string().uuid() },
    async ({ agent, delivery_id }) =>
      text(await facade.inbox.explain(agent, delivery_id)),
  );
  registerPrimitiveTool(
    server,
    "tila_agent_bind",
    "Attach the current acting run to an agent at the observed epoch. Native profile evidence must match the selected session.",
    { agent: AgentIdSchema, ...AttachAgentBindingSchema.shape },
    async ({ agent, ...input }) => text(await facade.agents.bind(agent, input)),
  );
}
