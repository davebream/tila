import { FenceError } from "@tila/core";
import { describe, expect, it } from "vitest";
import { acquire } from "../src/coordination-ops";
import { update } from "../src/entity-ops";
import {
  ExpiredClaimError,
  FenceNotFoundError,
  assertResourceFence,
  assertResourceFenceWithCanonical,
} from "../src/fence-ops";
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

  it("rejects a zombie write: an expired lease whose fence still matches current_fence", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-z" });

    const T = 1_000_000;
    // Acquire a 1s lease. No competing re-acquire happens, so current_fence
    // stays equal to claim.fence even after the lease expires.
    const claim = acquire(
      db,
      "task:task-z",
      "m1",
      "u1",
      "exclusive",
      1_000,
      undefined,
      T,
    );

    // Within the lease the matching fence is accepted...
    expect(() =>
      assertResourceFence(db, "task:task-z", claim.fence, {
        now: T + 500,
        requireLiveClaim: true,
      }),
    ).not.toThrow();

    // ...but once the lease has expired the same (still-numerically-valid)
    // fence is rejected — the zombie-write window is closed.
    expect(() =>
      assertResourceFence(db, "task:task-z", claim.fence, {
        now: T + 2_000,
        requireLiveClaim: true,
      }),
    ).toThrow(ExpiredClaimError);
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

// ── assertResourceFenceWithCanonical: error payload parity with assertResourceFence ─
describe("assertResourceFenceWithCanonical error payload", () => {
  // The refactor that introduced `assertResourceFenceWithCanonical` (Task 1,
  // T2 build) must be strictly behaviour-preserving: errors thrown via the fast
  // canonical path must carry the same `resource` payload as the original
  // `assertResourceFence` path, which throws with the bare entity id (not the
  // canonical `<type>:<id>` form). These tests pin that contract.

  it("throws FenceNotFoundError with bare id (not canonical) when no fence row exists", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-payload-nf" });

    // Call the canonical fast path directly — no acquire, so no fence row.
    let thrown: unknown;
    try {
      assertResourceFenceWithCanonical(db, "task:task-payload-nf", 1);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(FenceNotFoundError);
    // The error message must reference the bare id, not "task:task-payload-nf".
    expect((thrown as FenceNotFoundError).message).toContain("task-payload-nf");
    expect((thrown as FenceNotFoundError).message).not.toContain(
      "task:task-payload-nf",
    );
  });

  it("throws ExpiredClaimError with bare id (not canonical) when the lease has expired", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-payload-ec" });

    const T = 1_000_000;
    // 1s lease — expired by T+2000.
    acquire(
      db,
      "task:task-payload-ec",
      "m1",
      "u1",
      "exclusive",
      1_000,
      undefined,
      T,
    );

    let thrown: unknown;
    try {
      assertResourceFenceWithCanonical(db, "task:task-payload-ec", 1, {
        now: T + 2_000,
        requireLiveClaim: true,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ExpiredClaimError);
    expect((thrown as ExpiredClaimError).message).toContain("task-payload-ec");
    expect((thrown as ExpiredClaimError).message).not.toContain(
      "task:task-payload-ec",
    );
  });

  it("update() with missing fence throws FenceNotFoundError carrying the bare entity id", () => {
    // End-to-end: update() calls assertResourceFenceWithCanonical internally.
    // Verify the error payload seen by callers is the bare id, preserving the
    // contract that existed before the fast-path refactor.
    const { db } = createTestDb();
    createEntity(db, { id: "task-e2e-nf" });

    let thrown: unknown;
    try {
      update(db, "task-e2e-nf", { status: "in_progress" }, 1, {
        actor: "m1/u1",
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(FenceNotFoundError);
    expect((thrown as FenceNotFoundError).message).toContain("task-e2e-nf");
    expect((thrown as FenceNotFoundError).message).not.toContain(
      "task:task-e2e-nf",
    );
  });

  it("update() with expired claim throws ExpiredClaimError carrying the bare entity id", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-e2e-ec" });

    const T = 1_000_000;
    const claim = acquire(
      db,
      "task:task-e2e-ec",
      "m1",
      "u1",
      "exclusive",
      1_000,
      undefined,
      T,
    );

    let thrown: unknown;
    try {
      // Pass a now that is past the lease expiry so the zombie-write check fires.
      // update() uses Date.now() internally, but we need to trigger the expired
      // path. We do this by using assertResourceFenceWithCanonical directly with
      // a controlled `now`, then confirm update() also throws ExpiredClaimError.
      // For the e2e path, set the clock far in the past so the claim is expired
      // by real Date.now() (claim.expires_at = T+1000 = 1_001_000 which is well
      // below real Date.now() in 2026).
      update(db, "task-e2e-ec", { status: "in_progress" }, claim.fence, {
        actor: "m1/u1",
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ExpiredClaimError);
    expect((thrown as ExpiredClaimError).message).toContain("task-e2e-ec");
    expect((thrown as ExpiredClaimError).message).not.toContain(
      "task:task-e2e-ec",
    );
  });
});
