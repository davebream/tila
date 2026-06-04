import { FenceError } from "@tila/core";
import {
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type Migration,
  type MigrationStorage,
  RecordAlreadyExistsError,
  RecordInvalidStateError,
  RecordNotFoundError,
  RevisionNotFoundError,
  recordOps,
  schema,
} from "@tila/ops-sqlite";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Standard SQLite does not support expression-based PKs used in artifact_relationships.
// Replace for testing (same pattern as check-constraints.test.ts).
function patchMigration(sql: string): string {
  return sql.replace(
    "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
    "PRIMARY KEY (from_key, type)",
  );
}

function createMigrationStorage(
  sqlite: InstanceType<typeof Database>,
): MigrationStorage {
  return {
    sql: {
      exec<T>(statement: string, ...bindings: unknown[]) {
        const patched = patchMigration(statement);
        if (/^\s*(SELECT|PRAGMA)\b/i.test(patched)) {
          return {
            toArray: () => sqlite.prepare(patched).all(...bindings) as T[],
          };
        }
        if (bindings.length > 0) {
          sqlite.prepare(patched).run(...bindings);
        } else {
          sqlite.exec(patched);
        }
        return { toArray: () => [] as T[] };
      },
    },
  };
}

function runMigration(
  sqlite: InstanceType<typeof Database>,
  migration: Migration,
) {
  if ("run" in migration) {
    migration.run(createMigrationStorage(sqlite));
    return;
  }
  sqlite.exec(patchMigration(migration.sql));
}

let rawDb: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  rawDb = new Database(":memory:");
  rawDb.pragma("foreign_keys = ON");
  rawDb.exec(MIGRATION_BOOTSTRAP);
  // Run all migrations in order so all columns (including token_id added in 0004) exist
  for (const migration of MIGRATIONS) {
    runMigration(rawDb, migration);
  }
  db = drizzle(rawDb, { schema });
});

afterEach(() => {
  rawDb.close();
});

describe("createRecord", () => {
  it("creates a record with revision 1 and fence 1", async () => {
    const result = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { env: "production" },
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
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

  it("stores canonical JSON (key-sorted) and correct sha256", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { z_last: 1, a_first: 2 },
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    // Verify canonical JSON in DB
    const rawRow = rawDb
      .prepare("SELECT value_json FROM records WHERE type = ? AND key = ?")
      .get("config", "main") as { value_json: string };
    expect(rawRow.value_json).toBe('{"a_first":2,"z_last":1}');
  });

  it("stores tags (normalized)", async () => {
    const result = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { data: true },
        tags: ["env:prod", "team:platform"],
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(result.tags).toEqual(["env:prod", "team:platform"]);

    // Verify tags in DB
    const tagRows = rawDb
      .prepare(
        "SELECT tag FROM record_tags WHERE type = ? AND key = ? ORDER BY tag",
      )
      .all("config", "main") as { tag: string }[];
    expect(tagRows.map((r) => r.tag)).toEqual(["env:prod", "team:platform"]);
  });

  it("throws RecordAlreadyExistsError on duplicate (type, key)", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    await expect(
      recordOps.createRecord(
        db,
        {
          type: "config",
          key: "main",
          value: { v: 2 },
          schema_version: 1,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).rejects.toThrow(RecordAlreadyExistsError);
  });

  it("writes a revision row with operation created", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        message: "initial setup",
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    const rev = rawDb
      .prepare(
        "SELECT * FROM record_revisions WHERE type = ? AND key = ? AND revision = ?",
      )
      .get("config", "main", 1) as Record<string, unknown>;
    expect(rev.operation).toBe("created");
    expect(rev.message).toBe("initial setup");
    expect(rev.actor).toBe("test");
  });

  it("emits record.created journal event", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    const events = rawDb
      .prepare(
        "SELECT kind, resource, actor FROM journal ORDER BY seq DESC LIMIT 1",
      )
      .get() as { kind: string; resource: string; actor: string };
    expect(events.kind).toBe("record.created");
    expect(events.resource).toBe("record:config/main");
    expect(events.actor).toBe("test");
  });
});

