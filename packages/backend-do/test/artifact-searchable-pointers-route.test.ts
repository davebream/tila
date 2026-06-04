import Database from "better-sqlite3";
/**
 * Tests for GET /artifact/searchable-pointers DO route (C6).
 *
 * This route exposes listSearchablePointers to the Worker's reconcile route,
 * which uses it to cross-check R2 blob existence for searchable pointers.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATION_0001,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0011,
  MIGRATION_0016,
  artifactOps,
  runMigration0016,
  schema,
} from "../../ops-sqlite/src";
import { createArtifactRoutes } from "../src/routes/artifact-routes";
import type { RouterDeps } from "../src/routes/types";

const MIGRATION_0001_TEST = MIGRATION_0001.replace(
  "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
  "PRIMARY KEY (from_key, type)",
).replace(",\n  FOREIGN KEY (resource) REFERENCES entities(id)", "");

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_0001_TEST);
  sqlite.exec(MIGRATION_0003);
  sqlite.exec(MIGRATION_0004);
  sqlite.exec(MIGRATION_0011);
  sqlite.exec(
    "ALTER TABLE journal ADD COLUMN source TEXT DEFAULT NULL; ALTER TABLE journal ADD COLUMN source_version TEXT DEFAULT NULL;",
  );
  // Apply migration 0016 (tombstoned_at column)
  runMigration0016({
    sql: {
      exec<T>(statement: string) {
        if (/^\s*(SELECT|PRAGMA)\b/i.test(statement)) {
          return { toArray: () => sqlite.prepare(statement).all() as T[] };
        }
        sqlite.exec(statement);
        return { toArray: () => [] as T[] };
      },
    },
  });
  const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, sqlite };
}

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: vi.fn() as RouterDeps["enrichOpts"],
  };
}

let rawDb: InstanceType<typeof Database>;
let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;

beforeEach(() => {
  const testDb = createTestDb();
  rawDb = testDb.sqlite;
  db = testDb.db;
});

afterEach(() => {
  rawDb.close();
});

function insertPointer(r2Key: string, tombstoned = 0): void {
  rawDb
    .prepare(
      `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned)
       VALUES(?, NULL, 'output', 'sha-abc', 100, NULL, 'text/markdown', ${Date.now()}, 'test', NULL, ?)`,
    )
    .run(r2Key, tombstoned);
}

function insertSearchDoc(artifactKey: string, tombstoned = 0): void {
  db.run(
    sql`INSERT INTO artifact_search_docs(artifact_key, kind, mime_type, resource, title, body_text, indexed_at, source_sha256, tombstoned)
        VALUES(${artifactKey}, ${"output"}, ${"text/markdown"}, ${null}, ${"T"}, ${"B"}, ${Date.now()}, ${"sha-abc"}, ${tombstoned})`,
  );
}

describe("GET /artifact/searchable-pointers", () => {
  it("returns empty pointers array when no searchable pointers exist", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/searchable-pointers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pointers: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.pointers).toHaveLength(0);
  });

  it("returns searchable pointers with required columns", async () => {
    insertPointer("produced/a/doc.md");
    insertSearchDoc("produced/a/doc.md");

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/searchable-pointers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      pointers: Array<{
        r2_key: string;
        resource: string | null;
        kind: string;
        sha256: string;
      }>;
    };
    expect(body.pointers).toHaveLength(1);
    expect(body.pointers[0].r2_key).toBe("produced/a/doc.md");
    expect(body.pointers[0].kind).toBe("output");
    expect(body.pointers[0].sha256).toBe("sha-abc");
  });

  it("excludes tombstoned pointers", async () => {
    insertPointer("produced/b/dead.md", 1);
    insertSearchDoc("produced/b/dead.md");

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/searchable-pointers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pointers: unknown[] };
    expect(body.pointers).toHaveLength(0);
  });

  it("excludes pointers with no search doc", async () => {
    insertPointer("produced/c/nosearch.bin");
    // No search doc

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/searchable-pointers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pointers: unknown[] };
    expect(body.pointers).toHaveLength(0);
  });

  it("respects limit query parameter", async () => {
    for (let i = 0; i < 5; i++) {
      insertPointer(`produced/${i}/doc.md`);
      insertSearchDoc(`produced/${i}/doc.md`);
    }

    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/artifact/searchable-pointers?limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pointers: unknown[] };
    expect(body.pointers).toHaveLength(2);
  });
});
