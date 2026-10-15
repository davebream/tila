import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getArchiveWatermark, markArchived } from "../src/journal-archive-ops";
import { journalArchiveState, listJournal } from "../src/journal-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.rawDb.close();
});

/** Append `count` rows; kind and resource are derived from the 1-based index. */
function seed(
  count: number,
  shape: {
    kind?: (n: number) => string;
    resource?: (n: number) => string;
  } = {},
): void {
  const insert = testDb.rawDb.prepare(
    "INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, ?, ?, 'actor', '{}')",
  );
  const base = testDb.rawDb
    .prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM journal")
    .get() as { head: number };
  for (let i = 1; i <= count; i++) {
    const n = base.head + i;
    insert.run(
      1_000 + n,
      shape.kind?.(n) ?? "entity.created",
      shape.resource?.(n) ?? `res-${n}`,
    );
  }
}

function seqs(rows: { seq: number }[]): number[] {
  return rows.map((row) => row.seq);
}

function range(from: number, through: number): number[] {
  return Array.from({ length: through - from + 1 }, (_, i) => from + i);
}

/** Follow the cursor the way a client does until a page comes back short. */
function drain(
  query: Parameters<typeof listJournal>[1],
  start: number,
  watermark?: { lastArchivedSeq: number },
): { pages: number[][]; cursor: number } {
  const limit = query.limit ?? 100;
  const pages: number[][] = [];
  let cursor = start;
  for (let guard = 0; guard < 1_000; guard++) {
    const page = seqs(
      listJournal(testDb.db, { ...query, after_seq: cursor }, watermark),
    );
    pages.push(page);
    if (page.length > 0) cursor = page[page.length - 1];
    if (page.length < limit) return { pages, cursor };
  }
  throw new Error("cursor never reached the end of the journal");
}

describe("listJournal without a cursor", () => {
  it("returns the newest page, newest first", () => {
    seed(10);

    expect(seqs(listJournal(testDb.db, { limit: 3 }))).toEqual([10, 9, 8]);
  });

  it("keeps newest-first order for filtered reads", () => {
    seed(10, {
      kind: (n) => (n % 2 === 0 ? "claim.acquired" : "entity.created"),
    });

    expect(
      seqs(listJournal(testDb.db, { kind: "claim.acquired", limit: 3 })),
    ).toEqual([10, 8, 6]);
  });
});

