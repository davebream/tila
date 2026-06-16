import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "@tila/ops-sqlite";
import type { MigrationStorage } from "@tila/ops-sqlite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { journalOps, schema } from "../../ops-sqlite/src";

const { appendJournal, listJournal } = journalOps;
import {
  runProjectMigrations,
  validateProjectSchema,
} from "../src/migration-runner";

function patchMigration(sql: string): string {
  return sql.replace(
    "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
    "PRIMARY KEY (from_key, type)",
  );
}

function createStorage(
  sqlite: InstanceType<typeof Database>,
): MigrationStorage & { transactionSync<T>(callback: () => T): T } {
  return {
    sql: {
      exec<T>(statement: string, ...bindings: unknown[]) {
        const patched = patchMigration(statement);
        if (/^\s*(SELECT|PRAGMA)\b/i.test(patched)) {
          return {
            toArray: () => sqlite.prepare(patched).all(...bindings) as T[],
          };
        }
        if (bindings.length > 0) {
          sqlite.prepare(patched).run(...bindings);
        } else {
          sqlite.exec(patched);
        }
        return { toArray: () => [] as T[] };
      },
    },
    transactionSync<T>(callback: () => T): T {
      return sqlite.transaction(callback)();
    },
  };
}

function versions(sqlite: InstanceType<typeof Database>): number[] {
  return (
    sqlite
      .prepare("SELECT version FROM _migrations ORDER BY version")
      .all() as { version: number }[]
  ).map((r) => r.version);
}

