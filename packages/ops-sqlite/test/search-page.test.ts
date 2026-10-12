import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchQueryError } from "../src/artifact-ops";
import { InvalidCursorError } from "../src/list-cursor";
import { createRecord } from "../src/record-ops";
import * as schemaOps from "../src/schema-ops";
import {
  SearchKindDenied,
  literalFtsQuery,
  searchPage,
  searchableKinds,
} from "../src/search-page-ops";
import { type TestDb, createEntity, createTestDb, testOrigin } from "./helpers";

let testDb: TestDb;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.rawDb.close();
});

function ids(results: ReturnType<typeof searchPage>["results"]): string[] {
  return results.map((r) =>
    r.type === "entity"
      ? r.entity_id
      : r.type === "record"
        ? `${r.record_type}/${r.record_key}`
        : r.r2_key,
  );
}

function allPages(query: Parameters<typeof searchPage>[1]): string[][] {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = searchPage(testDb.db, { ...query, cursor });
    pages.push(ids(page.results));
    if (!page.next_cursor) return pages;
    cursor = page.next_cursor;
  }
  throw new Error("search pagination did not terminate");
}

describe("literalFtsQuery", () => {
  it("quotes each word and prefix-matches the last word", () => {
    expect(literalFtsQuery("deploy pipe")).toBe('"deploy" "pipe"*');
    expect(literalFtsQuery('a "b" OR cd')).toBe('"a" "b" "OR" "cd"');
    expect(literalFtsQuery("task-25")).toBe('"task-25"*');
  });

  it("rejects input with nothing searchable", () => {
    expect(() => literalFtsQuery('  " - ')).toThrow(SearchQueryError);
  });
});

