import type { schema } from "@tila/ops-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProjectErrorHandlers } from "../../src/do/routes/errors";
import { createRecordRoutes } from "../../src/do/routes/record-routes";
import type { RouterDeps } from "../../src/do/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: vi.fn().mockReturnValue(undefined),
  };
}

function createApp(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): Hono {
  const app = new Hono();
  installProjectErrorHandlers(app);
  app.route("/", createRecordRoutes(makeDeps(db)));
  return app;
}

// Seed a schema declaring a record type with a required field so that
// validateRecordWrite has something to gate on (schema-rejection tests).
const SCHEMA_TOML = `
schema_version = 1

[records.config]
format = "json"
history = "revision"

[records.config.fields]
region = { type = "string", required = true }
`;

function seedSchema(sqlite: TestDb["sqlite"]): void {
  sqlite
    .prepare(
      "INSERT INTO _schema_history (version, definition, applied_at, applied_by) VALUES (?, ?, ?, ?)",
    )
    .run(1, SCHEMA_TOML, Date.now(), "test");
}

type MutateBody = {
  ok: boolean;
  record: {
    type: string;
    key: string;
    value: Record<string, unknown>;
    revision: number;
    updated_by: string;
  };
  fence: number;
  revision: number;
};

let testDb: TestDb;
let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
let app: Hono;
const IDENTITY_BODY = {
  principal_id: "test:records",
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

async function put(
  type: string,
  key: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/record/${type}/${key}/put`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, ...IDENTITY_BODY }),
  });
}

describe("POST /record/:type/:key/put", () => {
  it("creates a new record (revision 1) and returns HTTP 200", async () => {
    const res = await put("config", "main", { value: { env: "prod" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MutateBody;
    expect(body.ok).toBe(true);
    expect(body.record.type).toBe("config");
    expect(body.record.key).toBe("main");
    expect(body.record.revision).toBe(1);
    expect(body.revision).toBe(1);
    expect(body.record.value).toEqual({ env: "prod" });
    expect(typeof body.fence).toBe("number");
  });

  it("replaces an existing record (revision 2) and returns HTTP 200", async () => {
    const first = await put("config", "main", { value: { env: "prod" } });
    expect(first.status).toBe(200);

    const second = await put("config", "main", { value: { env: "staging" } });
    expect(second.status).toBe(200);
    const body = (await second.json()) as MutateBody;
    expect(body.record.revision).toBe(2);
    expect(body.revision).toBe(2);
    expect(body.record.value).toEqual({ env: "staging" });
  });

  it("routes keys containing slashes to the handler", async () => {
    const res = await put("config", "env/staging", { value: { env: "x" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MutateBody;
    expect(body.record.key).toBe("env/staging");
  });

  it("records actor from the request body", async () => {
    const res = await put("config", "main", {
      value: { env: "prod" },
      actor: "alice",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MutateBody;
    expect(body.record.updated_by).toBe("alice");
  });

  it("create and set attribute the actor from the request body (not anonymous)", async () => {
    const created = await app.request("/record/config/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...IDENTITY_BODY,
        key: "attr",
        value: { env: "a" },
        actor: "alice",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as MutateBody;
    expect(createdBody.record.updated_by).toBe("alice");

    const set = await app.request("/record/config/attr/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...IDENTITY_BODY,
        value: { env: "b" },
        fence: createdBody.fence,
        actor: "bob",
      }),
    });
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as MutateBody;
    expect(setBody.record.updated_by).toBe("bob");
  });

  it("rejects a value exceeding 64 KiB with HTTP 413", async () => {
    const res = await put("config", "big", {
      value: { blob: "x".repeat(70_000) },
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("payload-too-large");
  });

  describe("schema validation parity with set", () => {
    it("rejects a value missing a required field (same as set)", async () => {
      seedSchema(testDb.sqlite);

      const putRes = await put("config", "main", { value: { other: 1 } });
      expect(putRes.status).toBe(422);
      const putBody = (await putRes.json()) as {
        ok: boolean;
        error: { code: string };
      };
      expect(putBody.ok).toBe(false);
      expect(putBody.error.code).toBe("constraint-violation");

      // Parity: set rejects the same invalid value identically.
      const setRes = await app.request("/record/config/main/set", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...IDENTITY_BODY,
          value: { other: 1 },
          fence: 0,
        }),
      });
      expect(setRes.status).toBe(422);
      const setBody = (await setRes.json()) as {
        ok: boolean;
        error: { code: string };
      };
      expect(setBody.error.code).toBe("constraint-violation");
    });

    it("accepts a value satisfying the declared schema", async () => {
      seedSchema(testDb.sqlite);
      const res = await put("config", "main", {
        value: { region: "us-east" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as MutateBody;
      expect(body.record.value).toEqual({ region: "us-east" });
    });
  });
});

describe("GET /record/:type/:key/history revision authors", () => {
  type HistoryBody = {
    ok: boolean;
    items: {
      revision: number;
      actor: string;
      principal_id: string | null;
      token_id: string | null;
    }[];
  };

  async function history(): Promise<HistoryBody> {
    const res = await app.request("/record/config/main/history");
    expect(res.status).toBe(200);
    return (await res.json()) as HistoryBody;
  }

  it("returns the writer's principal and credential beside the unchanged actor", async () => {
    const created = await put("config", "main", {
      value: { n: 1 },
      actor: "deploy-bot",
      actor_token_id: "token-1",
    });
    expect(created.status).toBe(200);

    const body = await history();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      revision: 1,
      // `actor` stays the display name the Worker stamps; the new fields are
      // the authenticated identity and credential.
      actor: "deploy-bot",
      principal_id: IDENTITY_BODY.principal_id,
      token_id: "token-1",
    });
  });

  it("keeps the principal when the credential rotates, with a different token_id", async () => {
    await put("config", "main", { value: { n: 1 }, actor_token_id: "old" });
    await put("config", "main", { value: { n: 2 }, actor_token_id: "new" });

    const { items } = await history();
    expect(items.map((i) => i.token_id)).toEqual(["new", "old"]);
    expect(new Set(items.map((i) => i.principal_id))).toEqual(
      new Set([IDENTITY_BODY.principal_id]),
    );
  });

  it("reports a browser or OIDC session write with its principal and a null token", async () => {
    // Session credentials have no D1 token row: the Worker sends no
    // `actor_token_id` (or null) with the canonical identity.
    await put("config", "main", { value: { n: 1 }, actor_token_id: null });
    await put("config", "main", { value: { n: 2 } });

    const { items } = await history();
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.principal_id).toBe(IDENTITY_BODY.principal_id);
      expect(item.token_id).toBeNull();
    }
  });

  it("returns null principal for a revision stored before the column existed", async () => {
    await put("config", "main", { value: { n: 1 }, actor_token_id: "t" });
    testDb.sqlite
      .prepare("UPDATE record_revisions SET principal_id = NULL")
      .run();

    const { items } = await history();
    expect(items[0]).toMatchObject({ principal_id: null, token_id: "t" });
  });
});
