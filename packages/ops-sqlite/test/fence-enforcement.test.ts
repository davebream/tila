import { FenceError } from "@tila/core";
import { describe, expect, it } from "vitest";
import { acquire } from "../src/coordination-ops";
import { update } from "../src/entity-ops";
import { FenceNotFoundError } from "../src/fence-ops";
import { createEntity, createTestDb } from "./helpers";

// Real fence-enforcement coverage for the destructive entity-write path,
// exercising the acquire -> write-with-fence contract end to end (not a mock).
// This pins the behaviour the claim-liveness fix builds on.
describe("fence enforcement on entity writes", () => {
  it("accepts an update carrying the fence returned by a live claim", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-1" });

    const claim = acquire(db, "task:task-1", "m1", "u1", "exclusive", 60_000);
    expect(claim.acquired).toBe(true);

    expect(() =>
      update(db, "task-1", { status: "in_progress" }, claim.fence, {
        actor: "m1/u1",
      }),
    ).not.toThrow();
  });

  it("rejects an update carrying a stale (non-current) fence", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-2" });

    const claim = acquire(db, "task:task-2", "m1", "u1", "exclusive", 60_000);

    expect(() =>
      update(db, "task-2", { status: "in_progress" }, claim.fence + 99, {
        actor: "m1/u1",
      }),
    ).toThrow(FenceError);
  });

  it("fails closed when no fence row exists (no claim was ever acquired)", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-3" });

    // No acquire() => no fence row for task:task-3. A required-fence write must
    // throw rather than silently succeed (the "fail closed when required fence
    // row is missing" rule).
    expect(() =>
      update(db, "task-3", { status: "in_progress" }, 1, { actor: "m1/u1" }),
    ).toThrow(FenceNotFoundError);
  });
});
