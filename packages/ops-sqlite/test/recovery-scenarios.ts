import assert from "node:assert/strict";
import { QueueRetryPolicySchema, type WorkAttempt } from "@tila/schemas";
import { eq } from "drizzle-orm";
import * as attempts from "../src/attempt-ops";
import * as recovery from "../src/attempt-recovery-ops";
import * as entities from "../src/entity-ops";
import type { ProjectDatabase } from "../src/queue-internals";
import * as queue from "../src/queue-ops";
import * as schema from "../src/schema";
import * as configs from "../src/schema-ops";
import {
  authority,
  attemptOrigin as origin,
  seedAttempt,
} from "./attempt-fixture";
import { lifecycleDefinition } from "./readiness-fixture";

const session = {
  provider: "fixture",
  id: "session",
  worktree: "/fixture/worktree",
};
const outcome = {
  status: "failure" as const,
  execution_stopped: true,
  unresolved_external_execution: false,
  evidence: [],
};
const revision = (a: WorkAttempt) => ({
  idempotency_key: crypto.randomUUID(),
  expected_revision: a.revision,
});
function setup(
  db: ProjectDatabase,
  retrySafe = false,
  assigner: string | null = null,
) {
  const now = Date.now();
  let attempt = seedAttempt(db, "task", now, assigner);
  queue.configure(
    db,
    {
      idempotency_key: "enable",
      expected_revision: 0,
      enabled: true,
      paused: false,
      execution_limit: 1,
      wip_limit: 1,
    },
    origin,
    true,
    now,
  );
  if (retrySafe)
    db.update(schema.queueEntries)
      .set({ retry_policy: QueueRetryPolicySchema.parse({ retry_safe: true }) })
      .run();
  attempt = attempts.accept(
    db,
    attempt.id,
    authority(attempt),
    origin,
    now,
  ).attempt;
  attempt = attempts.started(
    db,
    attempt.id,
    { ...authority(attempt), session },
    origin,
    now,
  ).attempt;
  return { now, attempt };
}
function suspend(db: ProjectDatabase, attempt: WorkAttempt, now: number) {
  const requested = recovery.requestSuspension(
    db,
    attempt.id,
    revision(attempt),
    origin,
    false,
    now,
  ).attempt;
  return recovery.confirmSuspension(
    db,
    attempt.id,
    {
      ...authority(requested),
      execution_quiescent: true,
      checkpoint: { session: session.id, step: "review" },
    },
    origin,
    now,
  ).attempt;
}
export const recoveryScenarios: {
  name: string;
  run: (db: ProjectDatabase) => void;
}[] = [
  {
    name: "suspension retains WIP, resume checks policy and creates fresh authority",
    run(db) {
      const { now, attempt } = setup(db);
      let current = recovery.requestSuspension(
        db,
        attempt.id,
        revision(attempt),
        origin,
        false,
        now,
      ).attempt;
      assert.deepEqual(queue.occupancy(db), { execution: 1, wip: 1 });
      assert.throws(() =>
        recovery.confirmSuspension(
          db,
          current.id,
          {
            ...authority(current),
            execution_quiescent: false as true,
            checkpoint: {},
          },
          origin,
          now,
        ),
      );
      current = recovery.confirmSuspension(
        db,
        current.id,
        {
          ...authority(current),
          execution_quiescent: true,
          checkpoint: { step: 1 },
        },
        origin,
        now,
      ).attempt;
      assert.deepEqual(queue.occupancy(db), { execution: 0, wip: 1 });
      attempts.expire(db, now + 500_000);
      assert.equal(attempts.get(db, current.id).state, "suspended");
      assert.throws(() =>
        attempts.heartbeat(db, current.id, authority(current), origin, now),
      );
      current = recovery.requestResume(
        db,
        current.id,
        revision(current),
        origin,
        false,
        now,
      ).attempt;
      queue.configure(
        db,
        { idempotency_key: "pause", expected_revision: 1, paused: true },
        origin,
        true,
        now,
      );
      assert.equal(
        recovery.claimResume(db, current.id, revision(current), origin, now)
          .kind,
        "no_grant",
      );
      queue.configure(
        db,
        { idempotency_key: "unpause", expected_revision: 2, paused: false },
        origin,
        true,
        now,
      );
      const command = revision(current);
      const granted = recovery.claimResume(
        db,
        current.id,
        command,
        origin,
        now,
      );
      assert.equal(granted.kind, "granted");
      assert.equal(granted.attempt.id, attempt.id);
      assert.equal(granted.attempt.state, "starting");
      assert.ok(granted.attempt.fence > attempt.fence);
      assert.deepEqual(queue.occupancy(db), { execution: 1, wip: 1 });
      assert.deepEqual(
        recovery.claimResume(db, current.id, command, origin, now),
        granted,
      );
      assert.throws(() =>
        attempts.heartbeat(db, current.id, authority(attempt), origin, now),
      );
      assert.equal(
        recovery.claimResume(db, current.id, command, origin, now + 60_000)
          .grant_valid,
        false,
      );
      assert.equal(attempts.get(db, current.id).state, "uncertain");
    },
  },
  {
    name: "resume respects current capabilities, gates and occupied capacity",
    run(db) {
      const { now, attempt } = setup(db);
      let current = suspend(db, attempt, now);
      current = recovery.requestResume(
        db,
        current.id,
        revision(current),
        origin,
        false,
        now,
      ).attempt;
      const entry = queue.getEntry(db, attempt.entry_id);
      queue.edit(
        db,
        entry.id,
        {
          idempotency_key: "target",
          expected_revision: entry.revision,
          required_capabilities: ["coding"],
        },
        origin,
        false,
        now,
      );
      const denied = recovery.claimResume(
        db,
        current.id,
        revision(current),
        origin,
        now,
      );
      assert.equal(denied.kind === "no_grant" && denied.reason, "blocked");
      db.insert(schema.gates)
        .values({
          id: "gate",
          resource: attempt.resource,
          await_type: "human",
          fence: attempt.fence,
          created_at: now,
          created_by: "test",
        })
        .run();
      assert.equal(
        recovery.claimResume(
          db,
          current.id,
          { ...revision(current), capabilities: ["coding"] },
          origin,
          now,
        ).kind,
        "no_grant",
      );
      db.delete(schema.gates).run();
      seedAttempt(db, "other", now);
      const full = recovery.claimResume(
        db,
        current.id,
        { ...revision(current), capabilities: ["coding"] },
        origin,
        now,
      );
      assert.equal(
        full.kind === "no_grant" && full.reason,
        "execution_capacity",
      );
    },
  },
  {
    name: "durable cancellation retains capacity and terminal result wins once",
    run(db) {
      const { now, attempt } = setup(db);
      const cancelled = recovery.requestCancellation(
        db,
        attempt.id,
        revision(attempt),
        { ...origin, principalId: "operator" },
        true,
        now,
      ).attempt;
      assert.equal(cancelled.cancellation_requested, true);
      assert.deepEqual(queue.occupancy(db), { execution: 1, wip: 1 });
      const result = attempts.finish(
        db,
        attempt.id,
        { ...authority(cancelled), outcome: { ...outcome, status: "success" } },
        origin,
        now,
      );
      const late = attempts.finish(
        db,
        attempt.id,
        {
          ...authority(cancelled),
          outcome: { ...outcome, status: "cancelled" },
        },
        origin,
        now,
      );
      assert.deepEqual(late, result);
      assert.deepEqual(queue.occupancy(db), { execution: 0, wip: 0 });
      assert.equal(entities.get(db, "task")?.data.phase, "shipped");
    },
  },
  {
    name: "suspended cancellation can finish without an execution heartbeat",
    run(db) {
      const { now, attempt } = setup(db);
      let current = suspend(db, attempt, now);
      current = recovery.requestCancellation(
        db,
        current.id,
        revision(current),
        origin,
        false,
        now,
      ).attempt;
      const result = attempts.finish(
        db,
        current.id,
        { ...authority(current), outcome: { ...outcome, status: "cancelled" } },
        origin,
        now + 600_000,
      );
      assert.equal(result.attempt.state, "terminal");
      assert.equal(result.grant_valid, false);
      assert.deepEqual(queue.occupancy(db), { execution: 0, wip: 0 });
      assert.deepEqual(
        attempts.finish(
          db,
          current.id,
          { ...authority(current), outcome },
          origin,
          now + 600_000,
        ),
        result,
      );
    },
  },
  {
    name: "unknown execution cannot retry and reconnect must match recorded session",
    run(db) {
      const { now, attempt } = setup(db, true);
      attempts.expire(db, now + 60_000);
      let current = attempts.get(db, attempt.id);
      assert.equal(current.state, "uncertain");
      current = recovery.reconcile(
        db,
        current.id,
        {
          ...revision(current),
          observation: "unknown",
          reason: "host unreachable",
        },
        origin,
        false,
        now + 60_001,
      ).attempt;
      assert.deepEqual(queue.occupancy(db), { execution: 1, wip: 1 });
      assert.throws(() =>
        recovery.retry(
          db,
          current.id,
          { ...revision(current), reason: "retry-safe" },
          origin,
          false,
          now + 60_001,
        ),
      );
      assert.throws(() =>
        recovery.reconcile(
          db,
          current.id,
          {
            ...revision(current),
            observation: "running",
            reason: "inspected",
            session: { ...session, id: "different" },
          },
          origin,
          false,
          now + 60_001,
        ),
      );
      const rebound = recovery.reconcile(
        db,
        current.id,
        {
          ...revision(current),
          observation: "running",
          reason: "same process inspected",
          session,
        },
        origin,
        false,
        now + 60_001,
      );
      assert.equal(rebound.grant_valid, true);
      assert.ok(rebound.attempt.fence > attempt.fence);
      assert.deepEqual(queue.occupancy(db), { execution: 1, wip: 1 });
    },
  },
  {
    name: "ownership rebind requires maintainer and invalidates previous participant",
    run(db) {
      const { now, attempt } = setup(db);
      const input = {
        ...revision(attempt),
        reason: "worker restarted",
        principal_id: origin.principalId,
        participant_id: "replacement",
        session,
      };
      assert.throws(() =>
        recovery.rebind(db, attempt.id, input, origin, false, now),
      );
      const result = recovery.rebind(db, attempt.id, input, origin, true, now);
      assert.equal(result.grant_valid, false);
      assert.equal(
        attempts.view(
          db,
          attempt.id,
          { ...origin, participantId: "replacement" },
          now,
        ).grant_valid,
        true,
      );
      assert.throws(() =>
        attempts.heartbeat(
          db,
          attempt.id,
          authority(result.attempt),
          origin,
          now,
        ),
      );
      assert.deepEqual(
        recovery.rebind(db, attempt.id, input, origin, true, now),
        result,
      );
    },
  },
  {
    name: "automatic retry retains WIP, uses backoff and stops at three attempts",
    run(db) {
      const { now, attempt } = setup(db, true);
      attempts.finish(
        db,
        attempt.id,
        { ...authority(attempt), outcome },
        origin,
        now,
      );
      assert.deepEqual(queue.occupancy(db), { execution: 0, wip: 1 });
      assert.equal(
        queue.getEntry(db, attempt.entry_id).available_at,
        now + 5_000,
      );
      assert.equal(
        queue.claimNext(
          db,
          { idempotency_key: "early" },
          origin,
          undefined,
          now + 4_999,
        ).kind,
        "no_grant",
      );
      const second = queue.claimNext(
        db,
        { idempotency_key: "second" },
        origin,
        undefined,
        now + 5_000,
      );
      assert.equal(second.kind, "granted");
      if (second.kind !== "granted") throw new Error("grant");
      assert.equal(second.attempt.predecessor_id, attempt.id);
      let current = attempts.accept(
        db,
        second.attempt.id,
        authority(second.attempt),
        origin,
        now + 5_000,
      ).attempt;
      attempts.finish(
        db,
        current.id,
        { ...authority(current), outcome },
        origin,
        now + 5_000,
      );
      assert.equal(
        queue.getEntry(db, attempt.entry_id).available_at,
        now + 15_000,
      );
      const third = queue.claimNext(
        db,
        { idempotency_key: "third" },
        origin,
        undefined,
        now + 15_000,
      );
      if (third.kind !== "granted") throw new Error("grant");
      current = attempts.accept(
        db,
        third.attempt.id,
        authority(third.attempt),
        origin,
        now + 15_000,
      ).attempt;
      attempts.finish(
        db,
        current.id,
        { ...authority(current), outcome },
        origin,
        now + 15_000,
      );
      assert.equal(queue.getEntry(db, attempt.entry_id).state, "finished");
      assert.deepEqual(queue.occupancy(db), { execution: 0, wip: 0 });
      assert.equal(attempts.list(db).length, 3);
    },
  },
  {
    name: "retry defaults off, explicit retry links same-millisecond history and keeps WIP after preaccept expiry",
    run(db) {
      const { now, attempt } = setup(db);
      let result = attempts.finish(
        db,
        attempt.id,
        { ...authority(attempt), outcome },
        origin,
        now,
      ).attempt;
      assert.equal(queue.getEntry(db, attempt.entry_id).state, "finished");
      recovery.retry(
        db,
        result.id,
        { ...revision(result), reason: "verified safe manually" },
        origin,
        false,
        now,
      );
      const replacement = queue.claimNext(
        db,
        { idempotency_key: "replace" },
        origin,
        undefined,
        now,
      );
      if (replacement.kind !== "granted") throw new Error("grant");
      assert.equal(replacement.attempt.predecessor_id, attempt.id);
      assert.equal(attempts.list(db)[0]?.id, replacement.attempt.id);
      attempts.expire(db, now + 60_000);
      assert.deepEqual(queue.occupancy(db), { execution: 0, wip: 1 });
      result = attempts.get(db, replacement.attempt.id);
      assert.equal(result.outcome?.execution_stopped, true);
      const final = queue.claimNext(
        db,
        { idempotency_key: "replace-expired" },
        origin,
        undefined,
        now + 60_000,
      );
      if (final.kind !== "granted") throw new Error("grant");
      assert.equal(final.attempt.predecessor_id, replacement.attempt.id);
    },
  },
  {
    name: "force recovery records unresolved execution and rejects previous authority",
    run(db) {
      const { now, attempt } = setup(db);
      const input = {
        ...revision(attempt),
        reason: "host lost; maintainer accepts duplicate-effect risk",
      };
      assert.throws(() =>
        recovery.forceRecovery(db, attempt.id, input, origin, false, now),
      );
      const result = recovery.forceRecovery(
        db,
        attempt.id,
        input,
        origin,
        true,
        now,
      );
      assert.equal(result.attempt.outcome?.status, "abandoned");
      assert.equal(result.attempt.outcome?.unresolved_external_execution, true);
      assert.equal(result.attempt.outcome?.execution_stopped, false);
      assert.equal(result.grant_valid, false);
      assert.throws(() =>
        attempts.heartbeat(db, attempt.id, authority(attempt), origin, now),
      );
      assert.equal(queue.getEntry(db, attempt.entry_id).state, "queued");
      assert.deepEqual(queue.occupancy(db), { execution: 0, wip: 1 });
      assert.deepEqual(
        recovery.forceRecovery(db, attempt.id, input, origin, true, now),
        result,
      );
    },
  },
  {
    name: "stopped reconciliation and automatic retry roll back together on schema conflict",
    run(db) {
      const { now, attempt } = setup(db, true);
      attempts.expire(db, now + 60_000);
      const current = attempts.get(db, attempt.id);
      configs.applySchema(
        db,
        `${lifecycleDefinition}\n[work_units.issue.fields.required_new]\ntype = "string"\nrequired = true\n`,
        "maintainer",
        "force",
        undefined,
        {
          expected_revision: 1,
          reviewed_definition: `${lifecycleDefinition}\n[work_units.issue.fields.required_new]\ntype = "string"\nrequired = true\n`,
        },
      );
      assert.throws(() =>
        recovery.reconcile(
          db,
          current.id,
          {
            ...revision(current),
            observation: "stopped",
            reason: "inspected process exit",
            outcome,
          },
          origin,
          false,
          now + 60_001,
        ),
      );
      assert.deepEqual(attempts.get(db, current.id), current);
      assert.deepEqual(queue.occupancy(db), { execution: 1, wip: 1 });
      assert.equal(db.select().from(schema.claims).all().length, 0);
    },
  },
];

