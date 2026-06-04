import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reindexBatch, resetEntitySearchDocs } from "../src/search-reindex-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

// Helpers for inserting test data without triggering search doc creation
function insertArtifact(
  rawDb: TestDb["rawDb"],
  r2_key: string,
  kind = "report",
) {
  rawDb
    .prepare(
      `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, tombstoned)
       VALUES(?, NULL, ?, 'abc123', 100, NULL, 'text/plain', 1000, 'test', 0)`,
    )
    .run(r2_key, kind);
}

function insertArtifactSearchDoc(rawDb: TestDb["rawDb"], r2_key: string) {
  rawDb
    .prepare(
      `INSERT OR IGNORE INTO artifact_search_docs(artifact_key, kind, mime_type, resource, title, body_text, indexed_at, source_sha256, tombstoned)
       VALUES(?, 'report', 'text/plain', NULL, NULL, '', ${Date.now()}, 'abc123', 0)`,
    )
    .run(r2_key);
}

function insertEntity(rawDb: TestDb["rawDb"], id: string, type = "task") {
  rawDb
    .prepare(
      `INSERT INTO entities(id, type, schema_version, data, archived, created_at, updated_at, created_by)
       VALUES(?, ?, 1, '{}', 0, 1000, 1000, 'test')`,
    )
    .run(id, type);
}

function insertEntitySearchDoc(rawDb: TestDb["rawDb"], id: string) {
  rawDb
    .prepare(
      `INSERT OR IGNORE INTO entity_search_docs(entity_id, entity_type, name, indexed_at)
       VALUES(?, 'task', NULL, ${Date.now()})`,
    )
    .run(id);
}

function countArtifactDocs(rawDb: TestDb["rawDb"]): number {
  const row = rawDb
    .prepare("SELECT COUNT(*) as cnt FROM artifact_search_docs")
    .get() as { cnt: number };
  return row.cnt;
}

function countEntityDocs(rawDb: TestDb["rawDb"]): number {
  const row = rawDb
    .prepare("SELECT COUNT(*) as cnt FROM entity_search_docs")
    .get() as { cnt: number };
  return row.cnt;
}

describe("reindexBatch -- artifact", () => {
  it("processes artifacts in batches until done", () => {
    const { db, rawDb } = testDb;

    // Insert 5 artifact_pointers without search docs
    insertArtifact(rawDb, "artifacts/a1");
    insertArtifact(rawDb, "artifacts/a2");
    insertArtifact(rawDb, "artifacts/a3");
    insertArtifact(rawDb, "artifacts/a4");
    insertArtifact(rawDb, "artifacts/a5");

    // First batch: batchSize=2 -> processes 2
    const r1 = reindexBatch(db, { kind: "artifact", batchSize: 2 });
    expect(r1.done).toBe(false);
    expect(r1.processed).toBe(2);
    expect(countArtifactDocs(rawDb)).toBe(2);

    // Second batch: processes 2 more
    const r2 = reindexBatch(db, { kind: "artifact", batchSize: 2 });
    expect(r2.done).toBe(false);
    expect(r2.processed).toBe(2);
    expect(countArtifactDocs(rawDb)).toBe(4);

    // Third batch: processes 1 remaining
    const r3 = reindexBatch(db, { kind: "artifact", batchSize: 2 });
    expect(r3.done).toBe(true);
    expect(r3.processed).toBe(1);
    expect(countArtifactDocs(rawDb)).toBe(5);

    // Fourth batch: nothing to do
    const r4 = reindexBatch(db, { kind: "artifact", batchSize: 2 });
    expect(r4.done).toBe(true);
    expect(r4.processed).toBe(0);
  });
});

describe("reindexBatch -- entity", () => {
  it("processes entities in batches until done", () => {
    const { db, rawDb } = testDb;

    insertEntity(rawDb, "ent-1");
    insertEntity(rawDb, "ent-2");
    insertEntity(rawDb, "ent-3");

    const r1 = reindexBatch(db, { kind: "entity", batchSize: 2 });
    expect(r1.done).toBe(false);
    expect(r1.processed).toBe(2);
    expect(countEntityDocs(rawDb)).toBe(2);

    const r2 = reindexBatch(db, { kind: "entity", batchSize: 2 });
    expect(r2.done).toBe(true);
    expect(r2.processed).toBe(1);
    expect(countEntityDocs(rawDb)).toBe(3);

    const r3 = reindexBatch(db, { kind: "entity", batchSize: 2 });
    expect(r3.done).toBe(true);
    expect(r3.processed).toBe(0);
  });
});

