import { coordinationOps, type schema } from "@tila/ops-sqlite";
import { MAX_TASK_DATA_BYTES, taskDataBytes } from "@tila/schemas";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityRoutes } from "../../src/do/routes/entity-routes";
import { installProjectErrorHandlers } from "../../src/do/routes/errors";
import type { RouterDeps } from "../../src/do/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

function createApp(db: Db): Hono {
  const deps: RouterDeps = {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: vi.fn().mockReturnValue(undefined),
  };
  const app = new Hono();
  installProjectErrorHandlers(app);
  app.route("/", createEntityRoutes(deps));
  return app;
}

const IDENTITY = {
  principal_id: "test:size",
  participant_id: "participant-1",
  environment: {},
};
const ORIGIN = {
  principalId: IDENTITY.principal_id,
  participantId: IDENTITY.participant_id,
  environment: {},
  actor: IDENTITY.principal_id,
};

// `{"d":"…"}` has 8 bytes of frame around the string value.
const FIELD_BYTES = MAX_TASK_DATA_BYTES - 8;
const atLimit = () => ({ d: "a".repeat(FIELD_BYTES) });
const overByOne = () => ({ d: "a".repeat(FIELD_BYTES + 1) });

type ErrorBody = {
  ok: boolean;
  error: { code: string; message: string; retryable: boolean };
};

let testDb: TestDb;
let db: Db;
let app: Hono;

beforeEach(() => {
  testDb = createTestDb();
  db = testDb.db;
  app = createApp(db);
});

afterEach(() => {
  testDb.sqlite.close();
});

function count(table: string, where = "1 = 1"): number {
  const row = testDb.sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .get() as { n: number };
  return row.n;
}

function rowCounts() {
  return {
    entities: count("entities"),
    tags: count("entity_tags"),
    search: count("entity_search_docs"),
    journal: count("journal"),
  };
}

async function create(
  id: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return app.request("/entity/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...IDENTITY,
      id,
      type: "task",
      data,
      created_by: "test",
      ...extra,
    }),
  });
}

