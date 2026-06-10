import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDED_MIGRATIONS,
  type MigrationStorage,
  runEmbeddedMigrations,
} from "@tila/backend-embedded";
import { artifactOps, entityOps, relationshipOps } from "@tila/ops-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalConnection } from "../src/connection";

/**
 * These tests pin the post-Task-4 behavior of the local (bun:sqlite) backend
 * once it delegates migrations to `@tila/backend-embedded`. They cover the
 * schema-identity guarantees that the existing suite (which has zero record
 * coverage and pre-dated the canonical-reuse restructure) cannot detect.
 */

/** A raw bun:sqlite-backed MigrationStorage, mirroring connection.ts. */
function bunStorage(rawDb: Database): MigrationStorage {
  return {
    sql: {
      exec<T>(statement: string, ...bindings: unknown[]) {
        const trimmed = statement.trim();
        if (/^(SELECT|PRAGMA)\b/i.test(trimmed)) {
          return {
            toArray: () =>
              rawDb.query(statement).all(...(bindings as never[])) as T[],
          };
        }
        if (bindings.length > 0) {
          rawDb.query(statement).run(...(bindings as never[]));
        } else {
          rawDb.exec(statement);
        }
        return { toArray: () => [] as T[] };
      },
    },
  };
}

function tableInfo(rawDb: Database, table: string): string[] {
  return (
    rawDb.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

function appliedVersions(rawDb: Database): number[] {
  return (
    rawDb.query("SELECT version FROM _migrations ORDER BY version").all() as {
      version: number;
    }[]
  ).map((r) => r.version);
}

describe("embedded migration set on a fresh local DB (Step 4)", () => {
  let tempDir: string;
  let db: ReturnType<typeof createLocalConnection>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-emig-"));
    db = createLocalConnection(join(tempDir, "fresh.db"), "o", "p", {
      skipFilesystemCheck: true,
    });
  });

  afterEach(() => {
    db.$client.close();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("(a) record_revisions has the v14 columns (token_id, source, source_version)", () => {
    const cols = tableInfo(db.$client, "record_revisions");
    expect(cols).toContain("token_id");
    expect(cols).toContain("source");
    expect(cols).toContain("source_version");
  });

  it("(b) _migrations contains every embedded version incl. 14 and excl. 15", () => {
    const tracked = appliedVersions(db.$client);
    const expected = EMBEDDED_MIGRATIONS.map((m) => m.version).sort(
      (a, b) => a - b,
    );
    // Versions tracked in _migrations, NOT PRAGMA user_version.
    expect(tracked).toEqual(expected);
    expect(tracked).toContain(14);
    expect(tracked).not.toContain(15);
    expect(tracked).toContain(1000); // idempotency overlay
  });

  it("(c) artifact_relationships carries the canonical `target` column + PK (from_key, target, type)", () => {
    const cols = tableInfo(db.$client, "artifact_relationships");
    expect(cols).toContain("target");

    // PK columns, in order, from PRAGMA table_info (pk > 0 => member, value = position).
    const pk = (
      db.$client.query("PRAGMA table_info(artifact_relationships)").all() as {
        name: string;
        pk: number;
      }[]
    )
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);
    expect(pk).toEqual(["from_key", "target", "type"]);
  });
});

describe("retroactive v14 upgrade of an existing local DB (Step 4b / R6)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-emig-v14-"));
    dbPath = join(tempDir, "old.db");
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("applies v14 retroactively, records version 14, and is idempotent on re-run", () => {
    // 1. Build a fully-migrated DB, then simulate a DB written by a CLI that
    //    shipped the embedded set MINUS v14: drop the v14 columns and delete the
    //    v14 _migrations row. record_revisions then lacks the v14 columns.
    const raw = new Database(dbPath, { create: true });
    raw.exec("PRAGMA foreign_keys=ON;");
    runEmbeddedMigrations(bunStorage(raw));

    // Rebuild record_revisions WITHOUT the v14 columns (SQLite can't DROP COLUMN
    // on older engines reliably, so recreate the table at its pre-v14 shape).
    raw.exec("DROP TABLE record_revisions");
    raw.exec(`
      CREATE TABLE record_revisions (
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        value TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        message TEXT,
        operation TEXT NOT NULL,
        fence INTEGER,
        schema_version INTEGER NOT NULL,
        actor TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        source_artifact_key TEXT,
        canonical_artifact_key TEXT,
        PRIMARY KEY (type, key, revision)
      )
    `);
    raw.exec("DELETE FROM _migrations WHERE version = 14");

    // Precondition: columns absent, version untracked.
    expect(tableInfo(raw, "record_revisions")).not.toContain("token_id");
    expect(appliedVersions(raw)).not.toContain(14);

    // 2. Re-run the embedded migrations — v14 should apply now.
    runEmbeddedMigrations(bunStorage(raw));

    const cols = tableInfo(raw, "record_revisions");
    expect(cols).toContain("token_id");
    expect(cols).toContain("source");
    expect(cols).toContain("source_version");
    expect(appliedVersions(raw)).toContain(14);

    // 3. A second run is a clean no-op (no double-apply / duplicate-column error).
    expect(() => runEmbeddedMigrations(bunStorage(raw))).not.toThrow();
    expect(appliedVersions(raw).filter((v) => v === 14).length).toBe(1);

    raw.close();
  });
});

