import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tombstonePointer, upsertPointer } from "../src/artifact-ops";
import * as versions from "../src/artifact-version-ops";
import { acquire } from "../src/coordination-ops";
import * as schema from "../src/schema";
import { type TestDb, createTestDb, testOrigin } from "./helpers";

let test: TestDb;
const origin = testOrigin("revision-test");
let fence: number;
beforeEach(() => {
  test = createTestDb();
  fence = acquire(
    test.db,
    "artifact:report",
    origin,
    "exclusive",
    60_000,
  ).fence;
});
afterEach(() => test.rawDb.close());
function input(
  id: string,
  sha = "a".repeat(64),
): versions.ReserveArtifactRevision {
  return {
    project_id: "p1",
    operation_id: id,
    request_hash: id,
    lineage_id: "report",
    lineage_fence: fence,
    kind: "report",
    resource: null,
    sha256: sha,
    bytes: 3,
    mime_type: "text/plain",
    fence: null,
    tags: ["Env:Prod"],
  };
}
function commit(
  id: string,
  patch: Partial<versions.ReserveArtifactRevision> = {},
) {
  const reserved = versions.reserveArtifactRevision(
    test.db,
    { ...input(id), ...patch },
    origin,
  );
  if (reserved.duplicate)
    return versions.revisionResponse(reserved.duplicate, true);
  versions.acceptArtifactRevision(test.db, id);
  return versions.publishArtifactRevision(test.db, id);
}

