import type { ArtifactLifecycleRecord } from "@tila/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as lifecycle from "../src/artifact-lifecycle-ops";
import { deleteTombstonedPointers } from "../src/artifact-ops";
import * as versions from "../src/artifact-version-ops";
import { acquire } from "../src/coordination-ops";
import { MIGRATIONS } from "../src/migrations-sql";
import * as schema from "../src/schema";
import { runMigration } from "./helpers";
import { type TestDb, createTestDb, testOrigin } from "./helpers";

const T = 1_800_000_000_000;
const DAY = 86_400_000;
let test: TestDb;
let fence: number;
const origin = testOrigin("lifecycle-test");
let records: Map<string, ArtifactLifecycleRecord>;
let store: lifecycle.LifecycleStore;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
  test = createTestDb();
  fence = acquire(
    test.db,
    "artifact:report",
    origin,
    "exclusive",
    60_000,
  ).fence;
  records = new Map();
  store = {
    writeRecord: vi.fn(async (key, record) => {
      if (records.has(key)) expect(records.get(key)).toEqual(record);
      records.set(key, record);
    }),
    deleteBlob: vi.fn(async () => {}),
  };
});
afterEach(() => {
  test.rawDb.close();
  vi.useRealTimers();
});
function commit(
  id: string,
  patch: Partial<versions.ReserveArtifactRevision> = {},
) {
  versions.reserveArtifactRevision(
    test.db,
    {
      operation_id: id,
      request_hash: id,
      project_id: "p1",
      lineage_id: "report",
      lineage_fence: fence,
      kind: "report",
      resource: null,
      sha256: id.padEnd(64, "a"),
      bytes: 3,
      mime_type: "text/plain",
      fence: null,
      tags: ["keep"],
      ...patch,
    },
    origin,
  );
  versions.acceptArtifactRevision(test.db, id);
  return versions.publishArtifactRevision(test.db, id).pointer;
}
function setPolicy(days: number, version = 1) {
  test.db
    .insert(schema.schemaHistory)
    .values({
      version,
      definition: `schema_version = 1\n[work_units]\n[artifacts.report]\nretention_days = ${days}\n`,
      applied_at: T,
      applied_by: "test",
    })
    .run();
}

