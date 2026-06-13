import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { acquire } from "../src/coordination-ops";
import { checkPendingGates, createGate } from "../src/gate-ops";
import * as schema from "../src/schema";
import { createEntity, createTestDb } from "./helpers";

// The append-only journal must stay complete: every meaningful state change
// emits a journal row in the same transaction. checkPendingGates (the
// write-path timer resolution reached on terminal entity transitions) used to
// flip a gate to timed_out WITHOUT journaling — a journal-vs-state drift. This
// guards that it now journals identically to the read-path (listGates).
describe("checkPendingGates journals timed-out gates (write path)", () => {
  it("emits a gate.timed_out journal row when resolving an expired timer gate", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-g" });
    const claim = acquire(db, "task:task-g", "m1", "u1", "exclusive", 60_000);

    const T0 = 1_000_000;
    createGate(
      db,
      {
        id: "gate-1",
        resource: "task:task-g",
        await_type: "timer",
        fence: claim.fence,
        timeout_at: T0 + 1_000,
      },
      { actor: "m1/u1" },
      T0,
    );

    // Resolve on the write path, after the gate's timeout.
    db.transaction((tx) => checkPendingGates(tx, "task:task-g", T0 + 2_000));

    const journaled = db
      .select()
      .from(schema.journal)
      .where(eq(schema.journal.kind, "gate.timed_out"))
      .all();

    expect(journaled).toHaveLength(1);
    expect(journaled[0].resource).toBe("task:task-g");
    expect(journaled[0].fence).toBe(claim.fence);
  });
});
