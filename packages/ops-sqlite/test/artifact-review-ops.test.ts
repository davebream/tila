import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  confirmBlobDeleted,
  deleteTombstonedPointers,
  listPointers,
  tombstonePointer,
  upsertPointer,
} from "../src/artifact-ops";
import {
  artifactTrustByKeys,
  listArtifactReviews,
  reviewArtifact,
} from "../src/artifact-review-ops";
import * as versions from "../src/artifact-version-ops";
import { acquire } from "../src/coordination-ops";
import * as entities from "../src/entity-ops";
import * as schema from "../src/schema";
import { applySchema } from "../src/schema-ops";
import { instantiateTemplate } from "../src/template-ops";
import { type TestDb, createTestDb, testOrigin } from "./helpers";

let test: TestDb;
const producer = testOrigin("producer-session", "producer");
const reviewer = testOrigin("review-session", "reviewer");
const key = "sources/evidence.txt";
const pointer = {
  r2_key: key,
  resource: null,
  kind: "report",
  sha256: "a".repeat(64),
  bytes: 3,
  fence: null,
  mime_type: "text/plain",
  produced_at: 123,
  produced_by: "display name",
  expires_at: null,
};
beforeEach(() => {
  test = createTestDb();
  upsertPointer(test.db, pointer, producer);
});
afterEach(() => test.rawDb.close());
function decide(
  decision: "trusted" | "rejected" | "superseded" | "revoked",
  revision: number,
  id = crypto.randomUUID(),
) {
  return reviewArtifact(
    test.db,
    key,
    { decision, expected_review_revision: revision },
    reviewer,
    id,
  );
}
function meta() {
  return versions.getArtifactMeta(test.db, key);
}

