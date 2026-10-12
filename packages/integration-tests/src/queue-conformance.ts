import type { AttemptBackend, QueueBackend } from "@tila/core";
import type { QueueClaimResult, WorkAttempt } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import { lifecycleDefinition } from "../../ops-sqlite/test/readiness-fixture";
export const queueConformanceDefinition = lifecycleDefinition.replace(
  'failure = "todo"',
  'failure = "todo"\nabandoned = "todo"',
);

export interface QueueFixture {
  queue: QueueBackend;
  attempts: AttemptBackend;
  createTask(id: string): Promise<unknown>;
  close(): Promise<void>;
}
const key = () => ({ idempotency_key: crypto.randomUUID() });
const revision = (value: { revision: number }) => ({
  ...key(),
  expected_revision: value.revision,
});
const authority = (value: WorkAttempt) => ({
  ...revision(value),
  fence: value.fence,
});
function granted(result: QueueClaimResult) {
  expect(result.kind).toBe("granted");
  if (result.kind !== "granted") throw new Error(result.message);
  expect(result.grant_valid).toBe(true);
  return result.attempt;
}
const outcome = {
  status: "cancelled" as const,
  execution_stopped: true,
  unresolved_external_execution: false,
  evidence: [],
};

/** Identical public-contract assertions for embedded SQLite and authenticated Worker/DO. */
export function queueConformance(
  name: string,
  factory: () => Promise<QueueFixture>,
) {
  describe(name, () => {
    const scenario = (title: string, run: (f: QueueFixture) => Promise<void>) =>
      it(title, async () => {
        const f = await factory();
        try {
          await run(f);
        } finally {
          await f.close();
        }
      });
    scenario(
      "skips incompatible high priority work and deduplicates permanent grants",
      async ({ queue, attempts, createTask }) => {
        await queue.configure({
          ...key(),
          expected_revision: 0,
          enabled: true,
          paused: false,
          execution_limit: 2,
        });
        for (const id of ["targeted", "capability", "first", "second"]) {
          await createTask(id);
          await queue.enroll({
            ...key(),
            task_id: id,
            priority: id === "targeted" || id === "capability" ? 100 : 1,
            ...(id === "targeted"
              ? { target_principal: "unavailable-principal" }
              : {}),
            ...(id === "capability" ? { required_capabilities: ["gpu"] } : {}),
          });
        }
        const input = key();
        const first = granted(await queue.claimNext(input));
        expect(first.task_id).toBe("first");
        expect(granted(await queue.claimNext(input)).id).toBe(first.id);
        expect(granted(await queue.claimNext(key())).task_id).toBe("second");
        const denied = key();
        expect(await queue.claimNext(denied)).toMatchObject({
          kind: "no_grant",
          reason: "execution_capacity",
        });
        await queue.claimNext(denied);
        expect(
          (await queue.inspect()).diagnostics?.grant_denials.execution_capacity,
        ).toBe(1);
        expect(await attempts.list()).toHaveLength(2);
      },
    );
    scenario(
      "separates execution from WIP, honors pause on resume and invalidates old receipts",
      async ({ queue, attempts, createTask }) => {
        await queue.configure({
          ...key(),
          expected_revision: 0,
          enabled: true,
          paused: false,
          execution_limit: 1,
          wip_limit: 1,
        });
        for (const id of ["one", "two"]) {
          await createTask(id);
          await queue.enroll({ ...key(), task_id: id });
        }
        const input = key();
        let a = granted(await queue.claimNext(input));
        const accepted = authority(a);
        a = (await attempts.accept(a.id, accepted)).attempt;
        const session = { provider: "conformance-fixture", id: "same-session" };
        a = (await attempts.started(a.id, { ...authority(a), session }))
          .attempt;
        a = (await attempts.requestSuspension(a.id, revision(a))).attempt;
        a = (
          await attempts.confirmSuspension(a.id, {
            ...authority(a),
            execution_quiescent: true,
            checkpoint: { step: 2 },
          })
        ).attempt;
        expect((await queue.inspect()).counts).toMatchObject({
          execution: 0,
          wip: 1,
          suspended: 1,
        });
        expect(await queue.claimNext(key())).toMatchObject({
          kind: "no_grant",
          reason: "wip_capacity",
        });
        let policy = await queue.configure({
          ...revision(await queue.policy()),
          paused: true,
        });
        a = (await attempts.requestResume(a.id, revision(a))).attempt;
        expect(await attempts.claimResume(a.id, revision(a))).toMatchObject({
          kind: "no_grant",
          reason: "paused",
        });
        policy = await queue.configure({ ...revision(policy), paused: false });
        const resumed = await attempts.claimResume(a.id, revision(a));
        expect(resumed.kind).toBe("granted");
        a = resumed.attempt;
        expect((await attempts.accept(a.id, accepted)).grant_valid).toBe(false);
        const replay = await queue.claimNext(input);
        expect(replay.kind === "granted" && replay.grant_valid).toBe(false);
        a = (await attempts.started(a.id, { ...authority(a), session }))
          .attempt;
        a = (await attempts.requestCancellation(a.id, revision(a))).attempt;
        expect((await queue.inspect()).counts.execution).toBe(1);
        const finish = { ...authority(a), outcome };
        const terminal = await attempts.finish(a.id, finish);
        expect(await attempts.finish(a.id, finish)).toEqual(terminal);
        const conflicting = await attempts.finish(a.id, {
          ...authority(a),
          outcome: { ...outcome, status: "success" },
        });
        expect(conflicting.attempt.outcome?.status).toBe("cancelled");
        expect((await queue.inspect()).counts).toMatchObject({
          execution: 0,
          wip: 0,
        });
        expect(granted(await queue.claimNext(key())).task_id).toBe("two");
      },
    );
    scenario(
      "holds unknown execution and requires explicit force recovery before replacement",
      async ({ queue, attempts, createTask }) => {
        await queue.configure({
          ...key(),
          expected_revision: 0,
          enabled: true,
          paused: false,
          execution_limit: 1,
        });
        await createTask("one");
        await queue.enroll({ ...key(), task_id: "one" });
        let a = granted(await queue.claimNext(key()));
        a = (await attempts.accept(a.id, authority(a))).attempt;
        const old = authority(a);
        a = (
          await attempts.reconcile(a.id, {
            ...revision(a),
            observation: "unknown",
            reason: "Unreachable runtime",
          })
        ).attempt;
        expect((await queue.inspect()).counts).toMatchObject({
          execution: 1,
          wip: 1,
          uncertain: 1,
        });
        await expect(
          attempts.retry(a.id, {
            ...revision(a),
            reason: "Not proof of stopped execution",
          }),
        ).rejects.toMatchObject({ code: "queue-invalid-state" });
        a = (
          await attempts.forceRecovery(a.id, {
            ...revision(a),
            reason: "Operator accepts unresolved external execution",
          })
        ).attempt;
        expect(a.outcome).toMatchObject({
          status: "abandoned",
          execution_stopped: false,
          unresolved_external_execution: true,
        });
        const replacement = granted(await queue.claimNext(key()));
        expect(replacement.id).not.toBe(a.id);
        expect(replacement.predecessor_id).toBe(a.id);
        expect(replacement.fence).toBeGreaterThan(old.fence);
        await expect(attempts.heartbeat(a.id, old)).rejects.toMatchObject({
          code: "queue-authority-lost",
        });
        expect((await queue.inspect()).diagnostics).toMatchObject({
          forced_abandonments: 1,
          retries: 1,
          uncertainty_events: 1,
        });
      },
    );
  });
}
