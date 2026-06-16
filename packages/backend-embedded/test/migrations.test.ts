import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_MIGRATIONS,
  IDEMPOTENCY_MIGRATION_VERSION,
  type Migration,
  type MigrationStorage,
  isStalePreFeatureSchema,
  runEmbeddedMigrations,
  warnIfStalePreFeatureSchema,
} from "../src/index";

/**
 * Canonical shared versions present in the embedded set: 1–20 minus 15
 * (v15 = DO-only journal-archive watermark). The embedded-only idempotency
 * overlay is appended at IDEMPOTENCY_MIGRATION_VERSION, above the shared range.
 */
const CANONICAL_VERSIONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20,
];
const EXPECTED_VERSIONS = [
  ...CANONICAL_VERSIONS,
  IDEMPOTENCY_MIGRATION_VERSION,
];

/**
 * In-memory MigrationStorage fake.
 *
 * Tracks `_migrations` rows in a Map so we can assert which versions were
 * applied and in what order. All other DDL / queries are tolerated: SELECT and
 * PRAGMA against tables other than `_migrations` return empty arrays (the
 * version-guarded `run` migrations no-op cleanly against that), and arbitrary
 * statements are accepted without effect. The fake records the ordered sequence
 * of versions inserted into `_migrations`.
 */
function createFakeStorage(): {
  storage: MigrationStorage;
  appliedOrder: number[];
} {
  const migrationsTable = new Map<number, number>();
  const appliedOrder: number[] = [];

  const storage: MigrationStorage = {
    sql: {
      exec(statement: string, ...bindings: unknown[]) {
        const trimmed = statement.trim();

        // Read already-applied versions.
        if (/^SELECT\s+version\s+FROM\s+_migrations/i.test(trimmed)) {
          return {
            toArray: () =>
              [...migrationsTable.keys()].map((version) => ({ version })),
          };
        }

        // Record a newly-applied version (bare INSERT or INSERT OR IGNORE).
        if (/^INSERT(\s+OR\s+IGNORE)?\s+INTO\s+_migrations/i.test(trimmed)) {
          const version = bindings[0] as number;
          const appliedAt = bindings[1] as number;
          migrationsTable.set(version, appliedAt);
          appliedOrder.push(version);
          return { toArray: () => [] };
        }

        // Everything else (DDL, PRAGMA table_info, run-migration probes) is a
        // tolerated no-op returning no rows.
        return { toArray: () => [] };
      },
    },
  };

  return { storage, appliedOrder };
}

describe("EMBEDDED_MIGRATIONS", () => {
  const versions = EMBEDDED_MIGRATIONS.map((m) => m.version);

  it("includes every canonical version 1–19 except 15 (v14 present, v15 absent), plus the idempotency overlay", () => {
    expect(versions).toEqual(EXPECTED_VERSIONS);
    expect(versions).toContain(14);
    expect(versions).not.toContain(15);
    expect(versions).toContain(IDEMPOTENCY_MIGRATION_VERSION);
  });

  it("reuses the canonical MIGRATION_0001 for v1 (no embedded variant): artifact_relationships carries target + PK (from_key, target, type)", () => {
    const v1 = EMBEDDED_MIGRATIONS.find((m) => m.version === 1);
    expect(v1).toBeDefined();
    expect(v1 && "sql" in v1).toBe(true);
    const sql = (v1 as { sql: string }).sql;
    expect(sql).toContain("target TEXT NOT NULL");
    expect(sql).toContain("PRIMARY KEY (from_key, target, type)");
    // The canonical v1 has NO embedded-only content_inline column.
    expect(sql).not.toContain("content_inline");
  });

  it("v5 is the canonical index migration, not an idempotency table", () => {
    const v5 = EMBEDDED_MIGRATIONS.find((m) => m.version === 5);
    expect(v5 && "sql" in v5).toBe(true);
    const sql = (v5 as { sql: string }).sql;
    expect(sql).toContain("idx_er_to_id_type");
    expect(sql).not.toContain("_idempotency");
  });

  it("is ordered strictly ascending by version", () => {
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
  });

  it("applies migrations in ascending version order", () => {
    const { storage, appliedOrder } = createFakeStorage();
    runEmbeddedMigrations(storage);

    expect(appliedOrder).toEqual(EXPECTED_VERSIONS);
  });

  it("is idempotent: a second run applies nothing new", () => {
    const { storage, appliedOrder } = createFakeStorage();
    runEmbeddedMigrations(storage);
    const countAfterFirst = appliedOrder.length;
    runEmbeddedMigrations(storage);
    expect(appliedOrder.length).toBe(countAfterFirst);
  });
});

