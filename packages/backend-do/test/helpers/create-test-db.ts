/**
 * Shared test-database bootstrap helper.
 *
 * Extracts the migration-replay machinery that was originally inlined in
 * entity-artifact-tags-route.test.ts so that every DO test file can share a
 * single, consistent in-memory SQLite setup without copy-pasting.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type Migration,
  type MigrationStorage,
  schema,
} from "../../../ops-sqlite/src";

// ---------------------------------------------------------------------------
// Internal migration helpers (verbatim lift from entity-artifact-tags-route.test.ts)
// ---------------------------------------------------------------------------

// Patch COALESCE-based PK that standard SQLite does not support.
// NOTE: currently inert — the relationships PK is now (from_key, target, type)
// with no COALESCE — but retained verbatim/defensively in case a future
// migration re-introduces the pattern.
function patchMigration(sql: string): string {
  return sql.replace(
    "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
    "PRIMARY KEY (from_key, type)",
  );
}

function createMigrationStorage(
  sqlite: InstanceType<typeof Database>,
): MigrationStorage {
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
  };
}

function runMigration(
  sqlite: InstanceType<typeof Database>,
  migration: Migration,
) {
  if ("run" in migration) {
    migration.run(createMigrationStorage(sqlite));
    return;
  }
  sqlite.exec(patchMigration(migration.sql));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateTestDbOptions {
  foreignKeys?: "on" | "off";
}

export interface TestDb {
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
  sqlite: InstanceType<typeof Database>;
}

/**
 * Create an in-memory SQLite database with all DO migrations applied.
 *
 * Default: `foreignKeys = "off"` mirrors the DO runtime where FK enforcement
 * is disabled and explicit deletes are tested instead.
 */
export function createTestDb(opts: CreateTestDbOptions = {}): TestDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma(`foreign_keys = ${opts.foreignKeys === "on" ? "ON" : "OFF"}`);
  sqlite.exec(MIGRATION_BOOTSTRAP);
  for (const migration of MIGRATIONS) {
    runMigration(sqlite, migration);
  }
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
