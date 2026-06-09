import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  MIGRATION_0003,
  MIGRATION_0006,
  MIGRATION_0007,
  MIGRATION_0008,
  MIGRATION_0009,
  MIGRATION_0011,
  MIGRATION_0012,
  MIGRATION_0018,
  MIGRATION_BOOTSTRAP,
  type Migration,
  type MigrationStorage,
  runMigration0002,
  runMigration0004,
  runMigration0010,
  runMigration0011,
  runMigration0013,
  runMigration0016,
  runMigration0017,
  schema,
} from "@tila/ops-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { LOCAL_MIGRATIONS, MIGRATION_0001_LOCAL } from "./migrations-local";

export class LocalFilesystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalFilesystemError";
  }
}

export interface LocalConnectionOptions {
  /** Skip NFS/SMB filesystem check (for tests using temp directories). */
  skipFilesystemCheck?: boolean;
  /** Open the database in readonly mode. */
  readonly?: boolean;
}

/**
 * Open a local SQLite database for a tila project.
 *
 * Applies PRAGMAs atomically, validates the filesystem is local (not NFS/SMB),
 * runs all shared + local-only migrations, and returns a typed Drizzle instance.
 *
 * The returned object has a `$client` property exposing the raw `bun:sqlite` Database
 * for direct access when needed (e.g., closing the connection, raw PRAGMA queries).
 */
export function createLocalConnection(
  dbPath: string,
  _org: string,
  _project: string,
  opts?: LocalConnectionOptions,
): BunSQLiteDatabase<typeof schema> & { $client: Database } {
  // 1. Validate filesystem before opening (NFS/SMB detection)
  if (!opts?.skipFilesystemCheck) {
    assertLocalFilesystem(dbPath);
  }

  // 2. Open raw bun:sqlite Database
  const rawDb = new Database(dbPath, {
    create: true,
    readonly: opts?.readonly ?? false,
  });

  // 3. PRAGMA initialization.
  //    Set busy_timeout FIRST (before any write-requiring PRAGMA) so that
  //    concurrent processes don't fail immediately with SQLITE_BUSY when the
  //    default busy_timeout=0 is in effect. Then set journal_mode and foreign_keys.
  //    These are correctness requirements, not performance hints.
  rawDb.exec("PRAGMA busy_timeout=5000;");
  rawDb.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
  `);

  // 4. Run migrations using the raw Database (before Drizzle wrapping)
  runMigrations(rawDb);

  // 5. Wrap in Drizzle
  const db = drizzle(rawDb, { schema });
  return db as BunSQLiteDatabase<typeof schema> & { $client: Database };
}

/**
 * Assert that the database path is on a local filesystem.
 * Throws LocalFilesystemError on NFS, SMB, or AFP mounts.
 */
function assertLocalFilesystem(dbPath: string): void {
  const dir = dirname(dbPath);

  // Ensure parent directory exists (statSync will throw if not)
  try {
    statSync(dir);
  } catch {
    // Parent dir does not exist -- let Database constructor handle this
    return;
  }

  if (process.platform === "linux") {
    assertLocalFilesystemLinux(dir);
  } else if (process.platform === "darwin") {
    assertLocalFilesystemMacOS(dir);
  }
  // Windows: no check (defer to future work)
}

function assertLocalFilesystemLinux(dir: string): void {
  try {
    const mounts = readFileSync("/proc/self/mounts", "utf-8");
    const networkTypes = new Set(["nfs", "nfs4", "cifs", "smb", "smbfs"]);

    for (const line of mounts.split("\n")) {
      const parts = line.split(" ");
      if (parts.length < 3) continue;
      const mountPoint = parts[1];
      const fsType = parts[2];

      if (dir.startsWith(mountPoint) && networkTypes.has(fsType)) {
        throw new LocalFilesystemError(
          `Database path is on a network filesystem (${fsType}). Local backend requires a local filesystem to guarantee SQLite locking semantics. Use a path under /home or a local SSD.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof LocalFilesystemError) throw err;
    // /proc/self/mounts not readable (e.g., Docker with restricted proc) -- skip check
  }
}

