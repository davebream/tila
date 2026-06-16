import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  listPointers,
  reconcilePointers,
  tombstonePointer,
  upsertPointer,
} from "../src/artifact-ops";
import { acquire } from "../src/coordination-ops";
import { createEntity, createTestDb } from "./helpers";

// Finding #3: reconcile recovers R2 blobs that have no pointer row. If a pointer
// was deliberately tombstoned and then hard-deleted (7-day grace) while its R2
// blob delete had failed, the blob is an orphan WITH a prior tombstone journal
// event. Reconcile must NOT resurrect it as a live pointer — doing so reverses a
// committed tombstone decision. The tombstone journal event is keyed by r2_key,
// so reconcile can detect it.
describe("reconcile does not resurrect a previously-tombstoned blob", () => {
  it("refuses to recover an orphan whose r2_key was tombstoned, leaving no live pointer", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-rt" });
    const claim = acquire(db, "task:task-rt", "m1", "u1", "exclusive", 60_000);

    const r2Key = "produced/task-rt/recovered.txt";
    // Produce a real artifact pointer under the live claim.
    upsertPointer(
      db,
      {
        r2_key: r2Key,
        resource: "task-rt",
        kind: "output",
        sha256: "sha-rt",
        bytes: 10,
        fence: claim.fence,
        mime_type: "text/plain",
        produced_at: 1,
        produced_by: "m1/u1",
        expires_at: null,
      },
      { actor: "m1/u1" },
    );

    // Tombstone it — records an artifact.tombstoned journal event keyed by r2_key.
    tombstonePointer(db, r2Key, { actor: "sweep-cron" });

    // Simulate the 7-day hard-delete: the pointer ROW is gone, but the R2 blob
    // delete had failed, so the blob still exists as an orphan.
    db.run(sql`DELETE FROM artifact_pointers WHERE r2_key = ${r2Key}`);

    // Reconcile finds the orphan blob (no pointer row) and tries to recover it.
    const orphan = {
      key: r2Key,
      size: 10,
      metadata: {
        "tila-kind": "output",
        "tila-sha256": "sha-rt",
        "tila-mime": "text/plain",
        "tila-task": "task-rt",
      },
    };
    const result = reconcilePointers(
      db,
      [orphan],
      { actor: "reconciler" },
      true,
    );

    // It must NOT be resurrected as a live pointer.
    expect(result.orphans_recovered).toBe(0);
    const live = listPointers(db, {}).find((p) => p.r2_key === r2Key);
    expect(live).toBeUndefined();
  });

  it("still recovers a genuine orphan that was never tombstoned", () => {
    const { db } = createTestDb();
    createEntity(db, { id: "task-go" });
    acquire(db, "task:task-go", "m1", "u1", "exclusive", 60_000);

    const r2Key = "produced/task-go/genuine.txt";
    const orphan = {
      key: r2Key,
      size: 10,
      metadata: {
        "tila-kind": "output",
        "tila-sha256": "sha-go",
        "tila-mime": "text/plain",
        "tila-task": "task-go",
      },
    };
    const result = reconcilePointers(
      db,
      [orphan],
      { actor: "reconciler" },
      true,
    );

    expect(result.orphans_recovered).toBe(1);
    const live = listPointers(db, {}).find((p) => p.r2_key === r2Key);
    expect(live).toBeDefined();
  });
});
