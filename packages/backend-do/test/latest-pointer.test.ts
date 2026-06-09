import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactOps, type schema } from "../../ops-sqlite/src";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

const { upsertPointer, getLatestPointer } = artifactOps;

let counter = 0;
function makePointer(overrides?: Partial<Parameters<typeof upsertPointer>[1]>) {
  counter++;
  return {
    r2_key: `keys/ptr-${counter}.md`,
    resource: "task-1",
    kind: "plan",
    sha256: `sha${counter}`,
    bytes: 100,
    fence: null,
    mime_type: "text/markdown",
    produced_at: counter * 1000, // stable, incrementing timestamps
    produced_by: "test-machine",
    expires_at: null,
    ...overrides,
  };
}

let testDb: TestDb;
let rawDb: TestDb["sqlite"];
let db: BaseSQLiteDatabase<"sync", unknown, typeof schema>;

beforeEach(() => {
  counter = 0;
  testDb = createTestDb();
  rawDb = testDb.sqlite;
  db = testDb.db;
});

afterEach(() => {
  testDb.sqlite.close();
});

describe("getLatestPointer", () => {
  it("returns null when no pointers exist", () => {
    const result = getLatestPointer(db, "plan", "task-1");
    expect(result).toBeNull();
  });

  it("returns the only pointer when there is one and no chain", () => {
    const ptr = makePointer();
    upsertPointer(db, ptr, { actor: "agent" });

    const result = getLatestPointer(db, "plan", "task-1");
    expect(result).not.toBeNull();
    expect(result?.r2_key).toBe(ptr.r2_key);
  });

  it("returns the most recent pointer by produced_at when no supersedes chain", () => {
    const ptr1 = makePointer(); // produced_at = 1000
    const ptr2 = makePointer(); // produced_at = 2000
    const ptr3 = makePointer(); // produced_at = 3000

    upsertPointer(db, ptr1, { actor: "agent" });
    upsertPointer(db, ptr2, { actor: "agent" });
    upsertPointer(db, ptr3, { actor: "agent" });

    const result = getLatestPointer(db, "plan", "task-1");
    // No supersedes chain — falls back to produced_at DESC
    expect(result?.r2_key).toBe(ptr3.r2_key);
  });

  it("returns the chain head when a supersedes chain exists", () => {
    const ptr1 = makePointer(); // v1
    const ptr2 = makePointer(); // v2 — supersedes v1
    const ptr3 = makePointer(); // v3 — supersedes v2

    upsertPointer(db, ptr1, { actor: "agent" });
    upsertPointer(db, ptr2, { actor: "agent" }, undefined, null, true); // auto-supersedes ptr1
    upsertPointer(db, ptr3, { actor: "agent" }, undefined, null, true); // auto-supersedes ptr1 and ptr2

    // ptr3 is the head: not superseded by anything
    const result = getLatestPointer(db, "plan", "task-1");
    expect(result?.r2_key).toBe(ptr3.r2_key);
  });

  it("ignores tombstoned pointers", () => {
    const ptr1 = makePointer({ r2_key: "keys/live.md" });
    const ptr2 = makePointer({ r2_key: "keys/tombstoned.md" });

    upsertPointer(db, ptr1, { actor: "agent" });
    upsertPointer(db, ptr2, { actor: "agent" });

    // Tombstone ptr2 (the more recent one)
    rawDb
      .prepare("UPDATE artifact_pointers SET tombstoned = 1 WHERE r2_key = ?")
      .run("keys/tombstoned.md");

    const result = getLatestPointer(db, "plan", "task-1");
    // ptr2 is tombstoned — should return ptr1
    expect(result?.r2_key).toBe("keys/live.md");
  });

  it("returns null when all pointers are tombstoned", () => {
    const ptr = makePointer();
    upsertPointer(db, ptr, { actor: "agent" });
    rawDb
      .prepare("UPDATE artifact_pointers SET tombstoned = 1 WHERE r2_key = ?")
      .run(ptr.r2_key);

    const result = getLatestPointer(db, "plan", "task-1");
    expect(result).toBeNull();
  });

  it("returns null for non-matching kind", () => {
    const ptr = makePointer({ kind: "design" });
    upsertPointer(db, ptr, { actor: "agent" });

    const result = getLatestPointer(db, "plan", "task-1"); // different kind
    expect(result).toBeNull();
  });

  it("returns null for non-matching resource", () => {
    const ptr = makePointer({ resource: "task-2" });
    upsertPointer(db, ptr, { actor: "agent" });

    const result = getLatestPointer(db, "plan", "task-1"); // different resource
    expect(result).toBeNull();
  });

  it("returns the most recent head when disjoint chains exist", () => {
    // Chain A: ptr1 ← ptr2 (ptr2 supersedes ptr1)
    const ptr1 = makePointer({ r2_key: "keys/chain-a-v1.md" }); // produced_at = 1000
    const ptr2 = makePointer({ r2_key: "keys/chain-a-v2.md" }); // produced_at = 2000

    // Chain B: ptr3 ← ptr4 (ptr4 supersedes ptr3)
    const ptr3 = makePointer({ r2_key: "keys/chain-b-v1.md" }); // produced_at = 3000
    const ptr4 = makePointer({ r2_key: "keys/chain-b-v2.md" }); // produced_at = 4000

    upsertPointer(db, ptr1, { actor: "agent" });
    upsertPointer(db, ptr2, { actor: "agent" }, undefined, null, true);
    upsertPointer(db, ptr3, { actor: "agent" });
    upsertPointer(db, ptr4, { actor: "agent" }, undefined, null, true);

    // Both ptr2 and ptr4 are chain heads; ptr4 has the higher produced_at
    const result = getLatestPointer(db, "plan", "task-1");
    expect(result?.r2_key).toBe("keys/chain-b-v2.md");
  });
});
