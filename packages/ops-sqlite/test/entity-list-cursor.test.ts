import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TaskListSort, list } from "../src/entity-ops";
import { InvalidCursorError } from "../src/list-cursor";
import * as schema from "../src/schema";
import { type TestDb, createEntity, createTestDb } from "./helpers";

let testDb: TestDb;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.rawDb.close();
});

/**
 * 300 tasks where most rows share sort values: 60% of updated_at values
 * collide, titles repeat, some titles are NULL or numbers, ids are inserted
 * out of order.
 */
function seed(count = 300) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `task-${String((i * 37) % count).padStart(3, "0")}`;
    const title = i % 7 === 0 ? undefined : i % 11 === 0 ? i : `Title ${i % 5}`;
    createEntity(testDb.db, {
      id,
      type: i % 3 === 0 ? "bug" : "story",
      data: {
        ...(title === undefined ? {} : { title }),
        status: i % 4 === 0 ? null : `s${i % 3}`,
      },
    });
    testDb.db
      .update(schema.entities)
      .set({
        created_at: 1000 + Math.floor(i / 10),
        updated_at: i % 5 < 3 ? 5000 : 5000 + i,
      })
      .where(eq(schema.entities.id, id))
      .run();
    ids.push(id);
  }
  return ids;
}

function collect(
  filter: Parameters<typeof list>[1] & { limit: number },
): string[][] {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = list(testDb.db, { ...filter, cursor });
    pages.push(page.entities.map((e) => e.id));
    if (!page.next_cursor) return pages;
    cursor = page.next_cursor;
  }
  throw new Error("pagination did not terminate");
}

const SORTS: TaskListSort[] = [
  "created_at",
  "updated_at",
  "type",
  "title",
  "status",
  "id",
];

describe("entity list keyset pagination", () => {
  for (const sort of SORTS) {
    for (const order of ["asc", "desc"] as const) {
      it(`visits every row exactly once sorted by ${sort} ${order}`, () => {
        const ids = seed();
        const pages = collect({ sort, order, limit: 100 });
        const seen = pages.flat();
        expect(pages.length).toBe(3);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.slice().sort()).toEqual(ids.slice().sort());
        // Paging must reproduce the single-query order exactly.
        expect(seen).toEqual(
          list(testDb.db, { sort, order }).entities.map((e) => e.id),
        );
      });
    }
  }

  it("orders by created_at then id by default", () => {
    seed(30);
    const all = list(testDb.db).entities;
    const expected = all
      .slice()
      .sort(
        (a, b) =>
          a.created_at - b.created_at ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((e) => e.id);
    expect(all.map((e) => e.id)).toEqual(expected);
  });

  it("reports the filtered total on every page and finds row 251", () => {
    seed(260);
    const pages = collect({ type: ["bug", "story"], limit: 100 });
    expect(pages.map((p) => p.length)).toEqual([100, 100, 60]);
    const third = list(testDb.db, {
      limit: 100,
      cursor:
        list(testDb.db, {
          limit: 100,
          cursor: list(testDb.db, { limit: 100 }).next_cursor ?? undefined,
        }).next_cursor ?? undefined,
    });
    expect(third.total).toBe(260);
    expect(third.next_cursor).toBeNull();
    expect(pages.flat()).toContain("task-251");
  });

  it("keeps cursors stable when filtered by type", () => {
    seed(90);
    const bugs = collect({ type: "bug", limit: 7 }).flat();
    expect(bugs.length).toBe(30);
    expect(new Set(bugs).size).toBe(30);
  });

  it("rejects a cursor reused with a different filter or sort", () => {
    seed(20);
    const cursor = list(testDb.db, { limit: 5, sort: "updated_at" })
      .next_cursor as string;
    expect(() =>
      list(testDb.db, { limit: 5, sort: "created_at", cursor }),
    ).toThrow(InvalidCursorError);
    expect(() =>
      list(testDb.db, { limit: 5, sort: "updated_at", type: "bug", cursor }),
    ).toThrow(InvalidCursorError);
    expect(() =>
      list(testDb.db, {
        limit: 5,
        sort: "updated_at",
        order: "desc",
        cursor,
      }),
    ).toThrow(InvalidCursorError);
  });

  it("rejects malformed cursors and cursor plus offset", () => {
    seed(20);
    for (const cursor of ["not-base64!", "e30", btoa('{"v":2,"f":"x"}')])
      expect(() => list(testDb.db, { limit: 5, cursor })).toThrow(
        InvalidCursorError,
      );
    const cursor = list(testDb.db, { limit: 5 }).next_cursor as string;
    expect(() => list(testDb.db, { limit: 5, offset: 5, cursor })).toThrow(
      InvalidCursorError,
    );
  });

  it("issues a cursor from an offset page so offset callers can switch", () => {
    seed(20);
    const offsetPage = list(testDb.db, { limit: 5, offset: 5 });
    const next = list(testDb.db, {
      limit: 5,
      cursor: offsetPage.next_cursor ?? undefined,
    });
    expect(next.entities.map((e) => e.id)).toEqual(
      list(testDb.db, { limit: 5, offset: 10 }).entities.map((e) => e.id),
    );
  });

  it("returns no cursor without a limit or on the last page", () => {
    seed(10);
    expect(list(testDb.db).next_cursor).toBeNull();
    expect(list(testDb.db, { limit: 10 }).next_cursor).toBeNull();
    expect(list(testDb.db, { limit: 9 }).next_cursor).not.toBeNull();
  });

  it("encodes non-ASCII sort keys", () => {
    for (const [i, title] of ["Żółw", "Äpfel", "日本", "émile"].entries())
      createEntity(testDb.db, { id: `u-${i}`, data: { title } });
    const pages = collect({ sort: "title", limit: 1 });
    expect(pages.flat().length).toBe(4);
  });
});
