import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getArchivableEvents,
  getArchiveWatermark,
  markArchived,
} from "../src/journal-archive-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

describe("getArchiveWatermark", () => {
  it("returns null on fresh DB with no archival", () => {
    const watermark = getArchiveWatermark(testDb.db);
    expect(watermark).toBeNull();
  });

  it("returns watermark values after markArchived", () => {
    // Insert an event
    testDb.rawDb.exec(
      "INSERT INTO journal (t, kind, resource, actor, data) VALUES (1000, 'task.created', 'res-1', 'actor', '{}')",
    );

    // Mark it as archived
    markArchived(testDb.db, 1);

    const watermark = getArchiveWatermark(testDb.db);
    expect(watermark).not.toBeNull();
    expect(watermark?.lastArchivedSeq).toBe(1);
    expect(watermark?.archivedAt).toBeTypeOf("number");
    expect(watermark?.archivedAt).toBeGreaterThan(0);
  });
});

describe("getArchivableEvents", () => {
  it("returns empty result when no events exist", () => {
    const result = getArchivableEvents(testDb.db, {
      maxAgeMs: 1000,
      maxRows: 100,
    });
    expect(result.events).toHaveLength(0);
    expect(result.throughSeq).toBe(0);
  });

  it("selects only events older than maxAgeMs threshold", () => {
    const now = Date.now();
    const oldTs = now - 10_000; // 10 seconds ago
    const newTs = now - 500; // 500ms ago

    // Insert old event
    testDb.rawDb
      .prepare(
        "INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, 'task.created', 'old-res', 'actor', '{}')",
      )
      .run(oldTs);

    // Insert recent event
    testDb.rawDb
      .prepare(
        "INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, 'task.updated', 'new-res', 'actor', '{}')",
      )
      .run(newTs);

    const result = getArchivableEvents(testDb.db, { maxAgeMs: 5000 });
    // Only the event older than 5s should appear
    expect(result.events).toHaveLength(1);
    expect(result.events[0].resource).toBe("old-res");
    expect(result.throughSeq).toBe(result.events[0].seq);
  });

  it("returns empty when all events are newer than maxAgeMs", () => {
    const now = Date.now();
    testDb.rawDb
      .prepare(
        "INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, 'task.created', 'res-1', 'actor', '{}')",
      )
      .run(now - 100);

    const result = getArchivableEvents(testDb.db, { maxAgeMs: 5000 });
    expect(result.events).toHaveLength(0);
    expect(result.throughSeq).toBe(0);
  });

  it("archives excess rows when journal size exceeds maxRows cap", () => {
    // Insert 10 old events
    const oldTs = Date.now() - 60_000;
    for (let i = 0; i < 10; i++) {
      testDb.rawDb
        .prepare(
          `INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, 'task.created', 'res-${i}', 'actor', '{}')`,
        )
        .run(oldTs);
    }

    // maxRows=3 means the target cap is 3 rows. With 10 total, 7 (excess) must be archived.
    const result = getArchivableEvents(testDb.db, {
      maxAgeMs: 30_000,
      maxRows: 3,
    });
    // 10 total - 3 maxRows = 7 excess rows to archive
    expect(result.events).toHaveLength(7);
    // throughSeq should be the highest seq in the returned batch
    const maxSeq = Math.max(...result.events.map((e) => e.seq));
    expect(result.throughSeq).toBe(maxSeq);
  });

  it("throughSeq is the highest seq in the returned batch", () => {
    const oldTs = Date.now() - 60_000;
    for (let i = 0; i < 5; i++) {
      testDb.rawDb
        .prepare(
          `INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, 'task.created', 'res-${i}', 'actor', '{}')`,
        )
        .run(oldTs);
    }

    const result = getArchivableEvents(testDb.db, { maxAgeMs: 30_000 });
    expect(result.events).toHaveLength(5);
    const maxSeq = Math.max(...result.events.map((e) => e.seq));
    expect(result.throughSeq).toBe(maxSeq);
  });
});

