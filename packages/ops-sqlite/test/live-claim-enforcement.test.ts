import { describe, expect, it } from "vitest";
import { upsertPointer } from "../src/artifact-ops";
import { acquire } from "../src/coordination-ops";
import { ExpiredClaimError } from "../src/fence-ops";
import { createGate } from "../src/gate-ops";
import { createEntity, createTestDb } from "./helpers";

// The zombie-write window: entity/gate/artifact fences bump only on acquire,
// not on write. So after a lease EXPIRES with no competing re-acquirer, the
// original holder's fence still numerically equals current_fence and a pure
// equality check passes. The entity write path already closes this with
// requireLiveClaim; these tests pin the same protection for the gate-create
// and artifact-pointer paths.
describe("live-claim enforcement on gate creation", () => {
  it("accepts a gate created under a live claim", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-lg" });

    const T = 1_000_000;
    const claim = acquire(
      db,
      "task:task-lg",
      "m1",
      "u1",
      "exclusive",
      1_000,
      undefined,
      T,
    );

    expect(() =>
      createGate(
        db,
        {
          id: "g-live",
          resource: "task:task-lg",
          await_type: "human",
          fence: claim.fence,
        },
        { actor: "m1/u1" },
        T + 500, // within the 1s lease
      ),
    ).not.toThrow();
  });

  it("rejects a zombie gate: an expired lease whose fence still matches current_fence", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-zg" });

    const T = 1_000_000;
    // 1s lease, no competing re-acquire -> current_fence stays == claim.fence
    const claim = acquire(
      db,
      "task:task-zg",
      "m1",
      "u1",
      "exclusive",
      1_000,
      undefined,
      T,
    );

    expect(() =>
      createGate(
        db,
        {
          id: "g-zombie",
          resource: "task:task-zg",
          await_type: "human",
          fence: claim.fence,
        },
        { actor: "m1/u1" },
        T + 2_000, // lease has expired
      ),
    ).toThrow(ExpiredClaimError);
  });
});

describe("live-claim enforcement on artifact pointers", () => {
  it("accepts an artifact pointer written under a live claim", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-la" });

    // Default now (real Date.now()); 60s TTL -> claim is live when upsert runs.
    const claim = acquire(db, "task:task-la", "m1", "u1", "exclusive", 60_000);

    expect(() =>
      upsertPointer(
        db,
        {
          r2_key: "produced/task-la/live.txt",
          resource: "task-la",
          kind: "output",
          sha256: "sha-live",
          bytes: 10,
          fence: claim.fence,
          mime_type: "text/plain",
          produced_at: 1,
          produced_by: "m1/u1",
          expires_at: null,
        },
        { actor: "m1/u1" },
      ),
    ).not.toThrow();
  });

  it("rejects a zombie artifact pointer: an expired lease whose fence still matches", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-za" });

    // Acquire far in the past: expires_at (T+1000) is long before the real
    // Date.now() that upsertPointer's liveness check reads, so the claim is
    // expired by the time the pointer is written.
    const T = 1_000_000;
    const claim = acquire(
      db,
      "task:task-za",
      "m1",
      "u1",
      "exclusive",
      1_000,
      undefined,
      T,
    );

    expect(() =>
      upsertPointer(
        db,
        {
          r2_key: "produced/task-za/zombie.txt",
          resource: "task-za",
          kind: "output",
          sha256: "sha-zombie",
          bytes: 10,
          fence: claim.fence,
          mime_type: "text/plain",
          produced_at: 1,
          produced_by: "m1/u1",
          expires_at: null,
        },
        { actor: "m1/u1" },
      ),
    ).toThrow(ExpiredClaimError);
  });
});
