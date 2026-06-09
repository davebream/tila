/**
 * Tests for POST /search/reindex DO route body parsing (issue #412).
 *
 * The DO handler must:
 * - Return 400 validation-error for an empty/missing body
 * - NOT throw / 500 when no JSON body is provided
 *
 * The valid-body 2xx path is tested in the integration suite
 * (packages/integration-tests/src/search.test.ts) because the DO handler
 * calls ctx.storage.put/setAlarm which throws on the {ctx: {} as DurableObjectState}
 * harness stub — the 400 path returns before touching storage, so it is runnable here.
 */
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { schema } from "../../ops-sqlite/src";
import { createArtifactRoutes } from "../src/routes/artifact-routes";
import type { RouterDeps } from "../src/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: vi.fn() as RouterDeps["enrichOpts"],
  };
}

let testDb: TestDb;
let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;

beforeEach(() => {
  testDb = createTestDb();
  db = testDb.db;
});

afterEach(() => {
  testDb.sqlite.close();
});

describe("POST /search/reindex -- body validation (issue #412)", () => {
  it("returns 400 (not 500) for /search/reindex with empty body", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/search/reindex", { method: "POST" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("validation-error");
  });

  it("returns 400 for /search/reindex with invalid JSON body", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/search/reindex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("validation-error");
  });

  it("returns 400 for /search/reindex with missing kind field", async () => {
    const app = createArtifactRoutes(makeDeps(db));
    const res = await app.request("/search/reindex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "unknown" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("validation-error");
  });
});
