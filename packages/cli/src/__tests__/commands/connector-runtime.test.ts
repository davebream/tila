import { randomUUID } from "node:crypto";
import { RegistrationSchema } from "@tila/schemas";
import { beforeEach, expect, it, vi } from "vitest";
import { relayFactory } from "../../lib/connector-runtime";

const mocked = vi.hoisted(() => ({
  runs: vi.fn(),
  close: vi.fn(),
  enrolled: vi.fn(),
}));
vi.mock("../../lib/runtime", () => ({
  startEnrolledRun: vi.fn(),
  enrolledRuntimeClient: mocked.enrolled,
}));
beforeEach(() => {
  mocked.runs.mockReset();
  mocked.close.mockReset();
  mocked.enrolled.mockReset();
  mocked.enrolled.mockResolvedValue({
    api: { runs: mocked.runs, close: mocked.close },
  });
});
function fixture() {
  const entry = RegistrationSchema.parse({
    key: "a".repeat(64),
    generation: randomUUID(),
    owner: { pid: 123, started: "fixture" },
    agent: "worker",
    profile: { id: "profile", revision: 1 },
    namespace: '["https://tila.test","project"]',
    actingRunId: randomUUID(),
    expectedEpoch: 0,
    allowIdleStart: false,
    relayOperationId: randomUUID(),
    relayRunId: randomUUID(),
    state: "paused",
    runtime: { kind: "standalone" },
    identity: {
      nativeSessionId: "native",
      harness: "codex",
      participantId: "participant",
      enrollmentId: randomUUID(),
      projectId: "project",
      instanceId: randomUUID(),
      accountRef: "fixture",
      principalId: "principal",
      brokerRef: "b".repeat(64),
      nativeEndpointRef: "c".repeat(64),
    },
  });
  const run = {
    run_id: entry.relayRunId,
    run_role: "relay",
    agent_id: "worker",
    project_id: "project",
    enrollment_id: entry.identity?.enrollmentId,
  };
  return { entry, run };
}
it("recovers the committed scoped relay ID without closing an uncertain operation from another run", async () => {
  const f = fixture();
  mocked.runs.mockResolvedValue({
    runs: [
      { ...f.run, run_id: f.entry.relayOperationId, agent_id: "other" },
      f.run,
    ],
  });
  await relayFactory.recover(f.entry);
  expect(mocked.close).toHaveBeenCalledExactlyOnceWith(f.entry.relayRunId);
});
it.each(["run_role", "agent_id", "project_id", "enrollment_id"])(
  "refuses %s crossover before relay cleanup",
  async (field) => {
    const f = fixture();
    mocked.runs.mockResolvedValue({
      runs: [{ ...f.run, [field]: "replacement" }],
    });
    await expect(relayFactory.recover(f.entry)).rejects.toThrow("another run");
    expect(mocked.close).not.toHaveBeenCalled();
  },
);
