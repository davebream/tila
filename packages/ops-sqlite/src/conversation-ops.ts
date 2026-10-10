import {
  type AckDelivery,
  CONVERSATION_INSTRUCTIONS,
  type ConsumerBinding,
  type CreateRoom,
  DeliverySchema,
  DispatchAttemptSchema,
  type DispatchReport,
  type Message,
  MessageSchema,
  OutboxEntrySchema,
  type PublishMessage,
  RoomSchema,
  type RuntimeIdentity,
} from "@tila/schemas";
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { authorizeRun, current } from "./agent-binding-ops";
import { clearLease, rearm } from "./conversation-state-ops";
import { appendJournal } from "./journal-ops";
import { canonicalJson } from "./project-transfer-ops";
import * as s from "./schema";

type DB = BaseSQLiteDatabase<"sync", unknown, typeof s>;
export interface ConversationAuthority {
  principal_id: string;
  participant_id: string;
  can_manage: boolean;
  runtime: RuntimeIdentity | null;
}
export class ConversationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 403 | 404 | 409 | 410 | 429 = 403,
  ) {
    super(message);
  }
}
function fail(
  code: string,
  message: string,
  status: 400 | 403 | 404 | 409 | 410 | 429 = 403,
): never {
  throw new ConversationError(code, message, status);
}
function bodyAccess(a: ConversationAuthority) {
  if (a.runtime?.run_role === "relay")
    fail(
      "permission-denied",
      "Relay credentials cannot access conversation bodies",
    );
}
function activeBinding(
  db: DB,
  agent: string,
  a: ConversationAuthority,
  now: number,
  relay = false,
): ConsumerBinding {
  const r = a.runtime;
  if (!r || r.agent_id !== agent || r.lease_expires_at * 1000 <= now)
    fail("runtime-required", "A current run pinned to this agent is required");
  authorizeRun(db, agent, r.principal_id);
  const b = current(db, agent);
  if (!b) fail("no-active-binding", "Agent has no active binding", 409);
  const epoch = db
    .select({ epoch: s.agents.binding_epoch })
    .from(s.agents)
    .where(eq(s.agents.id, agent))
    .get();
  if (epoch?.epoch !== b.binding_epoch)
    fail("stale-binding", "Binding epoch changed", 409);
  if (relay) {
    if (
      r.run_role !== "relay" ||
      !r.enrollment_id ||
      r.enrollment_id !== b.holder.enrollment_id
    )
      fail(
        "permission-denied",
        "Dispatch requires a relay from the holder's enrollment",
      );
  } else if (r.run_role !== "acting" || r.run_id !== b.holder.run_id) {
    fail(
      "stale-binding",
      "Only the current acting run may consume this mailbox",
      409,
    );
  }
  return b;
}
function memberKey(a: ConversationAuthority) {
  return a.runtime?.agent_id
    ? `agent:${a.runtime.agent_id}`
    : `principal:${a.principal_id}`;
}
function roomAccess(
  db: DB,
  id: string,
  a: ConversationAuthority,
  write = false,
) {
  bodyAccess(a);
  const row = db.select().from(s.rooms).where(eq(s.rooms.id, id)).get();
  if (!row || row.archived) fail("not-found", "Room not found", 404);
  if (write || (row.history_policy === "members" && !a.can_manage)) {
    const member = db
      .select()
      .from(s.roomMembers)
      .where(
        and(
          eq(s.roomMembers.room_id, id),
          eq(s.roomMembers.member, memberKey(a)),
        ),
      )
      .get();
    if (!member) fail("permission-denied", "Room membership required");
  }
  return RoomSchema.parse(row);
}
export function createRoom(
  db: DB,
  input: CreateRoom,
  a: ConversationAuthority,
  now = Date.now(),
) {
  bodyAccess(a);
  if (!a.can_manage)
    fail("permission-denied", "Managing rooms requires conversations:manage");
  return db.transaction((tx) => {
    const prior = tx
      .select()
      .from(s.rooms)
      .where(eq(s.rooms.id, input.id))
      .get();
    if (prior) {
      const {
        archived: _a,
        created_at: _c,
        updated_at: _u,
        ...request
      } = RoomSchema.parse(prior);
      if (canonicalJson(request) !== canonicalJson(input))
        fail("conflict", "Room already exists with different settings", 409);
      return RoomSchema.parse(prior);
    }
    tx.insert(s.rooms)
      .values({ ...input, created_at: now, updated_at: now })
      .run();
    tx.insert(s.roomMembers)
      .values({
        room_id: input.id,
        member: memberKey(a),
        wake: false,
        joined_at: now,
      })
      .run();
    return roomAccess(tx, input.id, a);
  });
}
export function listRooms(db: DB, a: ConversationAuthority) {
  bodyAccess(a);
  const memberships = new Set(
    db
      .select()
      .from(s.roomMembers)
      .where(eq(s.roomMembers.member, memberKey(a)))
      .all()
      .map((r) => r.room_id),
  );
  return db
    .select()
    .from(s.rooms)
    .where(eq(s.rooms.archived, false))
    .orderBy(s.rooms.id)
    .all()
    .filter(
      (r) =>
        a.can_manage || r.history_policy === "project" || memberships.has(r.id),
    )
    .map((r) => RoomSchema.parse(r));
}
export function getRoom(db: DB, id: string, a: ConversationAuthority) {
  const room = roomAccess(db, id, a);
  return {
    room,
    members: db
      .select()
      .from(s.roomMembers)
      .where(eq(s.roomMembers.room_id, id))
      .orderBy(s.roomMembers.member)
      .all(),
  };
}
export function setMember(
  db: DB,
  id: string,
  member: string,
  wake: boolean | null,
  a: ConversationAuthority,
  now = Date.now(),
) {
  bodyAccess(a);
  if (!a.can_manage)
    fail(
      "permission-denied",
      "Managing membership requires conversations:manage",
    );
  roomAccess(db, id, a);
  if (member.startsWith("agent:")) {
    const agent = db
      .select()
      .from(s.agents)
      .where(eq(s.agents.id, member.slice(6)))
      .get();
    if (!agent || agent.archived) fail("not-found", "Agent not found", 404);
  }
  const where = and(
    eq(s.roomMembers.room_id, id),
    eq(s.roomMembers.member, member),
  );
  if (wake === null) db.delete(s.roomMembers).where(where).run();
  else
    db.insert(s.roomMembers)
      .values({ room_id: id, member, wake, joined_at: now })
      .onConflictDoUpdate({
        target: [s.roomMembers.room_id, s.roomMembers.member],
        set: { wake },
      })
      .run();
}
export function createThread(
  db: DB,
  id: string,
  input: { id: string; title: string },
  a: ConversationAuthority,
  now = Date.now(),
) {
  return db.transaction((tx) => {
    roomAccess(tx, id, a, true);
    if (a.runtime) activeBinding(tx, a.runtime.agent_id ?? "", a, now);
    const prior = tx
      .select()
      .from(s.conversationThreads)
      .where(eq(s.conversationThreads.id, input.id))
      .get();
    if (prior) {
      if (prior.room_id !== id || prior.title !== input.title)
        fail("conflict", "Thread ID already used", 409);
      return prior;
    }
    return tx
      .insert(s.conversationThreads)
      .values({ ...input, room_id: id, created_at: now })
      .returning()
      .get();
  });
}
export function listThreads(db: DB, id: string, a: ConversationAuthority) {
  roomAccess(db, id, a);
  return db
    .select()
    .from(s.conversationThreads)
    .where(eq(s.conversationThreads.room_id, id))
    .orderBy(s.conversationThreads.created_at, s.conversationThreads.id)
    .all();
}
export function cursorGeneration(db: DB) {
  const row = db
    .select()
    .from(s.conversationState)
    .where(eq(s.conversationState.singleton, 1))
    .get();
  if (row) return row.generation;
  const generation = crypto.randomUUID();
  db.insert(s.conversationState)
    .values({ singleton: 1, generation })
    .onConflictDoNothing()
    .run();
  return (
    db
      .select()
      .from(s.conversationState)
      .where(eq(s.conversationState.singleton, 1))
      .get()?.generation ?? generation
  );
}
export function history(
  db: DB,
  id: string,
  a: ConversationAuthority,
  after = 0,
  limit = 50,
  thread?: string,
  direction: "forward" | "backward" = "forward",
) {
  roomAccess(db, id, a);
  const rows = db
    .select()
    .from(s.messages)
    .where(
      and(
        eq(s.messages.room_id, id),
        direction === "backward"
          ? lt(s.messages.seq, after || Number.MAX_SAFE_INTEGER)
          : gt(s.messages.seq, after),
        thread ? eq(s.messages.thread_id, thread) : undefined,
      ),
    )
    .orderBy(direction === "backward" ? desc(s.messages.seq) : s.messages.seq)
    .limit(Math.min(100, Math.max(1, limit)) + 1)
    .all();
  const selected = rows.slice(0, limit);
  if (direction === "backward") selected.reverse();
  return {
    messages: selected.map((r) => MessageSchema.parse(r.message)),
    has_more: rows.length > limit,
  };
}
async function hashRequest(input: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(input)),
  );
  return Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
