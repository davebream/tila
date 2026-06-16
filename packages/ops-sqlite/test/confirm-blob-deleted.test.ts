import { describe, expect, it } from "vitest";
import {
  confirmBlobDeleted,
  deleteTombstonedPointers,
  tombstonePointer,
  upsertPointer,
} from "../src/artifact-ops";
import { acquire } from "../src/coordination-ops";
import { createEntity, createTestDb } from "./helpers";

// confirmBlobDeleted is the signal the sweep records after a SUCCESSFUL R2 blob
// delete. It stamps blob_deleted_at, which is what gates the tombstoned-pointer
// hard-delete (deleteTombstonedPointers).
describe("confirmBlobDeleted", () => {
  function seedTombstoned(): {
    db: ReturnType<typeof createTestDb>["db"];
    rawDb: ReturnType<typeof createTestDb>["rawDb"];
    r2Key: string;
  } {
    const { db, rawDb } = createTestDb();
    createEntity(db, { id: "task-cb" });
    const claim = acquire(db, "task:task-cb", "m1", "u1", "exclusive", 60_000);
    const r2Key = "produced/task-cb/x.txt";
    upsertPointer(
      db,
      {
        r2_key: r2Key,
        resource: "task-cb",
        kind: "output",
        sha256: "s",
        bytes: 1,
        fence: claim.fence,
        mime_type: "text/plain",
        produced_at: 1,
        produced_by: "m1/u1",
        expires_at: null,
      },
      { actor: "m1/u1" },
    );
    tombstonePointer(db, r2Key, { actor: "sweep-cron" });
    return { db, rawDb, r2Key };
  }

  it("stamps blob_deleted_at for the given r2_key", () => {
    const { db, rawDb, r2Key } = seedTombstoned();

    const before = rawDb
      .prepare("SELECT blob_deleted_at FROM artifact_pointers WHERE r2_key = ?")
      .get(r2Key) as { blob_deleted_at: number | null };
    expect(before.blob_deleted_at).toBeNull();

    const T = 5_000_000;
    confirmBlobDeleted(db, r2Key, T);

    const after = rawDb
      .prepare("SELECT blob_deleted_at FROM artifact_pointers WHERE r2_key = ?")
      .get(r2Key) as { blob_deleted_at: number | null };
    expect(after.blob_deleted_at).toBe(T);
  });

  it("makes a past-grace tombstoned pointer eligible for hard-delete only after confirmation", () => {
    const { db, r2Key } = seedTombstoned();
    // tombstoned_at was stamped by tombstonePointer at real Date.now(); use a
    // cutoff far in the future so the row is unambiguously past grace.
    const cutoff = Date.now() + 1_000_000;

    // Before confirmation: retained despite being past grace.
    expect(deleteTombstonedPointers(db, cutoff)).toBe(0);

    confirmBlobDeleted(db, r2Key, Date.now());

    // After confirmation: eligible and deleted.
    expect(deleteTombstonedPointers(db, cutoff)).toBe(1);
  });
});