describe("immutable artifact provenance and reviews", () => {
  it("records the first producer, unknown client version, and never overwrites attribution on dedup", () => {
    expect(meta()).toMatchObject({
      provenance: {
        principal_id: "producer",
        participant_id: "producer-session",
        created_at: 123,
        client_name: "test",
        client_version: null,
      },
      review: { state: "unreviewed", review_revision: 0 },
    });
    upsertPointer(test.db, { ...pointer, produced_at: 999 }, reviewer);
    expect(meta().provenance?.created_at).toBe(123);
    expect(meta().provenance?.principal_id).toBe("producer");
    expect(() =>
      test.db
        .update(schema.artifactPointers)
        .set({ provenance: null })
        .where(eq(schema.artifactPointers.r2_key, key))
        .run(),
    ).toThrow("immutable");
  });

  it("retains append-only history, rejects stale writes and idempotency conflicts, and never resurrects approvals", () => {
    const first = decide("trusted", 0, "first");
    expect(decide("trusted", 0, "first")).toEqual(first);
    expect(() => decide("rejected", 0, "first")).toThrow("different input");
    expect(() => decide("rejected", 0)).toThrow("Review changed");
    expect(decide("rejected", 1).review.state).toBe("rejected");
    expect(decide("superseded", 2).review.state).toBe("superseded");
    expect(decide("revoked", 3).review).toMatchObject({
      state: "unreviewed",
      review_revision: 4,
    });
    expect(decide("trusted", 0, "first")).toEqual(first);
    expect(meta().review?.state).toBe("unreviewed");
    const page = listArtifactReviews(test.db, key, { limit: 2 });
    expect(page.items.map((e) => e.review_revision)).toEqual([4, 3]);
    if (page.next_revision === null) throw new Error("Missing history cursor");
    expect(
      listArtifactReviews(test.db, key, {
        before_revision: page.next_revision,
      }).items.map((e) => e.review_revision),
    ).toEqual([2, 1]);
    expect(
      test.db
        .select()
        .from(schema.journal)
        .all()
        .filter((e) => e.kind === "artifact.reviewed"),
    ).toHaveLength(4);
    expect(() => test.db.delete(schema.artifactReviews).run()).toThrow(
      "immutable",
    );
    expect(() =>
      test.db.update(schema.artifactReviews).set({ decision: "trusted" }).run(),
    ).toThrow("immutable");
  });

  it("allows self-review and replacement by another writer, without automatic supersession", () => {
    reviewArtifact(
      test.db,
      key,
      { decision: "trusted", expected_review_revision: 0 },
      producer,
      "self",
    );
    upsertPointer(
      test.db,
      { ...pointer, r2_key: "sources/new.txt", sha256: "b".repeat(64) },
      producer,
    );
    expect(
      listPointers(test.db, {}).find((p) => p.r2_key === key)?.review?.state,
    ).toBe("trusted");
    expect(decide("rejected", 1).review.latest?.principal_id).toBe("reviewer");
  });

  it("keeps metadata after tombstoning and rejects keys absent from the project", () => {
    decide("trusted", 0);
    tombstonePointer(test.db, key, producer);
    confirmBlobDeleted(test.db, key);
    expect(deleteTombstonedPointers(test.db, Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(listArtifactReviews(test.db, key).items).toHaveLength(1);
    expect(meta().review?.state).toBe("trusted");
    expect(meta().provenance?.principal_id).toBe("producer");
    expect(() =>
      reviewArtifact(
        test.db,
        "other/project.txt",
        { decision: "trusted", expected_review_revision: 0 },
        reviewer,
        "other",
      ),
    ).toThrow("not found");
  });

  it("represents legacy producer identity as unknown and still allows explicit review", () => {
    test.db
      .insert(schema.artifactPointers)
      .values({ ...pointer, r2_key: "legacy/file.txt" })
      .run();
    expect(
      artifactTrustByKeys(test.db, ["legacy/file.txt"]).get("legacy/file.txt"),
    ).toMatchObject({ provenance: null, review: { state: "unreviewed" } });
    expect(
      reviewArtifact(
        test.db,
        "legacy/file.txt",
        { decision: "trusted", expected_review_revision: 0 },
        reviewer,
        "legacy",
      ).review.state,
    ).toBe("trusted");
  });

  it.each([
    { deduplicated: false, restored_from: null, principal: "producer" },
    { deduplicated: true, restored_from: null, principal: null },
    {
      deduplicated: false,
      restored_from: "sources/original.txt",
      principal: null,
    },
  ])(
    "recovers old records without attributing deduplication or restoration to the producer: %j",
    ({ deduplicated, restored_from, principal }) => {
      const revisionKey = `versioned/p/evidence/1/${pointer.sha256}.txt`;
      versions.reconcileArtifactCommit(
        test.db,
        {
          format: "tila-artifact-revision-v1",
          project_id: "p",
          operation_id: "old-record",
          request_hash: "old-request",
          lineage_fence: 1,
          origin: producer,
          deduplicated,
          pointer: {
            ...pointer,
            r2_key: revisionKey,
            lineage_id: "evidence",
            revision: 1,
            restored_from,
            tombstoned: 0,
            tags: [],
          },
        },
        "p",
      );
      const recovered = versions.getArtifactMeta(test.db, revisionKey);
      expect(recovered.provenance?.principal_id ?? null).toBe(principal);
      expect(recovered.review?.state).toBe("unreviewed");
      expect(recovered.revision_creation?.principal_id ?? null).toBe(
        deduplicated ? null : "producer",
      );
    },
  );

  it("preserves producer provenance across restore chains but starts each revision unreviewed", () => {
    decide("trusted", 0);
    const fence = acquire(
      test.db,
      "artifact:evidence",
      reviewer,
      "exclusive",
      60_000,
    ).fence;
    function restore(source: string, id: string) {
      versions.reserveArtifactRevision(
        test.db,
        {
          project_id: "p",
          operation_id: id,
          request_hash: id,
          lineage_id: "evidence",
          lineage_fence: fence,
          kind: "report",
          resource: null,
          sha256: pointer.sha256,
          bytes: 3,
          mime_type: "text/plain",
          fence: null,
          restored_from: source,
          adopt: source === key,
        },
        reviewer,
      );
      versions.acceptArtifactRevision(test.db, id);
      return versions.publishArtifactRevision(test.db, id);
    }
    const restored = restore(key, "restore");
    const next = restore(restored.key, "restore-again");
    expect(next.pointer.provenance).toEqual(meta().provenance);
    expect(next.pointer.revision_creation?.principal_id).toBe("reviewer");
    expect(next.pointer.review?.state).toBe("unreviewed");
    const operation = versions.getRevisionOperation(test.db, "restore-again");
    if (!operation) throw new Error("Missing restore operation");
    const record = versions.revisionRecord(operation);
    expect(record.pointer).not.toHaveProperty("review");
    const other = createTestDb();
    try {
      expect(() =>
        versions.reconcileArtifactCommit(other.db, record, "foreign"),
      ).toThrow("does not belong");
      versions.reconcileArtifactCommit(other.db, record, "p");
      expect(versions.getArtifactMeta(other.db, next.key)).toMatchObject({
        provenance: meta().provenance,
        review: { state: "unreviewed" },
      });
      reviewArtifact(
        other.db,
        next.key,
        { decision: "trusted", expected_review_revision: 0 },
        reviewer,
        "archived-review",
      );
      // Simulate revision metadata retained by main's lifecycle after pointer GC.
      other.db
        .delete(schema.artifactPointers)
        .where(eq(schema.artifactPointers.r2_key, next.key))
        .run();
      expect(versions.getArtifactMeta(other.db, next.key).review?.state).toBe(
        "trusted",
      );
      expect(listArtifactReviews(other.db, next.key).items).toHaveLength(1);
      expect(
        reviewArtifact(
          other.db,
          next.key,
          { decision: "revoked", expected_review_revision: 1 },
          reviewer,
          "archived-revoke",
        ).review.state,
      ).toBe("unreviewed");
    } finally {
      other.rawDb.close();
    }
  });
});

describe("task review policies", () => {
  beforeEach(() => {
    applySchema(
      test.db,
      `schema_version = 1
[work_units.task.fields.status]
type = "enum"
values = ["open", "approved"]
[[work_units.task.references]]
name = "evidence"
kinds = ["report"]
multiple = true
require_trusted_for_statuses = ["approved"]
[artifacts.report]
[templates.finish.entities.task]
type = "task"
[templates.finish.entities.task.data]
status = "approved"
`,
      "test",
    );
    entities.create(
      test.db,
      { id: "T-1", type: "task", data: { status: "open" }, created_by: "test" },
      1,
      producer,
    );
  });
  function transition() {
    const fence = acquire(
      test.db,
      "task:T-1",
      producer,
      "exclusive",
      60_000,
    ).fence;
    return entities.update(
      test.db,
      "T-1",
      { status: "approved" },
      fence,
      producer,
    );
  }
  function attach(k = key) {
    test.db
      .insert(schema.entityArtifactReferences)
      .values({
        entity_id: "T-1",
        artifact_key: k,
        slot: "evidence",
        created_at: 1,
      })
      .run();
  }
  it("blocks absent references, unreviewed references and revoked reviews atomically", () => {
    expect(transition).toThrow("requires trusted");
    attach();
    expect(transition).toThrow("requires trusted");
    decide("trusted", 0);
    decide("revoked", 1);
    expect(transition).toThrow("requires trusted");
    expect(entities.get(test.db, "T-1")?.data.status).toBe("open");
    decide("trusted", 2);
    expect(transition().data.status).toBe("approved");
    decide("rejected", 3);
    expect(entities.get(test.db, "T-1")?.data.status).toBe("approved");
  });
  it("requires all references to be trusted and content to be available", () => {
    attach();
    decide("trusted", 0);
    upsertPointer(
      test.db,
      { ...pointer, r2_key: "sources/second.txt" },
      producer,
    );
    attach("sources/second.txt");
    expect(transition).toThrow("requires trusted");
    reviewArtifact(
      test.db,
      "sources/second.txt",
      { decision: "trusted", expected_review_revision: 0 },
      reviewer,
      "second",
    );
    test.db
      .update(schema.artifactPointers)
      .set({ expires_at: 1 })
      .where(eq(schema.artifactPointers.r2_key, key))
      .run();
    expect(transition).toThrow("requires trusted");
  });
  it("guards direct creation and template creation without partial writes", () => {
    expect(() =>
      entities.create(
        test.db,
        {
          id: "T-2",
          type: "task",
          data: { status: "approved" },
          created_by: "test",
        },
        1,
        producer,
      ),
    ).toThrow("requires trusted");
    expect(() =>
      instantiateTemplate(test.db, {
        templateName: "finish",
        rootId: "T-3",
        vars: {},
        origin: producer,
      }),
    ).toThrow("requires trusted");
    expect(test.db.select().from(schema.entities).all()).toHaveLength(1);
  });
});
