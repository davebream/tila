import {
  AgentRegistrationSchema,
  AttachAgentBindingSchema,
  CreateRoomSchema,
  PublishMessageSchema,
  type RuntimeIdentity,
} from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as bindings from "../../../ops-sqlite/src/agent-binding-ops";
import { RevisionConflictError } from "../../../ops-sqlite/src/config-revision-ops";
import * as ops from "../../../ops-sqlite/src/conversation-ops";
import { createTestDb } from "./helpers/create-test-db";

describe("room management revisions and archive", () => {
  let f: ReturnType<typeof createTestDb>;
  const now = 100_000;
  const owner: ops.ConversationAuthority = {
    principal_id: "owner",
    participant_id: "dashboard",
    can_manage: true,
    runtime: null,
  };
  const reader: ops.ConversationAuthority = {
    principal_id: "reader",
    participant_id: "reader-tab",
    can_manage: false,
    runtime: null,
  };
  const run = (role: "acting" | "relay"): RuntimeIdentity => ({
    run_id: crypto.randomUUID(),
    agent_id: "worker",
    run_role: role,
    principal_id: "owner",
    participant_id: crypto.randomUUID(),
    enrollment_id: "8b8f2b9e-3c1d-4f52-9b0e-0d3a8f1f2c11",
    workload_binding_id: null,
    lease_expires_at: 1_000_000,
  });
  const room = () => ops.getRoom(f.db, "general", owner).room;
  const publish = (op: string, a = owner, time = now) =>
    ops.publish(
      f.db,
      "general",
      PublishMessageSchema.parse({ client_op_id: op, body: "hello" }),
      a,
      time,
    );
  beforeEach(() => {
    f = createTestDb({ foreignKeys: "on" });
    bindings.register(
      f.db,
      AgentRegistrationSchema.parse({ id: "worker", name: "Worker" }),
      owner,
      now,
    );
    ops.createRoom(
      f.db,
      CreateRoomSchema.parse({
        id: "general",
        name: "General",
        history_policy: "project",
      }),
      owner,
      now,
    );
  });
  afterEach(() => f.sqlite.close());

  it("revision-checks settings changes and ignores no-ops", () => {
    const start = room().revision;
    const updated = ops.updateRoom(
      f.db,
      "general",
      {
        expected_revision: start,
        delivery_ttl_seconds: 3600,
        budgets: {
          max_hops: 2,
          pair_exchanges: 3,
          agent_wakes: 4,
          room_wakes: 5,
        },
      },
      owner,
    );
    expect(updated).toMatchObject({
      delivery_ttl_seconds: 3600,
      budgets: { max_hops: 2, room_wakes: 5 },
    });
    expect(() =>
      ops.updateRoom(
        f.db,
        "general",
        { expected_revision: start, name: "Stale" },
        owner,
      ),
    ).toThrow(RevisionConflictError);
    expect(
      ops.updateRoom(
        f.db,
        "general",
        { expected_revision: updated.revision, delivery_ttl_seconds: 3600 },
        owner,
      ).revision,
    ).toBe(updated.revision);
    expect(() =>
      ops.updateRoom(
        f.db,
        "general",
        { expected_revision: updated.revision, name: "x" },
        reader,
      ),
    ).toThrow(/conversations:manage/);
  });

  it("membership changes advance the room revision; publication does not", async () => {
    const start = room().revision;
    const joined = ops.setMember(
      f.db,
      "general",
      "agent:worker",
      true,
      owner,
      now,
      { expectedRevision: start },
    );
    expect(joined.revision).toBeGreaterThan(start);
    expect(() =>
      ops.setMember(f.db, "general", "principal:reader", false, owner, now, {
        expectedRevision: start,
      }),
    ).toThrow(RevisionConflictError);
    // Same wake setting: nothing changes, revision stays.
    expect(
      ops.setMember(f.db, "general", "agent:worker", true, owner, now).revision,
    ).toBe(joined.revision);
    await publish("one");
    expect(room().revision).toBe(joined.revision);
  });

  it("archive stops publication and wakes but keeps history and pending deliveries", async () => {
    ops.setMember(f.db, "general", "agent:worker", true, owner, now);
    const acting = { ...owner, can_manage: false, runtime: run("acting") };
    const relay = { ...owner, can_manage: false, runtime: run("relay") };
    bindings.attach(
      f.db,
      "worker",
      AttachAgentBindingSchema.parse({
        expected_epoch: 0,
        harness: "test",
        mechanism: "native-peer",
        capability_report: {
          protocol: 1,
          adapter_version: "t",
          capabilities: {},
        },
      }),
      acting,
      now,
    );
    await publish("before");
    expect(ops.archivePreview(f.db, "general", owner, now)).toMatchObject({
      archived: false,
      members: 2,
      pending_deliveries: 1,
      messages: 1,
    });
    const archived = ops.setArchived(
      f.db,
      "general",
      true,
      room().revision,
      owner,
    );
    expect(archived.archived).toBe(true);
    await expect(publish("after")).rejects.toMatchObject({
      code: "room-archived",
    });
    // History stays readable under the room policy, also for a non-manager.
    expect(
      ops.history(f.db, "general", reader).messages.map((m) => m.body),
    ).toEqual(["hello"]);
    expect(ops.listRooms(f.db, reader)).toEqual([]);
    expect(
      ops.listRooms(f.db, reader, { includeArchived: true }).map((r) => r.id),
    ).toEqual(["general"]);
    // No wake for the archived room's pending delivery, but the holder can
    // still fetch it until its TTL.
    expect(ops.leaseDispatch(f.db, "worker", relay, now + 1)).toBeNull();
    expect(
      ops.fetchInbox(f.db, "worker", acting, 50, undefined, now + 2).deliveries,
    ).toHaveLength(1);
    // Recreating the ID does not silently replay the archived room.
    expect(() =>
      ops.createRoom(
        f.db,
        CreateRoomSchema.parse({
          id: "general",
          name: "General",
          history_policy: "project",
        }),
        owner,
      ),
    ).toThrow(/archived room/);
    const restored = ops.setArchived(
      f.db,
      "general",
      false,
      archived.revision,
      owner,
    );
    expect(restored.archived).toBe(false);
    expect((await publish("after-restore")).replayed).toBe(false);
  });

  it("journals settings changes without member identities", () => {
    ops.setMember(f.db, "general", "principal:reader", false, owner, now);
    ops.updateRoom(
      f.db,
      "general",
      { expected_revision: room().revision, name: "Renamed" },
      owner,
    );
    const rows = f.sqlite
      .prepare(
        "SELECT kind, data FROM journal WHERE kind LIKE 'room.%' ORDER BY seq",
      )
      .all() as { kind: string; data: string }[];
    expect(rows.map((row) => row.kind)).toEqual([
      "room.created",
      "room.members_changed",
      "room.updated",
    ]);
    expect(rows.map((row) => row.data).join("")).not.toContain("reader");
  });
});
