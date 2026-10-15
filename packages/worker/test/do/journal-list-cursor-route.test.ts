import type { schema } from "@tila/ops-sqlite";
import { journalArchiveOps } from "@tila/ops-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinationRoutes } from "../../src/do/routes/coordination-routes";
import { installProjectErrorHandlers } from "../../src/do/routes/errors";
import type { RouterDeps } from "../../src/do/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

interface ListBody {
  ok: boolean;
  events: { seq: number; kind: string }[];
  archived: boolean;
  lastArchivedSeq: number | null;
}

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: vi.fn().mockReturnValue(undefined),
  };
}

function seedJournalRows(testDb: TestDb, count: number): void {
  const insert = testDb.sqlite.prepare(
    "INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, ?, ?, 'actor', '{}')",
  );
  const { head } = testDb.sqlite
    .prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM journal")
    .get() as { head: number };
  for (let i = 1; i <= count; i++) {
    const seq = head + i;
    insert.run(
      1_000 + seq,
      seq % 2 === 0 ? "claim.acquired" : "entity.created",
      `res-${seq}`,
    );
  }
}

let testDb: TestDb;
let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;
let app: Hono;

async function list(query: string): Promise<ListBody> {
  const res = await app.request(`/journal/list?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

/** Follow `after_seq` the way the dashboard tail does, one page per request. */
async function drain(
  start: number,
  limit: number,
  extra = "",
): Promise<{ pages: number[][]; flags: boolean[] }> {
  const pages: number[][] = [];
  const flags: boolean[] = [];
  let cursor = start;
  for (let guard = 0; guard < 1_000; guard++) {
    const body = await list(`after_seq=${cursor}&limit=${limit}${extra}`);
    const page = body.events.map((event) => event.seq);
    pages.push(page);
    flags.push(body.archived);
    if (page.length > 0) cursor = page[page.length - 1];
    if (page.length < limit) return { pages, flags };
  }
  throw new Error("cursor never reached the end of the journal");
}

function range(from: number, through: number): number[] {
  return Array.from({ length: through - from + 1 }, (_, i) => from + i);
}

beforeEach(() => {
  testDb = createTestDb();
  db = testDb.db;
  app = new Hono();
  installProjectErrorHandlers(app);
  app.route("/", createCoordinationRoutes(makeDeps(db)));
});

afterEach(() => {
  testDb.sqlite.close();
});

describe("GET /journal/list — after_seq cursor paging", () => {
  it("returns the next page after the cursor, oldest first", async () => {
    seedJournalRows(testDb, 300);

    const body = await list("after_seq=240&limit=2");

    expect(body.events.map((event) => event.seq)).toEqual([241, 242]);
    expect(body.archived).toBe(false);
  });

  it("keeps a no-cursor read newest first", async () => {
    seedJournalRows(testDb, 300);

    const body = await list("limit=3");

    expect(body.events.map((event) => event.seq)).toEqual([300, 299, 298]);
  });

  it("drains a 250-event burst over three pages with no gap or duplicate", async () => {
    seedJournalRows(testDb, 250);

    const { pages } = await drain(0, 100);

    expect(pages.map((page) => page.length)).toEqual([100, 100, 50]);
    expect(pages.flat()).toEqual(range(1, 250));
  });

  it("pages a comma-separated kind filter in order", async () => {
    seedJournalRows(testDb, 100);

    const { pages } = await drain(0, 20, "&kind=claim.acquired");

    expect(pages.flat()).toEqual(range(1, 50).map((n) => n * 2));
  });

  it("flags a cursor below the watermark archived and returns no live rows", async () => {
    seedJournalRows(testDb, 10);
    journalArchiveOps.markArchived(db, 4);

    const body = await list("after_seq=3&limit=3");

    expect(body).toMatchObject({
      ok: true,
      events: [],
      archived: true,
      lastArchivedSeq: 4,
    });
  });

  it("serves the first live page oldest first from a cursor at the watermark", async () => {
    seedJournalRows(testDb, 10);
    journalArchiveOps.markArchived(db, 4);

    const body = await list("after_seq=4&limit=3");

    expect(body.events.map((event) => event.seq)).toEqual([5, 6, 7]);
    expect(body.archived).toBe(false);
    expect(body.lastArchivedSeq).toBe(4);
  });

  it("drains the live range above the watermark without flagging it archived", async () => {
    seedJournalRows(testDb, 10);
    journalArchiveOps.markArchived(db, 4);

    const { pages, flags } = await drain(4, 4);

    expect(pages.flat()).toEqual(range(5, 10));
    expect(flags.every((archived) => !archived)).toBe(true);
  });
});
