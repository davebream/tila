import type { EmbeddedDb, MigrationStorage } from "@tila/backend-embedded";
import { runEmbeddedMigrations } from "@tila/backend-embedded";
import { schema } from "@tila/ops-sqlite";

import { assertLocalFilesystem } from "./filesystem-guard";

/**
 * Raised when the optional `better-sqlite3` peer dependency (or its drizzle
 * adapter) cannot be loaded. The message tells the user exactly how to fix it.
 */
export class MissingNativeDriverError extends Error {
  constructor(cause?: unknown) {
    super(
      "tila-sdk/local requires the optional peer dependency 'better-sqlite3'. Run: npm i better-sqlite3",
    );
    this.name = "MissingNativeDriverError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** A handle to an open embedded SQLite connection plus its raw closer. */
export interface NodeConnection {
  /** Runtime-neutral Drizzle handle accepted by the embedded backends. */
  db: EmbeddedDb;
  /** Close the underlying better-sqlite3 Database. */
  close: () => void;
}

export interface NodeConnectionOptions {
  /** Skip the NFS/SMB network-mount check (for tests using temp dirs). */
  skipFilesystemCheck?: boolean;
  /** Open the database read-only. */
  readonly?: boolean;
}

/**
 * Open a local SQLite database for a tila project under plain Node, backed by
 * `better-sqlite3`.
 *
 * This is the Node analogue of `@tila/backend-local`'s `createLocalConnection`
 * (which uses `bun:sqlite`). It:
 *
 *  - dynamically `import()`s BOTH `better-sqlite3` AND `drizzle-orm/better-sqlite3`
 *    inside ONE try/catch — neither is statically imported, so importing
 *    `tila-sdk/local` never loads the native binary; only CALLING this throws
 *    `MissingNativeDriverError` when the peer dep is absent (C6/R8);
 *  - normalizes the CJS interop default-vs-named export shape of `better-sqlite3`
 *    (`mod.default ?? mod`) (R8);
 *  - applies PRAGMAs in the SAME ORDER as the bun connection — `busy_timeout=5000`
 *    FIRST, then `journal_mode=WAL`, then `foreign_keys=ON` (R2) — so a Node
 *    writer never immediately races a bun writer into SQLITE_BUSY;
 *  - runs the shared `EMBEDDED_MIGRATIONS` via `runEmbeddedMigrations` against a
 *    Node `MigrationStorage` shim (mirroring the bun shim's `sql.exec` interface).
 *
 * `async` because the dynamic imports are async; the SQLite work itself is sync.
 */
export async function createNodeConnection(
  dbPath: string,
  opts?: NodeConnectionOptions,
): Promise<NodeConnection> {
  // 1. Validate the filesystem before opening (NFS/SMB detection).
  if (!opts?.skipFilesystemCheck) {
    assertLocalFilesystem(dbPath);
  }

  // 2. Dynamically import BOTH the native driver AND its drizzle adapter in ONE
  //    try/catch. If EITHER is missing, surface the single helpful error (C6).
  let DatabaseCtor: new (
    path: string,
    options?: { readonly?: boolean },
  ) => RawDatabase;
  let drizzle: (
    client: RawDatabase,
    config: { schema: typeof schema },
  ) => EmbeddedDb;
  try {
    const [betterSqlite3Mod, drizzleMod] = await Promise.all([
      import("better-sqlite3"),
      import("drizzle-orm/better-sqlite3"),
    ]);
    // CJS interop: `better-sqlite3` is a CommonJS module whose constructor is
    // the module's own export. Under ESM interop it may surface as `.default`
    // (Node's named-export synthesis) or be the namespace itself (R8).
    DatabaseCtor = (betterSqlite3Mod.default ??
      (betterSqlite3Mod as unknown)) as typeof DatabaseCtor;
    drizzle = drizzleMod.drizzle as unknown as typeof drizzle;
  } catch (err) {
    throw new MissingNativeDriverError(err);
  }

  // 3. Open the raw better-sqlite3 Database. A genuinely corrupt/locked/invalid
  //    file throws a native SqliteError here — we wrap it in a clean error (R5)
  //    rather than letting the raw native throw escape.
  let rawDb: RawDatabase;
  try {
    rawDb = new DatabaseCtor(dbPath, { readonly: opts?.readonly ?? false });
  } catch (err) {
    throw new Error(
      `Failed to open local SQLite database at ${dbPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  // 4. PRAGMA initialization — SAME ORDER as the bun connection (R2).
  //    busy_timeout FIRST (before any write-requiring PRAGMA) so concurrent
  //    processes wait instead of failing immediately with SQLITE_BUSY under the
  //    default busy_timeout=0. Then journal_mode=WAL, then foreign_keys=ON.
  rawDb.exec("PRAGMA busy_timeout=5000;");
  rawDb.exec("PRAGMA journal_mode=WAL;");
  rawDb.exec("PRAGMA foreign_keys=ON;");

  // 5. Run the shared embedded migration set against the raw Database (before
  //    Drizzle wrapping). The runner is storage-agnostic; we supply a
  //    better-sqlite3-backed MigrationStorage shim.
  runEmbeddedMigrations(createNodeMigrationStorage(rawDb));

  // 6. Wrap in Drizzle. The better-sqlite3 adapter returns
  //    BaseSQLiteDatabase<"sync", RunResult, …>; EmbeddedDb is
  //    BaseSQLiteDatabase<"sync", void, …>. The result-type generic is not used
  //    by any embedded delegation, so the shapes are operationally identical —
  //    we narrow through the local `drizzle` signature, mirroring the bun
  //    harness which casts via `as unknown` for the same reason.
  const db = drizzle(rawDb, { schema });

  return { db, close: () => rawDb.close() };
}

/**
 * Minimal structural type for the better-sqlite3 `Database` we use. We do NOT
 * statically import `better-sqlite3`'s types (it must stay an external/optional
 * peer), so this local shape captures only `exec`, `prepare`, and `close`.
 */
interface RawDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): RawStatement;
  close(): void;
}

interface RawStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * Adapt a raw `better-sqlite3` Database to the storage-agnostic
 * `MigrationStorage` interface the embedded migration runner expects. Mirrors
 * the bun `createBunMigrationStorage` shim shape: SELECT/PRAGMA statements
 * return rows via `toArray()`; all other statements execute (with optional
 * positional bindings) and return an empty `toArray()`.
 *
 * Unlike bun:sqlite's `Database.exec`, better-sqlite3's `exec` does NOT accept
 * bindings, so bound statements always go through `prepare(...).run(...)`.
 */
function createNodeMigrationStorage(rawDb: RawDatabase): MigrationStorage {
  return {
    sql: {
      exec<T>(statement: string, ...bindings: unknown[]) {
        const trimmed = statement.trim();
        if (/^(SELECT|PRAGMA)\b/i.test(trimmed)) {
          return {
            toArray: () => rawDb.prepare(statement).all(...bindings) as T[],
          };
        }
        if (bindings.length > 0) {
          rawDb.prepare(statement).run(...bindings);
        } else {
          rawDb.exec(statement);
        }
        return { toArray: () => [] as T[] };
      },
    },
  };
}
