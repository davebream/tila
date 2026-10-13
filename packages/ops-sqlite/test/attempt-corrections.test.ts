import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { correct } from "../src/attempt-correction-ops";
import * as attempts from "../src/attempt-ops";
import { create } from "../src/entity-ops";
import * as backup from "../src/queue-backup-ops";
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
const success = {
  status: "success" as const,
  execution_stopped: true,
  evidence: ["https://ci.example/run/1"],
  unresolved_external_execution: false,
};
const key = () => crypto.randomUUID();
function finished() {
  const { db } = fixture;
  const now = Date.now();
  let attempt = seedAttempt(db, "task", now);
  attempt = attempts.accept(
    db,
    attempt.id,
    authority(attempt),
    origin,
    now,
  ).attempt;
  attempt = attempts.finish(
    db,
    attempt.id,
    { ...authority(attempt), outcome: success },
    origin,
    now,
  ).attempt;
  create(
    db,
    { id: "hotfix", type: "issue", data: { phase: "todo" }, created_by: "t" },
    1,
    origin,
  );
  return { attempt, now };
}

it("links corrective work to an accepted result without rewriting it", () => {
  const { db } = fixture;
  const { attempt, now } = finished();
  const command = {
    idempotency_key: key(),
    task_id: "hotfix",
    reason: "Regression found after release",
  };
  const view = correct(db, attempt.id, command, origin, now);
  expect(view.attempt).toEqual(attempts.get(db, attempt.id));
  expect(view.attempt.outcome).toEqual(success);
  expect(view.attempt.revision).toBe(attempt.revision);
  expect(view.corrections).toMatchObject([
    {
      attempt_id: attempt.id,
      task_id: "hotfix",
      reason: "Regression found after release",
      principal_id: origin.principalId,
    },
  ]);
  // Replay is harmless; the same pair under a new key is a conflict.
  expect(correct(db, attempt.id, command, origin, now)).toEqual(view);
  expect(() =>
    correct(db, attempt.id, { ...command, idempotency_key: key() }, origin),
  ).toThrow("already linked");
  // The original task may carry the correction too.
  expect(
    correct(
      db,
      attempt.id,
      { idempotency_key: key(), task_id: "task", reason: "Reopened in place" },
      origin,
    ).corrections,
  ).toHaveLength(2);
  const events = db
    .select()
    .from(schema.journal)
    .where(eq(schema.journal.kind, "attempt.corrected"))
    .all();
  expect(events.map((e) => JSON.parse(e.data).task_id)).toEqual([
    "hotfix",
    "task",
  ]);
  expect(JSON.parse(events[0]?.data ?? "{}").outcome_status).toBe("success");
});

it("rejects corrections of unfinished attempts and missing or archived tasks", () => {
  const { db } = fixture;
  const live = seedAttempt(db, "live");
  expect(() =>
    correct(
      db,
      live.id,
      { idempotency_key: key(), task_id: "live", reason: "too early" },
      origin,
    ),
  ).toThrow("Only a finished attempt");
  const { attempt } = finished();
  expect(() =>
    correct(
      db,
      attempt.id,
      { idempotency_key: key(), task_id: "missing", reason: "x" },
      origin,
    ),
  ).toThrow("missing or archived");
  fixture.rawDb.exec("UPDATE entities SET archived = 1 WHERE id = 'hotfix'");
  expect(() =>
    correct(
      db,
      attempt.id,
      { idempotency_key: key(), task_id: "hotfix", reason: "x" },
      origin,
    ),
  ).toThrow("missing or archived");
});

it("refuses to rewrite terminal results or correction links at the storage layer", () => {
  const { db } = fixture;
  const { attempt } = finished();
  correct(
    db,
    attempt.id,
    { idempotency_key: key(), task_id: "hotfix", reason: "regression" },
    origin,
  );
  expect(() =>
    fixture.rawDb
      .prepare(
        'UPDATE work_attempts SET outcome = json(\'{"status":"failure"}\') WHERE id = ?',
      )
      .run(attempt.id),
  ).toThrow("attempt-terminal-immutable");
  expect(() =>
    fixture.rawDb
      .prepare("UPDATE work_attempts SET state = 'running' WHERE id = ?")
      .run(attempt.id),
  ).toThrow("attempt-terminal-immutable");
  expect(() =>
    fixture.rawDb.prepare("UPDATE attempt_corrections SET reason = 'x'").run(),
  ).toThrow("attempt-correction-immutable");
  // Non-result columns of a terminal attempt (for example fence watermarks) stay writable.
  fixture.rawDb
    .prepare("UPDATE work_attempts SET fence = fence WHERE id = ?")
    .run(attempt.id);
  expect(attempts.get(db, attempt.id).outcome).toEqual(success);
});

it("validates correction rows in backups and on restore", () => {
  const { db } = fixture;
  const { attempt } = finished();
  const view = correct(
    db,
    attempt.id,
    { idempotency_key: key(), task_id: "hotfix", reason: "regression" },
    origin,
  );
  const row = view.corrections?.[0] as Record<string, unknown>;
  expect(() =>
    backup.validateQueueBackupRow("attempt_corrections", row),
  ).not.toThrow();
  expect(() =>
    backup.validateQueueBackupRow("attempt_corrections", {
      ...row,
      created_at: "yesterday",
    }),
  ).toThrow();
  expect(() => backup.invalidateRestoredExecutions(db, {})).not.toThrow();
  const live = seedAttempt(db, "live");
  fixture.rawDb.exec("DROP TRIGGER attempt_corrections_append_only");
  fixture.rawDb
    .prepare("UPDATE attempt_corrections SET attempt_id = ?")
    .run(live.id);
  expect(() => backup.invalidateRestoredExecutions(db, {})).toThrow(
    "finished attempt",
  );
});
