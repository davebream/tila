import {
  AckDeliverySchema,
  AgentIdSchema,
  CapabilityReportSchema,
  ConversationInboxResponseSchema,
  ConversationPageOptionsSchema,
  CreateRoomSchema,
  CreateThreadSchema,
  DeliveryExplainResponseSchema,
  DeliveryListQuerySchema,
  DeliveryListResponseSchema,
  DispatchReportSchema,
  DispatchStatusResponseSchema,
  InboxAckResponseSchema,
  InboxWatchResponseSchema,
  MessageDeliveriesResponseSchema,
  MessagePublishResponseSchema,
  NativeSessionRefSchema,
  PublishMessageSchema,
  RoomArchivePreviewResponseSchema,
  RoomHistoryResponseSchema,
  RoomListResponseSchema,
  RoomResponseSchema,
  RoomRevisionSchema,
  RoomSchema,
  SetRoomMemberSchema,
  ThreadSchema,
  UpdateRoomSchema,
} from "@tila/schemas";
import { z } from "zod";
import { UnsupportedCapabilityError, type WriteOptions } from "./agents";
import type { TilaClient } from "./client";
const ok = z.object({ ok: z.literal(true) });
// Pre-#298 servers answer membership changes with `{ ok }` only.
const memberResult = z.object({
  ok: z.literal(true),
  room: RoomSchema.optional(),
});
const key = (write: WriteOptions) =>
  write.idempotencyKey ?? crypto.randomUUID();
type Page = z.input<typeof ConversationPageOptionsSchema>;
const options = <T>(schema: z.ZodType<T, unknown>, protocol = 1) => ({
  schema,
  validate: true,
  conversationProtocol: protocol,
});
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
    /** `includeArchived` lists archived rooms the caller may read. */
    list: (protocol = 1, read: { includeArchived?: boolean } = {}) =>
      client.get(base, {
        ...options(RoomListResponseSchema, protocol),
        query: { include_archived: read.includeArchived ? "true" : undefined },
      }),
    create: (input: z.input<typeof CreateRoomSchema>, protocol = 1) =>
      client.post(
        base,
        CreateRoomSchema.parse(input),
        options(RoomResponseSchema, protocol),
      ),
    get: (room: string, protocol = 1) =>
      client.get(path(room), options(RoomResponseSchema, protocol)),
    /** Membership is room policy: a change advances the room revision. */
    join: (
      room: string,
      member: string,
      wake = true,
      write: WriteOptions & { expectedRevision?: number } = {},
    ) =>
      client.put(
        `${path(room)}/members/${encodeURIComponent(member)}`,
        SetRoomMemberSchema.parse({
          wake,
          expected_revision: write.expectedRevision,
        }),
        { ...options(memberResult), idempotencyKey: key(write) },
      ),
    leave: (
      room: string,
      member: string,
      write: WriteOptions & { expectedRevision?: number } = {},
    ) =>
      client.delete(`${path(room)}/members/${encodeURIComponent(member)}`, {
        ...options(memberResult),
        idempotencyKey: key(write),
        query: {
          expected_revision:
            write.expectedRevision === undefined
              ? undefined
              : String(write.expectedRevision),
        },
      }),
    /**
     * Revision-checked settings change. TTL and hop/pair budgets apply to
     * later messages, wake budgets at the next dispatch.
     */
    update: (
      room: string,
      input: z.input<typeof UpdateRoomSchema>,
      write: WriteOptions = {},
    ) =>
      client.patch(path(room), UpdateRoomSchema.parse(input), {
        ...options(RoomResponseSchema),
        idempotencyKey: key(write),
      }),
    archivePreview: (room: string) =>
      client.get(
        `${path(room)}/archive-preview`,
        options(RoomArchivePreviewResponseSchema),
      ),
    /** Stops publication and wakes; history stays readable. */
    archive: (
      room: string,
      expectedRevision: number,
      write: WriteOptions = {},
    ) =>
      client.post(
        `${path(room)}/archive`,
        RoomRevisionSchema.parse({ expected_revision: expectedRevision }),
        { ...options(RoomResponseSchema), idempotencyKey: key(write) },
      ),
    unarchive: (
      room: string,
      expectedRevision: number,
      write: WriteOptions = {},
    ) =>
      client.post(
        `${path(room)}/unarchive`,
        RoomRevisionSchema.parse({ expected_revision: expectedRevision }),
        { ...options(RoomResponseSchema), idempotencyKey: key(write) },
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
    history: (
      room: string,
      raw: Page & {
        thread_id?: string;
        direction?: "forward" | "backward";
      } = {},
    ) =>
      client.get(`${path(room)}/messages`, {
        ...options(RoomHistoryResponseSchema),
        ...page(raw),
        query: {
          ...page(raw).query,
          thread_id: raw.thread_id,
          direction: raw.direction,
        },
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
    /** Readers get aggregate counts; managers also get per-recipient traces. */
    deliveries: (room: string, message: string) =>
      client.get(
        `${path(room)}/messages/${encodeURIComponent(z.string().uuid().parse(message))}/deliveries`,
        options(MessageDeliveriesResponseSchema),
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
    /** Browse delivery traces newest first; requires conversations:manage. */
    deliveries: (raw: z.input<typeof DeliveryListQuerySchema> & Page = {}) => {
      const { expires_after, ...filters } = DeliveryListQuerySchema.parse(raw);
      return client.get(
        `/projects/${encodeURIComponent(projectId)}/deliveries`,
        {
          ...options(DeliveryListResponseSchema),
          ...page(raw),
          query: {
            ...page(raw).query,
            ...filters,
            expires_after:
              expires_after === undefined ? undefined : String(expires_after),
          },
        },
      );
    },
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
    update: unsupported,
    archivePreview: unsupported,
    archive: unsupported,
    unarchive: unsupported,
    threads: unsupported,
    createThread: unsupported,
    history: unsupported,
    publish: unsupported,
    deliveries: unsupported,
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
    deliveries: unsupported,
  };
}
export function createUnsupportedDispatchMethods(): ReturnType<
  typeof createDispatchMethods
> {
  return { status: unsupported, lease: unsupported, report: unsupported };
}
