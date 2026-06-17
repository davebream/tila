import type Database from "better-sqlite3";
/**
 * Tests for the journal-archive DO routes that back the Worker sweep's
 * archival step (Task 8 / PR16).
 *
 * The Worker forms a UNIQUE R2 object key per archive batch by appending the
 * batch's `throughSeq` to the key. That uniqueness is only safe if the DO
 * guarantees: each successful archive→confirm cycle returns a strictly
 * INCREASING `throughSeq` over a DISJOINT range of journal rows (the prior
 * batch's rows are deleted and the watermark advances monotonically). These
 * tests pin that contract end-to-end through the HTTP route, so the Worker can
 * rely on `throughSeq` as a collision-free key discriminator across runs.
 */
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { schema } from "../../ops-sqlite/src";
import { createJournalArchiveRoutes } from "../src/routes/journal-archive-routes";
import type { RouterDeps } from "../src/routes/types";
import { createTestDb } from "./helpers/create-test-db";

function makeDeps(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: vi.fn() as RouterDeps["enrichOpts"],
  };
}

let rawDb: InstanceType<typeof Database>;
let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;

beforeEach(() => {
  const testDb = createTestDb();
  rawDb = testDb.sqlite;
  db = testDb.db;
});

afterEach(() => {
  rawDb.close();
});

/** Insert a journal row with an explicit timestamp `t` (ms). */
function insertEvent(t: number, kind = "task.created"): void {
  rawDb
    .prepare(
      "INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, ?, 'res', 'tester', '{}')",
    )
    .run(t, kind);
}

interface ArchiveResponse {
  ok: boolean;
  events: Array<{ seq: number; t: number }>;
  throughSeq: number;
  count: number;
}

describe("journal-archive routes — batch disjointness contract", () => {
  it("returns a strictly increasing throughSeq over disjoint ranges across two archive cycles", async () => {
    // 90-day-old events so they clear the route's MAX_AGE_MS threshold.
    const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
    insertEvent(old + 1); // seq 1
    insertEvent(old + 2); // seq 2
    insertEvent(old + 3); // seq 3

    const app = createJournalArchiveRoutes(makeDeps(db));

    // --- Cycle 1: archive seq 1..3 ---
    const res1 = await app.request("/journal/archive", { method: "POST" });
    expect(res1.status).toBe(200);
    const batch1 = (await res1.json()) as ArchiveResponse;
    expect(batch1.count).toBe(3);
    expect(batch1.throughSeq).toBe(3);
    const seqs1 = batch1.events.map((e) => e.seq);

    // Confirm → rows <= 3 deleted, watermark advances to 3.
    const confirm1 = await app.request("/journal/archive/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ throughSeq: batch1.throughSeq }),
    });
    expect(confirm1.status).toBe(200);

    // New events arrive AFTER cycle 1 (same calendar period in the Worker's
    // key grouping, but a strictly higher seq range).
    insertEvent(old + 4); // seq 4
    insertEvent(old + 5); // seq 5

    // --- Cycle 2: archive seq 4..5 ---
    const res2 = await app.request("/journal/archive", { method: "POST" });
    const batch2 = (await res2.json()) as ArchiveResponse;
    expect(batch2.count).toBe(2);
    const seqs2 = batch2.events.map((e) => e.seq);

    // The two batches' throughSeq values differ and increase monotonically.
    expect(batch2.throughSeq).toBeGreaterThan(batch1.throughSeq);

    // Ranges are disjoint — no seq appears in both batches.
    const overlap = seqs1.filter((s) => seqs2.includes(s));
    expect(overlap).toHaveLength(0);
  });

  it("re-archives nothing after confirm (idempotent watermark)", async () => {
    const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
    insertEvent(old + 1);
    insertEvent(old + 2);

    const app = createJournalArchiveRoutes(makeDeps(db));

    const res1 = await app.request("/journal/archive", { method: "POST" });
    const batch1 = (await res1.json()) as ArchiveResponse;
    await app.request("/journal/archive/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ throughSeq: batch1.throughSeq }),
    });

    // No new events; a second archive call must return an empty batch.
    const res2 = await app.request("/journal/archive", { method: "POST" });
    const batch2 = (await res2.json()) as ArchiveResponse;
    expect(batch2.count).toBe(0);
    expect(batch2.throughSeq).toBe(0);
  });
});
