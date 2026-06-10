import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  type MigrationStorage,
  runEmbeddedMigrations,
} from "@tila/backend-embedded";
import { schema } from "@tila/ops-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

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
 * runs the shared embedded migration set (via `@tila/backend-embedded`), and
 * returns a typed Drizzle instance.
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

  // 4. Run the shared embedded migration set against the raw Database
  //    (before Drizzle wrapping). The embedded runner is storage-agnostic; we
  //    supply a bun:sqlite-backed MigrationStorage shim.
  runEmbeddedMigrations(createBunMigrationStorage(rawDb));

  // 5. Wrap in Drizzle
  const db = drizzle(rawDb, { schema });
  return db as BunSQLiteDatabase<typeof schema> & { $client: Database };
}

/**
 * Adapt a raw `bun:sqlite` Database to the storage-agnostic `MigrationStorage`
 * interface the embedded migration runner expects. SELECT/PRAGMA statements
 * return rows via `toArray()`; all other statements execute (with optional
 * positional bindings) and return an empty `toArray()`.
 */
function createBunMigrationStorage(rawDb: Database): MigrationStorage {
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
