import type { schema } from "@tila/ops-sqlite";
import { coordinationOps } from "@tila/ops-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinationRoutes } from "../src/routes/coordination-routes";
import { installProjectErrorHandlers } from "../src/routes/errors";
import type { RouterDeps } from "../src/routes/types";
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
  app.route("/", createCoordinationRoutes(makeDeps(db)));
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

describe("POST /coord/release", () => {
  it("allows the current holder to release the claim", async () => {
    const claim = coordinationOps.acquire(
      db,
      "task:claim-1",
      {
        principalId: "test:holder",
        participantId: "holder",
        environment: { machine: "holder" },
        actor: "holder/holder",
      },
      "exclusive",
      60_000,
    );

    const res = await app.request("/coord/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "task:claim-1",
        fence: claim.fence,
        principal_id: "test:holder",
        participant_id: "holder",
        environment: { machine: "holder" },
        actor: "holder/holder",
      }),
    });

    expect(res.status).toBe(200);
    expect(coordinationOps.state(db, "task:claim-1")).toBeNull();
  });

  it("returns 403 release-ownership-denied for a non-holder", async () => {
    const claim = coordinationOps.acquire(
      db,
      "task:claim-1",
      {
        principalId: "test:holder",
        participantId: "holder",
        environment: { machine: "holder" },
        actor: "holder/holder",
      },
      "exclusive",
      60_000,
    );

    const res = await app.request("/coord/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "task:claim-1",
        fence: claim.fence,
        principal_id: "test:other",
        participant_id: "other",
        environment: { machine: "other" },
        actor: "other/other",
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("release-ownership-denied");
    expect(coordinationOps.state(db, "task:claim-1")).not.toBeNull();
  });
});