function assertLocalFilesystemMacOS(dir: string): void {
  try {
    const result = Bun.spawnSync(["stat", "-f", "%T", dir]);
    const fsType = new TextDecoder().decode(result.stdout).trim().toLowerCase();

    const networkTypes = ["smbfs", "nfs", "afpfs", "webdavfs"];
    for (const netType of networkTypes) {
      if (fsType.includes(netType)) {
        throw new LocalFilesystemError(
          `Database path is on a network filesystem (${fsType}). Local backend requires a local filesystem to guarantee SQLite locking semantics. Use a path under /Users or a local SSD.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof LocalFilesystemError) throw err;
    // stat command failed -- skip check
  }
}

/**
 * All migrations for local mode, ordered by version.
 *
 * Version 1 uses a bun:sqlite-compatible variant (no COALESCE expression in PK).
 * Versions 2-4 use the shared ops-sqlite migrations verbatim.
 * Version 5 adds the local-only idempotency table.
 */
const ALL_LOCAL_MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, sql: MIGRATION_0001_LOCAL },
  { version: 2, run: runMigration0002 },
  { version: 3, sql: MIGRATION_0003 },
  { version: 4, run: runMigration0004 },
  ...LOCAL_MIGRATIONS,
  { version: 6, sql: MIGRATION_0006 },
  { version: 7, sql: MIGRATION_0007 },
  { version: 8, sql: MIGRATION_0008 },
  { version: 9, sql: MIGRATION_0009 },
  { version: 10, run: runMigration0010 },
  { version: 11, run: runMigration0011 },
  { version: 12, sql: MIGRATION_0012 },
  { version: 13, run: runMigration0013 },
  // Versions 14 (record_revisions extra columns) and 15 (_journal_archive_watermark)
  // are intentionally skipped: record revision history and journal archival to R2 are
  // DO-only features with no CLI local-mode equivalent. Skipping keeps the local schema
  // lean; add them here if a future CLI command needs these tables.
  { version: 16, run: runMigration0016 },
  // Version 17: C7 fence-resource unification — backfill canonical type:id fence rows.
  { version: 17, run: runMigration0017 },
  // Version 18: tags on work-units + artifacts — entity_tags + artifact_tags tables.
  { version: 18, sql: MIGRATION_0018 },
];

/**
 * Run all migrations (local bun:sqlite-compatible set + local-only migrations).
 *
 * Replicates the bootstrap logic from packages/backend-do/src/project-do.ts
 * using the raw bun:sqlite Database instance (before Drizzle wrapping).
 *
 * Note: Does NOT use the shared MIGRATIONS array from @tila/ops-sqlite because
 * MIGRATION_0001 uses COALESCE() in a PRIMARY KEY expression, which is not
 * supported by bun:sqlite 3.51.x. The local MIGRATION_0001_LOCAL replaces it
 * with a compatible schema.
 */
function runMigrations(rawDb: Database): void {
  // 1. Bootstrap the _migrations table (idempotent)
  rawDb.exec(MIGRATION_BOOTSTRAP);

  // 2. Read already-applied versions
  const applied = new Set(
    rawDb
      .query("SELECT version FROM _migrations")
      .all()
      .map((r) => (r as { version: number }).version),
  );

  // 3. Run pending migrations in version order
  const now = Date.now();
  const migrationStorage = createMigrationStorage(rawDb);

  for (const migration of ALL_LOCAL_MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    if ("run" in migration) {
      migration.run(migrationStorage);
    } else {
      rawDb.exec(migration.sql);
    }
    rawDb.exec(
      `INSERT INTO _migrations (version, applied_at) VALUES (${migration.version}, ${now})`,
    );
  }
}

function createMigrationStorage(rawDb: Database): MigrationStorage {
  return {
    sql: {
      exec<T>(statement: string, ...bindings: unknown[]) {
        const trimmed = statement.trim();
        if (/^(SELECT|PRAGMA)\b/i.test(trimmed)) {
          return {
            toArray: () =>
              rawDb.query(statement).all(...(bindings as never[])) as T[],
          };
        }
        if (bindings.length > 0) {
          rawDb.query(statement).run(...(bindings as never[]));
        } else {
          rawDb.exec(statement);
        }
        return { toArray: () => [] as T[] };
      },
    },
  };
}
