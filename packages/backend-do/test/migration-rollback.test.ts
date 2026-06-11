import { describe, expect, it, vi } from "vitest";
import { runMigrationsWithPitrRollback } from "../src/migration-runner";

type SqlExecResult = { toArray: () => unknown[] };

const ALL_MIGRATION_VERSIONS = Array.from({ length: 19 }, (_, i) => i + 1);

function makeMockStorage(opts: {
  failOnSql?: string;
  bookmark?: string;
}) {
  const { failOnSql, bookmark = "test-bookmark-001" } = opts;
  const onNextSessionRestoreBookmark = vi
    .fn<[string], Promise<string>>()
    .mockResolvedValue(bookmark);

  const storage = {
    sql: {
      exec(statement: string, ..._bindings: unknown[]): SqlExecResult {
        if (failOnSql && statement.includes(failOnSql)) {
          throw new Error(`Deliberate SQL failure: ${failOnSql}`);
        }
        if (/^\s*(SELECT|PRAGMA)\b/i.test(statement)) {
          return { toArray: () => [] };
        }
        return { toArray: () => [] };
      },
    },
    transactionSync<T>(callback: () => T): T {
      return callback();
    },
    getCurrentBookmark(): Promise<string> {
      return Promise.resolve(bookmark);
    },
    onNextSessionRestoreBookmark,
  };

  return { storage, onNextSessionRestoreBookmark };
}

function makeStatefulStorage(opts: {
  appliedVersions?: number[];
  failOnVersionInsert?: number;
  bookmark?: string;
  invalidSchemaOnPragma?: boolean;
}) {
  const {
    appliedVersions = [],
    failOnVersionInsert,
    bookmark = "test-bookmark-001",
    invalidSchemaOnPragma = false,
  } = opts;
  const versions = [...appliedVersions];
  const onNextSessionRestoreBookmark = vi
    .fn<[string], Promise<string>>()
    .mockResolvedValue(bookmark);

  const storage = {
    sql: {
      exec(statement: string, ...bindings: unknown[]): SqlExecResult {
        if (statement.includes("SELECT version FROM _migrations")) {
          return {
            toArray: () => versions.map((version) => ({ version })),
          };
        }

        if (statement.includes("INSERT INTO _migrations")) {
          const version = Number(bindings[0]);
          if (version === failOnVersionInsert) {
            throw new Error(`Deliberate migration insert failure: ${version}`);
          }
          versions.push(version);
          return { toArray: () => [] };
        }

        if (/PRAGMA\s+table_info/i.test(statement)) {
          return {
            toArray: () =>
              invalidSchemaOnPragma ? [] : [{ name: "placeholder" }],
          };
        }

        if (/^\s*SELECT\b/i.test(statement)) {
          return { toArray: () => [] };
        }

        return { toArray: () => [] };
      },
    },
    transactionSync<T>(callback: () => T): T {
      return callback();
    },
    getCurrentBookmark(): Promise<string> {
      return Promise.resolve(bookmark);
    },
    onNextSessionRestoreBookmark,
  };

  return { storage, versions, onNextSessionRestoreBookmark };
}

