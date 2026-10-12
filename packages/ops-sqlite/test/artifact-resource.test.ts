import { afterEach, beforeEach, expect, it } from "vitest";
import {
  getLatestPointer,
  listGrepCandidates,
  listPointers,
  reconcilePointers,
  searchArtifacts,
  upsertPointer,
} from "../src/artifact-ops";
import {
  ArtifactResourceError,
  resolveArtifactResource,
  withArtifactResourceErrors,
} from "../src/artifact-resource";
import { acquire } from "../src/coordination-ops";
import {
  resolveEntityReference,
  resolveEntityResource,
} from "../src/fence-ops";
import { type TestDb, createEntity, createTestDb, testOrigin } from "./helpers";

let test: TestDb;
const origin = testOrigin();
beforeEach(() => {
  test = createTestDb();
  createEntity(test.db, { id: "task.api-routes" });
});
afterEach(() => test.rawDb.close());

function pointer(
  resource: string | null,
  key = "produced/test/a.txt",
  fence: number | null = null,
) {
  return {
    r2_key: key,
    resource,
    kind: "log",
    sha256: "a".repeat(64),
    bytes: 5,
    fence,
    mime_type: "text/plain",
    produced_at: Date.now(),
    produced_by: origin.actor,
    expires_at: null,
  };
}

it("resolves typed aliases without confusing colons or custom entity types", () => {
  createEntity(test.db, { id: "epic:one", type: "milestone" });
  createEntity(test.db, { id: "one", type: "epic" });
  expect(resolveEntityReference(test.db, "epic:one")).toEqual({
    id: "epic:one",
    resource: "milestone:epic:one",
  });
  expect(resolveArtifactResource(test.db, "milestone:epic:one")).toBe(
    "epic:one",
  );
  expect(resolveEntityResource(test.db, "task:task.api-routes")).toBe(
    "task:task.api-routes",
  );
  expect(resolveArtifactResource(test.db, null)).toBeNull();
  for (const resource of [
    "missing",
    "epic:task.api-routes",
    "record:type/key",
  ]) {
    expect(() => resolveArtifactResource(test.db, resource)).toThrow(
      ArtifactResourceError,
    );
    expect(listPointers(test.db, { resource })).toEqual([]);
  }
});

it("stores one canonical pointer, search document and journal event for either alias", () => {
  const fence = acquire(
    test.db,
    "task:task.api-routes",
    origin,
    "exclusive",
    60_000,
  ).fence;
  for (const resource of ["task:task.api-routes", "task.api-routes"]) {
    upsertPointer(
      test.db,
      pointer(resource, undefined, fence),
      origin,
      undefined,
      { title: "Routes", body_text: "hello routes" },
    );
    expect(listPointers(test.db, { resource })).toHaveLength(1);
    expect(getLatestPointer(test.db, "log", resource)?.resource).toBe(
      "task.api-routes",
    );
    expect(listGrepCandidates(test.db, { resource })[0].resource).toBe(
      "task.api-routes",
    );
    expect(searchArtifacts(test.db, { q: "hello", resource })[0].resource).toBe(
      "task.api-routes",
    );
  }
  expect(
    test.rawDb.prepare("SELECT resource FROM artifact_search_docs").all(),
  ).toEqual([{ resource: "task.api-routes" }]);
  expect(
    test.rawDb
      .prepare("SELECT resource FROM journal WHERE kind = 'artifact.produced'")
      .all(),
  ).toEqual([{ resource: "task.api-routes" }]);
  upsertPointer(test.db, pointer(null, "sources/a.txt"), origin, undefined, {
    title: null,
    body_text: "hello source",
  });
  expect(
    searchArtifacts(test.db, {
      q: "hello",
      resource: "task:task.api-routes",
      source_only: true,
    }).map((p) => p.resource),
  ).toEqual([null]);
});

it("matches supersedes across aliases and rejects invalid references atomically", () => {
  upsertPointer(test.db, pointer("task.api-routes"), origin);
  upsertPointer(
    test.db,
    pointer("task:task.api-routes", "produced/test/b.txt"),
    origin,
    undefined,
    null,
    true,
  );
  expect(getLatestPointer(test.db, "log", "task:task.api-routes")?.r2_key).toBe(
    "produced/test/b.txt",
  );
  expect(() => upsertPointer(test.db, pointer("task:missing"), origin)).toThrow(
    ArtifactResourceError,
  );
  expect(listPointers(test.db, {})).toHaveLength(2);
});

it("normalizes historical reconciliation metadata without changing its key or checking live fences", () => {
  const key = "produced/task:task.api-routes/old.txt";
  const result = reconcilePointers(
    test.db,
    [
      {
        key,
        size: 5,
        metadata: {
          "tila-task": "task:task.api-routes",
          "tila-fence": "123",
          "tila-kind": "log",
          "tila-sha256": "a".repeat(64),
          "tila-mime": "text/plain",
        },
      },
    ],
    origin,
    true,
  );
  expect(result.orphans_recovered).toBe(1);
  expect(
    listPointers(test.db, { resource: "task.api-routes" })[0],
  ).toMatchObject({ r2_key: key, resource: "task.api-routes", fence: 123 });
});

it("translates direct and wrapped foreign-key failures but preserves unrelated errors", () => {
  for (const error of [
    Object.assign(new Error("constraint"), {
      code: "SQLITE_CONSTRAINT_FOREIGNKEY",
    }),
    new Error("query failed", {
      cause: new Error(
        "FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)",
      ),
    }),
  ]) {
    expect(() =>
      withArtifactResourceErrors(() => {
        throw error;
      }),
    ).toThrow(ArtifactResourceError);
  }
  const transient = new Error("SQLITE_BUSY");
  expect(() =>
    withArtifactResourceErrors(() => {
      throw transient;
    }),
  ).toThrow(transient);
});
