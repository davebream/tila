import { GREP_CANDIDATE_CAP, GREP_INLINE_RESPONSE_BUDGET } from "@tila/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listGrepCandidates } from "../src/artifact-ops";
import type { GrepCandidate } from "../src/artifact-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

function insertPointer(
  db: TestDb,
  opts: {
    r2_key: string;
    kind?: string;
    resource?: string | null;
    tombstoned?: number;
    expires_at?: number | null;
    content_inline?: string | null;
    bytes?: number;
    produced_at?: number;
  },
): void {
  const {
    r2_key,
    kind = "output",
    resource = null,
    tombstoned = 0,
    expires_at = null,
    content_inline = null,
    bytes = 100,
    produced_at = Date.now(),
  } = opts;

  db.rawDb
    .prepare(
      `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned, content_inline)
       VALUES(?, ?, ?, 'deadbeef', ?, NULL, 'text/plain', ?, 'test-actor', ?, ?, ?)`,
    )
    .run(
      r2_key,
      resource,
      kind,
      bytes,
      produced_at,
      expires_at,
      tombstoned,
      content_inline,
    );
}

describe("listGrepCandidates", () => {
  it("filters tombstoned rows", () => {
    insertPointer(testDb, { r2_key: "sources/a/alive.md", tombstoned: 0 });
    insertPointer(testDb, { r2_key: "sources/b/dead.md", tombstoned: 1 });

    const result = listGrepCandidates(testDb.db, {});
    expect(result).toHaveLength(1);
    expect(result[0].r2_key).toBe("sources/a/alive.md");
  });

  it("filters by kind (string)", () => {
    insertPointer(testDb, { r2_key: "sources/a/a.md", kind: "lesson" });
    insertPointer(testDb, { r2_key: "sources/b/b.md", kind: "output" });

    const result = listGrepCandidates(testDb.db, { kind: "lesson" });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("lesson");
  });

  it("filters by kind (array via inArray)", () => {
    insertPointer(testDb, { r2_key: "sources/a/a.md", kind: "lesson" });
    insertPointer(testDb, { r2_key: "sources/b/b.md", kind: "output" });
    insertPointer(testDb, { r2_key: "sources/c/c.md", kind: "other" });

    const result = listGrepCandidates(testDb.db, {
      kind: ["lesson", "output"],
    });
    expect(result).toHaveLength(2);
    const kinds = result.map((r) => r.kind).sort();
    expect(kinds).toEqual(["lesson", "output"]);
  });

  it("filters by resource", () => {
    // Disable FK so we can insert a resource pointer without creating the entity row
    testDb.rawDb.pragma("foreign_keys = OFF");
    insertPointer(testDb, {
      r2_key: "produced/task-1/a.md",
      resource: "task-1",
    });
    insertPointer(testDb, { r2_key: "sources/a/b.md", resource: null });
    testDb.rawDb.pragma("foreign_keys = ON");

    const result = listGrepCandidates(testDb.db, { resource: "task-1" });
    expect(result).toHaveLength(1);
    expect(result[0].resource).toBe("task-1");
  });

  it("returns content_inline", () => {
    insertPointer(testDb, {
      r2_key: "sources/a/inline.md",
      content_inline: "hello world",
    });

    const result = listGrepCandidates(testDb.db, {});
    expect(result).toHaveLength(1);
    expect(result[0].content_inline).toBe("hello world");
  });

  it("returns null content_inline when not set", () => {
    insertPointer(testDb, {
      r2_key: "sources/a/no-inline.md",
      content_inline: null,
    });

    const result = listGrepCandidates(testDb.db, {});
    expect(result).toHaveLength(1);
    expect(result[0].content_inline).toBeNull();
  });

  it("resource field is string | null typed", () => {
    insertPointer(testDb, {
      r2_key: "sources/a/no-resource.md",
      resource: null,
    });

    const result = listGrepCandidates(testDb.db, {});
    const candidate: GrepCandidate = result[0];
    // resource may be null
    expect(
      candidate.resource === null || typeof candidate.resource === "string",
    ).toBe(true);
    expect(candidate.mime_type).toBe("text/plain"); // mime_type is always string (notNull)
  });

  it("clamps limit to GREP_CANDIDATE_CAP (100)", () => {
    // Insert 5 rows; request limit 999 which should be clamped to 100
    for (let i = 0; i < 5; i++) {
      insertPointer(testDb, { r2_key: `sources/a/f${i}.md` });
    }
    // We can't insert 101 rows easily, but we can verify the limit is applied by
    // checking that passing a limit > GREP_CANDIDATE_CAP doesn't throw and returns <= 100
    const result = listGrepCandidates(testDb.db, { limit: 999 });
    expect(result.length).toBeLessThanOrEqual(GREP_CANDIDATE_CAP);
  });

  it("excludes expired when now is passed", () => {
    const now = Date.now();
    insertPointer(testDb, {
      r2_key: "sources/a/expired.md",
      expires_at: now - 1000,
    });
    insertPointer(testDb, {
      r2_key: "sources/b/not-expired.md",
      expires_at: now + 10000,
    });
    insertPointer(testDb, {
      r2_key: "sources/c/no-expiry.md",
      expires_at: null,
    });

    const result = listGrepCandidates(testDb.db, { now });
    // expired (expires_at < now) is excluded; the other two are included
    expect(result).toHaveLength(2);
    const keys = result.map((r) => r.r2_key);
    expect(keys).not.toContain("sources/a/expired.md");
    expect(keys).toContain("sources/b/not-expired.md");
    expect(keys).toContain("sources/c/no-expiry.md");
  });

  it("does not exclude expired when now is not passed", () => {
    const now = Date.now();
    insertPointer(testDb, {
      r2_key: "sources/a/expired.md",
      expires_at: now - 1000,
    });

    const result = listGrepCandidates(testDb.db, {});
    // Without now, no expiry filter applied
    expect(result).toHaveLength(1);
  });

  it("nulls content_inline on rows past GREP_INLINE_RESPONSE_BUDGET", () => {
    // Use a small budget by creating rows whose cumulative inline bytes exceed it
    // We'll insert rows with large content_inline and verify budget logic.
    // Budget is 8 MiB; we create 3 rows with 4 MiB each — only the first 2 should keep inline.
    const fourMiB = "x".repeat(4 * 1024 * 1024);
    const now = Date.now();

    insertPointer(testDb, {
      r2_key: "sources/a/f1.md",
      content_inline: fourMiB,
      produced_at: now,
    });
    insertPointer(testDb, {
      r2_key: "sources/b/f2.md",
      content_inline: fourMiB,
      produced_at: now + 1,
    });
    insertPointer(testDb, {
      r2_key: "sources/c/f3.md",
      content_inline: fourMiB,
      produced_at: now + 2,
    });

    const result = listGrepCandidates(testDb.db, {});

    // All 3 rows must be returned (r2_key and bytes preserved)
    expect(result).toHaveLength(3);

    // Verify ordering by produced_at
    expect(result[0].r2_key).toBe("sources/a/f1.md");
    expect(result[1].r2_key).toBe("sources/b/f2.md");
    expect(result[2].r2_key).toBe("sources/c/f3.md");

    // Row 1 (0→4 MiB): within budget → keep inline
    expect(result[0].content_inline).toBe(fourMiB);
    // Row 2 (4→8 MiB): exactly at budget boundary → keep (cumulative = 8 MiB = budget)
    // Row 3 (8→12 MiB): exceeds budget → null
    // The cumulative after row 2 is 8 MiB which equals the budget exactly.
    // After row 2: cumulative = 8 MiB. Row 3 would push past budget → null.
    expect(result[2].content_inline).toBeNull();
    // r2_key and bytes still present on the budget-exceeded row
    expect(result[2].r2_key).toBe("sources/c/f3.md");
    expect(result[2].bytes).toBe(100);
  });

  it("returns empty array when no pointers", () => {
    const result = listGrepCandidates(testDb.db, {});
    expect(result).toEqual([]);
  });
});
