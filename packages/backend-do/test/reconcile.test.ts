import { artifactOps } from "@tila/ops-sqlite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "../../ops-sqlite/src";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

type OrphanBlob = artifactOps.OrphanBlob;
const { listPointers, reconcilePointers } = artifactOps;

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.sqlite.close();
});

describe("reconcilePointers", () => {
  it("reports 0 orphans when r2_blobs list is empty", () => {
    const { db } = testDb;
    const result = reconcilePointers(db, [], { actor: "test-actor" }, false);
    expect(result.orphans_found).toBe(0);
    expect(result.orphans_recovered).toBe(0);
    expect(result.orphans_unrecoverable).toBe(0);
    expect(result.details).toHaveLength(0);
  });

  it("reports orphan as skipped in dry-run mode", () => {
    const { db } = testDb;
    const orphans: OrphanBlob[] = [
      {
        key: "sources/def456.md",
        size: 200,
        metadata: {
          "tila-kind": "output",
          "tila-sha256": "def456",
          "tila-mime": "text/markdown",
          "tila-task": "",
        },
      },
    ];
    const result = reconcilePointers(
      db,
      orphans,
      { actor: "test-actor" },
      false,
    );
    expect(result.orphans_found).toBe(1);
    expect(result.orphans_recovered).toBe(0);
    expect(result.details[0].status).toBe("skipped");
  });

  it("recovers orphan when apply is true", () => {
    const { db } = testDb;
    const orphans: OrphanBlob[] = [
      {
        key: "sources/ghi789.md",
        size: 300,
        metadata: {
          "tila-kind": "output",
          "tila-sha256": "ghi789",
          "tila-mime": "text/markdown",
          "tila-task": "",
        },
      },
    ];
    const result = reconcilePointers(
      db,
      orphans,
      { actor: "test-actor" },
      true,
    );
    expect(result.orphans_recovered).toBe(1);
    expect(result.details[0].status).toBe("recovered");
    // Verify pointer was actually created
    const pointers = listPointers(db, {});
    const found = pointers.find((p) => p.r2_key === "sources/ghi789.md");
    expect(found).toBeDefined();
    expect(found?.kind).toBe("output");
  });

  it("reports unrecoverable when tila-kind metadata is missing", () => {
    const { db } = testDb;
    const orphans: OrphanBlob[] = [
      {
        key: "sources/jkl012.bin",
        size: 400,
        metadata: { "tila-sha256": "jkl012" }, // no tila-kind
      },
    ];
    const result = reconcilePointers(
      db,
      orphans,
      { actor: "test-actor" },
      true,
    );
    expect(result.orphans_unrecoverable).toBe(1);
    expect(result.details[0].status).toBe("unrecoverable");
    expect(result.details[0].reason).toContain("tila-kind");
  });

  it("emits artifact.reconciled journal event on recovery", () => {
    const { db } = testDb;
    const orphans: OrphanBlob[] = [
      {
        key: "sources/mno345.txt",
        size: 500,
        metadata: {
          "tila-kind": "source",
          "tila-sha256": "mno345",
          "tila-mime": "text/plain",
          "tila-task": "",
        },
      },
    ];
    reconcilePointers(db, orphans, { actor: "test-actor" }, true);
    // Check journal for artifact.reconciled event
    const journalRows = db
      .select()
      .from(schema.journal)
      .where(eq(schema.journal.kind, "artifact.reconciled"))
      .all();
    expect(journalRows.length).toBe(1);
    expect(journalRows[0].actor).toBe("test-actor");
  });

  it("creates artifact_search_docs row when search_body_text is provided", () => {
    const { db } = testDb;
    const orphans: OrphanBlob[] = [
      {
        key: "sources/search-test.md",
        size: 100,
        metadata: {
          "tila-kind": "output",
          "tila-sha256": "searchhash123",
          "tila-mime": "text/markdown",
          "tila-task": "",
        },
        search_title: "My Title",
        search_body_text: "searchable content for testing",
      },
    ];
    const result = reconcilePointers(
      db,
      orphans,
      { actor: "test-actor" },
      true,
    );
    expect(result.orphans_recovered).toBe(1);

    // Verify artifact_search_docs row was created
    const searchRows = db.select().from(schema.artifactSearchDocs).all();
    expect(searchRows.length).toBe(1);
    expect(searchRows[0].artifact_key).toBe("sources/search-test.md");
    expect(searchRows[0].title).toBe("My Title");
    expect(searchRows[0].body_text).toBe("searchable content for testing");
    expect(searchRows[0].tombstoned).toBe(0);
  });

  it("does not create artifact_search_docs row when search fields are absent", () => {
    const { db } = testDb;
    const orphans: OrphanBlob[] = [
      {
        key: "sources/no-search.bin",
        size: 200,
        metadata: {
          "tila-kind": "output",
          "tila-sha256": "nosearchhash",
          "tila-mime": "application/octet-stream",
          "tila-task": "",
        },
      },
    ];
    const result = reconcilePointers(
      db,
      orphans,
      { actor: "test-actor" },
      true,
    );
    expect(result.orphans_recovered).toBe(1);

    // Verify no search doc was created
    const searchRows = db.select().from(schema.artifactSearchDocs).all();
    expect(searchRows.length).toBe(0);
  });
});
