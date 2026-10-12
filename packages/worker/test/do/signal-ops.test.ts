import { signalOps, sweepOps } from "@tila/ops-sqlite";
import type { SignalIdentity } from "@tila/schemas";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/create-test-db";

const NOW = 1_000_000;

function actor(
  principalId: string,
  participantId: string,
  displayName = `${principalId}:${participantId}`,
): SignalIdentity {
  return {
    principal_id: principalId,
    participant_id: participantId,
    display_name: displayName,
    environment: { client_name: "test", machine: participantId },
  };
}

function addPresence(
  sqlite: InstanceType<typeof Database>,
  identity: SignalIdentity,
  lastSeen = NOW,
) {
  sqlite
    .prepare(
      `INSERT INTO presence
       (principal_id, participant_id, environment, last_seen, info)
       VALUES (?, ?, ?, ?, '{}')`,
    )
    .run(
      identity.principal_id,
      identity.participant_id,
      JSON.stringify(identity.environment),
      lastSeen,
    );
}

describe("participant-scoped signal delivery", () => {
  it("delivers directly without presence and snapshots complete identities", () => {
    const { db } = createTestDb();
    const sender = actor("principal-a", "participant-a", "Alice");
    const result = signalOps.send(
      db,
      {
        target: {
          type: "participant",
          principal_id: "principal-b",
          participant_id: "participant-b",
        },
        kind: "conflict",
        payload: { details: "overlap" },
        sender,
      },
      NOW,
    );

    expect(result.id).toMatch(/^sig_/);
    expect(result.recipient_count).toBe(1);
    const inbox = signalOps.inbox(
      db,
      actor("principal-b", "participant-b"),
      NOW,
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      id: result.id,
      kind: "conflict",
      payload: { details: "overlap" },
      sender,
      target: {
        type: "participant",
        principal_id: "principal-b",
        participant_id: "participant-b",
      },
    });
    expect(inbox[0].deliveries[0].recipient).toMatchObject({
      principal_id: "principal-b",
      participant_id: "participant-b",
    });
    expect(inbox[0].expires_at).toBe(NOW + 300_000);
  });

  it("isolates two participants owned by the same principal", () => {
    const { db } = createTestDb();
    signalOps.send(
      db,
      {
        target: {
          type: "participant",
          principal_id: "principal-b",
          participant_id: "participant-1",
        },
        kind: "info",
        sender: actor("principal-a", "participant-a"),
      },
      NOW,
    );

    expect(
      signalOps.inbox(db, actor("principal-b", "participant-1"), NOW),
    ).toHaveLength(1);
    expect(
      signalOps.inbox(db, actor("principal-b", "participant-2"), NOW),
    ).toHaveLength(0);
  });

  it("allows explicit direct self-targeting", () => {
    const { db } = createTestDb();
    const sender = actor("principal-a", "participant-a");
    const result = signalOps.send(
      db,
      {
        target: {
          type: "participant",
          principal_id: sender.principal_id,
          participant_id: sender.participant_id,
        },
        kind: "info",
        sender,
      },
      NOW,
    );
    expect(result.recipient_count).toBe(1);
    expect(signalOps.inbox(db, sender, NOW)).toHaveLength(1);
  });

  it("expands principal targets to active participants and excludes only the sender", () => {
    const { db, sqlite } = createTestDb();
    const sender = actor("principal-a", "participant-a");
    const sibling = actor("principal-a", "participant-sibling");
    const other = actor("principal-b", "participant-b");
    addPresence(sqlite, sender);
    addPresence(sqlite, sibling);
    addPresence(sqlite, other);

    const result = signalOps.send(
      db,
      {
        target: { type: "principal", principal_id: "principal-a" },
        kind: "request",
        sender,
      },
      NOW,
    );
    expect(result.recipient_count).toBe(1);
    expect(signalOps.inbox(db, sender, NOW)).toHaveLength(0);
    expect(signalOps.inbox(db, sibling, NOW)).toHaveLength(1);
    expect(signalOps.inbox(db, other, NOW)).toHaveLength(0);
  });

  it("fans broadcast out to active presence and ignores stale presence", () => {
    const { db, sqlite } = createTestDb();
    const sender = actor("principal-a", "participant-a");
    const active = actor("principal-b", "participant-b");
    const stale = actor("principal-c", "participant-c");
    addPresence(sqlite, sender);
    addPresence(sqlite, active, NOW - 59_999);
    addPresence(sqlite, stale, NOW - 60_000);

    const result = signalOps.send(
      db,
      { target: { type: "broadcast" }, kind: "ready", sender },
      NOW,
    );
    expect(result.recipient_count).toBe(1);
    expect(signalOps.inbox(db, active, NOW)).toHaveLength(1);
    expect(signalOps.inbox(db, stale, NOW)).toHaveLength(0);
  });

  it("fails atomically when an expanded target has no active recipients", () => {
    const { db, sqlite } = createTestDb();
    expect(() =>
      signalOps.send(
        db,
        {
          target: { type: "principal", principal_id: "nobody" },
          kind: "info",
          sender: actor("principal-a", "participant-a"),
        },
        NOW,
      ),
    ).toThrow(signalOps.NoActiveRecipientsError);
    expect(
      (
        sqlite.prepare("SELECT count(*) AS count FROM signals").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("distinguishes unknown groups from empty active audiences", () => {
    const { db } = createTestDb();
    const sender = actor("principal-a", "participant-a");
    expect(() =>
      signalOps.send(
        db,
        {
          target: { type: "group", group_id: "missing" },
          kind: "info",
          sender,
        },
        NOW,
      ),
    ).toThrow(signalOps.SignalGroupNotFoundError);

    signalOps.setGroup(
      db,
      "reviewers",
      "Reviewers",
      ["principal-b"],
      sender,
      NOW,
    );
    expect(() =>
      signalOps.send(
        db,
        {
          target: { type: "group", group_id: "reviewers" },
          kind: "info",
          sender,
        },
        NOW,
      ),
    ).toThrow(signalOps.NoActiveRecipientsError);
  });

  it("snapshots group membership and deliveries at send time", () => {
    const { db, sqlite } = createTestDb();
    const sender = actor("principal-a", "participant-a");
    const first = actor("principal-b", "participant-b");
    const second = actor("principal-c", "participant-c");
    addPresence(sqlite, first);
    addPresence(sqlite, second);
    signalOps.setGroup(
      db,
      "reviewers",
      "Reviewers",
      ["principal-b"],
      sender,
      NOW,
    );

    const sent = signalOps.send(
      db,
      {
        target: { type: "group", group_id: "reviewers" },
        kind: "request",
        sender,
      },
      NOW,
    );
    signalOps.setGroup(
      db,
      "reviewers",
      "New reviewers",
      ["principal-c"],
      sender,
      NOW + 1,
    );

    expect(sent.recipient_count).toBe(1);
    expect(signalOps.inbox(db, first, NOW + 1)).toHaveLength(1);
    expect(signalOps.inbox(db, second, NOW + 1)).toHaveLength(0);
  });
});

describe("signal acknowledgements and audit", () => {
  it("requires the exact delivery identity and records acknowledger metadata", () => {
    const { db } = createTestDb();
    const recipient = actor("principal-b", "participant-1", "Bob");
    const sent = signalOps.send(
      db,
      {
        target: {
          type: "participant",
          principal_id: recipient.principal_id,
          participant_id: recipient.participant_id,
        },
        kind: "info",
        sender: actor("principal-a", "participant-a", "Alice"),
      },
      NOW,
    );

    expect(
      signalOps.ack(
        db,
        sent.id,
        actor("principal-b", "participant-2"),
        NOW + 1,
      ),
    ).toEqual({ found: true, authorized: false, expired: false });
    expect(signalOps.ack(db, sent.id, recipient, NOW + 2)).toEqual({
      found: true,
      authorized: true,
      expired: false,
    });

    const delivery = signalOps.history(db, {}, NOW + 2).signals[0]
      .deliveries[0];
    expect(delivery.acknowledged_at).toBe(NOW + 2);
    expect(delivery.acknowledged_by).toEqual(recipient);
    expect(signalOps.inbox(db, recipient, NOW + 2)).toHaveLength(0);
  });

  it("makes repeated acknowledgement idempotent", () => {
    const { db, sqlite } = createTestDb();
    const recipient = actor("principal-b", "participant-b");
    const sent = signalOps.send(
      db,
      {
        target: {
          type: "participant",
          principal_id: recipient.principal_id,
          participant_id: recipient.participant_id,
        },
        kind: "info",
        sender: actor("principal-a", "participant-a"),
      },
      NOW,
    );
    signalOps.ack(db, sent.id, recipient, NOW + 10);
    signalOps.ack(db, sent.id, recipient, NOW + 20);
    const row = sqlite
      .prepare(
        "SELECT acknowledged_at FROM signal_deliveries WHERE signal_id = ?",
      )
      .get(sent.id) as { acknowledged_at: number };
    expect(row.acknowledged_at).toBe(NOW + 10);
  });

  it("acknowledges fan-out deliveries independently", () => {
    const { db, sqlite } = createTestDb();
    const sender = actor("principal-a", "participant-a");
    const first = actor("principal-b", "participant-b");
    const second = actor("principal-c", "participant-c");
    addPresence(sqlite, first);
    addPresence(sqlite, second);
    const sent = signalOps.send(
      db,
      { target: { type: "broadcast" }, kind: "ready", sender },
      NOW,
    );

    signalOps.ack(db, sent.id, first, NOW + 1);

    expect(signalOps.inbox(db, first, NOW + 1)).toHaveLength(0);
    expect(signalOps.inbox(db, second, NOW + 1)).toHaveLength(1);
    const deliveries = signalOps.history(db, {}, NOW + 1).signals[0].deliveries;
    expect(
      deliveries.find(
        (delivery) =>
          delivery.recipient.participant_id === first.participant_id,
      )?.acknowledged_at,
    ).toBe(NOW + 1);
    expect(
      deliveries.find(
        (delivery) =>
          delivery.recipient.participant_id === second.participant_id,
      )?.acknowledged_at,
    ).toBeNull();
  });

  it("paginates audit history without repeating signals", () => {
    const { db } = createTestDb();
    const sender = actor("principal-a", "participant-a");
    const recipient = actor("principal-b", "participant-b");
    const target = {
      type: "participant" as const,
      principal_id: recipient.principal_id,
      participant_id: recipient.participant_id,
    };
    const first = signalOps.send(db, { target, kind: "first", sender }, NOW);
    const second = signalOps.send(
      db,
      { target, kind: "second", sender },
      NOW + 1,
    );

    const pageOne = signalOps.history(db, { limit: 1 }, NOW + 2);
    const pageTwo = signalOps.history(
      db,
      { limit: 1, cursor: pageOne.next_cursor ?? undefined },
      NOW + 2,
    );

    expect(pageOne.signals.map((signal) => signal.id)).toEqual([second.id]);
    expect(pageOne.next_cursor).not.toBeNull();
    expect(pageTwo.signals.map((signal) => signal.id)).toEqual([first.id]);
    expect(pageTwo.next_cursor).toBeNull();
  });

  it("rejects acknowledgement after expiry", () => {
    const { db } = createTestDb();
    const recipient = actor("principal-b", "participant-b");
    const sent = signalOps.send(
      db,
      {
        target: {
          type: "participant",
          principal_id: recipient.principal_id,
          participant_id: recipient.participant_id,
        },
        kind: "info",
        ttl_ms: 1_000,
        sender: actor("principal-a", "participant-a"),
      },
      NOW,
    );
    expect(signalOps.ack(db, sent.id, recipient, NOW + 1_000)).toEqual({
      found: true,
      authorized: false,
      expired: true,
    });
    expect(signalOps.history(db, {}, NOW + 1_000).signals).toHaveLength(0);
  });

  it("retains acknowledged deliveries until expiry, then sweeps both tables", () => {
    const { db, sqlite } = createTestDb();
    const recipient = actor("principal-b", "participant-b");
    const sent = signalOps.send(
      db,
      {
        target: {
          type: "participant",
          principal_id: recipient.principal_id,
          participant_id: recipient.participant_id,
        },
        kind: "info",
        ttl_ms: 1_000,
        sender: actor("principal-a", "participant-a"),
      },
      NOW,
    );
    signalOps.ack(db, sent.id, recipient, NOW + 10);
    expect(sweepOps.sweep(db, NOW + 100).signalsDeleted).toBe(0);
    expect(signalOps.history(db, {}, NOW + 100).signals).toHaveLength(1);

    expect(sweepOps.sweep(db, NOW + 1_000).signalsDeleted).toBe(1);
    expect(
      (
        sqlite
          .prepare("SELECT count(*) AS count FROM signal_deliveries")
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });
});

describe("signal groups", () => {
  it("replaces memberships idempotently and deletes members explicitly", () => {
    const { db, sqlite } = createTestDb();
    const admin = actor("principal-admin", "participant-admin");
    signalOps.setGroup(
      db,
      "reviewers",
      "Reviewers",
      ["principal-b", "principal-b", "principal-c"],
      admin,
      NOW,
    );
    expect(signalOps.getGroup(db, "reviewers")?.principal_ids).toEqual([
      "principal-b",
      "principal-c",
    ]);
    signalOps.setGroup(
      db,
      "reviewers",
      "Primary reviewer",
      ["principal-c"],
      admin,
      NOW + 1,
    );
    expect(signalOps.listGroups(db)[0]).toMatchObject({
      id: "reviewers",
      name: "Primary reviewer",
      principal_ids: ["principal-c"],
    });
    expect(signalOps.deleteGroup(db, "reviewers")).toBe(true);
    expect(signalOps.deleteGroup(db, "reviewers")).toBe(false);
    expect(
      (
        sqlite
          .prepare("SELECT count(*) AS count FROM signal_group_members")
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });
});
