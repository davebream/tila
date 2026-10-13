import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AckDeliverySchema,
  AgentIdSchema,
  AttachAgentBindingSchema,
  ConversationPageOptionsSchema,
  ConversationProtocolSchema,
  CreateRoomSchema,
  PublishMessageSchema,
  RoomMemberSchema,
  UpdateRoomSchema,
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
  const revision = z.number().int().positive();
  const key = z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Reuse only when retrying the same request after a lost reply");
  registerPrimitiveTool(
    server,
    "tila_room_get",
    "Read a room's settings, revision and members. Archived rooms stay readable under their history policy.",
    { room: AgentIdSchema },
    async ({ room }) => text(await facade.conversations.get(room)),
  );
  registerPrimitiveTool(
    server,
    "tila_room_create",
    "Create a room (managers). Identical settings replay; a different room under the same ID conflicts.",
    { ...CreateRoomSchema.shape },
    async (input) => text(await facade.conversations.create(input)),
  );
  registerPrimitiveTool(
    server,
    "tila_room_update",
    "Change room settings against expected_revision. TTL and hop/pair budgets apply to later messages, wake budgets at the next dispatch, history policy immediately. Send all four budgets together.",
    {
      room: AgentIdSchema,
      ...UpdateRoomSchema.shape,
      idempotency_key: key,
    },
    async ({ room, idempotency_key, ...input }) =>
      text(
        await facade.conversations.update(room, input, {
          idempotencyKey: idempotency_key,
        }),
      ),
  );
  registerPrimitiveTool(
    server,
    "tila_room_member_set",
    "Add a member (agent:<id> or principal:<id>) or change its wake setting. Membership changes advance the room revision.",
    {
      room: AgentIdSchema,
      member: RoomMemberSchema.shape.member,
      wake: z.boolean().default(true),
      expected_revision: revision.optional(),
      idempotency_key: key,
    },
    async ({ room, member, wake, expected_revision, idempotency_key }) =>
      text(
        await facade.conversations.join(room, member, wake, {
          expectedRevision: expected_revision,
          idempotencyKey: idempotency_key,
        }),
      ),
  );
  registerPrimitiveTool(
    server,
    "tila_room_member_remove",
    "Remove a member. Its access to members-only history ends immediately.",
    {
      room: AgentIdSchema,
      member: RoomMemberSchema.shape.member,
      expected_revision: revision.optional(),
      idempotency_key: key,
    },
    async ({ room, member, expected_revision, idempotency_key }) =>
      text(
        await facade.conversations.leave(room, member, {
          expectedRevision: expected_revision,
          idempotencyKey: idempotency_key,
        }),
      ),
  );
  registerPrimitiveTool(
    server,
    "tila_room_archive_preview",
    "Show what archiving a room would affect now: members, pending deliveries and messages.",
    { room: AgentIdSchema },
    async ({ room }) => text(await facade.conversations.archivePreview(room)),
  );
  registerPrimitiveTool(
    server,
    "tila_room_archive",
    "Archive a room: publication stops now and wakes at the next dispatch. History stays readable and pending deliveries can be read and acknowledged until they expire.",
    { room: AgentIdSchema, expected_revision: revision, idempotency_key: key },
    async ({ room, expected_revision, idempotency_key }) =>
      text(
        await facade.conversations.archive(room, expected_revision, {
          idempotencyKey: idempotency_key,
        }),
      ),
  );
  registerPrimitiveTool(
    server,
    "tila_room_unarchive",
    "Restore publication in an archived room.",
    { room: AgentIdSchema, expected_revision: revision, idempotency_key: key },
    async ({ room, expected_revision, idempotency_key }) =>
      text(
        await facade.conversations.unarchive(room, expected_revision, {
          idempotencyKey: idempotency_key,
        }),
      ),
  );
  registerPrimitiveTool(
    server,
    "tila_agent_bind",
    "Attach the current acting run to an agent at the observed epoch. Native profile evidence must match the selected session.",
    { agent: AgentIdSchema, ...AttachAgentBindingSchema.shape },
    async ({ agent, ...input }) => text(await facade.agents.bind(agent, input)),
  );
}
