import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as entityOps from "../src/entity-ops";
import {
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type Migration,
  type MigrationStorage,
} from "../src/migrations-sql";
import * as schema from "../src/schema";

// Cloudflare's SQLite fork supports COALESCE in PRIMARY KEY; standard SQLite does not.
// Replace for testing (same pattern as backend-do test suite).
export function patchMigration(sql: string): string {
  return sql.replace(
    "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
    "PRIMARY KEY (from_key, type)",
  );
}

function createMigrationStorage(
  rawDb: InstanceType<typeof Database>,
): MigrationStorage {
  return {
    sql: {
      exec<T>(statement: string, ...bindings: unknown[]) {
        const patched = patchMigration(statement);
        if (/^\s*(SELECT|PRAGMA)\b/i.test(patched)) {
          return {
            toArray: () => rawDb.prepare(patched).all(...bindings) as T[],
          };
        }
        if (bindings.length > 0) {
          rawDb.prepare(patched).run(...bindings);
        } else {
          rawDb.exec(patched);
        }
        return { toArray: () => [] as T[] };
      },
    },
  };
}

function runMigration(
  rawDb: InstanceType<typeof Database>,
  migration: Migration,
) {
  if ("run" in migration) {
    migration.run(createMigrationStorage(rawDb));
    return;
  }
  rawDb.exec(patchMigration(migration.sql));
}

export interface TestDb {
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
  rawDb: InstanceType<typeof Database>;
}

export function createTestDb(): TestDb {
  const rawDb = new Database(":memory:");
  rawDb.pragma("foreign_keys = ON");
  rawDb.exec(MIGRATION_BOOTSTRAP);
  for (const migration of MIGRATIONS) {
    runMigration(rawDb, migration);
  }
  const db = drizzle(rawDb, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, rawDb };
}

export function createEntity(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  overrides?: { id?: string; type?: string; data?: Record<string, unknown> },
) {
  return entityOps.create(
    db,
    {
      id: overrides?.id ?? `ent-${Date.now()}`,
      type: overrides?.type ?? "task",
      data: overrides?.data ?? { name: "Deploy pipeline", status: "open" },
      created_by: "test-actor",
    },
    1,
    { actor: "test-actor" },
  );
}
