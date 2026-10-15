import type { schema } from "@tila/ops-sqlite";
import { EntityRelationshipTypeSchema } from "@tila/schemas";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityRoutes } from "../../src/do/routes/entity-routes";
import { installProjectErrorHandlers } from "../../src/do/routes/errors";
import type { RouterDeps } from "../../src/do/routes/types";
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
const IDENTITY_BODY = {
  principal_id: "test:test",
  participant_id: "participant-1",
  environment: {},
};

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

async function postRelationship(
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

/** Creates the relationship between two tasks that exist, as a client must. */
async function createRelationship(
  fromId: string,
  toId: string,
  type: string,
): Promise<Response> {
  for (const id of [fromId, toId]) {
    const res = await createEntity(id);
    expect([200, 409]).toContain(res.status);
  }
  return postRelationship(fromId, toId, type);
}

async function createEntity(id: string, type = "task"): Promise<Response> {
  return app.request("/entity/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...IDENTITY_BODY,
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

// ---------------------------------------------------------------------------
// POST /entity/relationship/create — both endpoints must exist, for every type
// ---------------------------------------------------------------------------

const LEAF_SCHEMA_TOML = `
schema_version = 1

[work_units.epic]
parents = []
[work_units.epic.fields]
title = { type = "string", required = true }

[work_units.task]
parents = ["epic"]
[work_units.task.fields]
title = { type = "string", required = true }

[hierarchy]
levels = ["epic", "task"]
`;

type ErrorBody = {
  ok: boolean;
  error: { code: string; message: string; retryable: boolean };
};

function count(table: string, where = "1 = 1"): number {
  const row = testDb.sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .get() as { n: number };
  return row.n;
}

async function expectMissing(res: Response, id: string): Promise<void> {
  expect(res.status).toBe(404);
  const body = (await res.json()) as ErrorBody;
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe("not-found");
  expect(body.error.retryable).toBe(false);
  expect(body.error.message).toContain(id);
}

describe("POST /entity/relationship/create — endpoint existence", () => {
  beforeEach(() => {
    // The Durable Object enforces foreign keys; do the same here so a missing
    // endpoint that reached the insert would fail as it does in production.
    testDb.sqlite.close();
    testDb = createTestDb({ foreignKeys: "on" });
    db = testDb.db;
    app = createApp(db);
  });

  const TYPES = EntityRelationshipTypeSchema.options;

  it.each(TYPES)(
    "%s: a missing to_id is 404 and writes nothing",
    async (type) => {
      await createEntity("from-1");

      await expectMissing(
        await postRelationship("from-1", "ghost-to", type),
        "ghost-to",
      );

      expect(count("entity_relationships")).toBe(0);
      expect(count("journal", "kind = 'relationship.entity.created'")).toBe(0);
    },
  );

  it.each(TYPES)(
    "%s: a missing from_id is 404 and writes nothing",
    async (type) => {
      await createEntity("to-1");

      await expectMissing(
        await postRelationship("ghost-from", "to-1", type),
        "ghost-from",
      );

      expect(count("entity_relationships")).toBe(0);
      expect(count("journal", "kind = 'relationship.entity.created'")).toBe(0);
    },
  );

  it.each(TYPES)(
    "%s: from_id is reported first when both are missing",
    async (type) => {
      await expectMissing(
        await postRelationship("ghost-from", "ghost-to", type),
        "ghost-from",
      );
      expect(count("entity_relationships")).toBe(0);
    },
  );

  it("never answers a missing endpoint with a retryable 500", async () => {
    await createEntity("from-1");
    const res = await postRelationship("from-1", "ghost-to", "blocks");
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).not.toBe("internal");
    expect(body.error.retryable).toBe(false);
  });

  it.each(TYPES)(
    "%s: still creates, then no-ops on a duplicate",
    async (type) => {
      const first = await createRelationship("from-1", "to-1", type);
      expect(first.status).toBe(201);
      expect(((await first.json()) as { created: boolean }).created).toBe(true);

      const second = await postRelationship("from-1", "to-1", type);
      expect(second.status).toBe(200);
      expect(((await second.json()) as { created: boolean }).created).toBe(
        false,
      );
      expect(count("entity_relationships")).toBe(1);
      expect(count("journal", "kind = 'relationship.entity.created'")).toBe(1);
    },
  );

  it("still accepts an archived endpoint", async () => {
    await createEntity("from-1");
    await createEntity("to-1");
    testDb.sqlite.prepare("UPDATE entities SET archived = 1").run();

    const res = await postRelationship("from-1", "to-1", "blocks");
    expect(res.status).toBe(201);
  });

  it("still answers missing required fields with 400 validation-error", async () => {
    const res = await app.request("/entity/relationship/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_id: "from-1", type: "blocks", actor: "t" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("validation-error");
  });

  describe("parent-child with a leaf-type parent", () => {
    beforeEach(() => {
      testDb.sqlite
        .prepare(
          "INSERT INTO _schema_history (version, definition, applied_at, applied_by) VALUES (1, ?, ?, 'test')",
        )
        .run(LEAF_SCHEMA_TOML, Date.now());
    });

    it("rejects a leaf parent with 422 when both endpoints exist", async () => {
      await createEntity("leaf-parent", "task");
      await createEntity("child", "task");

      const res = await postRelationship(
        "leaf-parent",
        "child",
        "parent-child",
      );

      expect(res.status).toBe(422);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("constraint-violation");
      expect(count("entity_relationships")).toBe(0);
    });

    it("reports a missing to_id before the leaf check", async () => {
      await createEntity("leaf-parent", "task");

      await expectMissing(
        await postRelationship("leaf-parent", "ghost-child", "parent-child"),
        "ghost-child",
      );
    });

    it("reports a missing parent as 404", async () => {
      await createEntity("child", "task");

      await expectMissing(
        await postRelationship("ghost-parent", "child", "parent-child"),
        "ghost-parent",
      );
    });

    it("allows a non-leaf parent", async () => {
      await createEntity("epic-1", "epic");
      await createEntity("child", "task");

      const res = await postRelationship("epic-1", "child", "parent-child");
      expect(res.status).toBe(201);
    });
  });
});