/** Sends the body as given so a key such as `__proto__` survives. */
async function createRaw(body: string): Promise<Response> {
  return app.request("/entity/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function acquire(id: string): number {
  return coordinationOps.acquire(db, id, ORIGIN, "exclusive", 60_000).fence;
}

async function update(
  id: string,
  data: Record<string, unknown>,
  fence: number,
): Promise<Response> {
  return app.request(`/entity/update/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...IDENTITY, data, fence }),
  });
}

function storedData(id: string): Record<string, unknown> {
  const row = testDb.sqlite
    .prepare("SELECT data FROM entities WHERE id = ?")
    .get(id) as { data: string };
  return JSON.parse(row.data) as Record<string, unknown>;
}

/** Writes a row the way pre-bound versions could: past the ops layer. */
function seedLegacy(id: string, data: Record<string, unknown>): void {
  testDb.sqlite
    .prepare(
      "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, 'task', 1, ?, 0, 1, 1, 'legacy')",
    )
    .run(id, JSON.stringify(data));
}

async function expectTooLarge(res: Response): Promise<ErrorBody> {
  expect(res.status).toBe(413);
  const body = (await res.json()) as ErrorBody;
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe("payload-too-large");
  expect(body.error.retryable).toBe(false);
  expect(body.error.message).toContain(String(MAX_TASK_DATA_BYTES));
  return body;
}

describe("POST /entity/create task data bound", () => {
  it("accepts data exactly at the limit", async () => {
    const data = atLimit();
    expect(taskDataBytes(data)).toBe(MAX_TASK_DATA_BYTES);
    const res = await create("at-limit", data);
    expect(res.status).toBe(200);
    expect(storedData("at-limit")).toEqual(data);
  });

  it("refuses data one byte over the limit, writing nothing", async () => {
    const before = rowCounts();
    const res = await create("over-limit", overByOne(), { tags: ["keep"] });
    await expectTooLarge(res);
    expect(rowCounts()).toEqual(before);
    expect(count("entities", "id = 'over-limit'")).toBe(0);
  });

  it("counts UTF-8 bytes: 87,379 three-byte characters are over", async () => {
    // Far fewer than 262,144 characters, one byte over once encoded.
    const data = { d: "€".repeat(87_379) };
    expect(data.d.length).toBeLessThan(MAX_TASK_DATA_BYTES);
    await expectTooLarge(await create("multibyte-over", data));
    expect(count("entities")).toBe(0);
  });

  it("accepts multibyte data that lands exactly on the limit", async () => {
    const data = { d: `${"€".repeat(87_378)}aa` };
    expect(taskDataBytes(data)).toBe(MAX_TASK_DATA_BYTES);
    expect((await create("multibyte-at", data)).status).toBe(200);
  });

  it("counts four-byte characters by bytes, not UTF-16 units", async () => {
    expect((await create("emoji-at", { d: "😀".repeat(65_534) })).status).toBe(
      200,
    );
    await expectTooLarge(
      await create("emoji-over", { d: `${"😀".repeat(65_534)}a` }),
    );
  });

  it("measures nested data, not just top-level strings", async () => {
    // Each of the three strings is under the limit; together they are over.
    const part = "n".repeat(90_000);
    const data = { a: { b: [part, part], c: { d: part } } };
    expect(taskDataBytes(data)).toBeGreaterThan(MAX_TASK_DATA_BYTES);
    await expectTooLarge(await create("nested", data));
  });

  it("counts an own __proto__ key that a key-sorted copy would drop", async () => {
    const pad = "p".repeat(MAX_TASK_DATA_BYTES);
    const res = await createRaw(
      `{"principal_id":"test:size","participant_id":"participant-1","environment":{},"id":"proto","type":"task","created_by":"test","data":{"__proto__":"${pad}"}}`,
    );
    await expectTooLarge(res);
    expect(count("entities")).toBe(0);
  });

  it("refuses a 16 MiB value with 413, not a retryable 500", async () => {
    const res = await create("sixteen-mib", {
      description: "x".repeat(16 * 1024 * 1024),
    });
    const body = await expectTooLarge(res);
    expect(body.error.code).not.toBe("internal");
    expect(count("entities")).toBe(0);
  });

  it("does not index or tag a refused task", async () => {
    await expectTooLarge(
      await create("tagged", overByOne(), { tags: ["a", "b"] }),
    );
    expect(count("entity_tags")).toBe(0);
    expect(count("entity_search_docs")).toBe(0);
    expect(count("journal", "kind = 'entity.created'")).toBe(0);
  });
});

describe("POST /entity/update/:id merged task data bound", () => {
  async function seed(id: string, data: Record<string, unknown>) {
    expect((await create(id, data)).status).toBe(200);
    return acquire(id);
  }

  it("refuses a patch that is small but whose merge is over the limit", async () => {
    const existing = { a: "e".repeat(200_000) };
    const patch = { b: "p".repeat(100_000) };
    expect(taskDataBytes(existing)).toBeLessThan(MAX_TASK_DATA_BYTES);
    expect(taskDataBytes(patch)).toBeLessThan(MAX_TASK_DATA_BYTES);
    const fence = await seed("merge-over", existing);
    const before = rowCounts();
    const updatedAt = testDb.sqlite
      .prepare("SELECT updated_at FROM entities WHERE id = 'merge-over'")
      .get();

    await expectTooLarge(await update("merge-over", patch, fence));

    expect(storedData("merge-over")).toEqual(existing);
    expect(rowCounts()).toEqual(before);
    expect(count("journal", "kind = 'entity.updated'")).toBe(0);
    expect(
      testDb.sqlite
        .prepare("SELECT updated_at FROM entities WHERE id = 'merge-over'")
        .get(),
    ).toEqual(updatedAt);
    // The claim and fence are untouched: the same fence still writes.
    expect((await update("merge-over", { a: "small" }, fence)).status).toBe(
      200,
    );
  });

  it("accepts a merge that lands exactly on the limit", async () => {
    const fence = await seed("merge-at", { k: "x" });
    // {"k":"x","d":"…"}: frame 8 + `"k":"x",` 8 bytes → the rest is value.
    const patch = { d: "a".repeat(MAX_TASK_DATA_BYTES - 8 - 8) };
    const res = await update("merge-at", patch, fence);
    expect(res.status).toBe(200);
    expect(taskDataBytes(storedData("merge-at"))).toBe(MAX_TASK_DATA_BYTES);
    // One more byte through the same path is over.
    await expectTooLarge(
      await update("merge-at", { d: "a".repeat(patch.d.length + 1) }, fence),
    );
  });

  it("lets the patch replace a large field with a smaller one", async () => {
    const fence = await seed("replace", { a: "e".repeat(250_000) });
    // The patch alone is 150 KB, the merge is smaller than the original.
    const res = await update("replace", { a: "s".repeat(150_000) }, fence);
    expect(res.status).toBe(200);
  });

  describe("a task already over the limit", () => {
    const legacy = () => ({ big: "L".repeat(300_000), keep: "yes" });

    it("refuses growth", async () => {
      seedLegacy("legacy-grow", legacy());
      const fence = acquire("legacy-grow");
      const body = await expectTooLarge(
        await update("legacy-grow", { extra: "more" }, fence),
      );
      expect(body.error.message).toContain("must make it smaller");
      expect(storedData("legacy-grow")).toEqual(legacy());
    });

    it("refuses a same-size rewrite and a no-op patch", async () => {
      seedLegacy("legacy-same", legacy());
      const fence = acquire("legacy-same");
      await expectTooLarge(
        await update("legacy-same", { big: "M".repeat(300_000) }, fence),
      );
      await expectTooLarge(await update("legacy-same", {}, fence));
      expect(storedData("legacy-same")).toEqual(legacy());
    });

    it("allows a strictly smaller result that is still over the limit", async () => {
      seedLegacy("legacy-trim", legacy());
      const fence = acquire("legacy-trim");
      const res = await update(
        "legacy-trim",
        { big: "T".repeat(299_999) },
        fence,
      );
      expect(res.status).toBe(200);
      expect(taskDataBytes(storedData("legacy-trim"))).toBeGreaterThan(
        MAX_TASK_DATA_BYTES,
      );
      // And only ever smaller again: the previous size is now refused.
      await expectTooLarge(
        await update("legacy-trim", { big: "U".repeat(299_999) }, fence),
      );
    });

    it("allows trimming below the limit, after which the bound applies", async () => {
      seedLegacy("legacy-fit", legacy());
      const fence = acquire("legacy-fit");
      expect((await update("legacy-fit", { big: "small" }, fence)).status).toBe(
        200,
      );
      await expectTooLarge(
        await update("legacy-fit", { big: "G".repeat(300_000) }, fence),
      );
    });
  });
});