export async function publish(
  db: DB,
  roomId: string,
  input: PublishMessage,
  a: ConversationAuthority,
  now = Date.now(),
) {
  bodyAccess(a);
  const hash = await hashRequest({ room_id: roomId, ...input });
  // Scope retries to a logical author. The current authenticated run is checked
  // by the Worker before this lookup; replay never grants new authority.
  const author = canonicalJson([a.principal_id, a.runtime?.agent_id ?? null]);
  return db.transaction((tx) => {
    const prior = tx
      .select()
      .from(s.messages)
      .where(
        and(
          eq(s.messages.author_key, author),
          eq(s.messages.client_op_id, input.client_op_id),
        ),
      )
      .get();
    if (prior) {
      if (prior.request_hash !== hash)
        fail("conflict", "Operation ID was used with a different message", 409);
      roomAccess(tx, roomId, a, true);
      if (a.runtime) activeBinding(tx, a.runtime.agent_id ?? "", a, now);
      return { message: MessageSchema.parse(prior.message), replayed: true };
    }
    const b = a.runtime
      ? activeBinding(tx, a.runtime.agent_id ?? "", a, now)
      : null;
    const room = roomAccess(tx, roomId, a, true);
    if (input.thread_id) {
      const t = tx
        .select()
        .from(s.conversationThreads)
        .where(eq(s.conversationThreads.id, input.thread_id))
        .get();
      if (t?.room_id !== roomId)
        fail("not-found", "Thread not in this room", 404);
    }
    for (const key of input.artifact_refs) {
      const artifact = tx
        .select()
        .from(s.artifactPointers)
        .where(
          and(
            eq(s.artifactPointers.r2_key, key),
            isNull(s.artifactPointers.tombstoned_at),
          ),
        )
        .get();
      if (!artifact)
        fail("not-found", "Artifact reference does not exist", 404);
    }
    const id = crypto.randomUUID();
    let chain: string = id;
    let hop = 0;
    if (b) {
      const context = tx
        .select()
        .from(s.conversationContext)
        .where(
          eq(s.conversationContext.consumer_binding_id, b.consumer_binding_id),
        )
        .get();
      if (context) {
        const parent = tx
          .select({ message: s.messages.message })
          .from(s.messageRecipients)
          .innerJoin(
            s.messages,
            eq(s.messages.id, s.messageRecipients.message_id),
          )
          .where(eq(s.messageRecipients.id, context.delivery_id))
          .get();
        if (parent) {
          chain = parent.message.chain_id;
          hop = parent.message.hop + 1;
        }
      }
    }
    const seq = tx
      .update(s.rooms)
      .set({ next_seq: sql`${s.rooms.next_seq}+1`, updated_at: now })
      .where(eq(s.rooms.id, roomId))
      .returning({ seq: s.rooms.next_seq })
      .get()?.seq;
    if (seq === undefined)
      throw new Error("Room sequence update did not return a row");
    const { targets, ...content } = input;
    const message: Message = {
      ...content,
      id,
      room_id: roomId,
      seq,
      authority: "peer-content",
      chain_id: chain,
      hop,
      created_at: now,
      provenance: {
        author_kind: b ? "agent" : "human",
        agent_id: b?.agent_id ?? null,
        principal_id: a.principal_id,
        participant_id: a.participant_id,
        consumer_binding_id: b?.consumer_binding_id ?? null,
        binding_epoch: b?.binding_epoch ?? null,
      },
    };
    const ordinal =
      (tx
        .select({ max: sql<number>`COALESCE(MAX(${s.messages.ordinal}),0)` })
        .from(s.messages)
        .get()?.max ?? 0) + 1;
    tx.insert(s.messages)
      .values({
        ordinal,
        id,
        room_id: roomId,
        thread_id: input.thread_id,
        seq,
        author_key: author,
        client_op_id: input.client_op_id,
        request_hash: hash,
        message,
        author_agent: b?.agent_id ?? null,
        chain_id: chain,
        hop,
        created_at: now,
      })
      .run();
    const members = tx
      .select()
      .from(s.roomMembers)
      .where(eq(s.roomMembers.room_id, roomId))
      .all();
    const recipients = new Map<
      string,
      { agent: string; binding: string | null; epoch: number | null }
    >();
    const add = (
      agent: string,
      binding: string | null,
      epoch: number | null,
    ) => {
      if (!members.some((m) => m.member === `agent:${agent}`))
        fail("permission-denied", "Recipients must belong to the room");
      if (binding) {
        const target = current(tx, agent);
        if (
          target?.consumer_binding_id !== binding ||
          target.binding_epoch !== epoch
        )
          fail("stale-binding", "Exact recipient binding changed", 409);
      }
      recipients.set(canonicalJson([agent, binding]), {
        agent,
        binding,
        epoch,
      });
    };
    for (const target of targets) {
      if (target.kind === "room") {
        for (const m of members)
          if (m.wake && m.member.startsWith("agent:"))
            add(m.member.slice(6), null, null);
      } else
        add(
          target.agent_id,
          target.kind === "binding" ? target.consumer_binding_id : null,
          target.kind === "binding" ? target.binding_epoch : null,
        );
    }
    for (const r of recipients.values()) {
      let suppression: "hop" | "pair" | null =
        hop > room.budgets.max_hops ? "hop" : null;
      if (b && !suppression) {
        const exchanges =
          tx
            .select({ n: count() })
            .from(s.messageRecipients)
            .innerJoin(
              s.messages,
              eq(s.messages.id, s.messageRecipients.message_id),
            )
            .where(
              and(
                gte(s.messages.created_at, now - 600000),
                or(
                  and(
                    eq(s.messages.author_agent, b.agent_id),
                    eq(s.messageRecipients.agent_id, r.agent),
                  ),
                  and(
                    eq(s.messages.author_agent, r.agent),
                    eq(s.messageRecipients.agent_id, b.agent_id),
                  ),
                ),
              ),
            )
            .get()?.n ?? 0;
        if (exchanges >= room.budgets.pair_exchanges) suppression = "pair";
      }
      tx.insert(s.messageRecipients)
        .values({
          ordinal,
          id: crypto.randomUUID(),
          message_id: id,
          agent_id: r.agent,
          target_binding_id: r.binding,
          target_epoch: r.epoch,
          wake_suppressed: suppression,
          created_at: now,
          expires_at: now + room.delivery_ttl_seconds * 1000,
        })
        .run();
      rearm(tx, r.agent, now);
    }
    appendJournal(tx, {
      kind: "conversation.published",
      resource: `room:${roomId}`,
      actor: "",
      principalId: a.principal_id,
      participantId: a.participant_id,
      environment: {},
      data: { message_id: id, room_id: roomId, seq },
    });
    return { message, replayed: false };
  });
}

