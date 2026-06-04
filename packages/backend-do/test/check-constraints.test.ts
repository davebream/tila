import { MIGRATION_0001, MIGRATION_0008 } from "@tila/ops-sqlite";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Cloudflare's SQLite fork supports expressions in PRIMARY KEY (e.g. COALESCE).
// Standard SQLite (used by better-sqlite3) does not. Replace the expression-based PK
// in artifact_relationships with a simple (from_key, type) PK for unit testing.
// The CHECK constraint on from_key is still present and tested.
const MIGRATION_0001_TEST = MIGRATION_0001.replace(
  "PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type)",
  "PRIMARY KEY (from_key, type)",
);

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(MIGRATION_0001_TEST);
});

afterEach(() => {
  db.close();
});

describe("entity_relationships CHECK constraints", () => {
  // FK requires entities to exist first
  beforeEach(() => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("task-1", "task", 1, "{}", 0, now, now, "test");
    db.prepare(
      "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("task-2", "task", 1, "{}", 0, now, now, "test");
  });

  it("rejects from_id containing a slash", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO entity_relationships (from_id, to_id, type, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("some/slash/path", "task-2", "parent-child", 1, Date.now());
    }).toThrow(/CHECK constraint failed/);
  });

  it("rejects to_id containing a slash", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO entity_relationships (from_id, to_id, type, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("task-1", "another/slash", "parent-child", 1, Date.now());
    }).toThrow(/CHECK constraint failed/);
  });

  it("accepts valid entity IDs without slashes", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO entity_relationships (from_id, to_id, type, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("task-1", "task-2", "parent-child", 1, Date.now());
    }).not.toThrow();
  });
});

describe("entity_artifact_references CHECK constraints", () => {
  beforeEach(() => {
    const now = Date.now();
    // FK prerequisite: entity must exist
    db.prepare(
      "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("task-1", "task", 1, "{}", 0, now, now, "test");
    // FK prerequisite: artifact_pointer must exist
    db.prepare(
      "INSERT INTO artifact_pointers (r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "artifacts/task-1/abc123.md",
      "task-1",
      "plan",
      "deadbeef",
      1024,
      null,
      "text/markdown",
      now,
      "test",
      null,
      0,
    );
  });

  it("rejects entity_id containing a slash", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO entity_artifact_references (entity_id, artifact_key, slot, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        "task/slash",
        "artifacts/task-1/abc123.md",
        "plan",
        "{}",
        Date.now(),
      );
    }).toThrow(/CHECK constraint failed/);
  });

  it("rejects artifact_key without a slash", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO entity_artifact_references (entity_id, artifact_key, slot, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("task-1", "no-slash-key", "plan", "{}", Date.now());
    }).toThrow(/(CHECK constraint failed|FOREIGN KEY constraint failed)/);
  });

  it("accepts valid entity_id and artifact_key", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO entity_artifact_references (entity_id, artifact_key, slot, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("task-1", "artifacts/task-1/abc123.md", "plan", "{}", Date.now());
    }).not.toThrow();
  });
});

describe("artifact_relationships CHECK constraints", () => {
  beforeEach(() => {
    const now = Date.now();
    // FK prerequisite: artifact_pointers must exist for from_key (and to_key if used)
    db.prepare(
      "INSERT INTO artifact_pointers (r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "artifacts/a/hash.md",
      null,
      "plan",
      "aaa",
      512,
      null,
      "text/markdown",
      now,
      "test",
      null,
      0,
    );
    db.prepare(
      "INSERT INTO artifact_pointers (r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "artifacts/b/hash.md",
      null,
      "plan",
      "bbb",
      256,
      null,
      "text/markdown",
      now,
      "test",
      null,
      0,
    );
  });

  it("rejects from_key without a slash", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO artifact_relationships (from_key, to_key, to_uri, type, target, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "no-slash-key",
        null,
        "https://github.com/pr/1",
        "references",
        "https://github.com/pr/1",
        "{}",
        Date.now(),
      );
    }).toThrow(/CHECK constraint failed/);
  });

  it("accepts valid from_key with to_key (internal reference)", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO artifact_relationships (from_key, to_key, to_uri, type, target, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "artifacts/a/hash.md",
        "artifacts/b/hash.md",
        null,
        "references",
        "artifacts/b/hash.md",
        "{}",
        Date.now(),
      );
    }).not.toThrow();
  });

  it("accepts valid from_key with to_uri (external reference)", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO artifact_relationships (from_key, to_key, to_uri, type, target, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "artifacts/a/hash.md",
        null,
        "https://github.com/pr/1",
        "references",
        "https://github.com/pr/1",
        "{}",
        Date.now(),
      );
    }).not.toThrow();
  });
});

describe("artifact_pointers CHECK constraint", () => {
  it("rejects r2_key without a slash", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO artifact_pointers (r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "no-slash",
        null,
        "plan",
        "abc",
        100,
        null,
        "text/plain",
        Date.now(),
        "test",
        null,
        0,
      );
    }).toThrow(/CHECK constraint failed/);
  });
});

describe("record_revisions CHECK constraints", () => {
  let rdb: InstanceType<typeof Database>;

  beforeEach(() => {
    rdb = new Database(":memory:");
    rdb.pragma("foreign_keys = ON");
    // MIGRATION_0001_TEST provides the base schema; MIGRATION_0008 adds records tables
    rdb.exec(MIGRATION_0001_TEST);
    rdb.exec(MIGRATION_0008);

    // Seed a parent records row (required by FK on record_revisions)
    const now = Date.now();
    rdb
      .prepare(
        "INSERT INTO records (type, key, schema_version, value_json, value_sha256, revision, archived, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("config", "main", 1, '{"a":1}', "abc123", 1, 0, now, now, "test");
  });

  afterEach(() => {
    rdb.close();
  });

  it("rejects invalid operation value", () => {
    expect(() => {
      rdb
        .prepare(
          "INSERT INTO record_revisions (type, key, revision, operation, schema_version, value_json, value_sha256, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "config",
          "main",
          1,
          "invalid-op",
          1,
          '{"a":1}',
          "abc123",
          "test",
          Date.now(),
        );
    }).toThrow(/CHECK constraint failed/);
  });

  for (const op of [
    "created",
    "set",
    "patch",
    "archived",
    "unarchived",
  ] as const) {
    it(`accepts valid operation: ${op}`, () => {
      expect(() => {
        rdb
          .prepare(
            "INSERT INTO record_revisions (type, key, revision, operation, schema_version, value_json, value_sha256, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "config",
            "main",
            op === "created" ? 1 : 2,
            op,
            1,
            '{"a":1}',
            "abc123",
            "test",
            Date.now(),
          );
      }).not.toThrow();
    });
  }
});
