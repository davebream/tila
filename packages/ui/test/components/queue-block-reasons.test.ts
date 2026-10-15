import { describeBlockReason } from "@/components/queue/block-reasons";
import type { QueueBlockReason } from "@tila/schemas";

const task = "task-0";
const reason = (
  over: Partial<QueueBlockReason> & Pick<QueueBlockReason, "code">,
) => ({ resource: task, ...over }) as QueueBlockReason;

describe("describeBlockReason", () => {
  it("keeps a visible predecessor's identity, state and path", () => {
    expect(
      describeBlockReason(
        reason({
          code: "dependency-unsatisfied",
          resource: "task-b",
          state: "in_review",
        }),
        task,
      ),
    ).toEqual({
      kind: "dependency",
      code: "dependency-unsatisfied",
      task: "task-b",
      linkable: true,
      state: "in_review",
      path: [],
    });
    expect(
      describeBlockReason(
        reason({
          code: "dependency-cycle",
          resource: "task-b",
          path: ["task-b", "task-c", "task-b"],
        }),
        task,
      ),
    ).toMatchObject({
      kind: "dependency",
      task: "task-b",
      path: ["task-b", "task-c", "task-b"],
    });
  });

  // The shape queue-ops `inspect` writes when a predecessor is restricted.
  it.each([
    "dependency-missing",
    "dependency-unsatisfied",
    "dependency-lifecycle-unconfigured",
    "dependency-cycle",
  ] as const)("treats %s naming the entry's own task as restricted", (code) => {
    expect(describeBlockReason(reason({ code }), task)).toEqual({
      kind: "restricted",
    });
  });

  it("does not mistake a real cycle through the entry's own task for a restriction", () => {
    expect(
      describeBlockReason(
        reason({
          code: "dependency-cycle",
          resource: task,
          path: [task, "task-b", task],
        }),
        task,
      ),
    ).toMatchObject({
      kind: "dependency",
      task,
      linkable: true,
      path: [task, "task-b", task],
    });
  });

  it.each([
    "missing",
    "archived",
    "lifecycle-unconfigured",
    "not-dispatchable",
    "retry-backoff",
    "target-mismatch",
    "capability-mismatch",
    "live-claim",
    "attempt-active",
    "execution-unresolved",
  ] as const)(
    "shows %s as the entry's own condition, not a restriction",
    (code) => {
      expect(
        describeBlockReason(reason({ code, state: "draft" }), task),
      ).toEqual({ kind: "own", code, state: "draft" });
    },
  );

  it("reads a gate's resource as a gate, never a task", () => {
    expect(
      describeBlockReason(
        reason({ code: "gate-pending", resource: "gate-9" }),
        task,
      ),
    ).toEqual({ kind: "gate", code: "gate-pending", gate: "gate-9" });
  });

  it("offers no task page for a predecessor that no longer exists", () => {
    expect(
      describeBlockReason(
        reason({ code: "dependency-missing", resource: "task-gone" }),
        task,
      ),
    ).toMatchObject({ kind: "dependency", task: "task-gone", linkable: false });
  });
});