describe("artifact revisions", () => {
  it("publishes only accepted revisions and preserves identical-byte restores", () => {
    const r1 = commit("one");
    expect(
      commit("dup", { mime_type: "text/markdown", tags: [] }),
    ).toMatchObject({
      key: r1.key,
      deduplicated: true,
      pointer: { tags: ["env:prod"] },
    });
    const r2 = commit("two", { sha256: "b".repeat(64) });
    const restore = { ...input("restore"), restored_from: r1.key };
    const reservation = versions.reserveArtifactRevision(
      test.db,
      restore,
      origin,
    );
    expect(
      versions
        .listArtifactHistory(test.db, r1.key)
        .items.map((p) => p.revision),
    ).toEqual([2, 1]);
    expect(() => versions.publishArtifactRevision(test.db, "restore")).toThrow(
      "no accepted commit",
    );
    versions.acceptArtifactRevision(test.db, "restore");
    expect(versions.listArtifactHistory(test.db, r1.key).items).toHaveLength(2);
    const r3 = versions.publishArtifactRevision(test.db, "restore");
    expect(r3.pointer.revision).toBe(3);
    expect(r3.key).not.toBe(r1.key);
    expect(r3.restored_from).toBe(r1.key);
    expect(r3.pointer.sha256).toBe(r1.pointer.sha256);
    expect(r3.pointer.tags).toEqual(["env:prod"]);
    expect(versions.publishArtifactRevision(test.db, "dup")).toMatchObject({
      key: r1.key,
      deduplicated: true,
    });
    expect(r2.pointer.revision).toBe(2);
    expect(reservation.operation?.state).toBe("reserved");
    expect(
      versions.reserveArtifactRevision(test.db, restore, origin).operation
        ?.state,
    ).toBe("published");
    expect(versions.publishArtifactRevision(test.db, "restore")).toEqual(r3);
    expect(() =>
      versions.reserveArtifactRevision(
        test.db,
        { ...restore, request_hash: "different" },
        origin,
      ),
    ).toThrow("different input");
  });

  it("fails closed for missing, stale and expired lineage claims, including at commit", () => {
    expect(() =>
      versions.reserveArtifactRevision(
        test.db,
        { ...input("bad"), lineage_id: "unknown" },
        origin,
      ),
    ).toThrow("No fence row");
    expect(() =>
      versions.reserveArtifactRevision(
        test.db,
        { ...input("bad"), lineage_fence: fence + 1 },
        origin,
      ),
    ).toThrow();
    versions.reserveArtifactRevision(test.db, input("pending"), origin);
    test.db
      .update(schema.claims)
      .set({ expires_at: 0 })
      .where(eq(schema.claims.resource, "artifact:report"))
      .run();
    expect(() => versions.acceptArtifactRevision(test.db, "pending")).toThrow(
      "No live claim",
    );
    expect(versions.listPendingArtifactCommits(test.db)).toHaveLength(0);
    expect(test.db.select().from(schema.artifactPointers).all()).toHaveLength(
      0,
    );
  });

  it("serializes pending publication and allows accepted outbox replay after lease expiry", () => {
    versions.reserveArtifactRevision(test.db, input("one"), origin);
    versions.acceptArtifactRevision(test.db, "one");
    expect(() =>
      versions.reserveArtifactRevision(test.db, input("two"), origin),
    ).toThrow("still being published");
    test.db.update(schema.claims).set({ expires_at: 0 }).run();
    expect(
      versions.publishArtifactRevision(test.db, "one").pointer.revision,
    ).toBe(1);
    expect(versions.listPendingArtifactCommits(test.db)).toHaveLength(0);
  });

  it("paginates a fixed revision ceiling despite new writes and retains tombstones", () => {
    const first = commit("one");
    commit("two", { sha256: "b".repeat(64) });
    const third = commit("three", { sha256: "c".repeat(64) });
    const page = versions.listArtifactHistory(test.db, first.key, { limit: 1 });
    commit("four", { sha256: "d".repeat(64) });
    const next = versions.listArtifactHistory(test.db, first.key, {
      limit: 1,
      cursor: page.meta.next_cursor as string,
    });
    expect(next.items.map((p) => p.revision)).toEqual([2]);
    expect(next.meta.total).toBe(3);
    expect(
      versions.listArtifactHistory(test.db, first.key, { limit: 500 }).meta
        .limit,
    ).toBe(200);
    expect(
      versions.listArtifactHistory(test.db, first.key, { limit: 0 }).meta.limit,
    ).toBe(1);
    expect(() =>
      versions.listArtifactHistory(test.db, first.key, { cursor: "garbage" }),
    ).toThrow("Cursor");
    tombstonePointer(test.db, third.key, origin);
    expect(versions.getArtifactMeta(test.db, third.key).tombstoned).toBe(1);
    expect(() => commit("restore", { restored_from: third.key })).toThrow(
      "no longer available",
    );
  });

  it("rebuilds committed history from recovery records without live claims", () => {
    const one = commit("one");
    const two = commit("two", { restored_from: one.key });
    const records = ["two", "one"].map((id) =>
      versions.revisionRecord(
        versions.getRevisionOperation(
          test.db,
          id,
        ) as versions.RevisionOperation,
      ),
    );
    const recovered = createTestDb();
    try {
      for (const record of records)
        versions.reconcileArtifactCommit(recovered.db, record, "p1");
      for (const record of records)
        versions.reconcileArtifactCommit(recovered.db, record, "p1");
      expect(versions.listArtifactHistory(recovered.db, one.key).items).toEqual(
        [two.pointer, one.pointer],
      );
      expect(() =>
        versions.reconcileArtifactCommit(
          recovered.db,
          records[0],
          "other-project",
        ),
      ).toThrow("this project");
      expect(
        recovered.db.select().from(schema.artifactLineages).get()
          ?.next_revision,
      ).toBe(3);
    } finally {
      recovered.rawDb.close();
    }
  });

  it("adopts a legacy artifact without changing its key or inventing history", () => {
    const old = {
      r2_key: "sources/legacy.txt",
      resource: null,
      kind: "report",
      sha256: "a".repeat(64),
      bytes: 3,
      fence: null,
      mime_type: "text/plain",
      produced_at: 1,
      produced_by: "legacy",
      expires_at: null,
    };
    upsertPointer(test.db, old, origin);
    expect(
      versions.listArtifactHistory(test.db, old.r2_key).items[0].revision,
    ).toBeNull();
    const adopted = commit("adopt", { restored_from: old.r2_key, adopt: true });
    expect(adopted.pointer.revision).toBe(1);
    expect(versions.getArtifactMeta(test.db, old.r2_key).lineage_id).toBeNull();
    expect(() =>
      commit("adopt-again", { restored_from: old.r2_key, adopt: true }),
    ).toThrow("cannot be adopted");
  });
});