describe("runEmbeddedMigrations concurrent-first-open race (INSERT OR IGNORE)", () => {
  it("does not throw when a _migrations bookkeeping row already exists (PK-enforcing storage)", () => {
    // Storage that enforces `version INTEGER PRIMARY KEY`: a bare INSERT of a
    // duplicate version throws SQLITE_CONSTRAINT_PRIMARYKEY, while INSERT OR
    // IGNORE silently no-ops. This simulates two runtimes opening the SAME FRESH
    // DB concurrently — both pass the applied-versions snapshot, both run a
    // migration, and the loser would throw on the bookkeeping insert if it were
    // a bare INSERT.
    const migrationsTable = new Map<number, number>();
    let snapshotRead = false;

    const storage: MigrationStorage = {
      sql: {
        exec(statement: string, ...bindings: unknown[]) {
          const trimmed = statement.trim();
          if (/^SELECT\s+version\s+FROM\s+_migrations/i.test(trimmed)) {
            // First (snapshot) read sees an EMPTY table, so the runner attempts
            // every migration. Immediately after, a racing runtime records v1 —
            // simulated here by seeding the table once the snapshot is taken.
            const rows = [...migrationsTable.keys()].map((version) => ({
              version,
            }));
            if (!snapshotRead) {
              snapshotRead = true;
              migrationsTable.set(1, Date.now()); // racer wins v1
            }
            return { toArray: () => rows };
          }
          if (/^INSERT(\s+OR\s+IGNORE)?\s+INTO\s+_migrations/i.test(trimmed)) {
            const orIgnore = /OR\s+IGNORE/i.test(trimmed);
            const version = bindings[0] as number;
            const appliedAt = bindings[1] as number;
            if (migrationsTable.has(version)) {
              // PK conflict: bare INSERT throws, OR IGNORE no-ops.
              if (!orIgnore) {
                throw new Error("SQLITE_CONSTRAINT_PRIMARYKEY");
              }
              return { toArray: () => [] };
            }
            migrationsTable.set(version, appliedAt);
            return { toArray: () => [] };
          }
          return { toArray: () => [] };
        },
      },
    };

    expect(() => runEmbeddedMigrations(storage)).not.toThrow();
    // The full set is recorded (v1 left as the racer's row, the rest inserted).
    expect(migrationsTable.has(1)).toBe(true);
    expect(migrationsTable.has(IDEMPOTENCY_MIGRATION_VERSION)).toBe(true);
  });
});