function columns(
  sqlite: InstanceType<typeof Database>,
  table: string,
): string[] {
  return (
    sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

function indexes(sqlite: InstanceType<typeof Database>): string[] {
  return (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("migration runner", () => {
  it("applies all migrations on a fresh database", () => {
    const sqlite = new Database(":memory:");
    runProjectMigrations(createStorage(sqlite));

    expect(versions(sqlite)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);

    const tableNames = (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);

    expect(tableNames).toContain("entities");
    expect(tableNames).toContain("_migrations");
    expect(tableNames).toContain("_schema_history");
    expect(tableNames).toContain("artifact_search_docs");
    expect(tableNames).toContain("entity_search_docs");
    expect(tableNames).toContain("gates");
    expect(tableNames).toContain("signals");
    expect(tableNames).toContain("records");
    expect(tableNames).toContain("record_tags");
    expect(tableNames).toContain("record_revisions");
    expect(tableNames).toContain("record_search_docs");
    expect(tableNames).toContain("_journal_archive_watermark");
    expect(indexes(sqlite)).toEqual(
      expect.arrayContaining([
        "idx_entity_relationships_to_id_type",
        "idx_presence_last_seen",
      ]),
    );
  });

  it("skips already-applied migrations on repeated cold starts", () => {
    const sqlite = new Database(":memory:");
    const storage = createStorage(sqlite);
    runProjectMigrations(storage);
    runProjectMigrations(storage);

    expect(versions(sqlite)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  it("backfills versions for pre-existing DOs", () => {
    const sqlite = new Database(":memory:");
    runProjectMigrations(createStorage(sqlite));
    sqlite.exec("DROP TABLE _migrations");

    runProjectMigrations(createStorage(sqlite));

    expect(versions(sqlite)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  it("applies only pending migrations when partially applied", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(MIGRATION_BOOTSTRAP);
    const migration1 = MIGRATIONS[0];
    if (!("sql" in migration1)) {
      throw new Error("migration 1 must be SQL");
    }
    sqlite.exec(patchMigration(migration1.sql));
    sqlite
      .prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)")
      .run(1, Date.now());

    runProjectMigrations(createStorage(sqlite));

    expect(versions(sqlite)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  it("recovers when column-add migrations applied but were not recorded", () => {
    const sqlite = new Database(":memory:");
    runProjectMigrations(createStorage(sqlite));
    sqlite
      .prepare("DELETE FROM _migrations WHERE version IN (2, 4, 10, 13)")
      .run();

    expect(() => runProjectMigrations(createStorage(sqlite))).not.toThrow();
    expect(versions(sqlite)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(columns(sqlite, "claims")).toEqual(
      expect.arrayContaining(["holder", "machine", "user"]),
    );
    expect(columns(sqlite, "journal")).toContain("token_id");
    expect(columns(sqlite, "_schema_history")).toEqual(
      expect.arrayContaining(["change_summary", "strategy"]),
    );
  });

  it("rolls back a migration when version recording fails", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
CREATE TABLE _migrations (
  version INTEGER PRIMARY KEY CHECK(version != 4),
  applied_at INTEGER NOT NULL
);
`);

    expect(() => runProjectMigrations(createStorage(sqlite))).toThrow(
      /CHECK constraint failed/,
    );
    expect(versions(sqlite)).toEqual([1, 2, 3]);
    expect(columns(sqlite, "journal")).not.toContain("token_id");
  });

  it("throws descriptive schema validation errors", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
CREATE TABLE claims (
  resource TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  mode TEXT NOT NULL,
  fence INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);
`);

    expect(() => validateProjectSchema(createStorage(sqlite))).toThrow(
      /claims missing columns: machine, user/,
    );
  });

  it("migration 13 adds source and source_version columns to journal", () => {
    const sqlite = new Database(":memory:");
    runProjectMigrations(createStorage(sqlite));

    expect(columns(sqlite, "journal")).toContain("source");
    expect(columns(sqlite, "journal")).toContain("source_version");
  });

  it("migration 18 creates entity_tags and artifact_tags tables with tag indexes", () => {
    const sqlite = new Database(":memory:");
    runProjectMigrations(createStorage(sqlite));

    const tableNames = (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);

    expect(tableNames).toContain("entity_tags");
    expect(tableNames).toContain("artifact_tags");

    const indexNames = (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((i) => i.name);

    expect(indexNames).toContain("idx_entity_tags_tag");
    expect(indexNames).toContain("idx_artifact_tags_tag");

    // Verify columns of entity_tags
    const entityTagsCols = (
      sqlite.prepare("PRAGMA table_info(entity_tags)").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(entityTagsCols).toContain("entity_id");
    expect(entityTagsCols).toContain("tag");

    // Verify columns of artifact_tags
    const artifactTagsCols = (
      sqlite.prepare("PRAGMA table_info(artifact_tags)").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(artifactTagsCols).toContain("artifact_key");
    expect(artifactTagsCols).toContain("tag");
  });

  it("migration 13 is idempotent when columns already exist", () => {
    const sqlite = new Database(":memory:");
    runProjectMigrations(createStorage(sqlite));
    // Remove version 13 from _migrations so the runner will re-run it
    sqlite.prepare("DELETE FROM _migrations WHERE version = 13").run();

    expect(() => runProjectMigrations(createStorage(sqlite))).not.toThrow();
    expect(columns(sqlite, "journal")).toContain("source");
    expect(columns(sqlite, "journal")).toContain("source_version");
  });

  it("appendJournal writes source fields and listJournal reads them back", () => {
    const sqlite = new Database(":memory:");
    runProjectMigrations(createStorage(sqlite));
    const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
      "sync",
      unknown,
      typeof schema
    >;

    sqlite.transaction(() => {
      // Insert entity required by journal resource field
      sqlite
        .prepare(
          "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES ('res1', 'task', 1, '{}', 0, 1, 1, 'test')",
        )
        .run();
    })();

    // Entry with source fields
    db.transaction((tx) => {
      appendJournal(tx, {
        kind: "entity.created",
        resource: "res1",
        actor: "agent",
        source: "sdk",
        sourceVersion: "0.3.1",
      });
    });

    // Entry without source fields
    db.transaction((tx) => {
      appendJournal(tx, {
        kind: "entity.updated",
        resource: "res1",
        actor: "agent",
      });
    });

    const entries = listJournal(db, { resource: "res1" });
    expect(entries).toHaveLength(2);

    // listJournal returns entries in descending seq order
    const withSource = entries.find((e) => e.kind === "entity.created");
    const withoutSource = entries.find((e) => e.kind === "entity.updated");

    expect(withSource?.source).toBe("sdk");
    expect(withSource?.source_version).toBe("0.3.1");
    expect(withoutSource?.source).toBeNull();
    expect(withoutSource?.source_version).toBeNull();
  });
});
