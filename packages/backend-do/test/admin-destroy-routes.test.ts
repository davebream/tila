import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it, vi } from "vitest";
import { schema, storeCountsOps } from "../../ops-sqlite/src";
import { runProjectMigrations } from "../src/migration-runner";
import { createAdminRoutes } from "../src/routes/admin-routes";
import type { RouterDeps } from "../src/routes/types";

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

function createTestDb() {
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

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  ctx: unknown,
): RouterDeps {
  return {
    ctx: ctx as DurableObjectState,
    db,
    enrichOpts: vi.fn() as RouterDeps["enrichOpts"],
  };
}

// ---------------------------------------------------------------------------
// Task 4: GET /admin/pointer-keys
// ---------------------------------------------------------------------------

describe("GET /admin/pointer-keys", () => {
  const now = Date.now();

  function seedPointers(db: ReturnType<typeof createTestDb>["db"]): void {
    db.insert(schema.artifactPointers)
      .values([
        {
          r2_key: "produced/T-1/abc123.txt",
          resource: "T-1",
          kind: "produced",
          sha256: "abc123",
          bytes: 10,
          mime_type: "text/plain",
          produced_at: now,
          produced_by: "test",
          tombstoned: 0,
        },
        {
          r2_key: "sources/def456.bin",
          resource: "T-2",
          kind: "source",
          sha256: "def456",
          bytes: 20,
          mime_type: "application/octet-stream",
          produced_at: now,
          produced_by: "test",
          tombstoned: 0,
        },
        {
          r2_key: "produced/T-3/ghi789.txt",
          resource: "T-3",
          kind: "produced",
          sha256: "ghi789",
          bytes: 30,
          mime_type: "text/plain",
          produced_at: now,
          produced_by: "test",
          tombstoned: 1, // tombstoned
        },
      ])
      .run();
  }

  it("returns empty keys array and null nextCursor when no pointers exist", async () => {
    const { db } = createTestDb();
    const app = createAdminRoutes(makeDeps(db, { abort: vi.fn() }));

    const res = await app.request("/admin/pointer-keys");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: string[];
      nextCursor: string | null;
    };
    expect(body.keys).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns all pointer keys including tombstoned ones (no pagination params)", async () => {
    const { db } = createTestDb();
    seedPointers(db);

    const app = createAdminRoutes(makeDeps(db, { abort: vi.fn() }));
    const res = await app.request("/admin/pointer-keys");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: string[];
      nextCursor: string | null;
    };
    // Should include tombstoned key too — sorted by r2_key
    expect(body.keys).toHaveLength(3);
    expect(body.keys).toContain("produced/T-1/abc123.txt");
    expect(body.keys).toContain("sources/def456.bin");
    expect(body.keys).toContain("produced/T-3/ghi789.txt");
    expect(body.nextCursor).toBeNull();
  });

  it("paginates: returns first page and non-null nextCursor when limit < total", async () => {
    const { db } = createTestDb();
    seedPointers(db);

    const app = createAdminRoutes(makeDeps(db, { abort: vi.fn() }));
    const res = await app.request("/admin/pointer-keys?limit=2");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: string[];
      nextCursor: string | null;
    };
    expect(body.keys).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
  });

  it("paginates: cursor advances to next page", async () => {
    const { db } = createTestDb();
    seedPointers(db);

    const app = createAdminRoutes(makeDeps(db, { abort: vi.fn() }));
    const res1 = await app.request("/admin/pointer-keys?limit=2");
    const body1 = (await res1.json()) as {
      keys: string[];
      nextCursor: string | null;
    };
    expect(body1.nextCursor).not.toBeNull();

    const cursor1 = body1.nextCursor;
    if (!cursor1) throw new Error("expected nextCursor to be non-null");
    const res2 = await app.request(
      `/admin/pointer-keys?limit=2&cursor=${encodeURIComponent(cursor1)}`,
    );
    const body2 = (await res2.json()) as {
      keys: string[];
      nextCursor: string | null;
    };
    expect(body2.keys).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();

    // All 3 keys, no duplicates
    const allKeys = [...body1.keys, ...body2.keys];
    expect(allKeys).toHaveLength(3);
    expect(new Set(allKeys).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Task 4: GET /admin/store-counts
// ---------------------------------------------------------------------------

describe("GET /admin/store-counts", () => {
  it("returns counts object with domain and schemaHistory keys", async () => {
    const { db } = createTestDb();
    const app = createAdminRoutes(makeDeps(db, { abort: vi.fn() }));

    const res = await app.request("/admin/store-counts");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { domain: Record<string, number>; schemaHistory: number };
    };
    expect(body.counts).toHaveProperty("domain");
    expect(body.counts).toHaveProperty("schemaHistory");
    // All domain counts should be 0 on an empty DB
    for (const val of Object.values(body.counts.domain)) {
      expect(val).toBe(0);
    }
  });

  it("reflects seeded data in domain counts", async () => {
    const { db } = createTestDb();

    const now = Date.now();
    db.insert(schema.artifactPointers)
      .values({
        r2_key: "produced/T-1/abc123.txt",
        resource: "T-1",
        kind: "produced",
        sha256: "abc123",
        bytes: 10,
        mime_type: "text/plain",
        produced_at: now,
        produced_by: "test",
        tombstoned: 0,
      })
      .run();

    const app = createAdminRoutes(makeDeps(db, { abort: vi.fn() }));
    const res = await app.request("/admin/store-counts");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { domain: Record<string, number>; schemaHistory: number };
    };
    expect(body.counts.domain.artifact_pointers).toBe(1);
    // All others should be 0
    for (const [key, val] of Object.entries(body.counts.domain)) {
      if (key !== "artifact_pointers") {
        expect(val).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Task 5: POST /admin/destroy
// ---------------------------------------------------------------------------

describe("POST /admin/destroy", () => {
  it("empties all domain tables without deleteAll or abort, returns ok:true", async () => {
    const { db, sqlite } = createTestDb();
    const callOrder: string[] = [];

    const now = Date.now();
    db.insert(schema.artifactPointers)
      .values({
        r2_key: "produced/T-1/abc123.txt",
        resource: "T-1",
        kind: "produced",
        sha256: "abc123",
        bytes: 10,
        mime_type: "text/plain",
        produced_at: now,
        produced_by: "test",
        tombstoned: 0,
      })
      .run();

    const storage = createStorage(sqlite) as ReturnType<
      typeof createStorage
    > & {
      deleteAlarm: () => Promise<void>;
      deleteAll: () => Promise<void>;
    };
    storage.deleteAlarm = vi.fn(async () => {
      callOrder.push("deleteAlarm");
    });
    storage.deleteAll = vi.fn(async () => {
      callOrder.push("deleteAll");
    });
    const ctx = {
      storage,
      abort: vi.fn((reason: string) => {
        callOrder.push(`abort:${reason}`);
      }),
    };

    const app = createAdminRoutes(makeDeps(db, ctx));
    const res = await app.request("/admin/destroy", { method: "POST" });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    // deleteAll() drops the SQL tables and abort() rolls back the deletes —
    // neither may run; only deleteAlarm precedes the explicit row deletes.
    expect(callOrder).toEqual(["deleteAlarm"]);
    expect(storage.deleteAll).not.toHaveBeenCalled();
    expect(ctx.abort).not.toHaveBeenCalled();
    // Every domain table is now empty.
    const counts = storeCountsOps.countStoreRows(db);
    for (const val of Object.values(counts.domain)) {
      expect(val).toBe(0);
    }
  });

  it("returns 500 and does NOT call abort when the table wipe throws", async () => {
    const { db } = createTestDb();
    const abortMock = vi.fn();

    const ctx = {
      storage: {
        deleteAlarm: vi.fn(async () => {}),
        sql: {
          exec: vi.fn(() => {
            throw new Error("sql failure");
          }),
        },
      },
      abort: abortMock,
    };

    const app = createAdminRoutes(makeDeps(db, ctx));
    const res = await app.request("/admin/destroy", { method: "POST" });

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("destroy-failed");
    // abort must NOT be called when the wipe throws
    expect(abortMock).not.toHaveBeenCalled();
  });

  it("returns 500 and does NOT call abort when deleteAlarm throws", async () => {
    const { db } = createTestDb();
    const abortMock = vi.fn();

    const ctx = {
      storage: {
        deleteAlarm: vi.fn(async () => {
          throw new Error("alarm failure");
        }),
        deleteAll: vi.fn(async () => {}),
      },
      abort: abortMock,
    };

    const app = createAdminRoutes(makeDeps(db, ctx));
    const res = await app.request("/admin/destroy", { method: "POST" });

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("destroy-failed");
    // abort must NOT be called
    expect(abortMock).not.toHaveBeenCalled();
  });
});