describe("runMigrationsWithPitrRollback", () => {
  it("captures PITR bookmark and calls onNextSessionRestoreBookmark when a migration fails", async () => {
    const { storage, onNextSessionRestoreBookmark } = makeMockStorage({
      // MIGRATION_BOOTSTRAP contains CREATE TABLE _migrations — trigger failure there
      failOnSql: "_migrations",
    });

    await expect(runMigrationsWithPitrRollback(storage)).rejects.toThrow(
      /Deliberate SQL failure/,
    );

    expect(onNextSessionRestoreBookmark).toHaveBeenCalledOnce();
    expect(onNextSessionRestoreBookmark).toHaveBeenCalledWith(
      "test-bookmark-001",
    );
  });

  it("re-throws the original error after registering the restore bookmark", async () => {
    const { storage } = makeMockStorage({
      failOnSql: "_migrations",
    });

    let caughtError: unknown;
    try {
      await runMigrationsWithPitrRollback(storage);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/Deliberate SQL failure/);
  });

  it("does NOT call onNextSessionRestoreBookmark when migrations succeed", async () => {
    // Build a storage where runProjectMigrations completes without error.
    // We simulate a DB that has all migrations applied and all required tables present.
    const onNextSessionRestoreBookmark = vi
      .fn<[string], Promise<string>>()
      .mockResolvedValue("test-bookmark-001");
    const storage = {
      sql: {
        exec(statement: string, ..._bindings: unknown[]): SqlExecResult {
          if (/^\s*(SELECT|PRAGMA)\b/i.test(statement)) {
            // _migrations: return all versions applied so no migrations run
            if (statement.includes("FROM _migrations")) {
              return {
                toArray: () =>
                  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => ({
                    version: v,
                  })),
              };
            }
            // PRAGMA table_info(<table>): return all required columns so validation passes
            if (/PRAGMA\s+table_info/i.test(statement)) {
              const match = /PRAGMA\s+table_info\((\w+)\)/i.exec(statement);
              const tableName = match?.[1] ?? "";
              const columnsByTable: Record<string, string[]> = {
                _migrations: ["version", "applied_at"],
                _schema_history: [
                  "version",
                  "definition",
                  "applied_at",
                  "applied_by",
                  "change_summary",
                  "strategy",
                ],
                artifact_pointers: [
                  "r2_key",
                  "resource",
                  "kind",
                  "sha256",
                  "bytes",
                  "fence",
                  "mime_type",
                  "produced_at",
                  "produced_by",
                  "expires_at",
                  "tombstoned",
                ],
                artifact_relationships: [
                  "from_key",
                  "to_key",
                  "to_uri",
                  "type",
                  "target",
                  "metadata",
                  "created_at",
                ],
                artifact_search_docs: [
                  "artifact_key",
                  "kind",
                  "mime_type",
                  "resource",
                  "title",
                  "body_text",
                  "indexed_at",
                  "source_sha256",
                  "tombstoned",
                ],
                claims: [
                  "resource",
                  "holder",
                  "machine",
                  "user",
                  "mode",
                  "fence",
                  "acquired_at",
                  "expires_at",
                  "metadata",
                ],
                entities: [
                  "id",
                  "type",
                  "schema_version",
                  "data",
                  "archived",
                  "created_at",
                  "updated_at",
                  "created_by",
                ],
                entity_artifact_references: [
                  "entity_id",
                  "artifact_key",
                  "slot",
                  "metadata",
                  "created_at",
                ],
                entity_relationships: [
                  "from_id",
                  "to_id",
                  "type",
                  "schema_version",
                  "created_at",
                ],
                entity_search_docs: [
                  "entity_id",
                  "entity_type",
                  "name",
                  "indexed_at",
                ],
                fences: ["resource", "current_fence"],
                gates: [
                  "id",
                  "resource",
                  "await_type",
                  "status",
                  "fence",
                  "timeout_at",
                  "resolved_at",
                  "resolution",
                  "created_at",
                  "created_by",
                  "token_id",
                  "data",
                ],
                journal: [
                  "seq",
                  "t",
                  "kind",
                  "resource",
                  "actor",
                  "fence",
                  "data",
                  "token_id",
                  "source",
                  "source_version",
                ],
                presence: ["machine", "last_seen", "info"],
                record_revisions: [
                  "type",
                  "key",
                  "revision",
                  "operation",
                  "schema_version",
                  "value_json",
                  "value_sha256",
                  "canonical_artifact_key",
                  "source_artifact_key",
                  "actor",
                  "created_at",
                  "message",
                ],
                record_tags: ["type", "key", "tag"],
                records: [
                  "type",
                  "key",
                  "schema_version",
                  "value_json",
                  "value_sha256",
                  "revision",
                  "archived",
                  "created_at",
                  "updated_at",
                  "updated_by",
                ],
                signals: [
                  "id",
                  "target",
                  "kind",
                  "resource",
                  "payload",
                  "created_by",
                  "created_at",
                  "expires_at",
                  "acked_at",
                ],
              };
              const cols = columnsByTable[tableName] ?? ["__col__"];
              return { toArray: () => cols.map((name) => ({ name })) };
            }
            return { toArray: () => [] };
          }
          return { toArray: () => [] };
        },
      },
      transactionSync<T>(callback: () => T): T {
        return callback();
      },
      getCurrentBookmark(): Promise<string> {
        return Promise.resolve("test-bookmark-001");
      },
      onNextSessionRestoreBookmark,
    };

    await expect(
      runMigrationsWithPitrRollback(storage),
    ).resolves.toBeUndefined();

    expect(onNextSessionRestoreBookmark).not.toHaveBeenCalled();
  });

  it("uses the exact bookmark string returned by getCurrentBookmark", async () => {
    const customBookmark = "v8-2026-05-22T10:00:00Z-unique-123";
    const { storage, onNextSessionRestoreBookmark } = makeMockStorage({
      failOnSql: "_migrations",
      bookmark: customBookmark,
    });

    await expect(runMigrationsWithPitrRollback(storage)).rejects.toThrow();

    expect(onNextSessionRestoreBookmark).toHaveBeenCalledWith(customBookmark);
  });

  it("calls the fatal-abort hook and leaves the failing migration version unapplied", async () => {
    const { storage, versions, onNextSessionRestoreBookmark } =
      makeStatefulStorage({
        appliedVersions: [1, 2, 3],
        failOnVersionInsert: 4,
      });
    const onFatal = vi.fn();

    await expect(
      runMigrationsWithPitrRollback(storage, onFatal),
    ).rejects.toThrow(/Deliberate migration insert failure: 4/);

    expect(onFatal).toHaveBeenCalledOnce();
    expect(onNextSessionRestoreBookmark).toHaveBeenCalledOnce();
    expect(versions).not.toContain(4);
  });

  it("skips schema validation entirely when no migration ran", async () => {
    const { storage, onNextSessionRestoreBookmark } = makeStatefulStorage({
      appliedVersions: ALL_MIGRATION_VERSIONS,
      invalidSchemaOnPragma: true,
    });

    await expect(
      runMigrationsWithPitrRollback(storage),
    ).resolves.toBeUndefined();

    expect(onNextSessionRestoreBookmark).not.toHaveBeenCalled();
  });
});
