import type { schema } from "@tila/ops-sqlite";
import { signalOps } from "@tila/ops-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProjectErrorHandlers } from "../src/routes/errors";
import { createSignalRoutes } from "../src/routes/signal-routes";
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
  app.route("/", createSignalRoutes(makeDeps(db)));
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

function ack(id: string, body: Record<string, unknown>) {
  return app.request(`/signal/${id}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /signal/:id/ack", () => {
  it("lets the addressee ack and consumes the signal", async () => {
    const { id } = signalOps.send(db, {
      target: "machine-B",
      kind: "info",
      created_by: "machine-A",
    });

    const res = await ack(id, { acker: "machine-B" });

    expect(res.status).toBe(200);
    expect(signalOps.inbox(db, "machine-B")).toHaveLength(0);
  });

  it("returns 403 forbidden when a non-addressee tries to ack, and leaves the signal in the inbox", async () => {
    const { id } = signalOps.send(db, {
      target: "machine-B",
      kind: "conflict",
      created_by: "machine-A",
    });

    const res = await ack(id, { acker: "machine-C" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
    // The real recipient still receives it.
    expect(signalOps.inbox(db, "machine-B")).toHaveLength(1);
  });

  it("returns 400 validation-error when acker is missing", async () => {
    const { id } = signalOps.send(db, {
      target: "machine-B",
      kind: "info",
      created_by: "machine-A",
    });

    const res = await ack(id, {});

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 404 not-found for an unknown signal id", async () => {
    const res = await ack("sig_nonexistent", { acker: "machine-B" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not-found");
  });
});
