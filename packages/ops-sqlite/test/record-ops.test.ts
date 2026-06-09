import { FenceError } from "@tila/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RecordAlreadyExistsError,
  RecordInvalidStateError,
  RecordNotFoundError,
  archiveRecord,
  createRecord,
  getRecord,
  listRecordHistory,
  listRecords,
  patchRecord,
  setRecord,
  unarchiveRecord,
} from "../src/record-ops";
import { type TestDb, createTestDb } from "./helpers";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.rawDb.close();
});

function testOrigin(actor: string) {
  return { actor };
}

describe("createRecord", () => {
  it("creates a record with revision 1 and fence 1", async () => {
    const result = await createRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        value: { env: "production" },
        schema_version: 1,
        actor: "test-agent",
      },
      testOrigin("test-agent"),
    );

    expect(result.type).toBe("config");
    expect(result.key).toBe("main");
    expect(result.revision).toBe(1);
    expect(result.fence).toBe(1);
    expect(result.archived).toBe(0);
    expect(result.value).toEqual({ env: "production" });
    expect(result.value_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.updated_by).toBe("test-agent");
    expect(result.tags).toEqual([]);
  });

  it("throws RecordAlreadyExistsError on duplicate (type, key)", async () => {
    await createRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        schema_version: 1,
        actor: "test",
      },
      testOrigin("test"),
    );

    await expect(
      createRecord(
        testDb.db,
        {
          type: "config",
          key: "main",
          value: { v: 2 },
          schema_version: 1,
          actor: "test",
        },
        testOrigin("test"),
      ),
    ).rejects.toThrow(RecordAlreadyExistsError);
  });

  it("stores tags passed at creation time", async () => {
    const result = await createRecord(
      testDb.db,
      {
        type: "config",
        key: "tagged",
        value: { data: true },
        tags: ["env:prod", "team:platform"],
        schema_version: 1,
        actor: "test",
      },
      testOrigin("test"),
    );

    expect(result.tags).toEqual(["env:prod", "team:platform"]);
  });
});

describe("setRecord", () => {
  it("updates value, increments revision and fence", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        schema_version: 1,
        actor: "test",
      },
      testOrigin("test"),
    );

    const updated = await setRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        value: { v: 2 },
        fence: created.fence,
        schema_version: 1,
        actor: "updater",
      },
      testOrigin("updater"),
    );

    expect(updated.revision).toBe(2);
    expect(updated.fence).toBe(2);
    expect(updated.value).toEqual({ v: 2 });
    expect(updated.updated_by).toBe("updater");
  });

  it("throws FenceError on stale fence", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        schema_version: 1,
        actor: "test",
      },
      testOrigin("test"),
    );

    await expect(
      setRecord(
        testDb.db,
        {
          type: "config",
          key: "main",
          value: { v: 2 },
          fence: created.fence + 999,
          schema_version: 1,
          actor: "test",
        },
        testOrigin("test"),
      ),
    ).rejects.toThrow(FenceError);
  });

  it("throws RecordNotFoundError for missing record", async () => {
    await expect(
      setRecord(
        testDb.db,
        {
          type: "config",
          key: "nonexistent",
          value: { v: 1 },
          fence: 1,
          schema_version: 1,
          actor: "test",
        },
        testOrigin("test"),
      ),
    ).rejects.toThrow(RecordNotFoundError);
  });
});

describe("patchRecord", () => {
  it("merges partial patch into existing value", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "config",
        key: "app",
        value: { name: "tila", version: "1.0", debug: false },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    const patched = await patchRecord(
      testDb.db,
      {
        type: "config",
        key: "app",
        patch: { version: "2.0", env: "prod" },
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    expect(patched.value).toEqual({
      name: "tila",
      version: "2.0",
      debug: false,
      env: "prod",
    });
    expect(patched.revision).toBe(2);
    expect(patched.fence).toBe(created.fence + 1);
  });

  it("throws FenceError on stale fence", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "config",
        key: "app",
        value: { name: "tila" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    await expect(
      patchRecord(
        testDb.db,
        {
          type: "config",
          key: "app",
          patch: { name: "v2" },
          fence: created.fence + 999,
          schema_version: 0,
          actor: "test",
        },
        testOrigin("test"),
      ),
    ).rejects.toThrow(FenceError);
  });

  it("throws RecordInvalidStateError on archived record", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "config",
        key: "app",
        value: { name: "tila" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    archiveRecord(
      testDb.db,
      {
        type: "config",
        key: "app",
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    const archived = getRecord(testDb.db, "config", "app");

    await expect(
      patchRecord(
        testDb.db,
        {
          type: "config",
          key: "app",
          patch: { name: "v2" },
          fence: archived?.fence ?? 0,
          schema_version: 0,
          actor: "test",
        },
        testOrigin("test"),
      ),
    ).rejects.toThrow(RecordInvalidStateError);
  });
});

describe("archiveRecord", () => {
  it("sets archived state and increments fence", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    const result = archiveRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        fence: created.fence,
        schema_version: 0,
        actor: "archiver",
      },
      testOrigin("archiver"),
    );

    expect(result.archived).toBe(1);
    expect(result.revision).toBe(2);
    expect(result.fence).toBe(created.fence + 1);
  });

  it("throws FenceError on stale fence", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    expect(() =>
      archiveRecord(
        testDb.db,
        {
          type: "svc",
          key: "api",
          fence: created.fence + 999,
          schema_version: 0,
          actor: "test",
        },
        testOrigin("test"),
      ),
    ).toThrow(FenceError);
  });

  it("throws RecordInvalidStateError when already archived", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    const archived = archiveRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    expect(() =>
      archiveRecord(
        testDb.db,
        {
          type: "svc",
          key: "api",
          fence: archived.fence,
          schema_version: 0,
          actor: "test",
        },
        testOrigin("test"),
      ),
    ).toThrow(RecordInvalidStateError);
  });
});

