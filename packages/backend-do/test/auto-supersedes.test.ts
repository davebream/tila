import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATION_0001,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0011,
  artifactOps,
  schema,
} from "../../ops-sqlite/src";

const { upsertPointer } = artifactOps;

// Cloudflare's SQLite fork supports COALESCE in PRIMARY KEY; standard SQLite does not.
const MIGRATION_0001_TEST = MIGRATION_0001.replace(
  "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
  "PRIMARY KEY (from_key, type)",
);

// Drop FK on resource -> entities(id) so we can insert pointers without entities
const MIGRATION_FOR_TEST = MIGRATION_0001_TEST.replace(
  ",\n  FOREIGN KEY (resource) REFERENCES entities(id)",
  "",
);

interface TestDb {
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
  sqlite: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_FOR_TEST);
  sqlite.exec(MIGRATION_0003); // artifact search docs + FTS5
  sqlite.exec(MIGRATION_0004); // journal.token_id column
  sqlite.exec(MIGRATION_0011); // content_inline column
  sqlite.exec(
    "ALTER TABLE journal ADD COLUMN source TEXT DEFAULT NULL; ALTER TABLE journal ADD COLUMN source_version TEXT DEFAULT NULL;",
  );
  const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, sqlite };
}

function makePointer(overrides?: Partial<Parameters<typeof upsertPointer>[1]>) {
  return {
    r2_key: `keys/${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
    resource: "task-1",
    kind: "plan",
    sha256: `sha${Date.now()}${Math.random()}`,
    bytes: 100,
    fence: null,
    mime_type: "text/markdown",
    produced_at: Date.now(),
    produced_by: "test-machine",
    expires_at: null,
    ...overrides,
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

// ---------------------------------------------------------------------------
// auto-supersedes tests
// ---------------------------------------------------------------------------

describe("upsertPointer with autoSupersedes=true", () => {
  it("creates a supersedes relationship to an existing pointer", () => {
    const old = makePointer({ r2_key: "keys/old.md", sha256: "sha_old" });
    const newPtr = makePointer({ r2_key: "keys/new.md", sha256: "sha_new" });

    upsertPointer(db, old, { actor: "agent" });
    upsertPointer(db, newPtr, { actor: "agent" }, undefined, null, true);

    const rows = rawDb
      .prepare(
        "SELECT from_key, to_key, type, target FROM artifact_relationships WHERE type = 'supersedes'",
      )
      .all() as Array<{
      from_key: string;
      to_key: string;
      type: string;
      target: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].from_key).toBe("keys/new.md");
    expect(rows[0].to_key).toBe("keys/old.md");
    expect(rows[0].type).toBe("supersedes");
    // target must equal to_key (NOT NULL)
    expect(rows[0].target).toBe("keys/old.md");
  });

  it("does NOT create a relationship when autoSupersedes=false (default)", () => {
    const old = makePointer({ r2_key: "keys/old2.md", sha256: "sha_old2" });
    const newPtr = makePointer({ r2_key: "keys/new2.md", sha256: "sha_new2" });

    upsertPointer(db, old, { actor: "agent" });
    upsertPointer(db, newPtr, { actor: "agent" }); // no autoSupersedes param

    const rows = rawDb
      .prepare(
        "SELECT COUNT(*) as cnt FROM artifact_relationships WHERE type = 'supersedes'",
      )
      .get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  it("does NOT create a relationship when resource is null", () => {
    const source = makePointer({
      r2_key: "sources/src.md",
      sha256: "sha_src",
      resource: null,
    });
    const newSource = makePointer({
      r2_key: "sources/src2.md",
      sha256: "sha_src2",
      resource: null,
    });

    upsertPointer(db, source, { actor: "agent" });
    upsertPointer(db, newSource, { actor: "agent" }, undefined, null, true);

    const rows = rawDb
      .prepare(
        "SELECT COUNT(*) as cnt FROM artifact_relationships WHERE type = 'supersedes'",
      )
      .get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  it("handles re-upload of same content (no duplicate relationships)", () => {
    const pointer = makePointer({ r2_key: "keys/same.md", sha256: "sha_same" });

    upsertPointer(db, pointer, { actor: "agent" });
    // Re-upload same r2_key — INSERT OR IGNORE on pointer is a no-op,
    // auto-supersedes query finds 0 other pointers with different r2_key
    upsertPointer(db, pointer, { actor: "agent" }, undefined, null, true);

    const rows = rawDb
      .prepare(
        "SELECT COUNT(*) as cnt FROM artifact_relationships WHERE type = 'supersedes'",
      )
      .get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  it("fan-out: new pointer supersedes all existing pointers for same (kind, resource)", () => {
    const ptr1 = makePointer({ r2_key: "keys/v1.md", sha256: "sha_v1" });
    const ptr2 = makePointer({ r2_key: "keys/v2.md", sha256: "sha_v2" });
    const ptr3 = makePointer({ r2_key: "keys/v3.md", sha256: "sha_v3" });

    upsertPointer(db, ptr1, { actor: "agent" });
    upsertPointer(db, ptr2, { actor: "agent" });
    upsertPointer(db, ptr3, { actor: "agent" }, undefined, null, true);

    const rows = rawDb
      .prepare(
        "SELECT from_key, to_key FROM artifact_relationships WHERE type = 'supersedes' ORDER BY to_key",
      )
      .all() as Array<{ from_key: string; to_key: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.from_key === "keys/v3.md")).toBe(true);
    const targets = rows.map((r) => r.to_key).sort();
    expect(targets).toEqual(["keys/v1.md", "keys/v2.md"]);
  });

  it("INSERT OR IGNORE prevents duplicate supersedes on second call for same pair", () => {
    const old = makePointer({
      r2_key: "keys/dupold.md",
      sha256: "sha_dup_old",
    });
    const newPtr = makePointer({
      r2_key: "keys/dupnew.md",
      sha256: "sha_dup_new",
    });

    upsertPointer(db, old, { actor: "agent" });
    upsertPointer(db, newPtr, { actor: "agent" }, undefined, null, true);
    // Second upsert of same newPtr with autoSupersedes: same INSERT OR IGNORE → no duplicate
    upsertPointer(db, newPtr, { actor: "agent" }, undefined, null, true);

    const rows = rawDb
      .prepare(
        "SELECT COUNT(*) as cnt FROM artifact_relationships WHERE type = 'supersedes'",
      )
      .get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it("only supersedes pointers with same (kind, resource) pair", () => {
    const planPtr = makePointer({
      r2_key: "keys/plan-old.md",
      sha256: "sha_plan_old",
      kind: "plan",
      resource: "task-1",
    });
    const designPtr = makePointer({
      r2_key: "keys/design-old.md",
      sha256: "sha_design_old",
      kind: "design",
      resource: "task-1",
    });
    const planNew = makePointer({
      r2_key: "keys/plan-new.md",
      sha256: "sha_plan_new",
      kind: "plan",
      resource: "task-1",
    });

    upsertPointer(db, planPtr, { actor: "agent" });
    upsertPointer(db, designPtr, { actor: "agent" });
    upsertPointer(db, planNew, { actor: "agent" }, undefined, null, true);

    const rows = rawDb
      .prepare(
        "SELECT from_key, to_key FROM artifact_relationships WHERE type = 'supersedes'",
      )
      .all() as Array<{ from_key: string; to_key: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].from_key).toBe("keys/plan-new.md");
    expect(rows[0].to_key).toBe("keys/plan-old.md");
  });
});