describe("OLD-style local DB version-reshuffle (Step 4c — KNOWN LIMITATION)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-emig-old-"));
    dbPath = join(tempDir, "legacy.db");
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * The OLD CLI's `ALL_LOCAL_MIGRATIONS` recorded version 5 as the *idempotency*
   * table (canonically v5 is the `idx_er_to_id_type` index) and used a
   * `target`-less `artifact_relationships` for v1. We reconstruct that on-disk
   * shape, then run the embedded runner and DOCUMENT what happens: because both
   * v1 and v5 are already recorded, the runner SKIPS them, leaving the canonical
   * v5 index missing and `artifact_relationships` without the `target` column.
   *
   * Chosen path: DOCUMENT-AS-LIMITATION (not reconcile). Local mode is a
   * single-machine, disposable-state dev/edge feature; a clean re-create
   * (`tila init --local`) is the supported upgrade for pre-feature DBs. A
   * self-healing target-column backfill would mean diverging the shared runner
   * or special-casing version 1, which is higher risk than the value. Flag for
   * the Task 14 docs.
   */
  it("documents that an OLD-style DB is left target-less and missing the v5 index after re-migration", () => {
    const raw = new Database(dbPath, { create: true });
    raw.exec("PRAGMA foreign_keys=ON;");

    // --- Reconstruct the OLD local schema (target-less artifact_relationships). ---
    raw.exec(`
      CREATE TABLE entities (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, schema_version INTEGER NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT NOT NULL
      );
      CREATE TABLE entity_relationships (
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL,
        schema_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (from_id, to_id, type)
      );
      CREATE TABLE artifact_pointers (
        r2_key TEXT PRIMARY KEY CHECK(r2_key LIKE '%/%'), resource TEXT, kind TEXT NOT NULL,
        sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, fence INTEGER, mime_type TEXT NOT NULL,
        produced_at INTEGER NOT NULL, produced_by TEXT NOT NULL, expires_at INTEGER,
        tombstoned INTEGER NOT NULL DEFAULT 0, content_inline TEXT,
        FOREIGN KEY (resource) REFERENCES entities(id)
      );
      CREATE TABLE artifact_relationships (
        from_key TEXT NOT NULL, to_key TEXT, to_uri TEXT, type TEXT NOT NULL,
        metadata TEXT DEFAULT '{}', created_at INTEGER NOT NULL,
        PRIMARY KEY (from_key, type),
        FOREIGN KEY (from_key) REFERENCES artifact_pointers(r2_key)
      );
      CREATE TABLE _idempotency (
        key TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
        response_json TEXT NOT NULL, status_code INTEGER NOT NULL
      );
      -- v13 created record_revisions in the OLD set too, but WITHOUT the v14
      -- columns (token_id/source/source_version). Reproduce that pre-v14 shape.
      CREATE TABLE record_revisions (
        type TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
        value TEXT, tags TEXT NOT NULL DEFAULT '[]', message TEXT,
        operation TEXT NOT NULL, fence INTEGER, schema_version INTEGER NOT NULL,
        actor TEXT NOT NULL, created_at INTEGER NOT NULL,
        source_artifact_key TEXT, canonical_artifact_key TEXT,
        PRIMARY KEY (type, key, revision)
      );
    `);
    // OLD _migrations rows: version 5 == old idempotency table; NO 14, NO 15.
    raw.exec(`
      CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    `);
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18]) {
      raw.exec(
        `INSERT INTO _migrations (version, applied_at) VALUES (${v}, 0)`,
      );
    }

    // Precondition: target-less, no canonical v5 index.
    expect(tableInfo(raw, "artifact_relationships")).not.toContain("target");
    const idxBefore = raw
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_er_to_id_type'",
      )
      .get();
    expect(idxBefore).toBeNull();

    // --- Run the embedded runner against the OLD DB. ---
    runEmbeddedMigrations(bunStorage(raw));

    // DOCUMENTED CURRENT BEHAVIOR (the limitation):
    //  - v5 recorded => canonical idx_er_to_id_type index is NOT created.
    const idxAfter = raw
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_er_to_id_type'",
      )
      .get();
    expect(idxAfter).toBeNull();

    //  - v1 recorded => artifact_relationships still LACKS the `target` column.
    //    This is the load-bearing limitation: shared ops that write `target`
    //    (upsertPointer autoSupersedes, insertArtifactRelationship) will fail on
    //    such a DB until it is re-created.
    expect(tableInfo(raw, "artifact_relationships")).not.toContain("target");

    //  - v14 DID apply (record_revisions existed via v13): the v14 columns are
    //    now present and version 14 is recorded. So records work on an upgraded
    //    old DB; only the v1/v5 reshuffle items are stale.
    expect(tableInfo(raw, "record_revisions")).toContain("token_id");
    expect(appliedVersions(raw)).toContain(14);

    //  => Supported remedy for the stale v1/v5 items is to re-create the local
    //     DB via `tila init --local` (disposable single-machine state).
    raw.close();
  });
});

