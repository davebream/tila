import { describe, expect, it } from "vitest";
import { listPointers, upsertPointer } from "../src/artifact-ops";
import { acquire, release } from "../src/coordination-ops";
import { createEntity, createTestDb } from "./helpers";

// Reconcile recovers an already-committed historical blob whose resource fence
// may have advanced since the blob was produced. It must record the historical
// fence verbatim WITHOUT the live-fence equality gate (which would otherwise
// reject recovery exactly when it is needed).
describe("upsertPointer reconcile (skipFenceValidation)", () => {
  it("records a historical fence without the live-fence gate, even after the fence advanced", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-r" });

    const c1 = acquire(db, "task:task-r", "m1", "u1", "exclusive", 60_000);
    release(db, "task:task-r", c1.fence, { actor: "m1/u1" });
    const c2 = acquire(db, "task:task-r", "m2", "u2", "exclusive", 60_000);
    expect(c2.fence).toBeGreaterThan(c1.fence); // current_fence has advanced

    const pointer = {
      // artifact_pointers.resource has a FK to entities(id) (the bare id), and
      // assertResourceFence canonicalizes it to task:task-r internally.
      r2_key: "produced/task-r/abc.txt",
      resource: "task-r",
      kind: "output",
      sha256: "sha-abc",
      bytes: 10,
      fence: c1.fence, // stale historical fence
      mime_type: "text/plain",
      produced_at: 1,
      produced_by: "reconciler",
      expires_at: null,
    };
    const origin = { actor: "reconciler" };

    // A normal (validated) write with the stale fence is rejected...
    expect(() => upsertPointer(db, pointer, origin)).toThrow();

    // ...but the reconcile replay records it verbatim (skipFenceValidation).
    expect(() =>
      upsertPointer(
        db,
        pointer,
        origin,
        "artifact.reconciled",
        undefined,
        undefined,
        undefined,
        true,
      ),
    ).not.toThrow();

    const recorded = listPointers(db, {}).find(
      (p) => p.r2_key === pointer.r2_key,
    );
    expect(recorded?.fence).toBe(c1.fence);
  });
});
