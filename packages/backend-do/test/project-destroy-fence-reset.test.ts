/**
 * AC-1 hard-gate test: fence resets to 1 after project destroy + slug reuse.
 *
 * Proves the invariant at the ops layer: a fresh DB (reconstruction equivalent)
 * issues fence=1 for a resource that had a higher fence in a prior-life DB.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { coordinationOps, schema } from "../../ops-sqlite/src";
import { runProjectMigrations } from "../src/migration-runner";

const { acquire, release } = coordinationOps;

// Cloudflare's SQLite fork supports COALESCE in PRIMARY KEY; standard SQLite does not.
function patchMigration(sql: string): string {
  return sql.replace(
    "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
    "PRIMARY KEY (from_key, type)",
  );
}

function createStorage(sqlite: InstanceType<typeof Database>) {
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

function createTestDb(): {
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
  sqlite: InstanceType<typeof Database>;
} {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  const storage = createStorage(sqlite);
  runProjectMigrations(storage);
  const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    unknown,
    typeof schema
  >;
  return { db, sqlite };
}

describe("AC-1: fence resets to 1 on project destroy + slug reuse", () => {
  it("DB-A: first holder gets fence=1, next holder gets fence=2 after release", () => {
    const { db: dbA } = createTestDb();

    // First acquire — fence is created at 1
    const first = acquire(
      dbA,
      "task:T-1",
      "machine-a",
      "user-a",
      "exclusive",
      60_000,
    );
    expect(first.acquired).toBe(true);
    expect(first.fence).toBe(1);

    release(dbA, "task:T-1", first.fence, { actor: "machine-a/user-a" });

    // A new holder on the same DB gets the next fence.
    const second = acquire(
      dbA,
      "task:T-1",
      "machine-b",
      "user-b",
      "exclusive",
      60_000,
    );
    expect(second.acquired).toBe(true);
    expect(second.fence).toBe(2);
  });

  it("DB-B (fresh/reconstructed): fences table is empty before acquiring", () => {
    const { sqlite: sqliteB } = createTestDb();
    const rows = sqliteB
      .prepare("SELECT COUNT(*) as cnt FROM fences")
      .get() as {
      cnt: number;
    };
    expect(rows.cnt).toBe(0);
  });

  it("DB-B (fresh/reconstructed): acquire returns fence=1, proving no stale fence inheritance", () => {
    const { db: dbB } = createTestDb();

    // DB-B is a completely independent DB — simulates a freshly reconstructed DO
    // after destroy. The fence for "task:T-1" does NOT exist here.
    const result = acquire(
      dbB,
      "task:T-1",
      "machine-b",
      "user-b",
      "exclusive",
      60_000,
    );

    expect(result.acquired).toBe(true);
    // Must be 1 — the initial fence — not 3 (which would be stale from DB-A's prior life)
    expect(result.fence).toBe(1);
  });

  it("end-to-end invariant: DB-A reaches fence=2; DB-B (reconstruction) starts at fence=1 for the same resource", () => {
    // DB-A: simulate two acquires on the same resource (prior-life state)
    const { db: dbA } = createTestDb();
    const first = acquire(
      dbA,
      "task:T-1",
      "machine-a",
      "user-a",
      "exclusive",
      60_000,
    );
    release(dbA, "task:T-1", first.fence, { actor: "machine-a/user-a" });
    const staleResult = acquire(
      dbA,
      "task:T-1",
      "machine-b",
      "user-b",
      "exclusive",
      60_000,
    );
    expect(staleResult.fence).toBe(2);

    // DB-B: a fresh in-memory DB represents slug reuse after destroy+reconstruction.
    // The key invariant: fence starts at 1 regardless of DB-A's history.
    const { db: dbB } = createTestDb();
    const freshResult = acquire(
      dbB,
      "task:T-1",
      "machine-b",
      "user-b",
      "exclusive",
      60_000,
    );
    expect(freshResult.acquired).toBe(true);
    expect(freshResult.fence).toBe(1);
  });
});