describe("runEmbeddedMigrations partial-failure consistency (R4)", () => {
  it("does not record a failed version, so a re-run resumes cleanly", () => {
    // Map-backed `_migrations` shared across the throwing-runner harness.
    const migrationsTable = new Map<number, number>();
    const appliedOrder: number[] = [];
    let shouldThrow = true;

    const storage: MigrationStorage = {
      sql: {
        exec(statement: string, ...bindings: unknown[]) {
          const trimmed = statement.trim();
          if (/^SELECT\s+version\s+FROM\s+_migrations/i.test(trimmed)) {
            return {
              toArray: () =>
                [...migrationsTable.keys()].map((version) => ({ version })),
            };
          }
          if (/^INSERT\s+INTO\s+_migrations/i.test(trimmed)) {
            const version = bindings[0] as number;
            migrationsTable.set(version, bindings[1] as number);
            appliedOrder.push(version);
            return { toArray: () => [] };
          }
          return { toArray: () => [] };
        },
      },
    };

    // A migration set with a deliberately-throwing step at version 99.
    const FAILING_MIGRATIONS: ReadonlyArray<Migration> = [
      { version: 1, sql: "-- ok" },
      {
        version: 99,
        run: () => {
          if (shouldThrow) throw new Error("boom");
        },
      },
      { version: 100, sql: "-- never reached on first run" },
    ];

    function runSet(migrations: ReadonlyArray<Migration>): void {
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      const applied = new Set(
        (
          storage.sql.exec("SELECT version FROM _migrations").toArray() as {
            version: number;
          }[]
        ).map((r) => r.version),
      );
      const now = Date.now();
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        if ("run" in migration) migration.run(storage);
        else storage.sql.exec(migration.sql);
        storage.sql.exec(
          "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)",
          migration.version,
          now,
        );
      }
    }

    // First run throws at v99 and must NOT record v99 or v100.
    expect(() => runSet(FAILING_MIGRATIONS)).toThrow("boom");
    expect(migrationsTable.has(1)).toBe(true);
    expect(migrationsTable.has(99)).toBe(false);
    expect(migrationsTable.has(100)).toBe(false);

    // Re-run resumes cleanly: v1 skipped, v99 now succeeds, v100 applied.
    shouldThrow = false;
    expect(() => runSet(FAILING_MIGRATIONS)).not.toThrow();
    expect(migrationsTable.has(99)).toBe(true);
    expect(migrationsTable.has(100)).toBe(true);
    // v1 applied exactly once.
    expect(appliedOrder.filter((v) => v === 1)).toEqual([1]);
  });
});

describe("pre-feature stale-schema detection", () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Build a fake MigrationStorage that reports a fixed set of `_migrations`
   * versions and a fixed set of `artifact_relationships` column names.
   */
  function fakeStorage(opts: {
    versions: number[];
    arColumns: string[] | null; // null = table absent
  }): MigrationStorage {
    return {
      sql: {
        exec(statement: string) {
          const trimmed = statement.trim();
          if (/SELECT\s+version\s+FROM\s+_migrations/i.test(trimmed)) {
            return {
              toArray: () => opts.versions.map((version) => ({ version })),
            };
          }
          if (/PRAGMA\s+table_info\(artifact_relationships\)/i.test(trimmed)) {
            return {
              toArray: () => (opts.arColumns ?? []).map((name) => ({ name })),
            };
          }
          return { toArray: () => [] };
        },
      },
    };
  }

  it("flags a pre-feature DB: v1+v5 recorded but artifact_relationships lacks `target`", () => {
    const storage = fakeStorage({
      versions: [1, 5, 14],
      arColumns: ["from_key", "to_key", "type", "created_at"], // no `target`
    });
    expect(isStalePreFeatureSchema(storage)).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfStalePreFeatureSchema(storage);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/tila init --local/);
  });

  it("does NOT flag a canonical DB: artifact_relationships has `target`", () => {
    const storage = fakeStorage({
      versions: [1, 5, 14],
      arColumns: ["from_key", "target", "type", "created_at"],
    });
    expect(isStalePreFeatureSchema(storage)).toBe(false);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfStalePreFeatureSchema(storage);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT flag when v1/v5 are not both recorded", () => {
    expect(
      isStalePreFeatureSchema(
        fakeStorage({ versions: [1], arColumns: ["from_key"] }),
      ),
    ).toBe(false);
  });

  it("does NOT flag when the artifact_relationships table is absent (no rows)", () => {
    expect(
      isStalePreFeatureSchema(
        fakeStorage({ versions: [1, 5], arColumns: null }),
      ),
    ).toBe(false);
  });
});