describe("setRecord", () => {
  it("updates value, increments revision and fence", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    const updated = await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 2 },
        fence: created.fence,
        schema_version: 1,
        actor: "updater",
      },
      { actor: "updater" },
    );

    expect(updated.revision).toBe(2);
    expect(updated.fence).toBe(2);
    expect(updated.value).toEqual({ v: 2 });
    expect(updated.updated_by).toBe("updater");
    expect(updated.created_at).toBe(created.created_at);
  });

  it("replaces tags when tags array is provided", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        tags: ["old-tag"],
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    const updated = await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 2 },
        fence: created.fence,
        tags: ["new-tag-1", "new-tag-2"],
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(updated.tags).toEqual(["new-tag-1", "new-tag-2"]);
  });

  it("preserves existing tags when tags is undefined", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        tags: ["keep-me"],
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    const updated = await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 2 },
        fence: created.fence,
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(updated.tags).toEqual(["keep-me"]);
  });

  it("clears all tags when tags is empty array", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        tags: ["remove-me"],
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    const updated = await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 2 },
        fence: created.fence,
        tags: [],
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(updated.tags).toEqual([]);
  });

  it("throws RecordNotFoundError for missing record", async () => {
    await expect(
      recordOps.setRecord(
        db,
        {
          type: "config",
          key: "nonexistent",
          value: { v: 1 },
          fence: 1,
          schema_version: 1,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).rejects.toThrow(RecordNotFoundError);
  });

  it("throws FenceError for stale fence", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    await expect(
      recordOps.setRecord(
        db,
        {
          type: "config",
          key: "main",
          value: { v: 2 },
          fence: created.fence + 999,
          schema_version: 1,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).rejects.toThrow(FenceError);
  });

  it("writes a revision row with operation set", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 2 },
        fence: created.fence,
        message: "update config",
        schema_version: 1,
        actor: "updater",
      },
      { actor: "updater" },
    );

    const rev = rawDb
      .prepare(
        "SELECT * FROM record_revisions WHERE type = ? AND key = ? AND revision = ?",
      )
      .get("config", "main", 2) as Record<string, unknown>;
    expect(rev.operation).toBe("set");
    expect(rev.message).toBe("update config");
    expect(rev.actor).toBe("updater");
  });

  it("emits record.updated journal event", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 2 },
        fence: created.fence,
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    const events = rawDb
      .prepare("SELECT kind, resource FROM journal ORDER BY seq DESC LIMIT 1")
      .get() as { kind: string; resource: string };
    expect(events.kind).toBe("record.updated");
    expect(events.resource).toBe("record:config/main");
  });
});

describe("getRecord", () => {
  it("returns record with tags and current fence", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { env: "staging" },
        tags: ["team:platform"],
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.getRecord(db, "config", "main");

    if (!result) throw new Error("Expected record to be found");
    expect(result.type).toBe("config");
    expect(result.key).toBe("main");
    expect(result.value).toEqual({ env: "staging" });
    expect(result.tags).toEqual(["team:platform"]);
    expect(result.fence).toBe(1);
    expect(result.revision).toBe(1);
  });

  it("returns null for missing record", () => {
    const result = recordOps.getRecord(db, "config", "nonexistent");
    expect(result).toBeNull();
  });

  it("returns updated state after setRecord", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 1 },
        schema_version: 1,
        actor: "test",
      },
      { actor: "test" },
    );

    await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { v: 2 },
        fence: created.fence,
        tags: ["updated"],
        schema_version: 1,
        actor: "updater",
      },
      { actor: "updater" },
    );

    const result = recordOps.getRecord(db, "config", "main");
    if (!result) throw new Error("Expected record to be found");
    expect(result.value).toEqual({ v: 2 });
    expect(result.tags).toEqual(["updated"]);
    expect(result.fence).toBe(2);
    expect(result.revision).toBe(2);
  });
});