describe("markArchived", () => {
  it("updates watermark and deletes archived events atomically", () => {
    const oldTs = Date.now() - 60_000;
    for (let i = 0; i < 3; i++) {
      testDb.rawDb
        .prepare(
          `INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, 'task.created', 'res-${i}', 'actor', '{}')`,
        )
        .run(oldTs);
    }

    // Add a recent event that should NOT be deleted
    testDb.rawDb.exec(
      "INSERT INTO journal (t, kind, resource, actor, data) VALUES (9999999999999, 'task.updated', 'res-recent', 'actor', '{}')",
    );

    // Archive through seq=3 (first 3 events)
    markArchived(testDb.db, 3);

    // Watermark should be updated
    const watermark = getArchiveWatermark(testDb.db);
    expect(watermark).not.toBeNull();
    expect(watermark?.lastArchivedSeq).toBe(3);

    // Journal should only have the recent event
    const remaining = testDb.rawDb
      .prepare("SELECT seq FROM journal ORDER BY seq")
      .all() as { seq: number }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].seq).toBe(4);
  });

  it("is idempotent — calling twice with same throughSeq is safe", () => {
    testDb.rawDb.exec(
      "INSERT INTO journal (t, kind, resource, actor, data) VALUES (1000, 'task.created', 'res-1', 'actor', '{}')",
    );

    markArchived(testDb.db, 1);
    // Second call should not throw
    expect(() => markArchived(testDb.db, 1)).not.toThrow();

    const watermark = getArchiveWatermark(testDb.db);
    expect(watermark?.lastArchivedSeq).toBe(1);

    // Journal should be empty
    const remaining = testDb.rawDb.prepare("SELECT seq FROM journal").all() as {
      seq: number;
    }[];
    expect(remaining).toHaveLength(0);
  });

  it("does not overwrite watermark when called with a lower throughSeq", () => {
    // Insert and archive 5 events
    const oldTs = Date.now() - 60_000;
    for (let i = 0; i < 5; i++) {
      testDb.rawDb
        .prepare(
          `INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, 'task.created', 'res-${i}', 'actor', '{}')`,
        )
        .run(oldTs);
    }
    markArchived(testDb.db, 5);

    // Insert new events
    testDb.rawDb.exec(
      "INSERT INTO journal (t, kind, resource, actor, data) VALUES (9999999999999, 'task.updated', 'res-new', 'actor', '{}')",
    );

    // Calling with seq=3 (below current watermark of 5) should be a no-op for watermark
    markArchived(testDb.db, 3);

    const watermark = getArchiveWatermark(testDb.db);
    // Watermark must not go backward
    expect(watermark?.lastArchivedSeq).toBeGreaterThanOrEqual(5);
  });

  it("deletes only rows up to the PASSED throughSeq, never down to the watermark", () => {
    // Latent-trap guard: markArchived advances the watermark monotonically
    // (max(current, throughSeq)) but must DELETE only what was archived THIS
    // cycle — i.e. seq <= the PASSED throughSeq — never seq <= watermark.
    // Otherwise a call with a throughSeq BELOW the watermark would delete rows
    // in the (throughSeq, watermark] gap that were never written to R2 this
    // cycle. (Unreachable via the sweep today, since it always confirms with the
    // throughSeq it just wrote, but a real correctness trap.)
    const oldTs = Date.now() - 60_000;
    for (let i = 0; i < 5; i++) {
      testDb.rawDb
        .prepare(
          `INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, 'task.created', 'res-${i}', 'actor', '{}')`,
        )
        .run(oldTs);
    }
    // Advance the watermark to 5 (this deletes seq 1..5).
    markArchived(testDb.db, 5);

    // Plant a DELETABLE row whose seq (4) falls in the (throughSeq=3, watermark=5]
    // gap. Explicit low seq simulates the hazard the buggy "delete <= watermark"
    // would wrongly hit. (Previously this test masked the bug by using a
    // non-deletable far-future row; this row is fully eligible by both seq and t.)
    testDb.rawDb
      .prepare(
        `INSERT INTO journal (seq, t, kind, resource, actor, data) VALUES (4, ?, 'task.updated', 'gap-row', 'actor', '{}')`,
      )
      .run(oldTs);

    // Stale call with a throughSeq (3) BELOW the current watermark (5).
    markArchived(testDb.db, 3);

    // The gap row (seq 4) must SURVIVE: it was not archived in this cycle, so
    // deleting it would lose an un-backed-up event. The fixed code deletes only
    // seq < throughSeq + 1 = 4, so seq 4 is preserved.
    const gapRow = testDb.rawDb
      .prepare("SELECT seq FROM journal WHERE seq = 4")
      .get() as { seq: number } | undefined;
    expect(gapRow).toBeDefined();
    expect(gapRow?.seq).toBe(4);

    // And the watermark still must not regress below 5.
    const watermark = getArchiveWatermark(testDb.db);
    expect(watermark?.lastArchivedSeq).toBeGreaterThanOrEqual(5);
  });
});
