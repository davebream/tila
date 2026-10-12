import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as attempts from "../src/attempt-ops";
import * as recovery from "../src/attempt-recovery-ops";
import * as backup from "../src/queue-backup-ops";
import * as queue from "../src/queue-ops";
import * as schema from "../src/schema";
import {
  authority,
  attemptOrigin as origin,
  seedAttempt,
} from "./attempt-fixture";
import { type TestDb, createTestDb } from "./helpers";

let fixture: TestDb;
beforeEach(() => {
  fixture = createTestDb();
});
afterEach(() => fixture.rawDb.close());
const session = { provider: "fixture", id: "session" };

it.each(["reserved", "running", "suspended", "uncertain"] as const)(
  "restored %s execution is paused, fenced and conservatively uncertain",
  (state) => {
    const { db } = fixture;
    let attempt = seedAttempt(db);
    queue.configure(
      db,
      {
        idempotency_key: "enable",
        expected_revision: 0,
        enabled: true,
        paused: false,
        execution_limit: 1,
      },
      origin,
      true,
    );
    const acceptCommand = authority(attempt, "accept");
    if (state !== "reserved") {
      attempt = attempts.accept(db, attempt.id, acceptCommand, origin).attempt;
      attempt = attempts.started(
        db,
        attempt.id,
        { ...authority(attempt), session },
        origin,
      ).attempt;
    }
    if (state === "suspended") {
      attempt = recovery.requestSuspension(
        db,
        attempt.id,
        authority(attempt),
        origin,
      ).attempt;
      attempt = recovery.confirmSuspension(
        db,
        attempt.id,
        {
          ...authority(attempt),
          execution_quiescent: true,
          checkpoint: { step: 1 },
        },
        origin,
      ).attempt;
    }
    if (state === "uncertain")
      attempt = recovery.reconcile(
        db,
        attempt.id,
        {
          ...authority(attempt),
          observation: "unknown",
          reason: "Disconnected",
        },
        origin,
        false,
      ).attempt;
    const oldFence = attempt.fence;
    const receipts = db.select().from(schema.queueOperationReceipts).all();
    backup.invalidateRestoredExecutions(db, {
      [attempt.resource]: oldFence + 100,
    });
    const restored = attempts.view(db, attempt.id, origin);
    expect(restored.attempt.state).toBe("uncertain");
    expect(restored.grant_valid).toBe(false);
    expect(queue.policy(db).paused).toBe(true);
    expect(queue.occupancy(db)).toEqual({ execution: 1, wip: 1 });
    expect(
      db
        .select()
        .from(schema.fences)
        .where(eq(schema.fences.resource, attempt.resource))
        .get()?.current_fence,
    ).toBeGreaterThan(oldFence + 100);
    expect(db.select().from(schema.claims).all()).toHaveLength(0);
    expect(db.select().from(schema.queueOperationReceipts).all()).toEqual(
      receipts,
    );
    if (state !== "reserved")
      expect(
        attempts.accept(db, attempt.id, acceptCommand, origin).grant_valid,
      ).toBe(false);
    expect(() =>
      attempts.heartbeat(db, attempt.id, authority(attempt), origin),
    ).toThrow();
    if (state === "suspended") {
      const suspended = recovery.reconcile(
        db,
        attempt.id,
        {
          idempotency_key: "observed-suspended",
          expected_revision: restored.attempt.revision,
          observation: "suspended",
          execution_quiescent: true,
          checkpoint: { step: 1 },
          session,
          reason: "Runtime confirms checkpoint remains quiescent",
        },
        origin,
        false,
      );
      expect(suspended.attempt.state).toBe("suspended");
      expect(queue.occupancy(db)).toEqual({ execution: 0, wip: 1 });
    }
  },
);

it("preserves immutable terminal history while invalidating its old authority", () => {
  const { db } = fixture;
  let attempt = seedAttempt(db);
  attempt = attempts.accept(db, attempt.id, authority(attempt), origin).attempt;
  attempt = attempts.finish(
    db,
    attempt.id,
    {
      ...authority(attempt),
      outcome: {
        status: "success",
        execution_stopped: true,
        unresolved_external_execution: false,
        evidence: [],
      },
    },
    origin,
  ).attempt;
  backup.invalidateRestoredExecutions(db);
  expect(attempts.get(db, attempt.id)).toEqual(attempt);
  expect(queue.occupancy(db)).toEqual({ execution: 0, wip: 0 });
});

it("rolls back restore normalization when enrollment history is inconsistent", () => {
  const { db } = fixture;
  const attempt = seedAttempt(db);
  db.update(schema.queueEntries).set({ state: "withdrawn" }).run();
  const before = db.select().from(schema.fences).all();
  expect(() => backup.invalidateRestoredExecutions(db)).toThrow(
    "Restored reservation is inconsistent",
  );
  expect(db.select().from(schema.fences).all()).toEqual(before);
  expect(attempts.get(db, attempt.id)).toEqual(attempt);
});

it("refuses destructive restore while unfinished execution or retry reservations exist", () => {
  const { db } = fixture;
  let a = seedAttempt(db);
  expect(() => backup.assertRestoreQuiescent(db)).toThrow(
    "quiescent destination",
  );
  a = attempts.accept(db, a.id, authority(a), origin).attempt;
  a = recovery.forceRecovery(
    db,
    a.id,
    {
      idempotency_key: "force",
      expected_revision: a.revision,
      reason: "Operator accepts unresolved execution",
    },
    origin,
    true,
  ).attempt;
  expect(a.state).toBe("terminal");
  expect(() => backup.assertRestoreQuiescent(db)).toThrow(
    "quiescent destination",
  );
});
it.each(["outcome", "finished_at"])(
  "rejects a nonterminal backup with partial terminal history: %s",
  (field) => {
    seedAttempt(fixture.db);
    const a = fixture.rawDb
      .prepare("SELECT * FROM work_attempts")
      .get() as Record<string, unknown>;
    a[field] =
      field === "finished_at"
        ? Date.now()
        : JSON.stringify({
            status: "success",
            execution_stopped: true,
            unresolved_external_execution: false,
            evidence: [],
          });
    expect(() => backup.validateQueueBackupRow("work_attempts", a)).toThrow(
      "terminal history",
    );
  },
);