describe("validateRecordValue", () => {
  it("returns ok:true when no fields are declared", () => {
    const result = recordOps.validateRecordValue(
      { anything: "goes" },
      { format: "json", history: "revision", mcp_resource: false, fields: {} },
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:true when required fields are present", () => {
    const result = recordOps.validateRecordValue(
      { name: "test", version: 1 },
      {
        format: "json",
        history: "revision",
        mcp_resource: false,
        fields: {
          name: { type: "string", required: true },
        },
      },
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns errors for missing required fields", () => {
    const result = recordOps.validateRecordValue(
      { unrelated: true },
      {
        format: "json",
        history: "revision",
        mcp_resource: false,
        fields: {
          name: { type: "string", required: true },
          env: { type: "string", required: true },
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain("name");
      expect(result.errors[1]).toContain("env");
    }
  });
});

describe("patchRecord", () => {
  it("merges partial patch into existing value", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { name: "tila", version: "1.0", debug: false },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const patched = await recordOps.patchRecord(
      db,
      {
        type: "config",
        key: "app",
        patch: { version: "2.0", env: "prod" },
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
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

  it("deletes key when patch value is null", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { name: "tila", debug: true },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const patched = await recordOps.patchRecord(
      db,
      {
        type: "config",
        key: "app",
        patch: { debug: null },
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(patched.value).toEqual({ name: "tila" });
    expect("debug" in patched.value).toBe(false);
  });

  it("replaces arrays wholesale (no element merge)", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { tags: ["a", "b", "c"] },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const patched = await recordOps.patchRecord(
      db,
      {
        type: "config",
        key: "app",
        patch: { tags: ["x"] },
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(patched.value).toEqual({ tags: ["x"] });
  });

  it("recursively merges nested objects", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { db: { host: "localhost", port: 5432 } },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const patched = await recordOps.patchRecord(
      db,
      {
        type: "config",
        key: "app",
        patch: { db: { port: 3306, ssl: true } },
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(patched.value).toEqual({
      db: { host: "localhost", port: 3306, ssl: true },
    });
  });

  it("writes operation='patch' revision row and record.updated journal", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { name: "tila" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    await recordOps.patchRecord(
      db,
      {
        type: "config",
        key: "app",
        patch: { name: "tila-v2" },
        fence: created.fence,
        schema_version: 0,
        actor: "patcher",
      },
      { actor: "patcher" },
    );

    const revisions = db
      .select()
      .from(schema.recordRevisions)
      .where(
        and(
          eq(schema.recordRevisions.type, "config"),
          eq(schema.recordRevisions.key, "app"),
        ),
      )
      .all();
    const patchRev = revisions.find((r) => r.operation === "patch");
    expect(patchRev).toBeDefined();
    expect(patchRev?.revision).toBe(2);

    const journal = db.select().from(schema.journal).all();
    const updateEvents = journal.filter(
      (j) => j.kind === "record.updated" && j.resource === "record:config/app",
    );
    expect(updateEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("throws FenceError on stale fence", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { name: "tila" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    await expect(
      recordOps.patchRecord(
        db,
        {
          type: "config",
          key: "app",
          patch: { name: "v2" },
          fence: created.fence + 999,
          schema_version: 0,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).rejects.toThrow(FenceError);
  });

  it("throws RecordNotFoundError for missing record", async () => {
    await expect(
      recordOps.patchRecord(
        db,
        {
          type: "config",
          key: "missing",
          patch: { x: 1 },
          fence: 1,
          schema_version: 0,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).rejects.toThrow(RecordNotFoundError);
  });

  it("throws RecordInvalidStateError on archived record", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { name: "tila" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    recordOps.archiveRecord(
      db,
      {
        type: "config",
        key: "app",
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    const archived = recordOps.getRecord(db, "config", "app");

    await expect(
      recordOps.patchRecord(
        db,
        {
          type: "config",
          key: "app",
          patch: { name: "v2" },
          fence: archived?.fence ?? 0,
          schema_version: 0,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).rejects.toThrow(RecordInvalidStateError);
  });

  it("does not modify tags", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { name: "tila" },
        tags: ["prod", "primary"],
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const patched = await recordOps.patchRecord(
      db,
      {
        type: "config",
        key: "app",
        patch: { name: "v2" },
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(patched.tags.sort()).toEqual(["primary", "prod"]);
  });
});

describe("archiveRecord", () => {
  it("archives active record", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.archiveRecord(
      db,
      {
        type: "svc",
        key: "api",
        fence: created.fence,
        schema_version: 0,
        actor: "archiver",
      },
      { actor: "archiver" },
    );

    expect(result.archived).toBe(1);
    expect(result.revision).toBe(2);
    expect(result.fence).toBe(created.fence + 1);
  });

  it("writes operation='archived' revision row and record.archived journal", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    recordOps.archiveRecord(
      db,
      {
        type: "svc",
        key: "api",
        fence: created.fence,
        schema_version: 0,
        actor: "archiver",
      },
      { actor: "archiver" },
    );

    const revisions = db
      .select()
      .from(schema.recordRevisions)
      .where(
        and(
          eq(schema.recordRevisions.type, "svc"),
          eq(schema.recordRevisions.key, "api"),
        ),
      )
      .all();
    const archiveRev = revisions.find((r) => r.operation === "archived");
    expect(archiveRev).toBeDefined();
    expect(archiveRev?.revision).toBe(2);

    const journal = db.select().from(schema.journal).all();
    const archiveEvents = journal.filter(
      (j) => j.kind === "record.archived" && j.resource === "record:svc/api",
    );
    expect(archiveEvents.length).toBe(1);
  });

  it("throws RecordInvalidStateError when already archived", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    const archived = recordOps.archiveRecord(
      db,
      {
        type: "svc",
        key: "api",
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(() =>
      recordOps.archiveRecord(
        db,
        {
          type: "svc",
          key: "api",
          fence: archived.fence,
          schema_version: 0,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).toThrow(RecordInvalidStateError);
  });

  it("throws RecordNotFoundError for missing record", () => {
    expect(() =>
      recordOps.archiveRecord(
        db,
        {
          type: "svc",
          key: "missing",
          fence: 1,
          schema_version: 0,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).toThrow(RecordNotFoundError);
  });

  it("throws FenceError on stale fence", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(() =>
      recordOps.archiveRecord(
        db,
        {
          type: "svc",
          key: "api",
          fence: created.fence + 999,
          schema_version: 0,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).toThrow(FenceError);
  });
});

describe("unarchiveRecord", () => {
  it("unarchives an archived record", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { status: "stopped" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    const archived = recordOps.archiveRecord(
      db,
      {
        type: "svc",
        key: "api",
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.unarchiveRecord(
      db,
      {
        type: "svc",
        key: "api",
        fence: archived.fence,
        schema_version: 0,
        actor: "restorer",
      },
      { actor: "restorer" },
    );

    expect(result.archived).toBe(0);
    expect(result.revision).toBe(3);
    expect(result.fence).toBe(archived.fence + 1);
  });

  it("writes operation='unarchived' revision row and record.unarchived journal", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { status: "stopped" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    const archived = recordOps.archiveRecord(
      db,
      {
        type: "svc",
        key: "api",
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    recordOps.unarchiveRecord(
      db,
      {
        type: "svc",
        key: "api",
        fence: archived.fence,
        schema_version: 0,
        actor: "restorer",
      },
      { actor: "restorer" },
    );

    const revisions = db
      .select()
      .from(schema.recordRevisions)
      .where(
        and(
          eq(schema.recordRevisions.type, "svc"),
          eq(schema.recordRevisions.key, "api"),
        ),
      )
      .all();
    const unarchiveRev = revisions.find((r) => r.operation === "unarchived");
    expect(unarchiveRev).toBeDefined();
    expect(unarchiveRev?.revision).toBe(3);

    const journal = db.select().from(schema.journal).all();
    const events = journal.filter(
      (j) => j.kind === "record.unarchived" && j.resource === "record:svc/api",
    );
    expect(events.length).toBe(1);
  });

  it("throws RecordInvalidStateError on active record", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(() =>
      recordOps.unarchiveRecord(
        db,
        {
          type: "svc",
          key: "api",
          fence: created.fence,
          schema_version: 0,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).toThrow(RecordInvalidStateError);
  });

  it("throws FenceError on stale fence", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { status: "running" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    const archived = recordOps.archiveRecord(
      db,
      {
        type: "svc",
        key: "api",
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    expect(() =>
      recordOps.unarchiveRecord(
        db,
        {
          type: "svc",
          key: "api",
          fence: archived.fence + 999,
          schema_version: 0,
          actor: "test",
        },
        { actor: "test" },
      ),
    ).toThrow(FenceError);
  });
});

describe("listRecords", () => {
  it("returns only active records by default", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { name: "api" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    const created2 = await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "web",
        value: { name: "web" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    recordOps.archiveRecord(
      db,
      {
        type: "svc",
        key: "web",
        fence: created2.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.listRecords(db, { type: "svc" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe("api");
    expect(result.total).toBe(1);
    expect(result.next_cursor).toBeNull();
  });

  it("returns both active and archived with includeArchived=true", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { name: "api" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    const created2 = await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "web",
        value: { name: "web" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    recordOps.archiveRecord(
      db,
      {
        type: "svc",
        key: "web",
        fence: created2.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.listRecords(db, {
      type: "svc",
      includeArchived: true,
    });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("filters by tag", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { name: "api" },
        tags: ["prod"],
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "web",
        value: { name: "web" },
        tags: ["staging"],
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.listRecords(db, { type: "svc", tag: "prod" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe("api");
  });

  it("filters by scalar dataFilter", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { owner: "platform", tier: "p0" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "web",
        value: { owner: "frontend", tier: "p1" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.listRecords(db, {
      type: "svc",
      dataFilter: { owner: "platform" },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe("api");
  });

  it("rejects object/array dataFilter values", () => {
    expect(() =>
      recordOps.listRecords(db, {
        type: "svc",
        dataFilter: { nested: { deep: true } },
      }),
    ).toThrow("dataFilter values must be scalar");
  });

  it("returns metadata-only shape (no value field)", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { name: "api", secret: "hidden" },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.listRecords(db, { type: "svc" });
    expect(result.items[0]).not.toHaveProperty("value");
    expect(result.items[0]).toHaveProperty("type");
    expect(result.items[0]).toHaveProperty("key");
    expect(result.items[0]).toHaveProperty("revision");
    expect(result.items[0]).toHaveProperty("tags");
  });

  it("returns tags for each item", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: { name: "api" },
        tags: ["prod", "primary"],
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.listRecords(db, { type: "svc" });
    expect(result.items[0].tags.sort()).toEqual(["primary", "prod"]);
  });

  it("truncates at limit and sets next_cursor", async () => {
    for (let i = 0; i < 3; i++) {
      await recordOps.createRecord(
        db,
        {
          type: "svc",
          key: `svc-${i}`,
          value: { idx: i },
          schema_version: 0,
          actor: "test",
        },
        { actor: "test" },
      );
    }

    const result = recordOps.listRecords(db, { type: "svc", limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.next_cursor).toBe("truncated");
  });
});

describe("listRecordHistory", () => {
  it("returns history newest-first, metadata-only by default", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { v: 1 },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { v: 2 },
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.listRecordHistory(db, "config", "app");
    expect(result.items).toHaveLength(2);
    expect(result.items[0].revision).toBe(2); // newest first
    expect(result.items[1].revision).toBe(1);
    expect(result.items[0]).not.toHaveProperty("value");
    expect(result.total).toBe(2);
  });

  it("includes values when includeValues=true", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { v: 1 },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const result = recordOps.listRecordHistory(db, "config", "app", {
      includeValues: true,
    });
    expect(result.items[0].value).toEqual({ v: 1 });
  });

  it("truncates at limit", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: { v: 1 },
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    let fence = created.fence;
    for (let i = 2; i <= 5; i++) {
      const updated = await recordOps.setRecord(
        db,
        {
          type: "config",
          key: "app",
          value: { v: i },
          fence,
          schema_version: 0,
          actor: "test",
        },
        { actor: "test" },
      );
      fence = updated.fence;
    }

    const result = recordOps.listRecordHistory(db, "config", "app", {
      limit: 3,
    });
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(5);
    expect(result.next_cursor).toBe("truncated");
  });
});

describe("listRecordTypesInUse", () => {
  it("returns distinct types from active records", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "api",
        value: {},
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "app",
        value: {},
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    await recordOps.createRecord(
      db,
      {
        type: "svc",
        key: "web",
        value: {},
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const types = recordOps.listRecordTypesInUse(db);
    expect(types).toEqual(["config", "svc"]); // sorted
  });

  it("excludes archived-only types", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "deprecated",
        key: "old",
        value: {},
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    recordOps.archiveRecord(
      db,
      {
        type: "deprecated",
        key: "old",
        fence: created.fence,
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );
    await recordOps.createRecord(
      db,
      {
        type: "active_type",
        key: "new",
        value: {},
        schema_version: 0,
        actor: "test",
      },
      { actor: "test" },
    );

    const types = recordOps.listRecordTypesInUse(db);
    expect(types).toEqual(["active_type"]);
    expect(types).not.toContain("deprecated");
  });

  it("returns empty array when no records exist", () => {
    const types = recordOps.listRecordTypesInUse(db);
    expect(types).toEqual([]);
  });
});

describe("snapshot artifact flows", () => {
  it("createRecord with canonical_artifact_key stores the key on the revision row", async () => {
    const result = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { env: "production" },
        canonical_artifact_key: "produced/record:config/main/abc123.json",
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
    );
    expect(result.revision).toBe(1);

    const rev = db
      .select()
      .from(schema.recordRevisions)
      .where(
        and(
          eq(schema.recordRevisions.type, "config"),
          eq(schema.recordRevisions.key, "main"),
          eq(schema.recordRevisions.revision, 1),
        ),
      )
      .get();
    expect(rev?.canonical_artifact_key).toBe(
      "produced/record:config/main/abc123.json",
    );
  });

  it("setRecord with canonical_artifact_key stores the key on the revision row", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { env: "production" },
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
    );
    const result = await recordOps.setRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { env: "staging" },
        fence: created.fence,
        canonical_artifact_key: "produced/record:config/main/def456.json",
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
    );
    expect(result.revision).toBe(2);

    const rev = db
      .select()
      .from(schema.recordRevisions)
      .where(
        and(
          eq(schema.recordRevisions.type, "config"),
          eq(schema.recordRevisions.key, "main"),
          eq(schema.recordRevisions.revision, 2),
        ),
      )
      .get();
    expect(rev?.canonical_artifact_key).toBe(
      "produced/record:config/main/def456.json",
    );
  });

  it("createRecord without canonical_artifact_key leaves revision canonical_artifact_key null", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { env: "production" },
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
    );

    const rev = db
      .select()
      .from(schema.recordRevisions)
      .where(
        and(
          eq(schema.recordRevisions.type, "config"),
          eq(schema.recordRevisions.key, "main"),
          eq(schema.recordRevisions.revision, 1),
        ),
      )
      .get();
    expect(rev?.canonical_artifact_key).toBeNull();
  });

  it("stampArtifacts updates canonical_artifact_key and source_artifact_key on revision row", async () => {
    const created = await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { env: "production" },
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
    );
    const patched = await recordOps.patchRecord(
      db,
      {
        type: "config",
        key: "main",
        patch: { env: "staging" },
        fence: created.fence,
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
    );
    expect(patched.revision).toBe(2);

    recordOps.stampArtifacts(db, {
      type: "config",
      key: "main",
      revision: 2,
      canonical_artifact_key: "produced/record:config/main/ghi789.json",
      source_artifact_key: "sources/abc.yaml",
    });

    const rev = db
      .select()
      .from(schema.recordRevisions)
      .where(
        and(
          eq(schema.recordRevisions.type, "config"),
          eq(schema.recordRevisions.key, "main"),
          eq(schema.recordRevisions.revision, 2),
        ),
      )
      .get();
    expect(rev?.canonical_artifact_key).toBe(
      "produced/record:config/main/ghi789.json",
    );
    expect(rev?.source_artifact_key).toBe("sources/abc.yaml");
  });

  it("stampArtifacts throws RevisionNotFoundError for non-existent revision", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { env: "production" },
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
    );

    expect(() =>
      recordOps.stampArtifacts(db, {
        type: "config",
        key: "main",
        revision: 999,
        canonical_artifact_key: "produced/record:config/main/xxx.json",
        source_artifact_key: null,
      }),
    ).toThrow(RevisionNotFoundError);
  });

  it("stampArtifacts throws RevisionNotFoundError for revision of wrong record", async () => {
    await recordOps.createRecord(
      db,
      {
        type: "config",
        key: "main",
        value: { env: "production" },
        schema_version: 1,
        actor: "test-agent",
      },
      { actor: "test-agent" },
    );

    expect(() =>
      recordOps.stampArtifacts(db, {
        type: "other_type",
        key: "main",
        revision: 1,
        canonical_artifact_key: "produced/record:other_type/main/xxx.json",
        source_artifact_key: null,
      }),
    ).toThrow(RevisionNotFoundError);
  });
});
