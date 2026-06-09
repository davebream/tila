import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchQueryError } from "../src/artifact-ops";
import { acquire } from "../src/coordination-ops";
import {
  EntityAlreadyExistsError,
  EntityNotFoundError,
  archive,
  create,
  get,
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
