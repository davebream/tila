import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchQueryError } from "../src/artifact-ops";
import { acquire } from "../src/coordination-ops";
import {
  EntityAlreadyExistsError,
  EntityNotFoundError,
  archive,
  compactEntity,
  create,
  get,
  getCompactEntityStats,
  list,
  searchEntities,
  update,
} from "../src/entity-ops";
import { listJournal } from "../src/journal-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

function acquireFence(id: string): number {
  const result = acquire(
    testDb.db,
    id,
    "test-actor",
    "test-actor",
    "exclusive",
    60_000,
  );
  return result.fence;
}

describe("create", () => {
  it("returns typed Entity with correct fields", () => {
    const entity = create(
      testDb.db,
      {
        id: "e-create-1",
        type: "task",
        data: { name: "Write tests", status: "open" },
        created_by: "agent-1",
      },
      1,
      { actor: "agent-1" },
    );

    expect(entity.id).toBe("e-create-1");
    expect(entity.type).toBe("task");
    expect(entity.data).toEqual({ name: "Write tests", status: "open" });
    expect(entity.archived).toBe(0);
    expect(entity.schema_version).toBe(1);
    expect(entity.created_by).toBe("agent-1");
    expect(entity.created_at).toBeTypeOf("number");
    expect(entity.updated_at).toBeTypeOf("number");
  });

  it("get() retrieves entity by ID after create", () => {
    create(
      testDb.db,
      {
        id: "e-get-1",
        type: "epic",
        data: { name: "Big feature", status: "open" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );

    const found = get(testDb.db, "e-get-1");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("e-get-1");
    expect(found?.type).toBe("epic");
    expect(found?.data).toEqual({ name: "Big feature", status: "open" });
  });

  it("get() returns null for missing entity", () => {
    const found = get(testDb.db, "nonexistent-id");
    expect(found).toBeNull();
  });

  it("throws EntityAlreadyExistsError on duplicate ID", () => {
    create(
      testDb.db,
      {
        id: "e-dup-1",
        type: "task",
        data: { name: "First", status: "open" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );

    expect(() =>
      create(
        testDb.db,
        {
          id: "e-dup-1",
          type: "task",
          data: { name: "Duplicate", status: "open" },
          created_by: "actor-2",
        },
        1,
        { actor: "actor-2" },
      ),
    ).toThrow(EntityAlreadyExistsError);
  });
});

describe("provenance threading", () => {
  it("create() threads provenance to journal", () => {
    create(
      testDb.db,
      {
        id: "e-prov-1",
        type: "task",
        data: { name: "test" },
        created_by: "alice",
      },
      1,
      {
        actor: "alice",
        tokenId: "tok_123",
        source: "sdk",
        sourceVersion: "1.2.3",
      },
    );

    const entries = listJournal(testDb.db, {
      resource: "e-prov-1",
      kind: "entity.created",
    });
    expect(entries[0].token_id).toBe("tok_123");
    expect(entries[0].source).toBe("sdk");
    expect(entries[0].source_version).toBe("1.2.3");
  });

  it("create() writes null provenance fields when origin has no optional fields", () => {
    create(
      testDb.db,
      {
        id: "e-prov-2",
        type: "task",
        data: { name: "test" },
        created_by: "alice",
      },
      1,
      { actor: "alice" },
    );

    const entries = listJournal(testDb.db, {
      resource: "e-prov-2",
      kind: "entity.created",
    });
    expect(entries[0].token_id).toBeNull();
    expect(entries[0].source).toBeNull();
    expect(entries[0].source_version).toBeNull();
  });

  it("update() threads provenance to journal", () => {
    create(
      testDb.db,
      {
        id: "e-prov-upd",
        type: "task",
        data: { name: "test" },
        created_by: "alice",
      },
      1,
      { actor: "alice" },
    );
    const fence = acquireFence("e-prov-upd");
    update(testDb.db, "e-prov-upd", { name: "updated" }, fence, {
      actor: "alice",
      tokenId: "tok_upd",
      source: "cli",
      sourceVersion: "2.0.0",
    });

    const entries = listJournal(testDb.db, {
      resource: "e-prov-upd",
      kind: "entity.updated",
    });
    expect(entries[0].token_id).toBe("tok_upd");
    expect(entries[0].source).toBe("cli");
    expect(entries[0].source_version).toBe("2.0.0");
  });

  it("archive() threads provenance to journal", () => {
    create(
      testDb.db,
      {
        id: "e-prov-arch",
        type: "task",
        data: { name: "test" },
        created_by: "alice",
      },
      1,
      { actor: "alice" },
    );
    const fence = acquireFence("e-prov-arch");
    archive(testDb.db, "e-prov-arch", fence, {
      actor: "alice",
      tokenId: "tok_arch",
      source: "mcp-server",
      sourceVersion: "3.0.0",
    });

    const entries = listJournal(testDb.db, {
      resource: "e-prov-arch",
      kind: "entity.archived",
    });
    expect(entries[0].token_id).toBe("tok_arch");
    expect(entries[0].source).toBe("mcp-server");
    expect(entries[0].source_version).toBe("3.0.0");
  });
});

describe("update", () => {
  it("merges data fields with fence and returns updated entity", () => {
    create(
      testDb.db,
      {
        id: "e-upd-1",
        type: "task",
        data: { name: "Old name", status: "open" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );
    const fence = acquireFence("e-upd-1");

    const updated = update(testDb.db, "e-upd-1", { name: "New name" }, fence, {
      actor: "actor-1",
    });

    expect(updated.data).toMatchObject({ name: "New name", status: "open" });
    expect(updated.id).toBe("e-upd-1");
  });

  it("throws EntityNotFoundError for missing entity ID", () => {
    const fence = acquireFence("nonexistent");

    expect(() =>
      update(testDb.db, "nonexistent", { name: "x" }, fence, {
        actor: "actor-1",
      }),
    ).toThrow(EntityNotFoundError);
  });
});

describe("archive", () => {
  it("sets archived=1 with fence", () => {
    create(
      testDb.db,
      {
        id: "e-arch-1",
        type: "task",
        data: { name: "Archivable", status: "open" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );
    const fence = acquireFence("e-arch-1");

    archive(testDb.db, "e-arch-1", fence, { actor: "actor-1" });

    const found = get(testDb.db, "e-arch-1");
    expect(found?.archived).toBe(1);
  });

  it("removes entity from FTS5 search index after archive", () => {
    create(
      testDb.db,
      {
        id: "e-arch-fts",
        type: "task",
        data: { name: "ArchiveSearchTarget", status: "open" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );

    // Entity should be findable before archive
    const beforeArchive = searchEntities(testDb.db, {
      q: "ArchiveSearchTarget",
    });
    expect(beforeArchive).toHaveLength(1);

    const fence = acquireFence("e-arch-fts");
    archive(testDb.db, "e-arch-fts", fence, { actor: "actor-1" });

    // Entity should NOT be findable after archive
    const afterArchive = searchEntities(testDb.db, {
      q: "ArchiveSearchTarget",
    });
    expect(afterArchive).toHaveLength(0);
  });
});

describe("list", () => {
  it("returns entities with total count", () => {
    create(
      testDb.db,
      {
        id: "e-list-1",
        type: "task",
        data: { name: "First" },
        created_by: "a",
      },
      1,
      { actor: "a" },
    );
    create(
      testDb.db,
      {
        id: "e-list-2",
        type: "task",
        data: { name: "Second" },
        created_by: "a",
      },
      1,
      { actor: "a" },
    );

    const result = list(testDb.db);
    expect(result.entities).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("filters by type", () => {
    create(
      testDb.db,
      { id: "e-task-1", type: "task", data: { name: "Task" }, created_by: "a" },
      1,
      { actor: "a" },
    );
    create(
      testDb.db,
      { id: "e-epic-1", type: "epic", data: { name: "Epic" }, created_by: "a" },
      1,
      { actor: "a" },
    );

    const tasks = list(testDb.db, { type: "task" });
    expect(tasks.entities).toHaveLength(1);
    expect(tasks.entities[0].type).toBe("task");
  });

  it("filters by archived status", () => {
    create(
      testDb.db,
      {
        id: "e-active",
        type: "task",
        data: { name: "Active" },
        created_by: "a",
      },
      1,
      { actor: "a" },
    );
    create(
      testDb.db,
      {
        id: "e-archived",
        type: "task",
        data: { name: "Archived" },
        created_by: "a",
      },
      1,
      { actor: "a" },
    );
    const fence = acquireFence("e-archived");
    archive(testDb.db, "e-archived", fence, { actor: "a" });

    const active = list(testDb.db, { archived: 0 });
    expect(active.entities).toHaveLength(1);
    expect(active.entities[0].id).toBe("e-active");

    const archived = list(testDb.db, { archived: 1 });
    expect(archived.entities).toHaveLength(1);
    expect(archived.entities[0].id).toBe("e-archived");
  });

  // --- dataFilter (json_extract scalar comparison) ---
  //
  // REGRESSION GUARD: `json_extract(data, '$.k')` UNQUOTES scalars (returns
  // `P1`, not `"P1"`), so equality must bind the raw primitive. The old code
  // compared against `JSON.stringify(value)` (`"P1"`) and matched NOTHING —
  // silently breaking `?status=`/`?parent=` entity filtering in the DO too.

  function seed(id: string, data: Record<string, unknown>) {
    create(testDb.db, { id, type: "task", data, created_by: "a" }, 1, {
      actor: "a",
    });
  }

  it("filters by a STRING data field (parent_id): only matching, excludes others", () => {
    seed("c1", { name: "Child 1", parent_id: "P1" });
    seed("c2", { name: "Child 2", parent_id: "P1" });
    seed("c3", { name: "Child 3", parent_id: "P2" });
    seed("orphan", { name: "Orphan" }); // no parent_id

    const result = list(testDb.db, { dataFilter: { parent_id: "P1" } });
    expect(result.entities.map((e) => e.id).sort()).toEqual(["c1", "c2"]);
    expect(result.total).toBe(2);
  });

  it("filters by a STRING data field (status)", () => {
    seed("s-open", { name: "Open one", status: "open" });
    seed("s-closed", { name: "Closed one", status: "closed" });

    const result = list(testDb.db, { dataFilter: { status: "open" } });
    expect(result.entities.map((e) => e.id)).toEqual(["s-open"]);
  });

  it("filters by an ARRAY of string values (IN): returns the union, excludes others", () => {
    seed("a-open", { name: "A", status: "open" });
    seed("a-blocked", { name: "B", status: "blocked" });
    seed("a-closed", { name: "C", status: "closed" });

    const result = list(testDb.db, {
      dataFilter: { status: ["open", "blocked"] },
    });
    expect(result.entities.map((e) => e.id).sort()).toEqual([
      "a-blocked",
      "a-open",
    ]);
  });

  it("filters by a NUMBER data field", () => {
    seed("p-low", { name: "Low", priority: 1 });
    seed("p-high", { name: "High", priority: 5 });

    const result = list(testDb.db, { dataFilter: { priority: 5 } });
    expect(result.entities.map((e) => e.id)).toEqual(["p-high"]);
  });

  it("filters by a BOOLEAN data field (true -> 1, false -> 0)", () => {
    seed("b-yes", { name: "Flagged", flagged: true });
    seed("b-no", { name: "Unflagged", flagged: false });

    const truthy = list(testDb.db, { dataFilter: { flagged: true } });
    expect(truthy.entities.map((e) => e.id)).toEqual(["b-yes"]);

    const falsy = list(testDb.db, { dataFilter: { flagged: false } });
    expect(falsy.entities.map((e) => e.id)).toEqual(["b-no"]);
  });
});

describe("entity tags", () => {
  it("create with tags persists and normalizes tags", () => {
    const entity = create(
      testDb.db,
      {
        id: "e-tag-1",
        type: "task",
        data: { name: "Tagged entity" },
        created_by: "actor-1",
        tags: ["Env:Prod", "team:platform"],
      },
      1,
      { actor: "actor-1" },
    );

    // tags are lowercased
    expect(entity.tags).toEqual(["env:prod", "team:platform"]);
  });

  it("create without tags returns empty tags array", () => {
    const entity = create(
      testDb.db,
      {
        id: "e-tag-notags",
        type: "task",
        data: { name: "No tags entity" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );

    expect(entity.tags).toEqual([]);
  });

  it("get returns tags", () => {
    create(
      testDb.db,
      {
        id: "e-get-tags",
        type: "task",
        data: { name: "get tags test" },
        created_by: "actor-1",
        tags: ["env:prod"],
      },
      1,
      { actor: "actor-1" },
    );

    const found = get(testDb.db, "e-get-tags");
    expect(found?.tags).toEqual(["env:prod"]);
  });

  it("list batch-enriches tags for multiple entities (no N+1)", () => {
    create(
      testDb.db,
      {
        id: "e-list-tag-1",
        type: "task",
        data: { name: "E1" },
        created_by: "actor-1",
        tags: ["team:alpha"],
      },
      1,
      { actor: "actor-1" },
    );
    create(
      testDb.db,
      {
        id: "e-list-tag-2",
        type: "task",
        data: { name: "E2" },
        created_by: "actor-1",
        tags: ["team:beta", "env:staging"],
      },
      1,
      { actor: "actor-1" },
    );

    const result = list(testDb.db);
    const e1 = result.entities.find((e) => e.id === "e-list-tag-1");
    const e2 = result.entities.find((e) => e.id === "e-list-tag-2");
    expect(e1?.tags).toEqual(["team:alpha"]);
    expect(e2?.tags).toEqual(
      expect.arrayContaining(["team:beta", "env:staging"]),
    );
    expect(e2?.tags).toHaveLength(2);
  });

  it("list filters by tag via ops-layer tag filter", () => {
    create(
      testDb.db,
      {
        id: "e-filter-tag-1",
        type: "task",
        data: { name: "E1" },
        created_by: "actor-1",
        tags: ["env:prod"],
      },
      1,
      { actor: "actor-1" },
    );
    create(
      testDb.db,
      {
        id: "e-filter-tag-2",
        type: "task",
        data: { name: "E2" },
        created_by: "actor-1",
        tags: ["env:staging"],
      },
      1,
      { actor: "actor-1" },
    );

    const result = list(testDb.db, { tag: "env:prod" });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe("e-filter-tag-1");
  });

  it("update with undefined tags preserves existing tags", () => {
    create(
      testDb.db,
      {
        id: "e-upd-tag-1",
        type: "task",
        data: { name: "Original" },
        created_by: "actor-1",
        tags: ["env:prod"],
      },
      1,
      { actor: "actor-1" },
    );
    const fence = acquire(
      testDb.db,
      "e-upd-tag-1",
      "actor-1",
      "actor-1",
      "exclusive",
      60_000,
    ).fence;

    const updated = update(
      testDb.db,
      "e-upd-tag-1",
      { name: "Updated" },
      fence,
      { actor: "actor-1" },
      // no tags arg → undefined → preserve
    );

    expect(updated.tags).toEqual(["env:prod"]);
  });

  it("update with tags: [] clears existing tags", () => {
    create(
      testDb.db,
      {
        id: "e-upd-tag-2",
        type: "task",
        data: { name: "Original" },
        created_by: "actor-1",
        tags: ["env:prod"],
      },
      1,
      { actor: "actor-1" },
    );
    const fence = acquire(
      testDb.db,
      "e-upd-tag-2",
      "actor-1",
      "actor-1",
      "exclusive",
      60_000,
    ).fence;

    const updated = update(
      testDb.db,
      "e-upd-tag-2",
      { name: "Updated" },
      fence,
      { actor: "actor-1" },
      [],
    );

    expect(updated.tags).toEqual([]);
  });

  it("update with tags: [x] replaces existing tags", () => {
    create(
      testDb.db,
      {
        id: "e-upd-tag-3",
        type: "task",
        data: { name: "Original" },
        created_by: "actor-1",
        tags: ["env:prod", "team:alpha"],
      },
      1,
      { actor: "actor-1" },
    );
    const fence = acquire(
      testDb.db,
      "e-upd-tag-3",
      "actor-1",
      "actor-1",
      "exclusive",
      60_000,
    ).fence;

    const updated = update(
      testDb.db,
      "e-upd-tag-3",
      { name: "Updated" },
      fence,
      { actor: "actor-1" },
      ["env:staging"],
    );

    expect(updated.tags).toEqual(["env:staging"]);
  });

  it("create throws on a malformed tag (space inside tag)", () => {
    expect(() =>
      create(
        testDb.db,
        {
          id: "e-bad-tag-1",
          type: "task",
          data: { name: "Bad tag entity" },
          created_by: "actor-1",
          tags: ["bad tag!"],
        },
        1,
        { actor: "actor-1" },
      ),
    ).toThrow();
  });

  it("create throws on a leading-hyphen tag", () => {
    expect(() =>
      create(
        testDb.db,
        {
          id: "e-bad-tag-2",
          type: "task",
          data: { name: "Bad tag entity" },
          created_by: "actor-1",
          tags: ["-leading-hyphen"],
        },
        1,
        { actor: "actor-1" },
      ),
    ).toThrow();
  });

  it("create throws when more than 20 tags are provided", () => {
    const tooManyTags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    expect(() =>
      create(
        testDb.db,
        {
          id: "e-too-many-tags",
          type: "task",
          data: { name: "Too many tags" },
          created_by: "actor-1",
          tags: tooManyTags,
        },
        1,
        { actor: "actor-1" },
      ),
    ).toThrow();
  });

  it("create with case-duplicate tags persists exactly one lowercased tag", () => {
    const entity = create(
      testDb.db,
      {
        id: "e-dedup-tag",
        type: "task",
        data: { name: "Dedup tags entity" },
        created_by: "actor-1",
        tags: ["env:prod", "ENV:PROD"],
      },
      1,
      { actor: "actor-1" },
    );

    expect(entity.tags).toEqual(["env:prod"]);
    expect(entity.tags).toHaveLength(1);
  });

  it("tag-PK collision on create does not misclassify as EntityAlreadyExistsError", () => {
    // This verifies tag inserts happen after the entity-insert try/catch
    // so a tag PK collision can never be mistaken for EntityAlreadyExistsError.
    // We test the normal create path works — the entity PK throws EntityAlreadyExistsError,
    // not a generic error.
    create(
      testDb.db,
      {
        id: "e-dup-tag",
        type: "task",
        data: { name: "Original" },
        created_by: "actor-1",
        tags: ["env:prod"],
      },
      1,
      { actor: "actor-1" },
    );

    expect(() =>
      create(
        testDb.db,
        {
          id: "e-dup-tag",
          type: "task",
          data: { name: "Duplicate" },
          created_by: "actor-2",
          tags: ["env:prod"],
        },
        1,
        { actor: "actor-2" },
      ),
    ).toThrow(EntityAlreadyExistsError);
  });
});

describe("searchEntities", () => {
  it("FTS5 search finds entity by name", () => {
    create(
      testDb.db,
      {
        id: "e-search-1",
        type: "task",
        data: { name: "Deploy production pipeline", status: "open" },
        created_by: "a",
      },
      1,
      { actor: "a" },
    );

    const results = searchEntities(testDb.db, { q: "pipeline" });
    expect(results).toHaveLength(1);
    expect(results[0].entity_id).toBe("e-search-1");
    expect(results[0].name).toBe("Deploy production pipeline");
  });

  it("returns empty array when no match", () => {
    create(
      testDb.db,
      {
        id: "e-search-2",
        type: "task",
        data: { name: "Something else" },
        created_by: "a",
      },
      1,
      { actor: "a" },
    );

    const results = searchEntities(testDb.db, { q: "nonexistentterm" });
    expect(results).toHaveLength(0);
  });

  it("throws SearchQueryError for invalid query (too long)", () => {
    expect(() => searchEntities(testDb.db, { q: "x".repeat(201) })).toThrow(
      SearchQueryError,
    );
  });
});

describe("list tagFilter (multi-tag AND)", () => {
  it("returns only entities carrying ALL tags in tagFilter", () => {
    // e1 has both tags, e2 has only repo:a, e3 has only team:x
    create(
      testDb.db,
      {
        id: "e-tf-1",
        type: "task",
        data: { name: "E1" },
        created_by: "actor",
        tags: ["repo:a", "team:x"],
      },
      1,
      { actor: "actor" },
    );
    create(
      testDb.db,
      {
        id: "e-tf-2",
        type: "task",
        data: { name: "E2" },
        created_by: "actor",
        tags: ["repo:a"],
      },
      1,
      { actor: "actor" },
    );
    create(
      testDb.db,
      {
        id: "e-tf-3",
        type: "task",
        data: { name: "E3" },
        created_by: "actor",
        tags: ["team:x"],
      },
      1,
      { actor: "actor" },
    );

    const result = list(testDb.db, { tagFilter: ["repo:a", "team:x"] });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe("e-tf-1");
  });

  it("single-tag tagFilter returns entities with that tag", () => {
    create(
      testDb.db,
      {
        id: "e-tf-4",
        type: "task",
        data: { name: "E4" },
        created_by: "actor",
        tags: ["repo:a", "team:x"],
      },
      1,
      { actor: "actor" },
    );
    create(
      testDb.db,
      {
        id: "e-tf-5",
        type: "task",
        data: { name: "E5" },
        created_by: "actor",
        tags: ["repo:a"],
      },
      1,
      { actor: "actor" },
    );

    const result = list(testDb.db, { tagFilter: ["repo:a"] });
    expect(result.entities).toHaveLength(2);
  });

  it("mixed-case tagFilter matches lowercased stored tags", () => {
    create(
      testDb.db,
      {
        id: "e-tf-6",
        type: "task",
        data: { name: "E6" },
        created_by: "actor",
        tags: ["repo:a"],
      },
      1,
      { actor: "actor" },
    );

    // tags stored as lowercase; filter uppercased should still match
    const result = list(testDb.db, { tagFilter: ["REPO:A"] });
    // Note: ops layer lowercases defensively; stored as "repo:a"
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe("e-tf-6");
  });

  it("singular tag AND tagFilter both apply (AND semantics)", () => {
    create(
      testDb.db,
      {
        id: "e-tf-7",
        type: "task",
        data: { name: "E7" },
        created_by: "actor",
        tags: ["repo:a", "team:x"],
      },
      1,
      { actor: "actor" },
    );
    create(
      testDb.db,
      {
        id: "e-tf-8",
        type: "task",
        data: { name: "E8" },
        created_by: "actor",
        tags: ["repo:a"],
      },
      1,
      { actor: "actor" },
    );

    const result = list(testDb.db, {
      tag: "repo:a",
      tagFilter: ["team:x"],
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe("e-tf-7");
  });
});

describe("compactEntity stats batching", () => {
  it("preserves blocker and artifact counts when reusing precomputed stats", () => {
    create(
      testDb.db,
      {
        id: "dep-1",
        type: "task",
        data: { title: "Dependency 1" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );
    create(
      testDb.db,
      {
        id: "dep-2",
        type: "task",
        data: { title: "Dependency 2" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );
    create(
      testDb.db,
      {
        id: "dep-3",
        type: "task",
        data: { title: "Dependency 3" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );

    const first = create(
      testDb.db,
      {
        id: "compact-batch-1",
        type: "task",
        data: { title: "First", status: "open" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );
    const second = create(
      testDb.db,
      {
        id: "compact-batch-2",
        type: "task",
        data: { title: "Second", status: "open" },
        created_by: "actor-1",
      },
      1,
      { actor: "actor-1" },
    );

    testDb.rawDb
      .prepare(
        `INSERT INTO entity_relationships(from_id, to_id, type, schema_version, created_at)
         VALUES (?, ?, 'blocks', 1, 1000), (?, ?, 'soft-blocks', 1, 1001), (?, ?, 'blocks', 1, 1002)`,
      )
      .run("dep-1", first.id, "dep-2", first.id, "dep-3", second.id);
    testDb.rawDb
      .prepare(
        `INSERT INTO artifact_pointers(r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, tombstoned)
         VALUES ('produced/a1.txt', NULL, 'report', 'sha1', 10, NULL, 'text/plain', 1000, 'actor', 0),
                ('produced/a2.txt', NULL, 'report', 'sha2', 10, NULL, 'text/plain', 1000, 'actor', 0),
                ('produced/a3.txt', NULL, 'report', 'sha3', 10, NULL, 'text/plain', 1000, 'actor', 0)`,
      )
      .run();
    testDb.rawDb
      .prepare(
        `INSERT INTO entity_artifact_references(entity_id, artifact_key, slot, metadata, created_at)
         VALUES (?, 'produced/a1.txt', 'primary', '{}', 1000),
                (?, 'produced/a2.txt', 'secondary', '{}', 1001),
                (?, 'produced/a3.txt', 'primary', '{}', 1002)`,
      )
      .run(first.id, first.id, second.id);

    const stats = getCompactEntityStats(testDb.db, [first.id, second.id]);

    expect(compactEntity(testDb.db, first, [], stats)).toEqual(
      compactEntity(testDb.db, first, []),
    );
    expect(compactEntity(testDb.db, second, [], stats)).toEqual(
      compactEntity(testDb.db, second, []),
    );
  });
});
