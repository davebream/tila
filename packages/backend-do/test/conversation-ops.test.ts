import {
  AgentRegistrationSchema,
  AttachAgentBindingSchema,
  CreateRoomSchema,
  PublishMessageSchema,
  type RuntimeIdentity,
} from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as bindings from "../../ops-sqlite/src/agent-binding-ops";
import * as ops from "../../ops-sqlite/src/conversation-ops";
import { createTestDb } from "./helpers/create-test-db";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected fixture value");
  return value;
}
describe("durable conversations", () => {
  let f: ReturnType<typeof createTestDb>;
  const now = 100000;
  const enrollment = crypto.randomUUID();
  const owner: ops.ConversationAuthority = {
    principal_id: "owner",
    participant_id: "human",
    can_manage: true,
    runtime: null,
  };
  let acting: ops.ConversationAuthority;
  let relay: ops.ConversationAuthority;
  const run = (
    id = "worker",
    role: "acting" | "relay" = "acting",
  ): RuntimeIdentity => ({
    run_id: crypto.randomUUID(),
    agent_id: id,
    run_role: role,
    principal_id: "owner",
    participant_id: crypto.randomUUID(),
    enrollment_id: enrollment,
    workload_binding_id: null,
    lease_expires_at: 1000000,
  });
  const attach = (a: ops.ConversationAuthority, epoch = 0) =>
    bindings.attach(
      f.db,
      "worker",
      AttachAgentBindingSchema.parse({
        expected_epoch: epoch,
        harness: "test",
        mechanism: "native-peer",
        capability_report: {
          protocol: 1,
          adapter_version: "test",
          capabilities: {},
        },
      }),
      a,
      now,
    );
  const message = (op = "one", extra = {}) =>
    PublishMessageSchema.parse({ client_op_id: op, body: "hello", ...extra });
  const publish = (op = "one", extra = {}, time = now) =>
    ops.publish(f.db, "general", message(op, extra), owner, time);
  beforeEach(() => {
    f = createTestDb({ foreignKeys: "on" });
    bindings.register(
      f.db,
      AgentRegistrationSchema.parse({ id: "worker", name: "Worker" }),
      owner,
      now,
    );
    acting = { ...owner, can_manage: false, runtime: run() };
    relay = { ...owner, can_manage: false, runtime: run("worker", "relay") };
    ops.createRoom(
      f.db,
      CreateRoomSchema.parse({ id: "general", name: "General" }),
      owner,
      now,
    );
    ops.setMember(f.db, "general", "agent:worker", true, owner, now);
  });
  afterEach(() => f.sqlite.close());
  it("snapshots offline members and atomically replays author operations", async () => {
    const first = await publish();
    expect((await publish()).message.id).toBe(first.message.id);
    await expect(publish("one", { body: "changed" })).rejects.toThrow(
      /different/,
    );
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM message_recipients").get(),
    ).toEqual({ n: 1 });
    expect(
      f.sqlite
        .prepare(
          "SELECT count(*) AS n FROM journal WHERE kind='conversation.published'",
        )
        .get(),
    ).toEqual({ n: 1 });
    attach(acting);
    expect(
      ops.fetchInbox(f.db, "worker", acting, 50, undefined, now).deliveries[0]
        .message.body,
    ).toBe("hello");
  });
  it("rolls back sequence, message, deliveries and outbox when a target is invalid", async () => {
    await expect(
      publish("bad", { targets: [{ kind: "agent", agent_id: "stranger" }] }),
    ).rejects.toThrow(/Recipients/);
    expect((await publish()).message.seq).toBe(1);
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM dispatch_outbox").get(),
    ).toEqual({ n: 1 });
  });
  it("fetch survives a crash; ack retries replay before checking delivery expiry", async () => {
    const b = attach(acting);
    await publish();
    const first = ops.fetchInbox(f.db, "worker", acting, 50, undefined, now);
    const second = ops.fetchInbox(
      f.db,
      "worker",
      acting,
      50,
      undefined,
      now + 1,
    );
    expect(second.pending).toBe(1);
    expect(second.deliveries[0].label).toContain("previously fetched");
    const input = {
      consumer_binding_id: b.consumer_binding_id,
      binding_epoch: b.binding_epoch,
      disposition: "accepted" as const,
    };
    const id = first.deliveries[0].delivery.id;
    expect(
      ops.acknowledge(f.db, "worker", id, input, acting, now + 2).pending,
    ).toBe(0);
    expect(
      ops.acknowledge(f.db, "worker", id, input, acting, now + 604800001)
        .replayed,
    ).toBe(true);
    expect(() =>
      ops.acknowledge(
        f.db,
        "worker",
        id,
        { ...input, disposition: "declined" },
        acting,
        now + 3,
      ),
    ).toThrow(/differently/);
  });
  it("rejects a stale consumer and does not transfer exact-binding deliveries", async () => {
    const b = attach(acting);
    await publish("exact", {
      targets: [
        {
          kind: "binding",
          agent_id: "worker",
          consumer_binding_id: b.consumer_binding_id,
          binding_epoch: b.binding_epoch,
        },
      ],
    });
    await publish("logical");
    const old = acting;
    acting = { ...acting, runtime: run() };
    attach(acting, 1);
    expect(() =>
      ops.fetchInbox(f.db, "worker", old, 50, undefined, now),
    ).toThrow(/current acting/);
    const page = ops.fetchInbox(f.db, "worker", acting, 50, undefined, now);
    expect(page.deliveries.map((d) => d.message.client_op_id)).toEqual([
      "logical",
    ]);
  });
  it("relay status exposes metadata without stamping fetched or granting body access", async () => {
    attach(acting);
    await publish();
    const status = ops.dispatchStatus(f.db, "worker", relay, now);
    expect(status.deliveries[0].fetched_at).toBeNull();
    expect(JSON.stringify(status)).not.toContain("hello");
    expect(() =>
      ops.fetchInbox(f.db, "worker", relay, 50, undefined, now),
    ).toThrow(/Relay/);
    expect(() => ops.history(f.db, "general", relay)).toThrow(/Relay/);
    expect(() =>
      ops.dispatchStatus(
        f.db,
        "worker",
        {
          ...relay,
          runtime: {
            ...required(relay.runtime),
            enrollment_id: crypto.randomUUID(),
          },
        },
        now,
      ),
    ).toThrow(/enrollment/);
  });
  it("a report cannot quiet a publication accepted during its lease", async () => {
    attach(acting);
    await publish();
    const lease = required(ops.leaseDispatch(f.db, "worker", relay, now));
    expect(lease).not.toBeNull();
    await publish("two", {}, now + 1);
    const report = {
      lease_token: lease.lease_token,
      consumer_binding_id: lease.consumer_binding_id,
      binding_epoch: lease.binding_epoch,
      publish_gen: lease.publish_gen,
      outcome: "accepted" as const,
    };
    ops.reportDispatch(f.db, "worker", report, relay, now + 2);
    const status = ops.dispatchStatus(f.db, "worker", relay, now + 2);
    expect(status.outbox?.state).toBe("pending");
    expect(status.outbox?.next_attempt_at).toBe(now + 2);
    expect(
      ops.reportDispatch(f.db, "worker", report, relay, now + 3).replayed,
    ).toBe(true);
  });
  it("recovers abandoned leases and rejects late reports", async () => {
    attach(acting);
    await publish();
    const old = required(ops.leaseDispatch(f.db, "worker", relay, now));
    const next = required(
      ops.leaseDispatch(f.db, "worker", relay, now + 30001),
    );
    expect(next.lease_token).not.toBe(old.lease_token);
    expect(() =>
      ops.reportDispatch(
        f.db,
        "worker",
        { ...old, outcome: "accepted" },
        relay,
        now + 30002,
      ),
    ).toThrow(/expired or was replaced/);
  });
  it("stalls fetched unacknowledged work after three re-wakes without dropping it", async () => {
    attach(acting);
    await publish();
    ops.fetchInbox(f.db, "worker", acting, 50, undefined, now);
    let t = now;
    for (let i = 0; i < 3; i++) {
      const lease = required(ops.leaseDispatch(f.db, "worker", relay, t));
      expect(lease).not.toBeNull();
      ops.reportDispatch(
        f.db,
        "worker",
        { ...lease, outcome: "accepted" },
        relay,
        t + 1,
      );
      t =
        ops.dispatchStatus(f.db, "worker", relay, t + 1).outbox
          ?.next_attempt_at ?? 0;
    }
    expect(ops.leaseDispatch(f.db, "worker", relay, t)).toBeNull();
    expect(
      ops.dispatchStatus(f.db, "worker", relay, t).deliveries[0],
    ).toMatchObject({
      state: "pending",
      wake_suppressed: "stalled",
      rewakes: 3,
    });
  });
  it("derives causal chains from held delivery context, not client reply fields", async () => {
    attach(acting);
    const root = await publish();
    const inbox = ops.fetchInbox(f.db, "worker", acting, 50, undefined, now);
    const reply = await ops.publish(
      f.db,
      "general",
      message(inbox.deliveries[0].reply_op_id),
      acting,
      now + 1,
    );
    expect(reply.message).toMatchObject({
      chain_id: root.message.chain_id,
      hop: 1,
      authority: "peer-content",
    });
    expect(
      PublishMessageSchema.safeParse({ ...message(), hop: 0 }).success,
    ).toBe(false);
  });
  it("expires only deliveries and preserves message history", async () => {
    attach(acting);
    await publish();
    expect(ops.expireDeliveries(f.db, now + 604800001)).toBe(1);
    expect(ops.history(f.db, "general", owner).messages).toHaveLength(1);
  });
  it("paginates deterministically across rooms and keeps pending deliveries independent of history", async () => {
    attach(acting);
    ops.createRoom(
      f.db,
      CreateRoomSchema.parse({ id: "other", name: "Other" }),
      owner,
      now,
    );
    ops.setMember(f.db, "other", "agent:worker", true, owner, now);
    await publish("first");
    await ops.publish(f.db, "other", message("second"), owner, now);
    await publish("third");
    expect(ops.history(f.db, "general", owner, 999).messages).toEqual([]);
    const first = ops.fetchInbox(f.db, "worker", acting, 1, undefined, now);
    const next = ops.fetchInbox(
      f.db,
      "worker",
      acting,
      1,
      first.deliveries[0].delivery,
      now,
    );
    const last = ops.fetchInbox(
      f.db,
      "worker",
      acting,
      1,
      next.deliveries[0].delivery,
      now,
    );
    expect(
      [first, next, last].map((p) => p.deliveries[0].message.client_op_id),
    ).toEqual(["first", "second", "third"]);
    expect(last.pending).toBe(3);
  });
  it("reconciles a specific dispatch lease after its delivery was acknowledged", async () => {
    const b = attach(acting);
    await publish();
    const lease = required(ops.leaseDispatch(f.db, "worker", relay, now));
    const page = ops.fetchInbox(f.db, "worker", acting, 50, undefined, now);
    ops.acknowledge(
      f.db,
      "worker",
      page.deliveries[0].delivery.id,
      {
        consumer_binding_id: b.consumer_binding_id,
        binding_epoch: b.binding_epoch,
        disposition: "accepted",
      },
      acting,
      now + 1,
    );
    const status = ops.dispatchStatus(
      f.db,
      "worker",
      relay,
      now + 2,
      lease.lease_token,
    );
    expect(status.deliveries[0].state).toBe("acked");
    expect(status.server_now).toBe(now + 2);
    expect(status.attempt).toMatchObject({
      created_at: now,
      lease_token: lease.lease_token,
      consumer_binding_id: b.consumer_binding_id,
      binding_epoch: b.binding_epoch,
    });
  });
  it("enforces byte limits and leaves budget-suppressed work pending", async () => {
    expect(
      PublishMessageSchema.safeParse({
        client_op_id: "large",
        body: "é".repeat(32769),
      }).success,
    ).toBe(false);
    expect(
      PublishMessageSchema.safeParse({
        client_op_id: "limit",
        body: "é".repeat(32768),
      }).success,
    ).toBe(true);
    attach(acting);
    for (let n = 0; n < 11; n++)
      await ops.publish(f.db, "general", message(`pair-${n}`), acting, now + n);
    const pending = ops.fetchInbox(
      f.db,
      "worker",
      acting,
      50,
      undefined,
      now + 20,
    );
    expect(pending.pending).toBe(11);
    expect(pending.deliveries.at(-1)?.delivery.wake_suppressed).toBe("pair");
  });
  it("retains accepted mailbox snapshots when room membership later changes", async () => {
    attach(acting);
    await publish();
    ops.setMember(f.db, "general", "agent:worker", null, owner, now + 1);
    expect(() => ops.history(f.db, "general", acting)).toThrow(/membership/);
    expect(
      ops.fetchInbox(f.db, "worker", acting, 50, undefined, now + 2).deliveries,
    ).toHaveLength(1);
  });
  it("requires existing artifacts and rejects threads from another room", async () => {
    ops.createRoom(
      f.db,
      CreateRoomSchema.parse({ id: "other", name: "Other" }),
      owner,
      now,
    );
    const thread = ops.createThread(
      f.db,
      "other",
      { id: crypto.randomUUID(), title: "Other thread" },
      owner,
      now,
    );
    await expect(
      publish("artifact", { artifact_refs: ["missing/blob"] }),
    ).rejects.toThrow(/Artifact reference/);
    await expect(publish("thread", { thread_id: thread?.id })).rejects.toThrow(
      /Thread not in/,
    );
    expect((await publish()).message.seq).toBe(1);
  });
});
