import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalResources, createTilaLocal } from "../local";
import {
  type ExecutionObservation,
  type QueueExecutionAdapter,
  QueueExecutor,
} from "../queue-executor";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
});
const stopped: Extract<ExecutionObservation, { state: "stopped" }> = {
  state: "stopped",
  outcome: {
    status: "success",
    execution_stopped: true,
    evidence: [],
    unresolved_external_execution: false,
  },
};
async function fixture(lease = 60_000) {
  const root = await mkdtemp(join(tmpdir(), "tila-executor-"));
  const local = await createTilaLocal({
    dbPath: join(root, "db"),
    artifactsPath: join(root, "blobs"),
    project: "test",
    identity: {
      principal_id: "worker",
      participant_id: "wrapper",
      environment: {},
    },
  });
  cleanup.push(async () => {
    local.close();
    await rm(root, { recursive: true, force: true });
  });
  const backend = buildLocalResources(local.project, local.artifacts);
  await backend.schema.apply(
    `schema_version = 1
[work_units.task.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done"]
dependency_satisfied = ["done"]
[work_units.task.fields.status]
type = "enum"
values = ["open", "done"]
`,
    undefined,
    { expected_revision: 0 },
  );
  await backend.tasks.create("task", "task", { status: "open" });
  await backend.queue.configure({
    expected_revision: 0,
    idempotency_key: "enable",
    enabled: true,
    paused: false,
    execution_limit: 1,
    lease_ms: lease,
  });
  await backend.queue.enroll({ task_id: "task", idempotency_key: "enroll" });
  let observation: ExecutionObservation = { state: "absent" };
  const adapter: QueueExecutionAdapter = {
    inspect: vi.fn(async () => observation),
    start: vi.fn(async () => {
      observation = {
        state: "running",
        session: { provider: "fixture", id: "session" },
      };
    }),
    cancel: vi.fn(async () => {
      observation = {
        ...stopped,
        outcome: { ...stopped.outcome, status: "cancelled" },
      };
    }),
  };
  const executor = () =>
    new QueueExecutor(backend, adapter, {
      principalId: "worker",
      participantId: "wrapper",
    });
  const grant = await executor().claim({ idempotency_key: "claim" });
  if (grant.kind !== "granted") throw new Error("Expected grant");
  return {
    backend,
    adapter,
    executor,
    id: grant.attempt.id,
    observe: (value: ExecutionObservation) => {
      observation = value;
    },
  };
}
const command = (revision: number) => ({
  expected_revision: revision,
  idempotency_key: crypto.randomUUID(),
});