describe("listJournal with an after_seq cursor", () => {
  it("returns the next contiguous page oldest first, not the newest page", () => {
    seed(10);

    const page = listJournal(testDb.db, { after_seq: 2, limit: 3 });

    expect(seqs(page)).toEqual([3, 4, 5]);
  });

  it("returns events strictly after the cursor", () => {
    seed(5);

    expect(seqs(listJournal(testDb.db, { after_seq: 3 }))).toEqual([4, 5]);
  });

  it("treats after_seq 0 as a cursor at the start of the journal", () => {
    seed(5);

    expect(seqs(listJournal(testDb.db, { after_seq: 0, limit: 2 }))).toEqual([
      1, 2,
    ]);
  });

  it("returns an empty page when the cursor is at or beyond the head", () => {
    seed(5);

    expect(listJournal(testDb.db, { after_seq: 5 })).toEqual([]);
    expect(listJournal(testDb.db, { after_seq: 50 })).toEqual([]);
  });

  it("drains a burst of more than two pages without gaps or duplicates", () => {
    seed(250);

    const { pages, cursor } = drain({ limit: 100 }, 0);

    expect(pages.map((page) => page.length)).toEqual([100, 100, 50]);
    expect(pages.flat()).toEqual(range(1, 250));
    expect(cursor).toBe(250);
  });

  it("ends on an empty page when the burst is an exact multiple of the limit", () => {
    seed(200);

    const { pages } = drain({ limit: 100 }, 0);

    expect(pages.map((page) => page.length)).toEqual([100, 100, 0]);
    expect(pages.flat()).toEqual(range(1, 200));
  });

  it("starts the drain from a mid-journal cursor", () => {
    seed(250);

    const { pages } = drain({ limit: 100 }, 120);

    expect(pages.flat()).toEqual(range(121, 250));
  });

  it("picks up rows appended while the client is between pages", () => {
    seed(150);
    const first = seqs(listJournal(testDb.db, { after_seq: 0, limit: 100 }));
    seed(120); // Writers keep going: seq 151..270.

    const { pages } = drain({ limit: 100 }, first[first.length - 1]);

    expect([...first, ...pages.flat()]).toEqual(range(1, 270));
  });

  it("pages a filtered read in order, skipping rows that do not match", () => {
    seed(300, {
      kind: (n) => (n % 3 === 0 ? "claim.acquired" : "entity.updated"),
    });

    const { pages } = drain({ kind: "claim.acquired", limit: 40 }, 0);

    expect(pages.map((page) => page.length)).toEqual([40, 40, 20]);
    expect(pages.flat()).toEqual(range(1, 100).map((n) => n * 3));
  });

  it("pages a multi-resource read in order without gaps", () => {
    seed(90, { resource: (n) => `r${n % 3}` });

    const { pages } = drain({ resource: ["r0", "r2"], limit: 25 }, 0);

    expect(pages.flat()).toEqual(range(1, 90).filter((n) => n % 3 !== 1));
  });

  it("pages custom-report filters in order", () => {
    seed(30, { kind: () => "custom.reported" });
    const insert = testDb.rawDb.prepare(
      "UPDATE journal SET data = ? WHERE seq = ?",
    );
    for (const n of range(1, 30)) {
      insert.run(
        JSON.stringify({
          event_name: n % 2 === 0 ? "tests.passed" : "tests.failed",
          correlation_id: "run-1",
        }),
        n,
      );
    }

    const { pages } = drain(
      { event_name: "tests.passed", correlation_id: "run-1", limit: 4 },
      0,
    );

    expect(pages.flat()).toEqual(range(1, 15).map((n) => n * 2));
  });
});

describe("listJournal cursor against the archive watermark", () => {
  // seq 1..4 archived and deleted; seq 5..10 remain live.
  beforeEach(() => {
    seed(10);
    markArchived(testDb.db, 4);
  });

  it("returns no live rows for a cursor below the watermark and flags it archived", () => {
    const watermark = getArchiveWatermark(testDb.db);
    if (!watermark) throw new Error("watermark was not recorded");

    expect(listJournal(testDb.db, { after_seq: 3 }, watermark)).toEqual([]);
    expect(journalArchiveState(3, watermark)).toEqual({
      archived: true,
      lastArchivedSeq: 4,
    });
  });

  it("serves the first live page, oldest first, from a cursor exactly at the watermark", () => {
    const watermark = getArchiveWatermark(testDb.db);
    if (!watermark) throw new Error("watermark was not recorded");

    expect(
      seqs(listJournal(testDb.db, { after_seq: 4, limit: 3 }, watermark)),
    ).toEqual([5, 6, 7]);
    expect(journalArchiveState(4, watermark).archived).toBe(false);
  });

  it("drains every live row from the watermark without gaps or duplicates", () => {
    const watermark = getArchiveWatermark(testDb.db);
    if (!watermark) throw new Error("watermark was not recorded");

    const { pages } = drain({ limit: 4 }, 4, watermark);

    expect(pages.flat()).toEqual(range(5, 10));
  });

  it("does not let a cursor just under the watermark skip the archived range", () => {
    const watermark = getArchiveWatermark(testDb.db);
    if (!watermark) throw new Error("watermark was not recorded");

    // One below the watermark: seq 4 is archived, so list must not silently
    // jump to seq 5 and hide the gap; the caller is told to use replay.
    const page = listJournal(testDb.db, { after_seq: 3, limit: 3 }, watermark);

    expect(page).toEqual([]);
    expect(journalArchiveState(3, watermark).archived).toBe(true);
  });

  it("leaves a no-cursor read newest first and unflagged", () => {
    const watermark = getArchiveWatermark(testDb.db);
    if (!watermark) throw new Error("watermark was not recorded");

    expect(seqs(listJournal(testDb.db, { limit: 3 }, watermark))).toEqual([
      10, 9, 8,
    ]);
    expect(journalArchiveState(undefined, watermark).archived).toBe(false);
  });
});
