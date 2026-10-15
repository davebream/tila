import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compactEntity,
  create,
  getCompactEntityStats,
  list,
} from "../src/entity-ops";
import * as schema from "../src/schema";
import { type TestDb, createTestDb, testOrigin } from "./helpers";

// Durable Object SQLite refuses a statement that binds more than 100 values;
// better-sqlite3 allows 32766, so the test enforces the Worker's cap itself.
const DO_SQLITE_VARIABLE_LIMIT = 100;

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

let testDb: TestDb;
let capped: Db;
let widest = 0;

beforeEach(() => {
  testDb = createTestDb();
  widest = 0;
  capped = drizzle(testDb.rawDb, {
    schema,
    logger: {
      logQuery(query, params) {
        widest = Math.max(widest, params.length);
        if (params.length > DO_SQLITE_VARIABLE_LIMIT)
          throw new Error(
            `too many SQL variables (${params.length}): ${query.slice(0, 120)}`,
          );
      },
    },
  }) as unknown as Db;
});

afterEach(() => {
  testDb.rawDb.close();
});

const COUNT = 250;
const idFor = (i: number) => `task-${String(i).padStart(3, "0")}`;

/** Tags and counts are derived from the index so the oracle is independent. */
const tagsFor = (i: number) =>
  i % 4 === 0 ? [] : i % 4 === 1 ? ["odd"] : [`group-${i % 10}`, "shared"];
const blockersFor = (i: number) => (i % 3 === 0 ? 0 : i % 3);
const artifactsFor = (i: number) => (i % 5 === 0 ? 2 : i % 7 === 0 ? 1 : 0);

function seed(): string[] {
  const origin = testOrigin("seed");
  for (const blocker of ["blocker-a", "blocker-b"])
    create(
      testDb.db,
      { id: blocker, type: "blocker", data: {}, created_by: "seed" },
      1,
      origin,
    );
  const ids: string[] = [];
  const insertRelationship = testDb.rawDb.prepare(
    `INSERT INTO entity_relationships(from_id, to_id, type, schema_version, created_at)
     VALUES (?, ?, 'blocks', 1, 1000)`,
  );
  const insertPointer = testDb.rawDb.prepare(
    `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, tombstoned)
     VALUES (?, NULL, 'report', ?, 10, NULL, 'text/plain', 1000, 'seed', 0)`,
  );
  const insertReference = testDb.rawDb.prepare(
    `INSERT INTO entity_artifact_references(entity_id, artifact_key, slot, metadata, created_at)
     VALUES (?, ?, ?, '{}', 1000)`,
  );
  for (let i = 0; i < COUNT; i++) {
    const id = idFor(i);
    create(
      testDb.db,
      {
        id,
        type: "task",
        data: { title: `Task ${i}`, status: "open" },
        created_by: "seed",
        tags: tagsFor(i),
      },
      1,
      origin,
    );
    for (let b = 0; b < blockersFor(i); b++)
      insertRelationship.run(["blocker-a", "blocker-b"][b], id);
    for (let a = 0; a < artifactsFor(i); a++) {
      const key = `produced/${id}-${a}.txt`;
      insertPointer.run(key, `sha-${id}-${a}`);
      insertReference.run(id, key, `slot-${a}`);
    }
    ids.push(id);
  }
  return ids;
}

describe("task list under the Durable Object SQLite variable limit", () => {
  it("the harness rejects a statement binding more than 100 values", () => {
    const ids = Array.from({ length: 101 }, (_, i) => idFor(i));
    const query = (values: string[]) =>
      capped
        .select()
        .from(schema.entityTags)
        .where(inArray(schema.entityTags.entity_id, values))
        .all();

    expect(() => query(ids.slice(0, 100))).not.toThrow();
    expect(() => query(ids)).toThrow(/too many SQL variables/);
  });

  it("lists every task without a limit, hydrating tags", () => {
    const ids = seed();

    const page = list(capped, { type: "task", sort: "id" });

    expect(page.total).toBe(COUNT);
    expect(page.next_cursor).toBeNull();
    expect(page.entities.map((e) => e.id)).toEqual(ids);
    for (const [i, entity] of page.entities.entries())
      expect(entity.tags?.slice().sort(), idFor(i)).toEqual(
        tagsFor(i).slice().sort(),
      );
    expect(widest).toBeLessThanOrEqual(DO_SQLITE_VARIABLE_LIMIT);
  });

  it.each([100, 101, 150, 250, 500])(
    "pages with limit %i without gaps or duplicates and correct tags",
    (limit) => {
      const ids = seed();
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        const page = list(capped, {
          type: "task",
          sort: "id",
          limit,
          cursor,
        });
        expect(page.total).toBe(COUNT);
        expect(page.entities.length).toBeLessThanOrEqual(limit);
        for (const entity of page.entities) {
          const i = Number(entity.id.slice("task-".length));
          expect(entity.tags?.slice().sort(), entity.id).toEqual(
            tagsFor(i).slice().sort(),
          );
          seen.push(entity.id);
        }
        cursor = page.next_cursor ?? undefined;
        pages++;
        expect(pages).toBeLessThanOrEqual(Math.ceil(COUNT / limit));
      } while (cursor);

      expect(seen).toEqual(ids);
      expect(new Set(seen).size).toBe(COUNT);
    },
  );

  it("keeps filtered paging correct when the page exceeds the limit", () => {
    seed();

    const page = list(capped, { tag: "shared", sort: "id", order: "desc" });

    const expected = Array.from({ length: COUNT }, (_, i) => i)
      .filter((i) => tagsFor(i).includes("shared"))
      .reverse()
      .map(idFor);
    expect(page.entities.map((e) => e.id)).toEqual(expected);
    expect(page.total).toBe(expected.length);
  });

  it("computes compact blocker and artifact counts for every id", () => {
    const ids = seed();

    const everyTask = list(capped, { type: "task", sort: "id" }).entities;
    const stats = getCompactEntityStats(
      capped,
      everyTask.map((e) => e.id),
    );

    expect(everyTask).toHaveLength(COUNT);
    for (const [i, entity] of everyTask.entries()) {
      const compact = compactEntity(capped, entity, [], stats);
      expect(
        {
          id: compact.id,
          blockers: compact.blockers,
          artifacts: compact.artifacts,
        },
        ids[i],
      ).toEqual({
        id: idFor(i),
        blockers: blockersFor(i),
        artifacts: artifactsFor(i),
      });
    }
    expect(widest).toBeLessThanOrEqual(DO_SQLITE_VARIABLE_LIMIT);
  });

  it("keeps compact counts correct for a page of 99 ids", () => {
    seed();

    const page = list(capped, { type: "task", sort: "id", limit: 99 });
    const stats = getCompactEntityStats(
      capped,
      page.entities.map((e) => e.id),
    );

    expect(page.entities).toHaveLength(99);
    for (const [i, entity] of page.entities.entries()) {
      const compact = compactEntity(capped, entity, [], stats);
      expect(compact.blockers, entity.id).toBe(blockersFor(i));
      expect(compact.artifacts, entity.id).toBe(artifactsFor(i));
    }
  });
});
