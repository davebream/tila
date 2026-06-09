import {
  MIGRATION_0001,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0011,
  MIGRATION_0013,
  MIGRATION_0018,
  artifactOps,
  runMigration0016,
  schema,
} from "@tila/ops-sqlite";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type OrphanBlob = artifactOps.OrphanBlob;
const { listPointers, reconcilePointers } = artifactOps;

// Cloudflare's SQLite fork supports COALESCE in PRIMARY KEY; standard SQLite does not.
// Replace the expression-based PK for unit testing.
const MIGRATION_0001_TEST = MIGRATION_0001.replace(
  "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
  "PRIMARY KEY (from_key, type)",
);

// artifact_pointers has a FK on resource -> entities(id).
// For reconcile tests we want to insert orphan blobs without a corresponding entity.
// We drop the FK constraint by removing it from the migration DDL.
// Instead, use resource=null (source artifacts) which have no FK dependency.
const MIGRATION_FOR_RECONCILE = MIGRATION_0001_TEST.replace(
  ",\n  FOREIGN KEY (resource) REFERENCES entities(id)",
  "",
);

function makeMigStorage(sqlite: InstanceType<typeof Database>) {
  return {
    sql: {
      exec<T>(statement: string, ...bindings: unknown[]) {
        if (/^\s*(SELECT|PRAGMA)\b/i.test(statement)) {
          return {
            toArray: () => sqlite.prepare(statement).all(...bindings) as T[],
          };
        }
        if (bindings.length > 0) {
          sqlite.prepare(statement).run(...bindings);
        } else {
          sqlite.exec(statement);
        }
        return { toArray: () => [] as T[] };
      },
    },
  };
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_FOR_RECONCILE);
  sqlite.exec(MIGRATION_0004);
  sqlite.exec(MIGRATION_0011);
  sqlite.exec(MIGRATION_0013);
  runMigration0016(makeMigStorage(sqlite));
  sqlite.exec(MIGRATION_0018); // entity_tags + artifact_tags tables
  return drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
}

function createTestDbWithSearch() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_FOR_RECONCILE);
  sqlite.exec(MIGRATION_0003);
  sqlite.exec(MIGRATION_0004);
  sqlite.exec(MIGRATION_0011);
  sqlite.exec(MIGRATION_0013);
  runMigration0016(makeMigStorage(sqlite));
  sqlite.exec(MIGRATION_0018); // entity_tags + artifact_tags tables
  return drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
}

describe("reconcilePointers", () => {
  it("reports 0 orphans when r2_blobs list is empty", () => {
    const db = createTestDb();
    const result = reconcilePointers(db, [], { actor: "test-actor" }, false);
    expect(result.orphans_found).toBe(0);
    expect(result.orphans_recovered).toBe(0);
    expect(result.orphans_unrecoverable).toBe(0);
    expect(result.details).toHaveLength(0);
  });

  it("reports orphan as skipped in dry-run mode", () => {
    const db = createTestDb();
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
    const db = createTestDb();
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
    const db = createTestDb();
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
    const db = createTestDb();
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
    const db = createTestDbWithSearch();
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
    const db = createTestDbWithSearch();
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
