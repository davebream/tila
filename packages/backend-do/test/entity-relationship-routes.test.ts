import type { schema } from "@tila/ops-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityRoutes } from "../src/routes/entity-routes";
import { installProjectErrorHandlers } from "../src/routes/errors";
import type { RouterDeps } from "../src/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    // Return undefined to skip entity enrichment (no schema-as-config in test db)
    enrichOpts: vi.fn().mockReturnValue(undefined),
  };
}

function createApp(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): Hono {
  const app = new Hono();
  installProjectErrorHandlers(app);
  app.route("/", createEntityRoutes(makeDeps(db)));
  return app;
}

let testDb: TestDb;
let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
let app: Hono;

beforeEach(() => {
  testDb = createTestDb();
  db = testDb.db;
  app = createApp(db);
});

afterEach(() => {
  testDb.sqlite.close();
});

// ---------------------------------------------------------------------------
// Helper: seed an entity and relationships via the route layer
// ---------------------------------------------------------------------------

async function createRelationship(
  fromId: string,
  toId: string,
  type: string,
): Promise<Response> {
  return app.request("/entity/relationship/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_id: fromId, to_id: toId, type, actor: "test" }),
  });
}

async function createEntity(id: string, type = "task"): Promise<Response> {
  return app.request("/entity/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      type,
      data: { title: id },
      created_by: "test",
    }),
  });
}

// ---------------------------------------------------------------------------
// POST /entity/relationship/create — 201 on insert, 200 on no-op
// ---------------------------------------------------------------------------

describe("POST /entity/relationship/create", () => {
  it("returns 201 and created:true on a real insert", async () => {
    const res = await createRelationship("task-A", "task-B", "blocks");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; created: boolean };
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
  });

  it("returns 200 and created:false on a duplicate (idempotent no-op)", async () => {
    await createRelationship("task-A", "task-B", "blocks");
    const res2 = await createRelationship("task-A", "task-B", "blocks");
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { ok: boolean; created: boolean };
    expect(body.ok).toBe(true);
    expect(body.created).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /entity/relationship/list
// ---------------------------------------------------------------------------

describe("GET /entity/relationship/list", () => {
  it("returns 200 with all relationships when no filter is provided", async () => {
    await createRelationship("A", "B", "blocks");
    await createRelationship("A", "C", "soft-blocks");

    const res = await app.request("/entity/relationship/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      relationships: Array<{ from_id: string; to_id: string; type: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.relationships).toHaveLength(2);
  });

  it("filters by type", async () => {
    await createRelationship("A", "B", "blocks");
    await createRelationship("A", "C", "parent-child");

    const res = await app.request("/entity/relationship/list?type=blocks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      relationships: Array<{ from_id: string; type: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.relationships).toHaveLength(1);
    expect(body.relationships[0].type).toBe("blocks");
  });

  it("filters by from_id", async () => {
    await createRelationship("A", "B", "blocks");
    await createRelationship("X", "B", "blocks");

    const res = await app.request("/entity/relationship/list?from_id=A");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      relationships: Array<{ from_id: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.relationships).toHaveLength(1);
    expect(body.relationships[0].from_id).toBe("A");
  });

  it("filters by to_id", async () => {
    await createRelationship("A", "B", "blocks");
    await createRelationship("A", "C", "blocks");

    const res = await app.request("/entity/relationship/list?to_id=B");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      relationships: Array<{ to_id: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.relationships).toHaveLength(1);
    expect(body.relationships[0].to_id).toBe("B");
  });

  it("uses AND semantics for combined from_id + type filter", async () => {
    await createRelationship("A", "B", "blocks");
    await createRelationship("A", "C", "parent-child");
    await createRelationship("X", "D", "blocks");

    const res = await app.request(
      "/entity/relationship/list?from_id=A&type=blocks",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      relationships: Array<{ from_id: string; type: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.relationships).toHaveLength(1);
    expect(body.relationships[0].from_id).toBe("A");
    expect(body.relationships[0].type).toBe("blocks");
  });

  it("returns empty array when no relationships match", async () => {
    const res = await app.request("/entity/relationship/list?type=blocks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      relationships: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.relationships).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /entity/relationship/delete
// ---------------------------------------------------------------------------

describe("POST /entity/relationship/delete", () => {
  it("returns removed:true when the edge exists", async () => {
    await createRelationship("A", "B", "blocks");

    const res = await app.request("/entity/relationship/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_id: "A", to_id: "B", type: "blocks" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
  });

  it("returns removed:false when the edge does not exist", async () => {
    const res = await app.request("/entity/relationship/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_id: "no-such",
        to_id: "no-such",
        type: "blocks",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(false);
  });

  it("delete is idempotent: second delete returns removed:false", async () => {
    await createRelationship("A", "B", "blocks");
    await app.request("/entity/relationship/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_id: "A", to_id: "B", type: "blocks" }),
    });
    const res2 = await app.request("/entity/relationship/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_id: "A", to_id: "B", type: "blocks" }),
    });
    const body = (await res2.json()) as { ok: boolean; removed: boolean };
    expect(body.removed).toBe(false);
  });

  it("returns 400 validation-error when from_id is missing", async () => {
    const res = await app.request("/entity/relationship/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_id: "B", type: "blocks" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 400 validation-error when to_id is missing", async () => {
    const res = await app.request("/entity/relationship/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_id: "A", type: "blocks" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 400 validation-error when type is missing", async () => {
    const res = await app.request("/entity/relationship/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_id: "A", to_id: "B" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
  });
});

// ---------------------------------------------------------------------------
// POST /entity/create — duplicate id → 409 already-exists
// ---------------------------------------------------------------------------

describe("POST /entity/create — duplicate id handling", () => {
  it("returns 409 already-exists when the same id is created twice", async () => {
    const first = await createEntity("unique-task-id");
    expect(first.status).toBe(200);

    const second = await createEntity("unique-task-id");
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("already-exists");
  });
});