export function expireDeliveries(db: DB, now = Date.now()) {
  return db
    .update(s.messageRecipients)
    .set({ state: "expired" })
    .where(
      and(
        eq(s.messageRecipients.state, "pending"),
        lte(s.messageRecipients.expires_at, now),
      ),
    )
    .returning({ id: s.messageRecipients.id })
    .all().length;
}
function pendingWhere(agent: string, b: ConsumerBinding, now: number) {
  return and(
    eq(s.messageRecipients.agent_id, agent),
    eq(s.messageRecipients.state, "pending"),
    gt(s.messageRecipients.expires_at, now),
    or(
      isNull(s.messageRecipients.target_binding_id),
      and(
        eq(s.messageRecipients.target_binding_id, b.consumer_binding_id),
        eq(s.messageRecipients.target_epoch, b.binding_epoch),
      ),
    ),
  );
}
export function pendingCount(
  db: DB,
  agent: string,
  b: ConsumerBinding,
  now = Date.now(),
) {
  return (
    db
      .select({ n: count() })
      .from(s.messageRecipients)
      .where(pendingWhere(agent, b, now))
      .get()?.n ?? 0
  );
}
export function fetchInbox(
  db: DB,
  agent: string,
  a: ConversationAuthority,
  limit = 50,
  after?: { ordinal: number; id: string },
  now = Date.now(),
) {
  bodyAccess(a);
  return db.transaction((tx) => {
    const b = activeBinding(tx, agent, a, now);
    expireDeliveries(tx, now);
    const pageSize = Math.min(100, Math.max(1, limit));
    const rows = tx
      .select({ delivery: s.messageRecipients, message: s.messages.message })
      .from(s.messageRecipients)
      .innerJoin(s.messages, eq(s.messages.id, s.messageRecipients.message_id))
      .where(
        and(
          pendingWhere(agent, b, now),
          after
            ? or(
                gt(s.messageRecipients.ordinal, after.ordinal),
                and(
                  eq(s.messageRecipients.ordinal, after.ordinal),
                  gt(s.messageRecipients.id, after.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(s.messageRecipients.ordinal, s.messageRecipients.id)
      .limit(pageSize + 1)
      .all();
    const page = rows.slice(0, pageSize);
    for (const { delivery: d } of page)
      tx.update(s.messageRecipients)
        .set({
          fetched_at: now,
          fetched_binding_id: b.consumer_binding_id,
          fetched_epoch: b.binding_epoch,
        })
        .where(eq(s.messageRecipients.id, d.id))
        .run();
    tx.update(s.agentBindings)
      .set({ lease_expires_at: a.runtime?.lease_expires_at, updated_at: now })
      .where(eq(s.agentBindings.consumer_binding_id, b.consumer_binding_id))
      .run();
    // The server records the open delivery; clients cannot fabricate causal metadata.
    if (page[0])
      tx.insert(s.conversationContext)
        .values({
          consumer_binding_id: b.consumer_binding_id,
          delivery_id: page[0].delivery.id,
          opened_at: now,
        })
        .onConflictDoUpdate({
          target: s.conversationContext.consumer_binding_id,
          set: { delivery_id: page[0].delivery.id, opened_at: now },
        })
        .run();
    return {
      instructions: CONVERSATION_INSTRUCTIONS,
      binding: {
        consumer_binding_id: b.consumer_binding_id,
        binding_epoch: b.binding_epoch,
      },
      pending: pendingCount(tx, agent, b, now),
      has_more: rows.length > pageSize,
      deliveries: page.map(({ delivery: d, message }) => ({
        delivery: DeliverySchema.parse({
          ...d,
          fetched_at: now,
          fetched_binding_id: b.consumer_binding_id,
          fetched_epoch: b.binding_epoch,
        }),
        message: MessageSchema.parse(message),
        label:
          d.fetched_at === null
            ? "new"
            : `previously fetched by epoch ${d.fetched_epoch} at ${d.fetched_at}`,
        reply_op_id: `reply:${d.id}`,
        remaining_budget: {
          hops: Math.max(
            0,
            (tx
              .select({ budgets: s.rooms.budgets })
              .from(s.rooms)
              .where(eq(s.rooms.id, message.room_id))
              .get()?.budgets.max_hops ?? 8) - message.hop,
          ),
        },
      })),
    };
  });
}
export function acknowledge(
  db: DB,
  agent: string,
  id: string,
  input: AckDelivery,
  a: ConversationAuthority,
  now = Date.now(),
) {
  bodyAccess(a);
  return db.transaction((tx) => {
    const b = activeBinding(tx, agent, a, now);
    if (
      input.consumer_binding_id !== b.consumer_binding_id ||
      input.binding_epoch !== b.binding_epoch
    )
      fail("stale-binding", "Acknowledgement binding changed", 409);
    const d = tx
      .select()
      .from(s.messageRecipients)
      .where(
        and(
          eq(s.messageRecipients.id, id),
          eq(s.messageRecipients.agent_id, agent),
        ),
      )
      .get();
    if (!d) fail("not-found", "Delivery not found", 404);
    if (
      d.target_binding_id &&
      (d.target_binding_id !== b.consumer_binding_id ||
        d.target_epoch !== b.binding_epoch)
    )
      fail("stale-binding", "Exact delivery belongs to another binding", 409);
    if (d.state === "acked") {
      if (
        d.acked_binding_id !== b.consumer_binding_id ||
        d.acked_epoch !== b.binding_epoch ||
        d.disposition !== input.disposition
      )
        fail("conflict", "Delivery already acknowledged differently", 409);
      return {
        delivery: DeliverySchema.parse(d),
        pending: pendingCount(tx, agent, b, now),
        replayed: true,
      };
    }
    if (d.state === "expired" || d.expires_at <= now)
      fail("delivery-expired", "Delivery expired", 410);
    const updated = tx
      .update(s.messageRecipients)
      .set({
        state: "acked",
        acked_at: now,
        acked_binding_id: b.consumer_binding_id,
        acked_epoch: b.binding_epoch,
        disposition: input.disposition,
      })
      .where(
        and(
          eq(s.messageRecipients.id, id),
          eq(s.messageRecipients.state, "pending"),
        ),
      )
      .returning()
      .get();
    if (!updated)
      throw new Error("Delivery acknowledgement lost its transaction");
    if (input.disposition === "accepted")
      tx.insert(s.conversationContext)
        .values({
          consumer_binding_id: b.consumer_binding_id,
          delivery_id: id,
          opened_at: now,
        })
        .onConflictDoUpdate({
          target: s.conversationContext.consumer_binding_id,
          set: { delivery_id: id, opened_at: now },
        })
        .run();
    const pending = pendingCount(tx, agent, b, now);
    if (!pending)
      tx.update(s.dispatchOutbox)
        .set({ state: "quiet", updated_at: now, ...clearLease })
        .where(eq(s.dispatchOutbox.agent_id, agent))
        .run();
    appendJournal(tx, {
      kind: "conversation.acknowledged",
      resource: `delivery:${id}`,
      actor: "",
      principalId: a.principal_id,
      participantId: a.participant_id,
      environment: {},
      data: { delivery_id: id, disposition: input.disposition },
    });
    return {
      delivery: DeliverySchema.parse(updated),
      pending,
      replayed: false,
    };
  });
}
export function inboxVersion(
  db: DB,
  agent: string,
  a: ConversationAuthority,
  now = Date.now(),
) {
  const b = activeBinding(db, agent, a, now);
  const outbox = db
    .select()
    .from(s.dispatchOutbox)
    .where(eq(s.dispatchOutbox.agent_id, agent))
    .get();
  return {
    version: `${cursorGeneration(db)}:${b.binding_epoch}:${outbox?.publish_gen ?? 0}`,
    pending: pendingCount(db, agent, b, now),
  };
}
export function dispatchStatus(
  db: DB,
  agent: string,
  a: ConversationAuthority,
  now = Date.now(),
  leaseToken?: string,
) {
  const b = activeBinding(db, agent, a, now, true);
  expireDeliveries(db, now);
  const outbox = db
    .select()
    .from(s.dispatchOutbox)
    .where(eq(s.dispatchOutbox.agent_id, agent))
    .get();
  const attempt = leaseToken
    ? db
        .select()
        .from(s.dispatchAttempts)
        .where(
          and(
            eq(s.dispatchAttempts.agent_id, agent),
            eq(s.dispatchAttempts.lease_token, leaseToken),
          ),
        )
        .get()
    : undefined;
  if (
    leaseToken &&
    (!attempt ||
      attempt.consumer_binding_id !== b.consumer_binding_id ||
      attempt.binding_epoch !== b.binding_epoch)
  )
    fail("stale-binding", "Lease does not belong to the current binding", 409);
  // Deliberately does not join messages, return content, or stamp fetched_at.
  return {
    server_now: now,
    attempt: attempt ? DispatchAttemptSchema.parse(attempt) : null,
    binding: {
      consumer_binding_id: b.consumer_binding_id,
      binding_epoch: b.binding_epoch,
      mechanism: b.mechanism,
    },
    outbox: outbox ? OutboxEntrySchema.parse(outbox) : null,
    deliveries: db
      .select()
      .from(s.messageRecipients)
      .where(
        and(
          eq(s.messageRecipients.agent_id, agent),
          attempt
            ? inArray(s.messageRecipients.id, attempt.delivery_ids)
            : eq(s.messageRecipients.state, "pending"),
        ),
      )
      .orderBy(s.messageRecipients.ordinal, s.messageRecipients.id)
      .limit(100)
      .all()
      .map((d) => DeliverySchema.parse(d)),
  };
}
const BACKOFF = [30000, 120000, 600000, 3600000, 21600000];
export function leaseDispatch(
  db: DB,
  agent: string,
  a: ConversationAuthority,
  now = Date.now(),
) {
  return db.transaction((tx) => {
    const b = activeBinding(tx, agent, a, now, true);
    expireDeliveries(tx, now);
    const outbox = tx
      .select()
      .from(s.dispatchOutbox)
      .where(eq(s.dispatchOutbox.agent_id, agent))
      .get();
    if (
      !outbox ||
      (outbox.lease_until ?? 0) > now ||
      outbox.next_attempt_at > now
    )
      return null;
    if (b.mechanism === "poll") {
      tx.update(s.dispatchOutbox)
        .set({ state: "quiet", ...clearLease, updated_at: now })
        .where(eq(s.dispatchOutbox.agent_id, agent))
        .run();
      return null;
    }
    const pending = tx
      .select({ delivery: s.messageRecipients, room: s.rooms })
      .from(s.messageRecipients)
      .innerJoin(s.messages, eq(s.messages.id, s.messageRecipients.message_id))
      .innerJoin(s.rooms, eq(s.rooms.id, s.messages.room_id))
      .where(
        and(
          pendingWhere(agent, b, now),
          isNull(s.messageRecipients.wake_suppressed),
        ),
      )
      .orderBy(s.messageRecipients.ordinal, s.messageRecipients.id)
      .limit(100)
      .all();
    const eligible: string[] = [];
    const roomIds = new Set<string>();
    const recent = tx
      .select()
      .from(s.dispatchAttempts)
      .where(gte(s.dispatchAttempts.created_at, now - 3600000))
      .all();
    for (const { delivery: d, room } of pending) {
      if (d.wake_suppressed) continue;
      let suppressed: "stalled" | "agent" | "room" | null = null;
      if (d.fetched_at !== null && d.rewakes >= 3) suppressed = "stalled";
      else if (
        recent.filter((r) => r.agent_id === agent).length >=
        room.budgets.agent_wakes
      )
        suppressed = "agent";
      else if (
        recent.filter((r) => r.room_ids.includes(room.id)).length >=
        room.budgets.room_wakes
      )
        suppressed = "room";
      if (suppressed)
        tx.update(s.messageRecipients)
          .set({ wake_suppressed: suppressed })
          .where(eq(s.messageRecipients.id, d.id))
          .run();
      else {
        eligible.push(d.id);
        roomIds.add(room.id);
      }
    }
    if (!eligible.length) {
      tx.update(s.dispatchOutbox)
        .set({ state: "quiet", ...clearLease, updated_at: now })
        .where(eq(s.dispatchOutbox.agent_id, agent))
        .run();
      return null;
    }
    const token = crypto.randomUUID();
    const lease = {
      lease_token: token,
      lease_until: now + 30000,
      lease_gen: outbox.publish_gen,
      lease_binding_id: b.consumer_binding_id,
      lease_epoch: b.binding_epoch,
    };
    tx.update(s.dispatchOutbox)
      .set({
        ...lease,
        attempt_count: outbox.attempt_count + 1,
        updated_at: now,
      })
      .where(eq(s.dispatchOutbox.agent_id, agent))
      .run();
    tx.insert(s.dispatchAttempts)
      .values({
        id: crypto.randomUUID(),
        agent_id: agent,
        lease_token: token,
        consumer_binding_id: b.consumer_binding_id,
        binding_epoch: b.binding_epoch,
        publish_gen: outbox.publish_gen,
        outcome: "leased",
        created_at: now,
        room_ids: [...roomIds],
        delivery_ids: eligible,
      })
      .run();
    tx.update(s.messageRecipients)
      .set({ rewakes: sql`${s.messageRecipients.rewakes}+1` })
      .where(
        and(
          inArray(s.messageRecipients.id, eligible),
          sql`${s.messageRecipients.fetched_at} IS NOT NULL`,
        ),
      )
      .run();
    return {
      lease_token: token,
      lease_until: lease.lease_until,
      publish_gen: outbox.publish_gen,
      consumer_binding_id: b.consumer_binding_id,
      binding_epoch: b.binding_epoch,
      pending: eligible.length,
      mechanism: b.mechanism,
      native_session_ref: b.native_session_ref,
      capability_report: b.capability_report,
      allow_idle_start: b.allow_idle_start,
    };
  });
}
export function reportDispatch(
  db: DB,
  agent: string,
  input: DispatchReport,
  a: ConversationAuthority,
  now = Date.now(),
) {
  return db.transaction((tx) => {
    const b = activeBinding(tx, agent, a, now, true);
    if (
      input.consumer_binding_id !== b.consumer_binding_id ||
      input.binding_epoch !== b.binding_epoch
    )
      fail("stale-binding", "Dispatch binding changed", 409);
    const attempt = tx
      .select()
      .from(s.dispatchAttempts)
      .where(
        and(
          eq(s.dispatchAttempts.agent_id, agent),
          eq(s.dispatchAttempts.lease_token, input.lease_token),
        ),
      )
      .get();
    if (
      !attempt ||
      attempt.consumer_binding_id !== b.consumer_binding_id ||
      attempt.binding_epoch !== b.binding_epoch ||
      attempt.publish_gen !== input.publish_gen
    )
      fail("conflict", "Unknown dispatch lease", 409);
    if (attempt.outcome !== "leased") {
      if (attempt.outcome !== input.outcome)
        fail("conflict", "Dispatch already reported differently", 409);
      return { replayed: true };
    }
    const outbox = tx
      .select()
      .from(s.dispatchOutbox)
      .where(eq(s.dispatchOutbox.agent_id, agent))
      .get();
    if (
      !outbox ||
      outbox.lease_token !== input.lease_token ||
      (outbox.lease_until ?? 0) <= now ||
      outbox.lease_gen !== input.publish_gen ||
      outbox.lease_epoch !== b.binding_epoch ||
      outbox.lease_binding_id !== b.consumer_binding_id
    )
      fail("conflict", "Dispatch lease expired or was replaced", 409);
    tx.update(s.dispatchAttempts)
      .set({ outcome: input.outcome, reported_at: now })
      .where(eq(s.dispatchAttempts.id, attempt.id))
      .run();
    const unchanged = outbox.publish_gen === input.publish_gen;
    tx.update(s.dispatchOutbox)
      .set({
        state: unchanged && input.outcome === "accepted" ? "quiet" : "pending",
        ...clearLease,
        next_attempt_at: unchanged
          ? now +
            (BACKOFF[Math.min(outbox.attempt_count - 1, BACKOFF.length - 1)] ??
              21600000)
          : now,
        updated_at: now,
      })
      .where(eq(s.dispatchOutbox.agent_id, agent))
      .run();
    return { replayed: false };
  });
}
export function explainDelivery(
  db: DB,
  agent: string,
  id: string,
  a: ConversationAuthority,
  now = Date.now(),
) {
  bodyAccess(a);
  if (!a.can_manage) activeBinding(db, agent, a, now);
  const d = db
    .select()
    .from(s.messageRecipients)
    .where(
      and(
        eq(s.messageRecipients.id, id),
        eq(s.messageRecipients.agent_id, agent),
      ),
    )
    .get();
  if (!d) fail("not-found", "Delivery not found", 404);
  const b = current(db, agent);
  const attempts = db
    .select()
    .from(s.dispatchAttempts)
    .where(eq(s.dispatchAttempts.agent_id, agent))
    .orderBy(s.dispatchAttempts.created_at)
    .all()
    .filter((attempt) => attempt.delivery_ids.includes(id));
  const last = attempts.at(-1);
  const reason =
    d.state === "acked"
      ? "acknowledged"
      : d.state === "expired" || d.expires_at <= now
        ? "deferred-past-ttl"
        : !b
          ? "no-binding"
          : d.target_binding_id &&
              (d.target_binding_id !== b.consumer_binding_id ||
                d.target_epoch !== b.binding_epoch)
            ? "stale-epoch"
            : d.wake_suppressed
              ? "budget-suppressed"
              : d.fetched_at
                ? "fetched-not-acked"
                : b.mechanism !== "poll" && !b.native_session_ref
                  ? "session-ref-missing"
                  : last?.outcome === "rejected"
                    ? "wake-rejected"
                    : "connector-not-polling";
  return {
    reason,
    delivery: DeliverySchema.parse(d),
    attempts: attempts.map((v) => DispatchAttemptSchema.parse(v)),
  };
}
export function resumeDelivery(
  db: DB,
  agent: string,
  id: string,
  a: ConversationAuthority,
  now = Date.now(),
) {
  bodyAccess(a);
  if (!a.can_manage)
    fail("permission-denied", "Resuming wakes requires conversations:manage");
  return db.transaction((tx) => {
    const d = tx
      .select()
      .from(s.messageRecipients)
      .where(
        and(
          eq(s.messageRecipients.id, id),
          eq(s.messageRecipients.agent_id, agent),
        ),
      )
      .get();
    if (!d) fail("not-found", "Delivery not found", 404);
    if (d.state !== "pending" || d.expires_at <= now)
      fail(
        "delivery-expired",
        "Only pending unexpired deliveries can resume",
        410,
      );
    tx.update(s.messageRecipients)
      .set({ wake_suppressed: null, rewakes: 0 })
      .where(eq(s.messageRecipients.id, id))
      .run();
    rearm(tx, agent, now, false);
  });
}
