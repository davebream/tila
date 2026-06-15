/**
 * Tests for artifact-ops tag plumbing (Phase 4).
 *
 * Covers:
 * - upsertPointer with tags: persists, normalises (lowercase/dedup via TagsSchema)
 * - getLatestPointer / listPointers return tags
 * - Re-upsert same r2_key: with tags REPLACES; with tags===undefined PRESERVES
 * - deleteTombstonedPointers: leaves NO orphan artifact_tags rows (FK-OFF mode,
 *   proving the EXPLICIT delete, not ON DELETE CASCADE)
 * - ops-layer `tag` filter on listPointers returns only matching pointers
 * - invalid-tag rejection + >20 cap (negative paths)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteTombstonedPointers,
  listPointers,
  upsertPointer,
} from "../src/artifact-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

const origin = { actor: "test-actor" };

function makePointer(r2Key: string, opts?: { resource?: string | null }) {
  return {
    r2_key: r2Key,
    resource: opts?.resource ?? null,
    kind: "output",
    sha256: `sha256-${r2Key.replace(/\//g, "-")}`,
    bytes: 100,
    fence: null,
    mime_type: "text/plain",
    produced_at: Date.now(),
    produced_by: "test-actor",
    expires_at: null,
  };
}

// Helper to get a pointer by r2_key directly (for source artifacts with resource=null)
function getPointerByKey(r2Key: string) {
  const rows = listPointers(testDb.db, {});
  return rows.find((p) => p.r2_key === r2Key) ?? null;
}

// -------------------------------------------------------------------------
// upsert with tags
// -------------------------------------------------------------------------
describe("upsertPointer with tags", () => {
  it("persists tags and normalizes to lowercase", () => {
    const r2Key = "artifacts/p1/file.txt";
    upsertPointer(
      testDb.db,
      makePointer(r2Key),
      origin,
      undefined,
      undefined,
      false,
      ["Env:Prod", "team:Platform"],
    );

    const pointer = getPointerByKey(r2Key);
    expect(pointer).not.toBeNull();
    expect(pointer?.tags).toEqual(
      expect.arrayContaining(["env:prod", "team:platform"]),
    );
    expect(pointer?.tags).toHaveLength(2);
  });

  it("deduplicates case-insensitive tags", () => {
    const r2Key = "artifacts/p2/file.txt";
    upsertPointer(
      testDb.db,
      makePointer(r2Key),
      origin,
      undefined,
      undefined,
      false,
      ["env:prod", "ENV:PROD", "Env:Prod"],
    );

    const pointer = getPointerByKey(r2Key);
    expect(pointer?.tags).toEqual(["env:prod"]);
  });

  it("upsert without tags returns empty tags array", () => {
    const r2Key = "artifacts/p3/file.txt";
    upsertPointer(testDb.db, makePointer(r2Key), origin);

    const pointer = getPointerByKey(r2Key);
    expect(pointer?.tags).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// re-upsert semantics (same r2_key)
// -------------------------------------------------------------------------
describe("re-upsert same r2_key tag semantics", () => {
  it("re-upsert with tags=[] replaces (clears) existing tags", () => {
    const r2Key = "artifacts/reup1/file.txt";
    upsertPointer(
      testDb.db,
      makePointer(r2Key),
      origin,
      undefined,
      undefined,
      false,
      ["env:prod"],
    );

    // Re-upsert same key with tags=[] → should clear
    upsertPointer(
      testDb.db,
      makePointer(r2Key),
      origin,
      undefined,
      undefined,
      false,
      [],
    );

    const pointer = getPointerByKey(r2Key);
    expect(pointer?.tags).toEqual([]);
  });

  it("re-upsert with new tags replaces existing tags", () => {
    const r2Key = "artifacts/reup2/file.txt";
    upsertPointer(
      testDb.db,
      makePointer(r2Key),
      origin,
      undefined,
      undefined,
      false,
      ["env:prod", "team:alpha"],
    );

    upsertPointer(
      testDb.db,
      makePointer(r2Key),
      origin,
      undefined,
      undefined,
      false,
      ["env:staging"],
    );

    const pointer = getPointerByKey(r2Key);
    expect(pointer?.tags).toEqual(["env:staging"]);
  });

  it("re-upsert with tags===undefined PRESERVES existing tags", () => {
    const r2Key = "artifacts/reup3/file.txt";
    upsertPointer(
      testDb.db,
      makePointer(r2Key),
      origin,
      undefined,
      undefined,
      false,
      ["env:prod"],
    );

    // Re-upsert same key with tags omitted → should preserve
    upsertPointer(testDb.db, makePointer(r2Key), origin);

    const pointer = getPointerByKey(r2Key);
    expect(pointer?.tags).toEqual(["env:prod"]);
  });
});

// -------------------------------------------------------------------------
// listPointers returns tags
// -------------------------------------------------------------------------
describe("listPointers returns tags", () => {
  it("batch-enriches tags for multiple pointers (no N+1)", () => {
    upsertPointer(
      testDb.db,
      makePointer("artifacts/list1/a.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["team:alpha"],
    );
    upsertPointer(
      testDb.db,
      makePointer("artifacts/list1/b.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["team:beta", "env:staging"],
    );

    const pointers = listPointers(testDb.db, {});
    const a = pointers.find((p) => p.r2_key === "artifacts/list1/a.txt");
    const b = pointers.find((p) => p.r2_key === "artifacts/list1/b.txt");
    expect(a?.tags).toEqual(["team:alpha"]);
    expect(b?.tags).toEqual(
      expect.arrayContaining(["team:beta", "env:staging"]),
    );
    expect(b?.tags).toHaveLength(2);
  });

  it("pointers with no tags return empty array", () => {
    upsertPointer(testDb.db, makePointer("artifacts/list2/notags.txt"), origin);

    const pointers = listPointers(testDb.db, {});
    const p = pointers.find((p) => p.r2_key === "artifacts/list2/notags.txt");
    expect(p?.tags).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// ops-layer tag filter
// -------------------------------------------------------------------------
describe("listPointers tag filter", () => {
  it("returns only pointers matching the tag", () => {
    upsertPointer(
      testDb.db,
      makePointer("artifacts/filter1/a.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["env:prod"],
    );
    upsertPointer(
      testDb.db,
      makePointer("artifacts/filter1/b.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["env:staging"],
    );

    const result = listPointers(testDb.db, { tag: "env:prod" });
    expect(result).toHaveLength(1);
    expect(result[0].r2_key).toBe("artifacts/filter1/a.txt");
  });

  it("returns empty array when no pointers match the tag", () => {
    upsertPointer(
      testDb.db,
      makePointer("artifacts/filter2/a.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["env:prod"],
    );

    const result = listPointers(testDb.db, { tag: "team:unknown" });
    expect(result).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------
// deleteTombstonedPointers: CRITICAL no-orphan test (FK-OFF)
// -------------------------------------------------------------------------
describe("deleteTombstonedPointers: no orphan artifact_tags (FK-OFF)", () => {
  it("removes artifact_tags for deleted pointers even when FK enforcement is OFF", () => {
    const now = Date.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;

    // Insert a pointer with tags that will be hard-deleted
    const r2KeyOld = "artifacts/gc1/old.bin";
    upsertPointer(
      testDb.db,
      { ...makePointer(r2KeyOld) },
      origin,
      undefined,
      undefined,
      false,
      ["env:prod", "team:alpha"],
    );

    // Manually set tombstoned=1 + tombstoned_at past the cutoff
    testDb.rawDb
      .prepare(
        "UPDATE artifact_pointers SET tombstoned = 1, tombstoned_at = ? WHERE r2_key = ?",
      )
      .run(cutoff - 1000, r2KeyOld);

    // Insert a LIVE pointer with tags — must NOT be affected
    const r2KeyLive = "artifacts/gc1/live.bin";
    upsertPointer(
      testDb.db,
      { ...makePointer(r2KeyLive) },
      origin,
      undefined,
      undefined,
      false,
      ["env:staging"],
    );

    // CRITICAL: turn FK enforcement OFF to replicate DO production reality.
    // With FK ON, ON DELETE CASCADE would fire and give a FALSE GREEN.
    // This asserts the EXPLICIT delete in deleteTombstonedPointers, not cascade.
    testDb.rawDb.pragma("foreign_keys = OFF");

    const deleted = deleteTombstonedPointers(testDb.db, cutoff);
    expect(deleted).toBe(1);

    // Verify the pointer row is gone
    const pointerRow = testDb.rawDb
      .prepare("SELECT r2_key FROM artifact_pointers WHERE r2_key = ?")
      .get(r2KeyOld);
    expect(pointerRow).toBeUndefined();

    // CRITICAL: verify NO orphan artifact_tags rows remain for the deleted key
    const orphanTags = testDb.rawDb
      .prepare("SELECT COUNT(*) AS n FROM artifact_tags WHERE artifact_key = ?")
      .get(r2KeyOld) as { n: number };
    expect(orphanTags.n).toBe(0);

    // Restore FK ON and verify live pointer's tags are intact
    testDb.rawDb.pragma("foreign_keys = ON");

    const liveTags = testDb.rawDb
      .prepare("SELECT COUNT(*) AS n FROM artifact_tags WHERE artifact_key = ?")
      .get(r2KeyLive) as { n: number };
    expect(liveTags.n).toBe(1);
  });
});

// -------------------------------------------------------------------------
// Negative paths: invalid tags + >20 cap
// -------------------------------------------------------------------------
describe("tag validation (negative paths)", () => {
  it("rejects a tag with invalid characters (space inside tag)", () => {
    expect(() =>
      upsertPointer(
        testDb.db,
        makePointer("artifacts/badtag1/file.txt"),
        origin,
        undefined,
        undefined,
        false,
        ["bad tag!"],
      ),
    ).toThrow();
  });

  it("rejects a tag starting with a hyphen", () => {
    expect(() =>
      upsertPointer(
        testDb.db,
        makePointer("artifacts/badtag2/file.txt"),
        origin,
        undefined,
        undefined,
        false,
        ["-leading-hyphen"],
      ),
    ).toThrow();
  });

  it("rejects more than 20 tags", () => {
    const tooManyTags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    expect(() =>
      upsertPointer(
        testDb.db,
        makePointer("artifacts/badtag3/file.txt"),
        origin,
        undefined,
        undefined,
        false,
        tooManyTags,
      ),
    ).toThrow();
  });

  it("accepts exactly 20 tags", () => {
    const exactlyTwenty = Array.from(
      { length: 20 },
      (_, i) => `tag${String(i).padStart(2, "0")}`,
    );
    expect(() =>
      upsertPointer(
        testDb.db,
        makePointer("artifacts/goodtag1/file.txt"),
        origin,
        undefined,
        undefined,
        false,
        exactlyTwenty,
      ),
    ).not.toThrow();
  });
});

describe("listPointers tagFilter (multi-tag AND)", () => {
  it("returns only pointers carrying ALL tags in tagFilter", () => {
    // p1 has both tags, p2 has only repo:a, p3 has only team:x
    upsertPointer(
      testDb.db,
      makePointer("artifacts/tf/p1.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["repo:a", "team:x"],
    );
    upsertPointer(
      testDb.db,
      makePointer("artifacts/tf/p2.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["repo:a"],
    );
    upsertPointer(
      testDb.db,
      makePointer("artifacts/tf/p3.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["team:x"],
    );

    const result = listPointers(testDb.db, {
      tagFilter: ["repo:a", "team:x"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].r2_key).toBe("artifacts/tf/p1.txt");
  });

  it("single-tag tagFilter returns pointers with that tag", () => {
    upsertPointer(
      testDb.db,
      makePointer("artifacts/tf2/p1.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["repo:a", "team:x"],
    );
    upsertPointer(
      testDb.db,
      makePointer("artifacts/tf2/p2.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["repo:a"],
    );

    const result = listPointers(testDb.db, { tagFilter: ["repo:a"] });
    expect(result).toHaveLength(2);
  });

  it("singular tag AND tagFilter both apply (AND semantics)", () => {
    upsertPointer(
      testDb.db,
      makePointer("artifacts/tf3/p1.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["repo:a", "team:x"],
    );
    upsertPointer(
      testDb.db,
      makePointer("artifacts/tf3/p2.txt"),
      origin,
      undefined,
      undefined,
      false,
      ["repo:a"],
    );

    const result = listPointers(testDb.db, {
      tag: "repo:a",
      tagFilter: ["team:x"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].r2_key).toBe("artifacts/tf3/p1.txt");
  });
});

describe("upsertPointer deduplication signal", () => {
  function countProducedEvents(): number {
    const rows = testDb.rawDb
      .prepare(
        "SELECT COUNT(*) AS n FROM journal WHERE kind = 'artifact.produced'",
      )
      .get() as { n: number };
    return rows.n;
  }

  it("returns deduplicated=false on first insert and logs one artifact.produced", () => {
    const ptr = makePointer("artifacts/dedup/abc123.txt");
    const res = upsertPointer(testDb.db, ptr, origin);
    expect(res).toEqual({ deduplicated: false });
    expect(countProducedEvents()).toBe(1);
  });

  it("returns deduplicated=true on a second identical put and logs NO second event", () => {
    const ptr = makePointer("artifacts/dedup/abc123.txt");
    upsertPointer(testDb.db, ptr, origin);
    expect(countProducedEvents()).toBe(1);

    // Second identical content-addressed put: same r2_key/sha256.
    const res = upsertPointer(testDb.db, ptr, origin);
    expect(res).toEqual({ deduplicated: true });
    // The deduplicated put must not emit a duplicate artifact.produced event.
    expect(countProducedEvents()).toBe(1);
  });
});