describe("real-driver schema parity: shared ops write `target` (Step 4d)", () => {
  let tempDir: string;
  let db: ReturnType<typeof createLocalConnection>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-emig-4d-"));
    db = createLocalConnection(join(tempDir, "parity.db"), "o", "p", {
      skipFilesystemCheck: true,
    });
  });

  afterEach(() => {
    db.$client.close();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("upsertPointer(autoSupersedes) writes a `target`-bearing supersedes row and insertArtifactRelationship round-trips", () => {
    const origin = {
      actor: "local",
      tokenId: null,
      source: null,
      sourceVersion: null,
    };

    // artifact_pointers.resource → entities(id) FK (foreign_keys=ON): create it.
    entityOps.create(
      db,
      { id: "task-1", type: "task", data: { status: "open" }, created_by: "t" },
      1,
      { actor: "t" },
    );

    const base = {
      resource: "task-1",
      kind: "report",
      sha256: "a".repeat(64),
      bytes: 3,
      fence: null,
      mime_type: "text/plain",
      produced_at: Date.now(),
      produced_by: "local",
      expires_at: null,
    };

    // First pointer (no prior chain — nothing to supersede yet).
    artifactOps.upsertPointer(
      db,
      { ...base, r2_key: "o/p/aaa.txt" },
      origin,
      undefined,
      null,
      true,
    );

    // Second pointer with autoSupersedes=true => INSERT into artifact_relationships
    // with the `target` column. This throws "no column named target" if the
    // canonical-reuse schema were missing the column.
    expect(() =>
      artifactOps.upsertPointer(
        db,
        { ...base, r2_key: "o/p/bbb.txt", sha256: "b".repeat(64) },
        origin,
        undefined,
        null,
        true,
      ),
    ).not.toThrow();

    const supersedes = relationshipOps.listArtifactRelationships(db, {
      from_key: "o/p/bbb.txt",
    });
    expect(supersedes).toHaveLength(1);
    expect(supersedes[0]).toMatchObject({
      from_key: "o/p/bbb.txt",
      to_key: "o/p/aaa.txt",
      type: "supersedes",
    });

    // insertArtifactRelationship also writes `target` (= to_uri here). Must not throw.
    expect(() =>
      relationshipOps.insertArtifactRelationship(
        db,
        {
          from_key: "o/p/bbb.txt",
          to_uri: "https://example.com/x",
          type: "derived-from",
        },
        "local",
      ),
    ).not.toThrow();

    const derived = relationshipOps.listArtifactRelationships(db, {
      from_key: "o/p/bbb.txt",
      type: "derived-from",
    });
    expect(derived).toHaveLength(1);
    expect(derived[0].to_uri).toBe("https://example.com/x");
  });
});
