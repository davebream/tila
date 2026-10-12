import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidCursorError } from "../src/list-cursor";
import { type RecordListSort, listRecords } from "../src/record-ops";
import * as schema from "../src/schema";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.rawDb.close();
});

/** 450 records: updated_at and revision collide heavily; keys contain slashes. */
function seed(count = 450) {
  for (let i = 0; i < count; i++) {
    const key = `team/${i % 3}/svc-${String((i * 53) % count).padStart(3, "0")}`;
    testDb.db
      .insert(schema.records)
      .values({
        type: "deploy",
        key,
        schema_version: 1,
        value_json: JSON.stringify({
          service: i % 10 === 0 ? "" : `Service ${i}`,
        }),
        value_sha256: "0".repeat(64),
        revision: 1 + (i % 4),
        archived: i % 9 === 0 ? 1 : 0,
        created_at: 1,
        updated_at: i % 5 < 3 ? 100 : 100 + i,
        updated_by: "test",
      })
      .run();
  }
}

function collect(filter: Parameters<typeof listRecords>[1]): string[][] {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = listRecords(testDb.db, { ...filter, cursor });
    pages.push(page.items.map((item) => item.key));
    if (!page.next_cursor) return pages;
    cursor = page.next_cursor;
  }
  throw new Error("pagination did not terminate");
}

describe("listRecords keyset pagination", () => {
  for (const sort of ["key", "updated_at", "revision"] as RecordListSort[]) {
    for (const order of ["asc", "desc"] as const) {
      it(`visits every record once sorted by ${sort} ${order}`, () => {
        seed();
        const pages = collect({
          type: "deploy",
          includeArchived: true,
          sort,
          order,
          limit: 200,
        });
        const seen = pages.flat();
        expect(pages.map((p) => p.length)).toEqual([200, 200, 50]);
        expect(new Set(seen).size).toBe(450);
      });
    }
  }

  it("orders by key by default", () => {
    seed(20);
    const keys = listRecords(testDb.db, {
      type: "deploy",
      includeArchived: true,
    }).items.map((item) => item.key);
    expect(keys).toEqual(keys.slice().sort());
  });

  it("filters by key substring and keeps the cursor bound to it", () => {
    seed(60);
    const pages = collect({ type: "deploy", keyContains: "team/1/", limit: 7 });
    expect(pages.flat().every((key) => key.includes("team/1/"))).toBe(true);
    const cursor = listRecords(testDb.db, {
      type: "deploy",
      keyContains: "team/1/",
      limit: 3,
    }).next_cursor as string;
    expect(() =>
      listRecords(testDb.db, {
        type: "deploy",
        keyContains: "team/2/",
        limit: 3,
        cursor,
      }),
    ).toThrow(InvalidCursorError);
  });

  it("applies key-prefix restrictions across pages", () => {
    seed(90);
    const keys = collect({
      type: "deploy",
      restrictions: { records: [{ type: "deploy", key_prefixes: ["team/0"] }] },
      limit: 4,
    }).flat();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith("team/0/"))).toBe(true);
  });

  it("projects the declared title field and leaves empty titles null", () => {
    seed(20);
    const items = listRecords(testDb.db, {
      type: "deploy",
      includeArchived: true,
      titleField: "service",
    }).items;
    expect(items.some((item) => item.title === "Service 1")).toBe(true);
    const blank = testDb.db
      .select({ key: schema.records.key })
      .from(schema.records)
      .where(eq(schema.records.value_json, JSON.stringify({ service: "" })))
      .get();
    expect(items.find((item) => item.key === blank?.key)?.title).toBeNull();
    expect(
      listRecords(testDb.db, { type: "deploy" }).items[0],
    ).not.toHaveProperty("title");
  });

  it("rejects a cursor from another sort", () => {
    seed(20);
    const cursor = listRecords(testDb.db, {
      type: "deploy",
      sort: "updated_at",
      limit: 5,
    }).next_cursor as string;
    expect(() =>
      listRecords(testDb.db, { type: "deploy", sort: "key", limit: 5, cursor }),
    ).toThrow(InvalidCursorError);
  });
});
