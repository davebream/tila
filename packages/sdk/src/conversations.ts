import {
  AckDeliverySchema,
  AgentIdSchema,
  CapabilityReportSchema,
  ConversationInboxResponseSchema,
  ConversationPageOptionsSchema,
  CreateRoomSchema,
  CreateThreadSchema,
  DeliveryExplainResponseSchema,
  DispatchReportSchema,
  DispatchStatusResponseSchema,
  InboxAckResponseSchema,
  InboxWatchResponseSchema,
  MessagePublishResponseSchema,
  NativeSessionRefSchema,
  PublishMessageSchema,
  RoomHistoryResponseSchema,
  RoomListResponseSchema,
  RoomResponseSchema,
  SetRoomMemberSchema,
  ThreadSchema,
} from "@tila/schemas";
import { z } from "zod";
import { UnsupportedCapabilityError } from "./agents";
import type { TilaClient } from "./client";
const ok = z.object({ ok: z.literal(true) });
type Page = z.input<typeof ConversationPageOptionsSchema>;
const options = <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  protocol = 1,
) => ({ schema, validate: true, conversationProtocol: protocol });
const encode = (id: string) => encodeURIComponent(AgentIdSchema.parse(id));
function page(raw: Page = {}) {
  const value = ConversationPageOptionsSchema.parse(raw);
  return {
    query: { limit: value.limit?.toString(), cursor: value.cursor },
    conversationProtocol: value.conversation_protocol ?? 1,
  };
}
export function createConversationMethods(
  client: TilaClient,
  projectId: string,
) {
  const base = `/projects/${encodeURIComponent(projectId)}/rooms`;
  const path = (room: string) => `${base}/${encode(room)}`;
  return {
    list: (protocol = 1) =>
      client.get(base, options(RoomListResponseSchema, protocol)),
    create: (input: z.input<typeof CreateRoomSchema>, protocol = 1) =>
      client.post(
        base,
        CreateRoomSchema.parse(input),
        options(RoomResponseSchema, protocol),
      ),
    get: (room: string, protocol = 1) =>
      client.get(path(room), options(RoomResponseSchema, protocol)),
    join: (room: string, member: string, wake = true) =>
      client.put(
        `${path(room)}/members/${encodeURIComponent(member)}`,
        SetRoomMemberSchema.parse({ wake }),
        options(ok),
      ),
    leave: (room: string, member: string) =>
      client.delete(
        `${path(room)}/members/${encodeURIComponent(member)}`,
        options(ok),
      ),
    threads: (room: string) =>
      client.get(
        `${path(room)}/threads`,
        options(
          z.object({ ok: z.literal(true), threads: z.array(ThreadSchema) }),
        ),
      ),
    createThread: (room: string, input: z.input<typeof CreateThreadSchema>) =>
      client.post(
        `${path(room)}/threads`,
        CreateThreadSchema.parse(input),
        options(z.object({ ok: z.literal(true), thread: ThreadSchema })),
      ),
    history: (room: string, raw: Page & { thread_id?: string } = {}) =>
      client.get(`${path(room)}/messages`, {
        ...options(RoomHistoryResponseSchema),
        ...page(raw),
        query: { ...page(raw).query, thread_id: raw.thread_id },
      }),
    publish: (
      room: string,
      input: z.input<typeof PublishMessageSchema>,
      protocol = 1,
    ) =>
      client.post(
        `${path(room)}/messages`,
        PublishMessageSchema.parse(input),
        options(MessagePublishResponseSchema, protocol),
      ),
  };
}
export function createInboxMethods(client: TilaClient, projectId: string) {
  const path = (agent: string) =>
    `/projects/${encodeURIComponent(projectId)}/inbox/${encode(agent)}`;
  const delivery = (agent: string, id: string) =>
    `${path(agent)}/deliveries/${encodeURIComponent(z.string().uuid().parse(id))}`;
  return {
    fetch: (agent: string, raw: Page = {}) =>
      client.get(path(agent), {
        ...options(ConversationInboxResponseSchema),
        ...page(raw),
      }),
    ack: (
      agent: string,
      id: string,
      input: z.input<typeof AckDeliverySchema>,
    ) =>
      client.post(
        `${delivery(agent, id)}/ack`,
        AckDeliverySchema.parse(input),
        options(InboxAckResponseSchema),
      ),
    watch: (
      agent: string,
      raw: {
        version?: string;
        timeout_ms?: number;
        signal?: AbortSignal;
        conversation_protocol?: 1;
      } = {},
    ) =>
      client.get(`${path(agent)}/watch`, {
        ...options(InboxWatchResponseSchema, raw.conversation_protocol),
        signal: raw.signal,
        query: { version: raw.version, timeout_ms: raw.timeout_ms?.toString() },
      }),
    explain: (agent: string, id: string) =>
      client.get(delivery(agent, id), options(DeliveryExplainResponseSchema)),
    resume: (agent: string, id: string) =>
      client.post(`${delivery(agent, id)}/resume`, {}, options(ok)),
  };
}
const LeaseSchema = z.object({
  lease_token: z.string().uuid(),
  lease_until: z.number(),
  publish_gen: z.number().int(),
  consumer_binding_id: z.string().uuid(),
  binding_epoch: z.number().int(),
  pending: z.number(),
  mechanism: z.string(),
  native_session_ref: NativeSessionRefSchema.nullable(),
  capability_report: CapabilityReportSchema,
  allow_idle_start: z.boolean(),
});
export function createDispatchMethods(client: TilaClient, projectId: string) {
  const path = (agent: string) =>
    `/projects/${encodeURIComponent(projectId)}/dispatch/${encode(agent)}`;
  return {
    status: (agent: string, leaseToken?: string) =>
      client.get(`${path(agent)}/status`, {
        ...options(DispatchStatusResponseSchema),
        query: { lease_token: leaseToken },
      }),
    lease: (agent: string) =>
      client.post(
        `${path(agent)}/lease`,
        {},
        options(
          z.object({ ok: z.literal(true), lease: LeaseSchema.nullable() }),
        ),
      ),
    report: (agent: string, input: z.input<typeof DispatchReportSchema>) =>
      client.post(
        `${path(agent)}/report`,
        DispatchReportSchema.parse(input),
        options(z.object({ ok: z.literal(true), replayed: z.boolean() })),
      ),
  };
}
const unsupported = async (): Promise<never> => {
  throw new UnsupportedCapabilityError();
};
export function createUnsupportedConversationMethods(): ReturnType<
  typeof createConversationMethods
> {
  return {
    list: unsupported,
    create: unsupported,
    get: unsupported,
    join: unsupported,
    leave: unsupported,
    threads: unsupported,
    createThread: unsupported,
    history: unsupported,
    publish: unsupported,
  };
}
export function createUnsupportedInboxMethods(): ReturnType<
  typeof createInboxMethods
> {
  return {
    fetch: unsupported,
    ack: unsupported,
    watch: unsupported,
    explain: unsupported,
    resume: unsupported,
  };
}
export function createUnsupportedDispatchMethods(): ReturnType<
  typeof createDispatchMethods
> {
  return { status: unsupported, lease: unsupported, report: unsupported };
}