describe("repository execution helper with real embedded queue", () => {
  it("accepts before launch, reconnects without relaunching and commits explicit outcome", async () => {
    const f = await fixture();
    vi.mocked(f.adapter.start).mockImplementationOnce(async (attempt) => {
      expect((await f.backend.attempts.get(attempt.id)).attempt.state).toBe(
        "starting",
      );
      f.observe({
        state: "running",
        session: { provider: "fixture", id: "session" },
      });
    });
    expect((await f.executor().step(f.id)).attempt.state).toBe("running");
    expect((await f.executor().recoverable()).map((a) => a.id)).toEqual([f.id]);
    await f.executor().step(f.id);
    expect(f.adapter.start).toHaveBeenCalledTimes(1);
    f.observe(stopped);
    expect((await f.executor().step(f.id)).attempt.outcome?.status).toBe(
      "success",
    );
    expect((await f.backend.queue.inspect()).counts.execution).toBe(0);
  });
  it("inspects after a lost launch acknowledgement and replays a lost result response", async () => {
    const f = await fixture();
    vi.mocked(f.adapter.start).mockImplementationOnce(async () => {
      f.observe(stopped);
      throw new Error("lost launch acknowledgement");
    });
    const finish = f.backend.attempts.finish.bind(f.backend.attempts);
    const spy = vi
      .spyOn(f.backend.attempts, "finish")
      .mockImplementationOnce(async (...args) => {
        await finish(...args);
        throw new TypeError("connection lost");
      });
    expect((await f.executor().step(f.id)).attempt.outcome?.status).toBe(
      "success",
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]).toEqual(spy.mock.calls[1]);
    expect(f.adapter.start).toHaveBeenCalledTimes(1);
  });
  it("attaches a restarted provider session to the same attempt without relaunching", async () => {
    const f = await fixture();
    expect((await f.executor().step(f.id)).attempt.state).toBe("running");
    const before = (await f.backend.attempts.get(f.id)).attempt;
    f.observe({
      state: "replaced",
      reason: "provider session restarted",
      session: { provider: "fixture", id: "session-2" },
    });
    const replaced = await f.executor().step(f.id);
    expect(replaced.attempt.id).toBe(f.id);
    expect(replaced.attempt.session?.id).toBe("session-2");
    expect(replaced.attempt.fence).toBeGreaterThan(before.fence);
    expect(replaced.attempt.outcome).toBeNull();
    expect(f.adapter.start).toHaveBeenCalledTimes(1);
    f.observe({
      state: "running",
      session: { provider: "fixture", id: "session-2" },
    });
    expect((await f.executor().step(f.id)).attempt.state).toBe("running");
    expect((await f.executor().recoverable()).map((a) => a.id)).toEqual([f.id]);
  });
  it("keeps unknown execution uncertain without a replacement", async () => {
    const f = await fixture();
    f.observe({
      state: "unknown",
      reason: "intent exists but launcher disappeared",
    });
    expect((await f.executor().step(f.id)).attempt.state).toBe("uncertain");
    await f.executor().step(f.id);
    expect(f.adapter.start).not.toHaveBeenCalled();
    expect((await f.backend.queue.inspect()).counts.execution).toBe(1);
  });
  it("acknowledges cancellation before launch and running cancellation after observed stop", async () => {
    for (const launch of [false, true]) {
      const f = await fixture();
      if (launch) await f.executor().step(f.id);
      const view = await f.backend.attempts.get(f.id);
      await f.backend.attempts.requestCancellation(
        f.id,
        command(view.attempt.revision),
      );
      expect((await f.executor().step(f.id)).attempt.outcome?.status).toBe(
        "cancelled",
      );
      expect(f.adapter.start).toHaveBeenCalledTimes(launch ? 1 : 0);
    }
  });
  it("holds authority throughout a launch longer than its lease", async () => {
    const f = await fixture(1_000);
    vi.mocked(f.adapter.start).mockImplementationOnce(
      async (_attempt, { signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 1_400));
        signal.throwIfAborted();
        f.observe({
          state: "running",
          session: { provider: "fixture", id: "slow" },
        });
      },
    );
    expect((await f.executor().step(f.id)).grant_valid).toBe(true);
  });
  it("aborts an in-flight adapter on authority loss and never reports a stale start", async () => {
    const f = await fixture(1_000);
    vi.mocked(f.adapter.start).mockImplementationOnce(
      async (_attempt, { signal }) => {
        const current = await f.backend.attempts.get(f.id);
        await f.backend.attempts.forceRecovery(f.id, {
          ...command(current.attempt.revision),
          reason: "test isolation",
        });
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      },
    );
    await expect(f.executor().step(f.id)).rejects.toThrow();
    expect((await f.backend.attempts.get(f.id)).attempt.outcome?.status).toBe(
      "abandoned",
    );
  });
  it("releases only execution on confirmed suspension and resumes the same attempt", async () => {
    const f = await fixture();
    f.adapter.suspend = vi.fn(async () =>
      f.observe({
        state: "suspended",
        session: { provider: "fixture", id: "session" },
        checkpoint: { checkpoint: "one" },
      }),
    );
    f.adapter.resume = vi.fn(async () =>
      f.observe({
        state: "running",
        session: { provider: "fixture", id: "session" },
      }),
    );
    const started = await f.executor().step(f.id);
    await f.backend.attempts.requestSuspension(
      f.id,
      command(started.attempt.revision),
    );
    const suspended = await f.executor().step(f.id);
    expect(suspended.attempt.state).toBe("suspended");
    expect((await f.backend.queue.inspect()).counts).toMatchObject({
      execution: 0,
      wip: 1,
    });
    await f.backend.attempts.requestResume(
      f.id,
      command(suspended.attempt.revision),
    );
    const resumed = await f.executor().step(f.id);
    expect(resumed.attempt.state).toBe("running");
    expect(resumed.attempt.fence).toBeGreaterThan(started.attempt.fence);
    expect(f.adapter.resume).toHaveBeenCalledTimes(1);
    expect(f.adapter.start).toHaveBeenCalledTimes(1);
  });
  it("keeps capacity for adapters without suspension and rejects identity mismatch", async () => {
    const f = await fixture();
    const running = await f.executor().step(f.id);
    await f.backend.attempts.requestSuspension(
      f.id,
      command(running.attempt.revision),
    );
    expect((await f.executor().step(f.id)).attempt.state).toBe("running");
    expect((await f.backend.queue.inspect()).counts.execution).toBe(1);
    const other = new QueueExecutor(f.backend, f.adapter, {
      principalId: "other",
      participantId: "wrapper",
    });
    await expect(other.step(f.id)).rejects.toThrow("another worker");
  });
});

it.each(["running", "unknown"] as const)(
  "reconciles an expired accepted lease observed as %s without waiting for a sweep",
  async (state) => {
    const f = await fixture();
    const running = await f.executor().step(f.id);
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue((running.attempt.lease_expires_at ?? Date.now()) + 1);
    try {
      if (state === "unknown")
        f.observe({ state, reason: "runtime disconnected" });
      const recovered = await f.executor().step(f.id);
      expect(recovered.attempt.state).toBe(
        state === "running" ? "running" : "uncertain",
      );
      expect(recovered.grant_valid).toBe(state === "running");
      if (state === "running")
        expect(recovered.attempt.fence).toBeGreaterThan(running.attempt.fence);
      expect(f.adapter.start).toHaveBeenCalledTimes(1);
      expect((await f.backend.queue.inspect()).counts.execution).toBe(1);
    } finally {
      now.mockRestore();
    }
  },
);

it("releases an expired unaccepted reservation without launching", async () => {
  const f = await fixture();
  const before = await f.backend.attempts.get(f.id);
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue((before.attempt.lease_expires_at ?? Date.now()) + 1);
  try {
    expect((await f.executor().step(f.id)).attempt).toMatchObject({
      state: "terminal",
      accepted_at: null,
      outcome: { status: "abandoned", execution_stopped: true },
    });
    expect(f.adapter.start).not.toHaveBeenCalled();
    expect((await f.backend.queue.inspect()).counts).toMatchObject({
      execution: 0,
      wip: 0,
      backlog: 1,
    });
  } finally {
    now.mockRestore();
  }
});
