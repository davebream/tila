/**
 * Bun-only test harness for the embedded backend.
 *
 * `@tila/backend-embedded/src` carries `types: []` and imports NO SQLite driver
 * (enforced by the `no-runtime-imports` fitness test). But `EmbeddedProject`
 * needs a REAL sync Drizzle DB to exercise. This harness lives in `test/`
 * (which the fitness test does NOT scan) and constructs an in-memory
 * `bun:sqlite` + `drizzle-orm/bun-sqlite` DB, runs the embedded migrations
 * against it, and provides an in-memory `BlobStore`.
 *
 * This is why the records/artifact/project/search tests run under `bun test`,
 * not vitest: vitest runs under Node where `bun:sqlite` is unavailable, and we
 * deliberately do NOT add `@types/better-sqlite3` / a Node driver to this
 * package (the Node/better-sqlite3 path is exercised from tila-sdk/local in
 * Task 9). The migration + fitness tests stay on vitest.
 */

import { Database } from "bun:sqlite";
import { schema } from "@tila/ops-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  type BlobStore,
  EmbeddedArtifactBackend,
  type EmbeddedDb,
  EmbeddedProject,
  type MigrationStorage,
  runEmbeddedMigrations,
} from "../src/index";

/** No-op sleep: tests verify retry via attempt counts, not timing. */
export const noopSleep = (_ms: number): void => {};

/** Build a MigrationStorage shim over a raw bun:sqlite Database. */
function migrationStorage(rawDb: Database): MigrationStorage {
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

export interface Harness {
  db: EmbeddedDb;
  rawDb: Database;
  project: EmbeddedProject;
  artifacts: EmbeddedArtifactBackend;
  blobs: BlobStore;
  close: () => void;
}

/**
 * Build a fully-migrated in-memory embedded project + artifact backend over an
 * in-memory BlobStore. The `close` closes the underlying bun:sqlite Database.
 */
export function makeHarness(
  org = "test-org",
  project = "test-project",
): Harness {
  const rawDb = new Database(":memory:");
  rawDb.exec("PRAGMA busy_timeout=5000;");
  rawDb.exec("PRAGMA foreign_keys=ON;");
  runEmbeddedMigrations(migrationStorage(rawDb));

  const db = drizzle(rawDb, { schema }) as unknown as BaseSQLiteDatabase<
    "sync",
    void,
    typeof schema
  >;

  const close = () => rawDb.close();
  const blobs = new MemoryBlobStore();

  const embeddedProject = new EmbeddedProject({
    db,
    org,
    project,
    sleepSync: noopSleep,
    close,
  });

  const artifacts = new EmbeddedArtifactBackend({
    db,
    blobs,
    org,
    project,
    sleepSync: noopSleep,
  });

  return { db, rawDb, project: embeddedProject, artifacts, blobs, close };
}

/** In-memory BlobStore backed by a Map<key, Uint8Array>. */
export class MemoryBlobStore implements BlobStore {
  private store = new Map<string, Uint8Array>();

  async write(
    key: string,
    data: Uint8Array | string,
  ): Promise<{ bytes: number }> {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.store.set(key, bytes);
    return { bytes: bytes.byteLength };
  }

  async readStream(key: string): Promise<ReadableStream | null> {
    const bytes = this.store.get(key);
    if (bytes === undefined) return null;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async read(key: string): Promise<string | null> {
    const bytes = this.store.get(key);
    if (bytes === undefined) return null;
    return new TextDecoder().decode(bytes);
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    for (const [key, bytes] of this.store) {
      if (key.startsWith(prefix)) out.push({ key, size: bytes.byteLength });
    }
    return out;
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async unlink(key: string): Promise<void> {
    this.store.delete(key);
  }
}