describe("reindexBatch -- idempotency", () => {
  it("returns done=true with processed=0 when all artifacts already have search docs", () => {
    const { db, rawDb } = testDb;

    insertArtifact(rawDb, "artifacts/b1");
    insertArtifact(rawDb, "artifacts/b2");
    insertArtifact(rawDb, "artifacts/b3");
    insertArtifactSearchDoc(rawDb, "artifacts/b1");
    insertArtifactSearchDoc(rawDb, "artifacts/b2");
    insertArtifactSearchDoc(rawDb, "artifacts/b3");

    const r = reindexBatch(db, { kind: "artifact", batchSize: 10 });
    expect(r.done).toBe(true);
    expect(r.processed).toBe(0);
    // Count stays at 3 -- no new rows added
    expect(countArtifactDocs(rawDb)).toBe(3);
  });
});

describe("reindexBatch -- entity title extraction", () => {
  it("indexes entity title from data.title during reindex (issue #412)", () => {
    const { db, rawDb } = testDb;
    rawDb
      .prepare(
        `INSERT INTO entities(id, type, schema_version, data, archived, created_at, updated_at, created_by)
         VALUES('r1','task',1,'{"title":"Auth System"}',0,1000,1000,'test')`,
      )
      .run();
    const res = reindexBatch(db, { kind: "entity", batchSize: 50 });
    expect(res.processed).toBe(1);
    const row = rawDb
      .prepare("SELECT name FROM entity_search_docs WHERE entity_id = 'r1'")
      .get() as { name: string | null };
    expect(row.name).toBe("Auth System");
  });
});

describe("resetEntitySearchDocs -- full rebuild repairs stale rows", () => {
  it("repairs pre-existing NULL-name entity docs on full rebuild (issue #412)", () => {
    const { db, rawDb } = testDb;
    // Simulate pre-fix state: entity with a title, but a stale NULL-name search doc.
    rawDb
      .prepare(
        `INSERT INTO entities(id, type, schema_version, data, archived, created_at, updated_at, created_by)
         VALUES('e1','task',1,'{"title":"Auth System"}',0,1000,1000,'test')`,
      )
      .run();
    rawDb
      .prepare(
        `INSERT INTO entity_search_docs(entity_id, entity_type, name, indexed_at)
         VALUES('e1','task',NULL,1000)`,
      )
      .run();

    // Without reset, reindex skips e1 (already has a doc).
    expect(reindexBatch(db, { kind: "entity", batchSize: 50 }).processed).toBe(
      0,
    );

    // Reset + rebuild repairs it.
    resetEntitySearchDocs(db);
    reindexBatch(db, { kind: "entity", batchSize: 50 });
    const row = rawDb
      .prepare("SELECT name FROM entity_search_docs WHERE entity_id = 'e1'")
      .get() as { name: string | null };
    expect(row.name).toBe("Auth System");
  });
});

describe("reindexBatch -- mixed state", () => {
  it("processes only unindexed artifacts when some already have search docs", () => {
    const { db, rawDb } = testDb;

    // 5 artifacts total: 2 already indexed, 3 not
    insertArtifact(rawDb, "artifacts/c1");
    insertArtifact(rawDb, "artifacts/c2");
    insertArtifact(rawDb, "artifacts/c3");
    insertArtifact(rawDb, "artifacts/c4");
    insertArtifact(rawDb, "artifacts/c5");
    insertArtifactSearchDoc(rawDb, "artifacts/c1");
    insertArtifactSearchDoc(rawDb, "artifacts/c2");

    // All 3 unindexed processed in one batch
    const r1 = reindexBatch(db, { kind: "artifact", batchSize: 10 });
    expect(r1.done).toBe(true);
    expect(r1.processed).toBe(3);
    expect(countArtifactDocs(rawDb)).toBe(5);

    // No more work
    const r2 = reindexBatch(db, { kind: "artifact", batchSize: 10 });
    expect(r2.done).toBe(true);
    expect(r2.processed).toBe(0);
  });
});
