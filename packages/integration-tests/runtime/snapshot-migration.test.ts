import { runInDurableObject } from "cloudflare:test";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "@tila/ops-sqlite";
import { expect, it } from "vitest";
import { runProjectMigrations } from "../../worker/src/do/migration-runner";
import { bindings } from "./setup";

it("preserves populated artifact storage and guards on upgrade, and rolls back migration failures", async () => {
  const stub = bindings.MIGRATION.get(bindings.MIGRATION.newUniqueId());
  await runInDurableObject(stub, (_instance, state) => {
    const storage = state.storage;
    storage.sql.exec(MIGRATION_BOOTSTRAP);
    for (const migration of MIGRATIONS.filter((m) => m.version < 41)) {
      storage.transactionSync(() => {
        if ("sql" in migration) storage.sql.exec(migration.sql);
        else migration.run(storage);
        storage.sql.exec(
          "INSERT INTO _migrations VALUES (?, ?)",
          migration.version,
          1,
        );
      });
    }
    storage.sql.exec(
      "INSERT INTO entities (id, type, schema_version, data, created_at, updated_at, created_by) VALUES ('task-1', 'task', 1, '{}', 1, 1, 'fixture')",
    );
    storage.sql.exec(`INSERT INTO artifact_pointers
      (r2_key, resource, kind, sha256, bytes, fence, mime_type, produced_at, produced_by, expires_at, tombstoned, tombstoned_at, blob_deleted_at, content_inline, lineage_id, revision, restored_from, provenance, revision_creation)
      VALUES ('produced/task-1/a.txt', 'task-1', 'log', 'abc', 3, 1, 'text/plain', 1, 'fixture', 9, 0, NULL, NULL, 'abc', 'lineage-1', 1, NULL, '{}', '{}'),
      ('sources/b.txt', NULL, 'log', 'def', 3, NULL, 'text/plain', 2, 'fixture', NULL, 1, 5, 6, NULL, NULL, NULL, NULL, '{}', '{}')`);
    storage.sql.exec(
      "INSERT INTO artifact_tags VALUES ('produced/task-1/a.txt', 'preserved')",
    );
    storage.sql.exec(
      "INSERT INTO entity_artifact_references VALUES ('task-1', 'produced/task-1/a.txt', 'result', '{}', 1)",
    );
    storage.sql.exec(
      "INSERT INTO artifact_relationships VALUES ('produced/task-1/a.txt', 'sources/b.txt', NULL, 'derived-from', 'sources/b.txt', '{}', 1)",
    );
    storage.sql.exec(
      "INSERT INTO artifact_search_docs (artifact_key, kind, mime_type, resource, body_text, indexed_at, source_sha256) VALUES ('produced/task-1/a.txt', 'log', 'text/plain', 'task-1', 'preserved', 1, 'abc')",
    );
    const tables = [
      "artifact_pointers",
      "artifact_tags",
      "entity_artifact_references",
      "artifact_relationships",
      "artifact_search_docs",
    ];
    const before = tables.map((table) =>
      storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray(),
    );
    const objects = storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = 'artifact_pointers' ORDER BY name",
      )
      .toArray();
    // Keep the active transfer lock while temporarily suspending only the
    // guards needed for the table copy and cascading tag restoration.
    storage.sql.exec(
      "INSERT INTO _project_transfer_state (singleton, session_id, mode, owner, started_at, updated_at, applying) VALUES (1, 'transfer', 'import', 'fixture', 1, 1, 0)",
    );
    expect(() =>
      runProjectMigrations({
        transactionSync: (callback) => storage.transactionSync(callback),
        sql: {
          exec(statement: string, ...args: unknown[]) {
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
    expect(
      tables.map((table) =>
        storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray(),
      ),
    ).toEqual(before);
    expect(
      storage.sql.exec("PRAGMA foreign_key_list(artifact_pointers)").toArray(),
    ).toHaveLength(1);

    runProjectMigrations(storage);
    expect(
      tables.map((table) =>
        storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray(),
      ),
    ).toEqual(before);
    const afterObjects = storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = 'artifact_pointers' ORDER BY name",
      )
      .toArray();
    expect(afterObjects).toEqual(expect.arrayContaining(objects));
    expect(
      storage.sql.exec("PRAGMA foreign_key_list(artifact_pointers)").toArray(),
    ).toEqual([]);
    expect(storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    expect(
      storage.sql
        .exec(
          "SELECT count(*) AS n FROM artifact_search_docs_fts WHERE artifact_search_docs_fts MATCH 'preserved'",
        )
        .one(),
    ).toMatchObject({ n: 1 });
    expect(() =>
      storage.sql.exec(
        "UPDATE artifact_pointers SET bytes = 4 WHERE resource = 'task-1'",
      ),
    ).toThrow("project-maintenance");
    storage.sql.exec("DELETE FROM _project_transfer_state");
    expect(() =>
      storage.sql.exec(
        "UPDATE artifact_pointers SET provenance = NULL WHERE resource = 'task-1'",
      ),
    ).toThrow("artifact-provenance-immutable");
    expect(() =>
      storage.sql.exec(
        "UPDATE artifact_pointers SET resource = 'missing' WHERE resource = 'task-1'",
      ),
    ).toThrow("FOREIGN KEY");
    expect(() =>
      storage.sql.exec("DELETE FROM entities WHERE id = 'task-1'"),
    ).toThrow("FOREIGN KEY");
    expect(() =>
      storage.sql.exec(
        "UPDATE entities SET id = 'renamed' WHERE id = 'task-1'",
      ),
    ).toThrow("FOREIGN KEY");
    runProjectMigrations(storage);
    expect(storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
  });
});