describe("searchPage", () => {
  it("finds a task by an id fragment", () => {
    createEntity(testDb.db, {
      id: "task-251",
      data: { title: "Rotate keys" },
    });
    createEntity(testDb.db, { id: "task-9", data: { title: "Other" } });

    const page = searchPage(testDb.db, {
      q: "251",
      syntax: "literal",
      kinds: ["task"],
      limit: 20,
    });
    expect(ids(page.results)).toEqual(["task-251"]);
    expect(page.next_cursor).toBeNull();
  });

  it("ranks a title match above an id-only match", () => {
    createEntity(testDb.db, { id: "rotate-1", data: { title: "Unrelated" } });
    createEntity(testDb.db, { id: "x-2", data: { title: "Rotate keys" } });
    const page = searchPage(testDb.db, {
      q: "rotate",
      syntax: "literal",
      kinds: ["task"],
      limit: 20,
    });
    expect(ids(page.results)).toEqual(["x-2", "rotate-1"]);
  });

  it("pages through equal-rank matches without duplicates or gaps", () => {
    for (let i = 0; i < 30; i++)
      createEntity(testDb.db, {
        id: `dup-${String(i).padStart(2, "0")}`,
        data: { title: "Same title" },
      });
    const pages = allPages({
      q: "same",
      syntax: "literal",
      kinds: ["task"],
      limit: 7,
    });
    const seen = pages.flat();
    expect(pages.map((p) => p.length)).toEqual([7, 7, 7, 7, 2]);
    expect(new Set(seen).size).toBe(30);
    // Equal bm25 falls back to id order.
    expect(seen).toEqual(seen.slice().sort());
  });

  it("filters by task type", () => {
    createEntity(testDb.db, {
      id: "b-1",
      type: "bug",
      data: { title: "Crash" },
    });
    createEntity(testDb.db, {
      id: "s-1",
      type: "story",
      data: { title: "Crash" },
    });
    const page = searchPage(testDb.db, {
      q: "crash",
      kinds: ["task"],
      types: ["bug"],
      limit: 20,
    });
    expect(ids(page.results)).toEqual(["b-1"]);
  });

  it("honors presentation.title for indexed titles", () => {
    schemaOps.applySchema(
      testDb.db,
      `schema_version = 1

[work_units.story]
fields = [{ name = "headline", type = "string" }]
presentation = { title = "headline" }
`,
      "test",
    );
    createEntity(testDb.db, {
      id: "st-1",
      type: "story",
      data: { headline: "Quarterly report" },
    });
    const page = searchPage(testDb.db, {
      q: "quarterly",
      syntax: "literal",
      kinds: ["task"],
      limit: 20,
    });
    expect(page.results).toMatchObject([
      { type: "entity", entity_id: "st-1", name: "Quarterly report" },
    ]);
  });

  it("re-indexes existing titles when presentation.title changes", () => {
    const base = `schema_version = 1

[work_units.story]
fields = [{ name = "title", type = "string" }, { name = "headline", type = "string" }]
`;
    schemaOps.applySchema(testDb.db, base, "test");
    createEntity(testDb.db, {
      id: "st-2",
      type: "story",
      data: { title: "Old words", headline: "Fresh words" },
    });
    const find = (q: string) =>
      ids(
        searchPage(testDb.db, {
          q,
          syntax: "literal",
          kinds: ["task"],
          limit: 5,
        }).results,
      );
    expect(find("fresh")).toEqual([]);

    schemaOps.applySchema(
      testDb.db,
      `${base}presentation = { title = "headline" }\n`,
      "test",
    );
    expect(find("fresh")).toEqual(["st-2"]);
    expect(find("old")).toEqual([]);

    schemaOps.applySchema(testDb.db, base, "test");
    expect(find("old")).toEqual(["st-2"]);
  });

  it("never matches tasks or records outside the caller's restrictions", async () => {
    createEntity(testDb.db, {
      id: "e-1",
      type: "epic",
      data: { title: "Alpha" },
    });
    createEntity(testDb.db, {
      id: "t-1",
      type: "task",
      data: { title: "Alpha" },
    });
    createEntity(testDb.db, {
      id: "t-2",
      type: "task",
      data: { title: "Alpha", parent_id: "e-1" },
    });
    for (const key of ["team/a/one", "team/b/two"])
      await createRecord(
        testDb.db,
        {
          type: "config",
          key,
          value: { note: "alpha" },
          schema_version: 1,
          actor: "test",
        },
        testOrigin(),
      );

    const restrictions = {
      task_types: ["task"],
      records: [{ type: "config", key_prefixes: ["team/a"] }],
    };
    const page = searchPage(testDb.db, {
      q: "alpha",
      kinds: ["task", "record"],
      limit: 20,
      restrictions,
    });
    expect(ids(page.results).sort()).toEqual(["config/team/a/one", "t-1"]);
  });

  it("interleaves kinds and carries one offset per kind", async () => {
    for (let i = 0; i < 5; i++)
      createEntity(testDb.db, { id: `t-${i}`, data: { title: "Beta" } });
    for (let i = 0; i < 2; i++)
      await createRecord(
        testDb.db,
        {
          type: "note",
          key: `n-${i}`,
          value: { body: "beta" },
          schema_version: 1,
          actor: "test",
        },
        testOrigin(),
      );
    const pages = allPages({
      q: "beta",
      kinds: ["task", "record"],
      limit: 3,
    });
    const seen = pages.flat();
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
    expect(pages[0]).toEqual(["t-0", "note/n-0", "t-1"]);
  });

  it("rejects a cursor reused with another query or kind set", () => {
    for (let i = 0; i < 5; i++)
      createEntity(testDb.db, { id: `g-${i}`, data: { title: "Gamma" } });
    const first = searchPage(testDb.db, {
      q: "gamma",
      kinds: ["task"],
      limit: 2,
    });
    const cursor = first.next_cursor as string;
    expect(() =>
      searchPage(testDb.db, { q: "delta", kinds: ["task"], limit: 2, cursor }),
    ).toThrow(InvalidCursorError);
    expect(() =>
      searchPage(testDb.db, {
        q: "gamma",
        kinds: ["task", "record"],
        limit: 2,
        cursor,
      }),
    ).toThrow(InvalidCursorError);
  });
});

describe("searchableKinds", () => {
  it("searches every kind without a scoped policy", () => {
    expect(searchableKinds(undefined, undefined)).toEqual({
      restricted: false,
      kinds: ["task", "artifact", "record"],
    });
  });

  it("requires each kind's read capability and reports what was left out", () => {
    expect(
      searchableKinds(
        { capabilities: ["search:read", "tasks:read"] },
        undefined,
      ),
    ).toEqual({
      restricted: false,
      kinds: ["task"],
      excluded_kinds: [
        { kind: "artifact", reason: "capability" },
        { kind: "record", reason: "capability" },
      ],
    });
  });

  it("never searches artifacts for namespace-restricted credentials", () => {
    const policy = {
      capabilities: ["search:read", "tasks:read", "artifacts:read"],
      restrictions: { task_types: ["task"] },
    };
    expect(searchableKinds(policy, undefined)).toMatchObject({
      restricted: true,
      kinds: ["task"],
      excluded_kinds: [
        { kind: "artifact", reason: "restricted" },
        { kind: "record", reason: "capability" },
      ],
    });
    expect(() => searchableKinds(policy, ["artifact"])).toThrow(
      SearchKindDenied,
    );
  });
});
