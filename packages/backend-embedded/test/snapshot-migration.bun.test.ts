import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "@tila/ops-sqlite";
import { runEmbeddedMigrations } from "../src/migrations";
import { migrationStorage } from "./harness.bun";

it("atomically rebuilds populated local artifact storage and can retry an interrupted upgrade", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec("PRAGMA foreign_keys=ON");
    const storage = migrationStorage(raw);
    raw.exec(MIGRATION_BOOTSTRAP);
    for (const migration of MIGRATIONS.filter((m) => m.version < 41)) {
      if ("sql" in migration) raw.exec(migration.sql);
      else migration.run(storage);
      raw
        .query("INSERT INTO _migrations VALUES (?, ?)")
        .run(migration.version, 1);
    }
    raw.exec(
      "INSERT INTO entities (id, type, schema_version, created_at, updated_at, created_by) VALUES ('task-1', 'task', 1, 1, 1, 'fixture')",
    );
    raw.exec(
      "INSERT INTO artifact_pointers (r2_key, resource, kind, sha256, bytes, mime_type, produced_at, produced_by) VALUES ('produced/task-1/a.txt', 'task-1', 'log', 'a', 1, 'text/plain', 1, 'fixture')",
    );
    raw.exec(
      "INSERT INTO artifact_tags VALUES ('produced/task-1/a.txt', 'tag')",
    );
    const before = raw.query("SELECT * FROM artifact_pointers").all();
    expect(() =>
      runEmbeddedMigrations({
        sql: {
          exec(statement, ...args) {
            if (
              statement.startsWith(
                "ALTER TABLE _migration0041_artifact_pointers",
              )
            )
              throw new Error("injected migration failure");
            return storage.sql.exec(statement, ...args);
          },
        },
      }),
    ).toThrow("injected migration failure");
    expect(raw.query("SELECT * FROM artifact_pointers").all()).toEqual(before);
    expect(
      raw.query("SELECT version FROM _migrations WHERE version = 41").all(),
    ).toEqual([]);
    expect(
      raw.query("PRAGMA foreign_key_list(artifact_pointers)").all(),
    ).toHaveLength(1);
    runEmbeddedMigrations(storage);
    expect(raw.query("SELECT * FROM artifact_pointers").all()).toEqual(before);
    expect(raw.query("SELECT * FROM artifact_tags").all()).toEqual([
      { artifact_key: "produced/task-1/a.txt", tag: "tag" },
    ]);
    expect(
      raw.query("PRAGMA foreign_key_list(artifact_pointers)").all(),
    ).toEqual([]);
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    runEmbeddedMigrations(storage);
    expect(() => raw.exec("DELETE FROM entities WHERE id = 'task-1'")).toThrow(
      "FOREIGN KEY",
    );
  } finally {
    raw.close();
  }
});
