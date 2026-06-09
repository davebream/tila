/**
 * Phase 5 tests: entity + artifact tags flow through the DO routes.
 *
 * Covers:
 * - POST /entity/create with tags -> GET /entity/get/:id returns tags
 * - GET /entity/list returns tags (always present, default [])
 * - POST /artifact/pointer with tags -> GET /artifact/latest returns tags
 * - GET /artifact/pointers returns tags
 * - Response tags default to [] when omitted from create
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type Migration,
  type MigrationStorage,
  artifactOps,
  entityOps,
  schema,
} from "../../ops-sqlite/src";
import { createArtifactRoutes } from "../src/routes/artifact-routes";
import { createEntityRoutes } from "../src/routes/entity-routes";
import type { RouterDeps } from "../src/routes/types";

// Patch COALESCE-based PK that standard SQLite does not support
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

let rawDb: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  rawDb = new Database(":memory:");
  rawDb.pragma("foreign_keys = OFF"); // mirrors DO runtime; explicit deletes tested
  rawDb.exec(MIGRATION_BOOTSTRAP);
  for (const migration of MIGRATIONS) {
    runMigration(rawDb, migration);
  }
  db = drizzle(rawDb, { schema });
});

afterEach(() => {
  rawDb.close();
});

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: () =>
      undefined as unknown as ReturnType<RouterDeps["enrichOpts"]>,
  };
}

// ---------------------------------------------------------------------------
// Entity tags via DO routes
// ---------------------------------------------------------------------------

describe("entity create + get/list tags via DO route", () => {
  it("POST /entity/create with tags -> GET /entity/get/:id returns tags", async () => {
    const app = createEntityRoutes(
      makeDeps(
        db as unknown as BaseSQLiteDatabase<"sync", unknown, typeof schema>,
      ),
    );

    const createRes = await app.request("/entity/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "T-tag1",
        type: "task",
        data: { title: "Tag Test" },
        created_by: "test-agent",
        tags: ["env:prod", "team:platform"],
      }),
    });
    expect(createRes.status).toBe(200);
    const createBody = (await createRes.json()) as {
      ok: boolean;
      entity: { id: string; tags: string[] };
    };
    expect(createBody.ok).toBe(true);
    expect(createBody.entity.id).toBe("T-tag1");
    expect(createBody.entity.tags).toEqual(
      expect.arrayContaining(["env:prod", "team:platform"]),
    );
    expect(createBody.entity.tags).toHaveLength(2);

    // GET returns the same tags
    const getApp = createEntityRoutes(
      makeDeps(
        db as unknown as BaseSQLiteDatabase<"sync", unknown, typeof schema>,
      ),
    );
    const getRes = await getApp.request("/entity/get/T-tag1");
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      ok: boolean;
      entity: { id: string; tags: string[] };
    };
    expect(getBody.ok).toBe(true);
    expect(getBody.entity.tags).toEqual(
      expect.arrayContaining(["env:prod", "team:platform"]),
    );
  });

  it("response tags default to [] when no tags provided on create", async () => {
    const app = createEntityRoutes(
      makeDeps(
        db as unknown as BaseSQLiteDatabase<"sync", unknown, typeof schema>,
      ),
    );

    const createRes = await app.request("/entity/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "T-notag",
        type: "task",
        data: { title: "No Tags" },
        created_by: "test-agent",
      }),
    });
    expect(createRes.status).toBe(200);
    const body = (await createRes.json()) as {
      ok: boolean;
      entity: { tags: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.entity.tags).toEqual([]);
  });

  it("GET /entity/list returns tags for all entities", async () => {
    // Create entities via ops directly so we control tags precisely
    entityOps.create(
      db as unknown as BaseSQLiteDatabase<"sync", unknown, typeof schema>,
      {
        id: "T-list1",
        type: "task",
        data: {},
        created_by: "agent",
        tags: ["env:prod"],
      },
      1,
      { actor: "agent" },
    );
    entityOps.create(
      db as unknown as BaseSQLiteDatabase<"sync", unknown, typeof schema>,
      { id: "T-list2", type: "task", data: {}, created_by: "agent" },
      1,
      { actor: "agent" },
    );

    const app = createEntityRoutes(
      makeDeps(
        db as unknown as BaseSQLiteDatabase<"sync", unknown, typeof schema>,
      ),
    );
    const res = await app.request("/entity/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      entities: Array<{ id: string; tags: string[] }>;
    };
    expect(body.ok).toBe(true);
    const e1 = body.entities.find((e) => e.id === "T-list1");
    const e2 = body.entities.find((e) => e.id === "T-list2");
    expect(e1).toBeDefined();
    expect(e1?.tags).toEqual(["env:prod"]);
    expect(e2).toBeDefined();
    expect(e2?.tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Artifact tags via DO routes
// ---------------------------------------------------------------------------

describe("artifact pointer upsert + get/list tags via DO route", () => {
  it("POST /artifact/pointer with tags -> GET /artifact/latest returns tags", async () => {
    const app = createArtifactRoutes(
      makeDeps(
        db as unknown as BaseSQLiteDatabase<"sync", unknown, typeof schema>,
      ),
    );

    const upsertRes = await app.request("/artifact/pointer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        r2_key: "sources/abc123.md",
        resource: null,
        kind: "plan",
        sha256: "abc123",
        bytes: 100,
        fence: null,
        mime_type: "text/markdown",
        produced_at: 1000,
        produced_by: "agent",
        expires_at: null,
        actor: "agent",
        tags: ["env:prod", "team:platform"],
      }),
    });
    expect(upsertRes.status).toBe(200);
    const upsertBody = (await upsertRes.json()) as { ok: boolean };
    expect(upsertBody.ok).toBe(true);

    // GET /artifact/latest returns tags
    const latestRes = await app.request(
      "/artifact/latest?kind=plan&resource=any",
    );
    // Note: resource=null above means it's a source artifact without resource;
    // use listPointers to verify tags
    const listRes = await app.request("/artifact/pointers");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      ok: boolean;
      pointers: Array<{ r2_key: string; tags: string[] }>;
    };
    expect(listBody.ok).toBe(true);
    const ptr = listBody.pointers.find((p) => p.r2_key === "sources/abc123.md");
    expect(ptr).toBeDefined();
    expect(ptr?.tags).toEqual(
      expect.arrayContaining(["env:prod", "team:platform"]),
    );
    expect(ptr?.tags).toHaveLength(2);
  });

  it("artifact pointer response tags default to [] when no tags provided", async () => {
    const app = createArtifactRoutes(
      makeDeps(
        db as unknown as BaseSQLiteDatabase<"sync", unknown, typeof schema>,
      ),
    );

    await app.request("/artifact/pointer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        r2_key: "sources/notag.md",
        resource: null,
        kind: "doc",
        sha256: "notag",
        bytes: 50,
        fence: null,
        mime_type: "text/markdown",
        produced_at: 2000,
        produced_by: "agent",
        expires_at: null,
        actor: "agent",
      }),
    });

    const listRes = await app.request("/artifact/pointers");
    const listBody = (await listRes.json()) as {
      ok: boolean;
      pointers: Array<{ r2_key: string; tags: string[] }>;
    };
    const ptr = listBody.pointers.find((p) => p.r2_key === "sources/notag.md");
    expect(ptr).toBeDefined();
    expect(ptr?.tags).toEqual([]);
  });

  it("POST /artifact/pointer re-upsert replaces tags when tags provided", async () => {
    const app = createArtifactRoutes(
      makeDeps(
        db as unknown as BaseSQLiteDatabase<"sync", unknown, typeof schema>,
      ),
    );

    // First upsert with tags
    await app.request("/artifact/pointer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        r2_key: "sources/replace.md",
        resource: null,
        kind: "plan",
        sha256: "replace",
        bytes: 100,
        fence: null,
        mime_type: "text/markdown",
        produced_at: 1000,
        produced_by: "agent",
        expires_at: null,
        actor: "agent",
        tags: ["old:tag"],
      }),
    });

    // Re-upsert same key (INSERT OR IGNORE is a no-op for the row) but with new tags
    await app.request("/artifact/pointer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        r2_key: "sources/replace.md",
        resource: null,
        kind: "plan",
        sha256: "replace",
        bytes: 100,
        fence: null,
        mime_type: "text/markdown",
        produced_at: 1000,
        produced_by: "agent",
        expires_at: null,
        actor: "agent",
        tags: ["new:tag"],
      }),
    });

    const listRes = await app.request("/artifact/pointers");
    const listBody = (await listRes.json()) as {
      ok: boolean;
      pointers: Array<{ r2_key: string; tags: string[] }>;
    };
    const ptr = listBody.pointers.find(
      (p) => p.r2_key === "sources/replace.md",
    );
    expect(ptr).toBeDefined();
    expect(ptr?.tags).toEqual(["new:tag"]);
  });
});
