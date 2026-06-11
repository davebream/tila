import type { Database } from "bun:sqlite";
import { EmbeddedProject } from "@tila/backend-embedded";
import type { schema } from "@tila/ops-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import { createLocalConnection } from "./connection";
import type { LocalConnectionOptions } from "./connection";

/** The bun:sqlite-backed Drizzle handle, with the raw `$client` exposed. */
type BunDb = BunSQLiteDatabase<typeof schema> & { $client: Database };

/**
 * Local (bun:sqlite) SQLite project backend.
 *
 * A thin host wrapper around the runtime-agnostic `EmbeddedProject`
 * (`@tila/backend-embedded`): all domain logic — entities, coordination,
 * journal, gates, signals, schema, summary, records, idempotency, search —
 * lives in the embedded class. This wrapper only:
 *
 *  - owns the bun:sqlite connection construction (`LocalProject.open` →
 *    `createLocalConnection`: filesystem guard, PRAGMAs, embedded migrations);
 *  - injects the Bun-specific primitives the embedded core takes by injection:
 *    `Bun.sleepSync` as the busy-retry blocking sleep, and
 *    `() => db.$client.close()` as the connection closer;
 *  - re-narrows `getDb()` to the concrete Bun handle (`{ $client }`) so callers
 *    that need the raw `bun:sqlite` Database (CLI context, pragma tests) keep
 *    their typed access.
 *
 * The public surface (`LocalProject.open`, `getDb()`, `close()`, and every
 * backend method) is preserved exactly.
 */
export class LocalProject extends EmbeddedProject {
  private constructor(
    private readonly bunDb: BunDb,
    org: string,
    project: string,
  ) {
    super({
      db: bunDb,
      org,
      project,
      sleepSync: Bun.sleepSync,
      close: () => bunDb.$client.close(),
    });
  }

  /**
   * Open a local project database. Applies PRAGMAs, runs migrations,
   * and returns a ready-to-use LocalProject instance.
   */
  static open(
    dbPath: string,
    org: string,
    project: string,
    options?: LocalConnectionOptions,
  ): LocalProject {
    const db = createLocalConnection(dbPath, org, project, options);
    return new LocalProject(db, org, project);
  }

  /**
   * Expose the bun:sqlite-backed Drizzle DB instance (with `$client`) for
   * `LocalArtifactBackend` sharing and raw-driver access. Re-narrows the
   * embedded `EmbeddedDb` return type to the concrete Bun handle.
   */
  override getDb(): BunDb {
    return this.bunDb;
  }
}
