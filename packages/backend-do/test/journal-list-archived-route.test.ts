import type { schema } from "@tila/ops-sqlite";
import { journalArchiveOps } from "@tila/ops-sqlite";
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

function seedJournalRows(testDb: TestDb, count: number): void {
  const ts = Date.now() - 60_000;
  for (let i = 0; i < count; i++) {
    testDb.sqlite
      .prepare(
        `INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, 'task.created', 'res-${i}', 'actor', '{}')`,
      )
      .run(ts);
  }
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

describe("GET /journal/list — archived range indicator", () => {
  it("signals archived=true when after_seq is below the archival watermark", async () => {
    seedJournalRows(testDb, 5);
    // Archive through seq=5, advancing the watermark and deleting those rows.
    journalArchiveOps.markArchived(db, 5);

    const res = await app.request("/journal/list?after_seq=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      events: unknown[];
      archived: boolean;
      lastArchivedSeq: number | null;
    };
    expect(body.ok).toBe(true);
    expect(body.archived).toBe(true);
    expect(body.lastArchivedSeq).toBe(5);
    // The archived range returns no live events, but the indicator distinguishes
    // it from a genuine "caught up" empty read.
    expect(body.events).toHaveLength(0);
  });

  it("signals archived=false for an in-range cursor read", async () => {
    seedJournalRows(testDb, 5);
    journalArchiveOps.markArchived(db, 2);
    // 3 rows (seq 3,4,5) survive; reading after seq=4 is fully in-range.
    const res = await app.request("/journal/list?after_seq=4");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      events: unknown[];
      archived: boolean;
      lastArchivedSeq: number | null;
    };
    expect(body.archived).toBe(false);
    expect(body.lastArchivedSeq).toBe(2);
    expect(body.events).toHaveLength(1);
  });

  it("recent {limit:N} reads with no cursor are never flagged archived", async () => {
    seedJournalRows(testDb, 5);
    journalArchiveOps.markArchived(db, 5);

    const res = await app.request("/journal/list?limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      events: unknown[];
      archived: boolean;
      lastArchivedSeq: number | null;
    };
    expect(body.archived).toBe(false);
    expect(body.lastArchivedSeq).toBe(5);
  });
});