describe("version-aware lifecycle", () => {
  it("removes existing search content when replaying lineage retirement", () => {
    const pointer = commit("1");
    test.db
      .insert(schema.artifactSearchDocs)
      .values({
        artifact_key: pointer.r2_key,
        kind: pointer.kind,
        mime_type: pointer.mime_type,
        indexed_at: T,
        source_sha256: pointer.sha256,
        body_text: "private content",
      })
      .run();
    lifecycle.reconcileLifecycle(
      test.db,
      {
        format: "tila-artifact-lifecycle-v1",
        type: "destroy",
        project_id: "p1",
        lineage_id: "report",
        kind: "report",
        resource: null,
        at: T,
      },
      "p1",
    );
    expect(test.db.select().from(schema.artifactSearchDocs).all()).toHaveLength(
      0,
    );
    expect(versions.getArtifactLineageHead(test.db, "report")).toBeNull();
  });
  it("migrates existing pointers and published receipts without recreating removed pointers", () => {
    const one = commit("1");
    const two = commit("2");
    test.db
      .delete(schema.artifactTags)
      .where(eq(schema.artifactTags.artifact_key, two.r2_key))
      .run();
    test.db
      .delete(schema.artifactPointers)
      .where(eq(schema.artifactPointers.r2_key, two.r2_key))
      .run();
    test.rawDb.exec(
      "DROP TRIGGER artifact_reviews_no_delete; DROP TABLE artifact_revisions; DROP TABLE artifact_lifecycle_operations; DROP TABLE artifact_retention_state; ALTER TABLE artifact_lineages DROP COLUMN destroyed_at;",
    );
    const migration = MIGRATIONS.find((m) => m.version === 28);
    if (!migration) throw new Error("Missing lifecycle migration");
    runMigration(test.rawDb, migration);
    const reviewMigration = MIGRATIONS.find((m) => m.version === 29);
    if (!reviewMigration) throw new Error("Missing review migration");
    runMigration(test.rawDb, reviewMigration);
    expect(versions.getArtifactMeta(test.db, one.r2_key)).toMatchObject({
      tags: ["keep"],
      tombstoned: 0,
    });
    expect(versions.getArtifactMeta(test.db, two.r2_key)).toMatchObject({
      tags: ["keep"],
      tombstoned: 1,
    });
    expect(test.db.select().from(schema.artifactPointers).all()).toHaveLength(
      1,
    );
    expect(versions.listArtifactHistory(test.db, two.r2_key).meta.total).toBe(
      2,
    );
  });

  it("gives restored revisions their own production time and current retention", () => {
    setPolicy(7);
    const one = commit("1");
    vi.setSystemTime(T + 1000);
    setPolicy(30, 2);
    const restored = commit("2", {
      restored_from: one.r2_key,
      sha256: one.sha256,
    });
    expect(restored.expires_at).toBe(T + 1000 + 30 * DAY);
    expect(versions.getArtifactMeta(test.db, one.r2_key).expires_at).toBe(
      T + 7 * DAY,
    );
  });

  it("keeps unspecified retention forever and protects the current head", async () => {
    const one = commit("1");
    const two = commit("2");
    await lifecycle.drainLifecycle(test.db, store, 50, T + 400 * DAY);
    expect(store.deleteBlob).not.toHaveBeenCalled();
    expect(versions.getArtifactMeta(test.db, one.r2_key).expires_at).toBeNull();
    expect(versions.getArtifactLineageHead(test.db, "report")?.r2_key).toBe(
      two.r2_key,
    );
  });
  it("assigns retention per revision and sweeps only the non-head at the boundary", async () => {
    setPolicy(7);
    const one = commit("1");
    const two = commit("2");
    expect(one.expires_at).toBe(T + 7 * DAY);
    await lifecycle.drainLifecycle(test.db, store, 50, T + 7 * DAY - 1);
    expect(store.deleteBlob).not.toHaveBeenCalled();
    await lifecycle.drainLifecycle(test.db, store, 50, T + 7 * DAY);
    expect(store.deleteBlob).toHaveBeenCalledExactlyOnceWith(one.r2_key);
    expect(versions.getArtifactLineageHead(test.db, "report")?.r2_key).toBe(
      two.r2_key,
    );
  });
  it("backfills bounded batches against one policy snapshot and persists assignments before deletion", async () => {
    const one = commit("1");
    commit("2");
    test.db
      .update(schema.artifactRevisions)
      .set({ retention_assigned: 0 })
      .run();
    setPolicy(7);
    lifecycle.backfillRetention(test.db, 1);
    setPolicy(30, 2);
    lifecycle.backfillRetention(test.db, 1);
    expect(versions.getArtifactMeta(test.db, one.r2_key).expires_at).toBe(
      T + 7 * DAY,
    );
    expect(
      lifecycle.acceptDeletion(
        test.db,
        one.r2_key,
        {},
        origin,
        "expired",
        T + 8 * DAY,
      ),
    ).toBeNull();
    await lifecycle.drainLifecycle(test.db, store, 50, T + 8 * DAY);
    await lifecycle.drainLifecycle(test.db, store, 50, T + 8 * DAY);
    expect(store.deleteBlob).toHaveBeenCalledExactlyOnceWith(one.r2_key);
    expect(
      records.get(`${one.r2_key}.retention.json`)?.pointer?.expires_at,
    ).toBe(T + 7 * DAY);
  });
  it("rechecks head protection after a candidate's newer revision is tombstoned", () => {
    setPolicy(1);
    const one = commit("1");
    const two = commit("2");
    lifecycle.acceptDeletion(test.db, two.r2_key, { fence }, origin);
    expect(
      lifecycle.acceptDeletion(
        test.db,
        one.r2_key,
        {},
        origin,
        "expired",
        T + 2 * DAY,
      ),
    ).toBeNull();
    expect(versions.getArtifactLineageHead(test.db, "report")?.r2_key).toBe(
      one.r2_key,
    );
  });
  it("keeps history, tags, and deleted pagination anchors after audit-preserving cleanup", async () => {
    const one = commit("1");
    const two = commit("2");
    const page = versions.listArtifactHistory(test.db, two.r2_key, {
      limit: 1,
    });
    lifecycle.acceptDeletion(test.db, two.r2_key, { fence }, origin);
    await lifecycle.drainLifecycle(test.db, store);
    expect(deleteTombstonedPointers(test.db, T + 7 * DAY + 1)).toBe(0);
    const meta = versions.getArtifactMeta(test.db, two.r2_key);
    expect(meta).toMatchObject({
      tombstoned: 1,
      blob_deleted_at: T,
      tags: ["keep"],
    });
    expect(
      versions.listArtifactHistory(test.db, two.r2_key, {
        cursor: page.meta.next_cursor ?? undefined,
      }).items[0].r2_key,
    ).toBe(one.r2_key);
    expect(versions.listArtifactHistory(test.db, two.r2_key).meta.total).toBe(
      2,
    );
    expect(() => versions.assertRestorable(test.db, two.r2_key)).toThrowError(
      expect.objectContaining({ status: 410 }),
    );
  });
  it("rejects missing, stale, and expired fences but replays accepted deletion after lease expiry", () => {
    const one = commit("1");
    expect(() =>
      lifecycle.acceptDeletion(test.db, one.r2_key, {}, origin),
    ).toThrowError(expect.objectContaining({ code: "missing-fence" }));
    expect(() =>
      lifecycle.acceptDeletion(
        test.db,
        one.r2_key,
        { fence: fence + 1 },
        origin,
      ),
    ).toThrow();
    const id = lifecycle.acceptDeletion(
      test.db,
      one.r2_key,
      { fence, idempotencyKey: "delete" },
      origin,
    );
    expect(
      lifecycle.acceptDeletion(
        test.db,
        one.r2_key,
        { fence, idempotencyKey: "second-delete" },
        origin,
      ),
    ).toBe(id);
    vi.setSystemTime(T + DAY);
    expect(
      lifecycle.acceptDeletion(
        test.db,
        one.r2_key,
        { fence, idempotencyKey: "second-delete" },
        origin,
      ),
    ).toBe(id);
    expect(
      lifecycle.acceptDeletion(
        test.db,
        one.r2_key,
        { fence, idempotencyKey: "delete" },
        origin,
      ),
    ).toBe(id);
    expect(() =>
      lifecycle.acceptDeletion(test.db, one.r2_key, { fence }, origin),
    ).toThrow();
  });
  it("waits for pending publication and rejects idempotency keys used for a different target", () => {
    const one = commit("1");
    const two = commit("2");
    lifecycle.acceptDeletion(
      test.db,
      one.r2_key,
      { fence, idempotencyKey: "same" },
      origin,
    );
    expect(() =>
      lifecycle.acceptDeletion(
        test.db,
        two.r2_key,
        { fence, idempotencyKey: "same" },
        origin,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "idempotency-key-conflict" }),
    );
    test.db
      .update(schema.artifactRevisionOperations)
      .set({ state: "accepted" })
      .where(eq(schema.artifactRevisionOperations.id, "2"))
      .run();
    expect(() =>
      lifecycle.acceptDeletion(test.db, two.r2_key, { fence }, origin),
    ).toThrowError(expect.objectContaining({ code: "artifact-lineage-busy" }));
    expect(() =>
      lifecycle.destroyLineage(test.db, "report", { fence }, origin),
    ).toThrowError(expect.objectContaining({ code: "artifact-lineage-busy" }));
  });
  it.each(["retention", "destroy"] as const)(
    "requires the %s recovery record before deleting any bytes",
    async (type) => {
      const one = commit("1");
      commit("2");
      if (type === "retention") {
        test.db
          .update(schema.artifactRevisions)
          .set({ retention_assigned: 0 })
          .run();
        setPolicy(1);
      } else lifecycle.destroyLineage(test.db, "report", { fence }, origin);
      const failing: lifecycle.LifecycleStore = {
        ...store,
        writeRecord: async (key, record) => {
          if (record.type === type) throw new Error("record unavailable");
          await store.writeRecord(key, record);
        },
      };
      const result = await lifecycle.drainLifecycle(
        test.db,
        failing,
        50,
        T + 2 * DAY,
      );
      expect(result.errors).toBeGreaterThan(0);
      expect(store.deleteBlob).not.toHaveBeenCalled();
      for (let i = 0; i < 3; i++)
        await lifecycle.drainLifecycle(
          test.db,
          store,
          50,
          T + 2 * DAY + 10_000,
        );
      expect(store.deleteBlob).toHaveBeenCalledWith(one.r2_key);
    },
  );
  it.each(["retention", "tombstone", "deleted", "destroy"] as const)(
    "retries an acknowledged-lost %s record without changing its immutable contents",
    async (type) => {
      const one = commit("1");
      commit("2");
      if (type === "retention") {
        test.db
          .update(schema.artifactRevisions)
          .set({ retention_assigned: 0 })
          .run();
        setPolicy(1);
      } else if (type === "destroy")
        lifecycle.destroyLineage(test.db, "report", { fence }, origin);
      else lifecycle.acceptDeletion(test.db, one.r2_key, { fence }, origin);
      let failed = false;
      const failing: lifecycle.LifecycleStore = {
        ...store,
        writeRecord: async (key, record) => {
          await store.writeRecord(key, record);
          if (record.type === type && !failed) {
            failed = true;
            throw new Error("lost acknowledgement");
          }
        },
      };
      await lifecycle.drainLifecycle(test.db, failing, 50, T + 2 * DAY);
      expect(failed).toBe(true);
      for (let i = 0; i < 3; i++)
        await lifecycle.drainLifecycle(
          test.db,
          store,
          50,
          T + 2 * DAY + 10_000,
        );
      expect(lifecycle.hasLifecycleWork(test.db)).toBe(false);
      expect(
        versions.getArtifactMeta(test.db, one.r2_key).blob_deleted_at,
      ).not.toBeNull();
    },
  );
  it.each(["tombstone", "deleted", "blob"])(
    "retries %s failure without losing metadata or starving another key",
    async (failure) => {
      const one = commit("1");
      const two = commit("2");
      commit("3");
      lifecycle.acceptDeletion(test.db, one.r2_key, { fence }, origin);
      lifecycle.acceptDeletion(test.db, two.r2_key, { fence }, origin);
      let fail = true;
      const failing: lifecycle.LifecycleStore = {
        writeRecord: async (key, record) => {
          if (fail && key === `${one.r2_key}.${failure}.json`)
            throw new Error("offline");
          await store.writeRecord(key, record);
        },
        deleteBlob: async (key) => {
          if (fail && failure === "blob" && key === one.r2_key)
            throw new Error("offline");
          await store.deleteBlob(key);
        },
      };
      const result = await lifecycle.drainLifecycle(test.db, failing);
      expect(result.errors).toBe(1);
      expect(
        versions.getArtifactMeta(test.db, one.r2_key).blob_deleted_at,
      ).toBeNull();
      expect(
        versions.getArtifactMeta(test.db, two.r2_key).blob_deleted_at,
      ).toBe(T);
      if (failure === "tombstone")
        expect(store.deleteBlob).not.toHaveBeenCalledWith(one.r2_key);
      expect(deleteTombstonedPointers(test.db, T + 8 * DAY)).toBe(0);
      fail = false;
      await lifecycle.drainLifecycle(test.db, failing, 50, T + 6000);
      expect(
        versions.getArtifactMeta(test.db, one.r2_key).blob_deleted_at,
      ).not.toBeNull();
    },
  );
  it("retires groups, drains across batches, and never resurrects revisions during recovery", async () => {
    const revisions = [commit("1"), commit("2"), commit("3")];
    const commits = test.db
      .select()
      .from(schema.artifactRevisionOperations)
      .all()
      .map(versions.revisionRecord);
    const destroyed = lifecycle.destroyLineage(
      test.db,
      "report",
      { fence, idempotencyKey: "destroy" },
      origin,
    );
    expect(versions.getArtifactLineageHead(test.db, "report")).toBeNull();
    expect(() => commit("4")).toThrowError(
      expect.objectContaining({ code: "artifact-lineage-destroyed" }),
    );
    for (let i = 0; i < 8; i++)
      await lifecycle.drainLifecycle(test.db, store, 1);
    expect(store.deleteBlob).toHaveBeenCalledTimes(3);
    expect(lifecycle.hasLifecycleWork(test.db)).toBe(false);
    vi.setSystemTime(T + DAY);
    expect(
      lifecycle.destroyLineage(
        test.db,
        "report",
        { fence, idempotencyKey: "destroy" },
        origin,
      ).response,
    ).toEqual(destroyed.response);
    const fresh = createTestDb();
    try {
      for (const fact of records.values())
        lifecycle.reconcileLifecycle(fresh.db, fact, "p1");
      for (const record of commits)
        versions.reconcileArtifactCommit(fresh.db, record, "p1");
      expect(versions.getArtifactLineageHead(fresh.db, "report")).toBeNull();
      expect(
        fresh.db.select().from(schema.artifactPointers).all(),
      ).toHaveLength(0);
      const history = versions.listArtifactHistory(
        fresh.db,
        revisions[0].r2_key,
      );
      expect(history.items).toHaveLength(3);
      expect(
        history.items.every((p) => p.blob_deleted_at != null && p.tombstoned),
      ).toBe(true);
    } finally {
      fresh.rawDb.close();
    }
  });
});