recoveryScenarios.push(
  {
    name: "an earlier resume receipt never authorizes a later resume",
    run(db) {
      const { now, attempt } = setup(db);
      let current = suspend(db, attempt, now);
      current = recovery.requestResume(
        db,
        current.id,
        revision(current),
        origin,
        false,
        now,
      ).attempt;
      const firstCommand = revision(current);
      current = recovery.claimResume(
        db,
        current.id,
        firstCommand,
        origin,
        now,
      ).attempt;
      current = attempts.started(
        db,
        current.id,
        { ...authority(current), session },
        origin,
        now,
      ).attempt;
      current = suspend(db, current, now);
      current = recovery.requestResume(
        db,
        current.id,
        revision(current),
        origin,
        false,
        now,
      ).attempt;
      const second = recovery.claimResume(
        db,
        current.id,
        revision(current),
        origin,
        now,
      );
      assert.equal(second.grant_valid, true);
      const old = recovery.claimResume(
        db,
        current.id,
        firstCommand,
        origin,
        now,
      );
      assert.equal(old.grant_valid, false);
      assert.equal(old.attempt.fence, second.attempt.fence);
    },
  },
  {
    name: "cancellation before acceptance never authorizes spawning",
    run(db) {
      const now = Date.now();
      const reserved = seedAttempt(db, "task", now);
      const cancelled = recovery.requestCancellation(
        db,
        reserved.id,
        revision(reserved),
        origin,
        false,
        now,
      ).attempt;
      assert.throws(() =>
        attempts.accept(db, cancelled.id, authority(cancelled), origin, now),
      );
      const result = recovery.reconcile(
        db,
        cancelled.id,
        {
          ...revision(cancelled),
          observation: "stopped",
          reason: "wrapper never launched",
          outcome: { ...outcome, status: "cancelled" },
        },
        origin,
        false,
        now,
      );
      assert.equal(result.attempt.state, "terminal");
      assert.deepEqual(queue.occupancy(db), { execution: 0, wip: 0 });
    },
  },
  {
    name: "confirmed stopped reconciliation schedules safe retry but unknown never does",
    run(db) {
      const { now, attempt } = setup(db, true);
      const unknown = recovery.reconcile(
        db,
        attempt.id,
        {
          ...revision(attempt),
          observation: "unknown",
          reason: "connection lost",
        },
        origin,
        false,
        now,
      ).attempt;
      assert.equal(queue.getEntry(db, attempt.entry_id).state, "admitted");
      const stopped = recovery.reconcile(
        db,
        unknown.id,
        {
          ...revision(unknown),
          observation: "stopped",
          reason: "runtime reports exited",
          outcome,
        },
        origin,
        false,
        now,
      ).attempt;
      assert.equal(stopped.outcome?.status, "failure");
      assert.equal(queue.getEntry(db, attempt.entry_id).state, "queued");
      assert.deepEqual(queue.occupancy(db), { execution: 0, wip: 1 });
    },
  },
  {
    name: "configured abandonment mapping permits replacement while preserving unresolved history",
    run(db) {
      const { now, attempt } = setup(db);
      const definition = lifecycleDefinition.replace(
        'cancelled = "aborted"',
        'cancelled = "aborted"\nabandoned = "todo"',
      );
      configs.applySchema(db, definition, "maintainer", "force", undefined, {
        expected_revision: 1,
        reviewed_definition: definition,
      });
      const result = recovery.forceRecovery(
        db,
        attempt.id,
        { ...revision(attempt), reason: "explicit risk accepted" },
        origin,
        true,
        now,
      );
      const next = queue.claimNext(
        db,
        { idempotency_key: "replacement" },
        origin,
        undefined,
        now,
      );
      if (next.kind !== "granted")
        throw new Error(JSON.stringify({ next, queue: queue.inspect(db) }));
      assert.equal(next.attempt.predecessor_id, attempt.id);
      assert.ok(next.attempt.fence > result.attempt.fence);
      assert.equal(
        attempts.get(db, attempt.id).outcome?.unresolved_external_execution,
        true,
      );
      assert.throws(() =>
        entities.update(
          db,
          "task",
          { phase: "shipped" },
          attempt.fence,
          origin,
        ),
      );
    },
  },
  {
    name: "control requests come from the owner, the assigner or a maintainer",
    run(db) {
      const { now, attempt } = setup(db, false, "orchestrator");
      const stranger = {
        ...origin,
        principalId: "stranger",
        participantId: "stranger-process",
      };
      const assigner = {
        ...origin,
        principalId: "orchestrator",
        participantId: "orchestrator-process",
      };
      for (const request of [
        recovery.requestCancellation,
        recovery.requestSuspension,
      ])
        assert.throws(
          () =>
            request(db, attempt.id, revision(attempt), stranger, false, now),
          /attempt owner/,
        );
      let current = recovery.requestSuspension(
        db,
        attempt.id,
        revision(attempt),
        assigner,
        false,
        now,
      ).attempt;
      assert.equal(current.suspension_requested, true);
      // A maintainer replaces the execution participant; the former one loses control.
      current = recovery.rebind(
        db,
        current.id,
        {
          ...revision(current),
          reason: "worker replaced",
          principal_id: origin.principalId,
          participant_id: "replacement",
          session,
        },
        origin,
        true,
        now,
      ).attempt;
      assert.throws(
        () =>
          recovery.requestCancellation(
            db,
            current.id,
            revision(current),
            origin,
            false,
            now,
          ),
        /attempt owner/,
      );
      const command = revision(current);
      current = recovery.requestCancellation(
        db,
        current.id,
        command,
        assigner,
        false,
        now,
      ).attempt;
      assert.equal(current.cancellation_requested, true);
      const requested = db
        .select()
        .from(schema.journal)
        .where(eq(schema.journal.kind, "attempt.cancellation_requested"))
        .all();
      assert.deepEqual(
        requested.map((row) => row.principal_id),
        ["orchestrator"],
      );
      assert.equal(
        attempts.view(db, current.id, assigner, now).assigner_principal_id,
        "orchestrator",
      );
    },
  },
  {
    name: "enrollments without a recorded assigner allow only owner or maintainer control",
    run(db) {
      const { now, attempt } = setup(db);
      const stranger = { ...origin, principalId: "stranger" };
      assert.throws(() =>
        recovery.requestSuspension(
          db,
          attempt.id,
          revision(attempt),
          stranger,
          false,
          now,
        ),
      );
      const owned = recovery.requestSuspension(
        db,
        attempt.id,
        revision(attempt),
        origin,
        false,
        now,
      ).attempt;
      const managed = recovery.requestCancellation(
        db,
        owned.id,
        revision(owned),
        stranger,
        true,
        now,
      ).attempt;
      assert.equal(managed.cancellation_requested, true);
    },
  },
  {
    name: "explicit retry and receipt replay require current control",
    run(db) {
      const { now, attempt } = setup(db, false, "orchestrator");
      const finished = attempts.finish(
        db,
        attempt.id,
        { ...authority(attempt), outcome },
        origin,
        now,
      ).attempt;
      const stranger = { ...origin, principalId: "stranger" };
      const input = { ...revision(finished), reason: "transient failure" };
      assert.throws(
        () => recovery.retry(db, finished.id, input, stranger, false, now),
        /attempt owner/,
      );
      const assigner = { ...origin, principalId: "orchestrator" };
      recovery.retry(db, finished.id, input, assigner, false, now);
      assert.equal(queue.getEntry(db, attempt.entry_id).state, "queued");
      db.update(schema.queueEntries)
        .set({ enrolled_by_principal: "someone-else" })
        .run();
      assert.throws(
        () => recovery.retry(db, finished.id, input, assigner, false, now),
        /attempt owner/,
      );
    },
  },
  {
    name: "finishing suspended work requires the latest recorded fence",
    run(db) {
      const { now, attempt } = setup(db);
      let current = suspend(db, attempt, now);
      current = recovery.requestResume(
        db,
        current.id,
        revision(current),
        origin,
        false,
        now,
      ).attempt;
      current = recovery.claimResume(
        db,
        current.id,
        revision(current),
        origin,
        now,
      ).attempt;
      current = attempts.started(
        db,
        current.id,
        { ...authority(current), session },
        origin,
        now,
      ).attempt;
      current = suspend(db, current, now);
      assert.ok(current.fence > attempt.fence);
      assert.throws(
        () =>
          attempts.finish(
            db,
            current.id,
            {
              ...authority(current),
              fence: attempt.fence,
              outcome: { ...outcome, status: "success" },
            },
            origin,
            now,
          ),
        /another execution authority/,
      );
      assert.deepEqual(attempts.get(db, current.id), current);
      const result = attempts.finish(
        db,
        current.id,
        { ...authority(current), outcome: { ...outcome, status: "success" } },
        origin,
        now,
      );
      assert.equal(result.attempt.outcome?.status, "success");
    },
  },
  {
    name: "stopped reconciliation never records a result for an unaccepted reservation",
    run(db) {
      const now = Date.now();
      const reserved = seedAttempt(db, "task", now);
      for (const status of ["success", "failure", "cancelled"] as const)
        assert.throws(
          () =>
            recovery.reconcile(
              db,
              reserved.id,
              {
                ...revision(reserved),
                observation: "stopped",
                reason: "wrapper reports exit",
                outcome: { ...outcome, status },
              },
              origin,
              true,
              now,
            ),
          /Unaccepted execution/,
        );
      assert.deepEqual(attempts.get(db, reserved.id), reserved);
    },
  },
  {
    name: "maintainer recovery records the maintainer and the owner in the journal",
    run(db) {
      const { now, attempt } = setup(db);
      const maintainer = {
        ...origin,
        principalId: "maintainer",
        participantId: "maintainer-console",
      };
      recovery.forceRecovery(
        db,
        attempt.id,
        { ...revision(attempt), reason: "host lost" },
        maintainer,
        true,
        now,
      );
      const finished = db
        .select()
        .from(schema.journal)
        .where(eq(schema.journal.kind, "attempt.finished"))
        .get();
      assert.equal(finished?.principal_id, "maintainer");
      assert.equal(finished?.participant_id, "maintainer-console");
      const data = JSON.parse(finished?.data ?? "{}");
      assert.equal(data.owner_principal_id, origin.principalId);
      assert.equal(data.owner_participant_id, origin.participantId);
    },
  },
);