describe("unarchiveRecord", () => {
  it("restores an archived record to active state", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        value: { status: "stopped" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    const archived = archiveRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    const result = unarchiveRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        fence: archived.fence,
        schema_version: 0,
        actor: "restorer",
      },
      testOrigin("restorer"),
    );

    expect(result.archived).toBe(0);
    expect(result.revision).toBe(3);
    expect(result.fence).toBe(archived.fence + 1);
  });

  it("throws RecordInvalidStateError on active record", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    expect(() =>
      unarchiveRecord(
        testDb.db,
        {
          type: "svc",
          key: "api",
          fence: created.fence,
          schema_version: 0,
          actor: "test",
        },
        testOrigin("test"),
      ),
    ).toThrow(RecordInvalidStateError);
  });

  it("throws FenceError on stale fence", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    const archived = archiveRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    expect(() =>
      unarchiveRecord(
        testDb.db,
        {
          type: "svc",
          key: "api",
          fence: archived.fence + 999,
          schema_version: 0,
          actor: "test",
        },
        testOrigin("test"),
      ),
    ).toThrow(FenceError);
  });
});

describe("listRecords", () => {
  it("returns active records by default", async () => {
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        value: { name: "api" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    const created2 = await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "web",
        value: { name: "web" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    archiveRecord(
      testDb.db,
      {
        type: "svc",
        key: "web",
        fence: created2.fence,
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    const result = listRecords(testDb.db, { type: "svc" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe("api");
    expect(result.total).toBe(1);
    expect(result.next_cursor).toBeNull();
  });

  it("filters by tag", async () => {
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        value: { name: "api" },
        tags: ["prod"],
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "web",
        value: { name: "web" },
        tags: ["staging"],
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    const result = listRecords(testDb.db, { type: "svc", tag: "prod" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe("api");
  });

  it("includes archived records when includeArchived=true", async () => {
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        value: { name: "api" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    const c2 = await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "web",
        value: { name: "web" },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    archiveRecord(
      testDb.db,
      {
        type: "svc",
        key: "web",
        fence: c2.fence,
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    const result = listRecords(testDb.db, {
      type: "svc",
      includeArchived: true,
    });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
  });
});

describe("listRecordHistory", () => {
  it("returns history newest-first", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "config",
        key: "app",
        value: { v: 1 },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    await setRecord(
      testDb.db,
      {
        type: "config",
        key: "app",
        value: { v: 2 },
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    const result = listRecordHistory(testDb.db, "config", "app");
    expect(result.items).toHaveLength(2);
    expect(result.items[0].revision).toBe(2);
    expect(result.items[1].revision).toBe(1);
    expect(result.total).toBe(2);
  });

  it("respects limit", async () => {
    const created = await createRecord(
      testDb.db,
      {
        type: "config",
        key: "app",
        value: { v: 1 },
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    let fence = created.fence;
    for (let i = 2; i <= 5; i++) {
      const updated = await setRecord(
        testDb.db,
        {
          type: "config",
          key: "app",
          value: { v: i },
          fence,
          schema_version: 0,
          actor: "test",
        },
        testOrigin("test"),
      );
      fence = updated.fence;
    }

    const result = listRecordHistory(testDb.db, "config", "app", { limit: 3 });
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(5);
    expect(result.next_cursor).toBe("truncated");
  });
});

describe("listRecords tagFilter (multi-tag AND)", () => {
  it("returns only records carrying ALL tags in tagFilter", async () => {
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api",
        value: { name: "api" },
        tags: ["repo:a", "team:x"],
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "web",
        value: { name: "web" },
        tags: ["repo:a"],
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "worker",
        value: { name: "worker" },
        tags: ["team:x"],
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    const result = listRecords(testDb.db, {
      type: "svc",
      tagFilter: ["repo:a", "team:x"],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe("api");
  });

  it("single-tag tagFilter returns records with that tag", async () => {
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api2",
        value: { name: "api2" },
        tags: ["repo:a", "team:x"],
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "web2",
        value: { name: "web2" },
        tags: ["repo:a"],
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    const result = listRecords(testDb.db, {
      type: "svc",
      tagFilter: ["repo:a"],
    });
    expect(result.items).toHaveLength(2);
  });

  it("singular tag AND tagFilter both apply (AND semantics)", async () => {
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "api3",
        value: { name: "api3" },
        tags: ["repo:a", "team:x"],
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );
    await createRecord(
      testDb.db,
      {
        type: "svc",
        key: "web3",
        value: { name: "web3" },
        tags: ["repo:a"],
        schema_version: 0,
        actor: "test",
      },
      testOrigin("test"),
    );

    const result = listRecords(testDb.db, {
      type: "svc",
      tag: "repo:a",
      tagFilter: ["team:x"],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe("api3");
  });
});
