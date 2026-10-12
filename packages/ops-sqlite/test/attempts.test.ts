import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as attempts from "../src/attempt-ops";
import { get as getEntity } from "../src/entity-ops";
import * as schema from "../src/schema";
import { applySchema } from "../src/schema-ops";
import { sweep } from "../src/sweep-ops";
import {
  authority,
  attemptOrigin as origin,
  seedAttempt,
} from "./attempt-fixture";
import { type TestDb, createTestDb } from "./helpers";
import { lifecycleDefinition } from "./readiness-fixture";

let fixture: TestDb;
beforeEach(() => {
  fixture = createTestDb();
});
afterEach(() => fixture.rawDb.close());
const stopped = {
  status: "success" as const,
  execution_stopped: true,
  evidence: [],
  unresolved_external_execution: false,
};

it("commits acceptance, lifecycle status, session binding and result without losing immutable history", () => {
  const { db } = fixture;
  let attempt = seedAttempt(db);
  expect(attempt.state).toBe("reserved");
  expect(() =>
    attempts.started(
      db,
      attempt.id,
      {
        ...authority(attempt),
        session: { provider: "fixture", id: "session" },
      },
      origin,
    ),
  ).toThrow("after acceptance");
  attempt = attempts.accept(db, attempt.id, authority(attempt), origin).attempt;
  expect(getEntity(db, "task")?.data.phase).toBe("working");
  attempt = attempts.started(
    db,
    attempt.id,
    { ...authority(attempt), session: { provider: "fixture", id: "session" } },
    origin,
  ).attempt;
  const result = attempts.finish(
    db,
    attempt.id,
    { ...authority(attempt), outcome: stopped },
    origin,
  );
  expect(result.grant_valid).toBe(false);
  expect(result.attempt.state).toBe("terminal");
  expect(getEntity(db, "task")?.data.phase).toBe("shipped");
  expect(db.select().from(schema.executionReservations).all()).toEqual([]);
  expect(db.select().from(schema.claims).all()).toEqual([]);
  const losing = attempts.finish(
    db,
    attempt.id,
    { ...authority(attempt), outcome: { ...stopped, status: "failure" } },
    origin,
  );
  expect(losing.attempt).toEqual(result.attempt);
  expect(attempts.list(db, { task_id: "task" })).toEqual([result.attempt]);
});
it("rolls the whole admission back when an attempt or reservation cannot be written", () => {
  const { db, rawDb } = fixture;
  const attempt = seedAttempt(db);
  const before = rawDb.prepare("SELECT count(*) AS n FROM journal").get();
  const entry = db.select().from(schema.queueEntries).get();
  if (!entry) throw new Error("entry");
  expect(() =>
    db.transaction((tx) => {
      tx.delete(schema.executionReservations).run();
      tx.delete(schema.claims).run();
      attempts.reserveInTransaction(tx, entry, origin, 60_000);
    }),
  ).toThrow();
  expect(attempts.get(db, attempt.id)).toEqual(attempt);
  expect(db.select().from(schema.executionReservations).all()).toHaveLength(1);
  expect(rawDb.prepare("SELECT count(*) AS n FROM journal").get()).toEqual(
    before,
  );
});
it("replays commands with current authority, never the original spawn permission", () => {
  const { db } = fixture;
  const now = Date.now();
  const reserved = seedAttempt(db, "task", now);
  const input = authority(reserved, "accept-once");
  const first = attempts.accept(db, reserved.id, input, origin, now);
  expect(attempts.accept(db, reserved.id, input, origin, now + 1)).toEqual(
    first,
  );
  const expired = attempts.accept(db, reserved.id, input, origin, now + 60_000);
  expect(expired.grant_valid).toBe(false);
  expect(expired.attempt.state).toBe("uncertain");
  expect(db.select().from(schema.executionReservations).all()).toHaveLength(1);
  expect(() =>
    attempts.accept(
      db,
      reserved.id,
      { ...input, expected_revision: 500 },
      origin,
    ),
  ).toThrow("different command");
  expect(db.select().from(schema.queueOperationReceipts).all()).toHaveLength(1);
});
it("frees unaccepted grants but retains capacity after acceptance even if claims were swept", () => {
  const { db } = fixture;
  const now = Date.now();
  const reserved = seedAttempt(db, "unaccepted", now);
  const accepted = seedAttempt(db, "accepted", now);
  attempts.accept(db, accepted.id, authority(accepted), origin, now);
  db.delete(schema.claims).run();
  expect(attempts.expire(db, now + 60_000)).toBe(2);
  expect(attempts.get(db, reserved.id).outcome?.status).toBe("abandoned");
  expect(
    db
      .select()
      .from(schema.queueEntries)
      .where(eq(schema.queueEntries.id, reserved.entry_id))
      .get()?.state,
  ).toBe("queued");
  expect(attempts.get(db, accepted.id).state).toBe("uncertain");
  expect(
    db
      .select()
      .from(schema.executionReservations)
      .all()
      .map((r) => r.attempt_id),
  ).toEqual([accepted.id]);
  expect(attempts.expire(db, now + 90_000)).toBe(0);
});
it("rejects expired, stale, mismatched and superseded authorities without renewing them", () => {
  const { db } = fixture;
  const now = Date.now();
  const attempt = seedAttempt(db, "task", now);
  expect(() =>
    attempts.accept(
      db,
      attempt.id,
      authority(attempt),
      { ...origin, participantId: "other" },
      now,
    ),
  ).toThrow("another execution authority");
  expect(() =>
    attempts.accept(
      db,
      attempt.id,
      { ...authority(attempt), fence: attempt.fence + 1 },
      origin,
      now,
    ),
  ).toThrow("another execution authority");
  expect(() =>
    attempts.accept(
      db,
      attempt.id,
      { ...authority(attempt), expected_revision: 999 },
      origin,
      now,
    ),
  ).toThrow("Expected revision");
  const accepted = attempts.accept(
    db,
    attempt.id,
    authority(attempt),
    origin,
    now,
  ).attempt;
  expect(() =>
    attempts.heartbeat(
      db,
      attempt.id,
      authority(accepted),
      origin,
      now + 60_000,
    ),
  ).toThrow("expired or was revoked");
  expect(attempts.get(db, attempt.id).state).toBe("uncertain");
});
it("a retried heartbeat does not extend a lease twice", () => {
  const { db } = fixture;
  const now = Date.now();
  const attempt = seedAttempt(db, "task", now);
  const input = authority(attempt);
  const first = attempts.heartbeat(db, attempt.id, input, origin, now + 10_000);
  const retry = attempts.heartbeat(db, attempt.id, input, origin, now + 20_000);
  expect(retry).toEqual(first);
  expect(retry.attempt.lease_expires_at).toBe(now + 70_000);
});
it("leaves results uncommitted when current lifecycle validation conflicts", () => {
  const { db } = fixture;
  let attempt = seedAttempt(db);
  attempt = attempts.accept(db, attempt.id, authority(attempt), origin).attempt;
  applySchema(
    db,
    `${lifecycleDefinition}\n[work_units.issue.fields.new_required]\ntype = "string"\nrequired = true\n`,
    "maintainer",
    "force",
  );
  const before = attempts.get(db, attempt.id);
  expect(() =>
    attempts.finish(
      db,
      attempt.id,
      { ...authority(attempt), outcome: stopped },
      origin,
    ),
  ).toThrow();
  expect(attempts.get(db, attempt.id)).toEqual(before);
  expect(db.select().from(schema.executionReservations).all()).toHaveLength(1);
  expect(db.select().from(schema.queueOperationReceipts).all()).toHaveLength(1);
});

it("the generic seven-day sweep preserves execution receipts and uncertain capacity", () => {
  const { db } = fixture;
  const now = Date.now();
  const attempt = seedAttempt(db, "task", now);
  attempts.accept(db, attempt.id, authority(attempt), origin, now);
  sweep(db, now + 8 * 86_400_000);
  expect(attempts.get(db, attempt.id).state).toBe("uncertain");
  expect(db.select().from(schema.queueOperationReceipts).all()).toHaveLength(1);
  expect(db.select().from(schema.executionReservations).all()).toHaveLength(1);
});
