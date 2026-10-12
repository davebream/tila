/**
 * Embedded runtimes use every canonical project migration, plus the existing
 * local response-cache overlay at version 1000. Migration 21 was previously
 * skipped; it now supplies transactional receipts for revision-aware writes.
 * The runner tracks individual versions, so old databases receive the missing
 * additive migration even when they already have higher versions applied.
 * Keep the legacy overlay for compatibility with existing local consumers.
 */

import {
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type Migration,
  type MigrationStorage,
} from "@tila/ops-sqlite";

export type { Migration, MigrationStorage } from "@tila/ops-sqlite";

/** Version assigned to the embedded-only idempotency overlay (outside the
 *  canonical shared range so it is purely additive). */
export const IDEMPOTENCY_MIGRATION_VERSION = 1000;

/**
 * Embedded-only idempotency table.
 *
 * In Cloudflare mode, idempotency lives in D1 (`worker/src/d1`). In embedded
 * mode it lives in the same project SQLite database (one fewer store to
 * coordinate); the store is a standalone INSERT OR IGNORE, not folded into the
 * mutating operation's own transaction. The `project_id` column is omitted
 * because each embedded DB file is scoped to exactly one project.
 */
export const MIGRATION_IDEMPOTENCY = `
CREATE TABLE IF NOT EXISTS _idempotency (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  status_code INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON _idempotency(created_at);
`;

/**
 * The embedded migration set, ordered by version.
 *
 * = canonical project `MIGRATIONS` (verbatim), with the
 * embedded-only idempotency overlay appended above the canonical range. Every
 * shared version reuses the exact same SQL / run-function object as the DO, so
 * schema identity is structurally guaranteed (no copy that can drift).
 */
export const EMBEDDED_MIGRATIONS: ReadonlyArray<Migration> = [
  ...MIGRATIONS,
  { version: IDEMPOTENCY_MIGRATION_VERSION, sql: MIGRATION_IDEMPOTENCY },
];

/**
 * Apply all pending embedded migrations against an injected `MigrationStorage`.
 *
 * Storage-agnostic: the host supplies the concrete SQLite driver. Bootstraps
 * the `_migrations` tracking table, reads already-applied versions, then runs
 * pending migrations in ascending version order. Each successful migration is
 * recorded in `_migrations` immediately after it runs, so a failure partway
 * through leaves earlier versions recorded and the failing version unrecorded —
 * a re-run resumes cleanly from the failed version (R4).
 */
export function runEmbeddedMigrations(storage: MigrationStorage): void {
  // 1. Bootstrap the _migrations tracking table (idempotent).
  storage.sql.exec(MIGRATION_BOOTSTRAP);

  // 2. Read already-applied versions.
  const applied = new Set(
    (
      storage.sql.exec("SELECT version FROM _migrations").toArray() as {
        version: number;
      }[]
    ).map((r) => r.version),
  );

  // 3. Run pending migrations in version order.
  const now = Date.now();
  for (const migration of EMBEDDED_MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    if ("run" in migration) {
      migration.run(storage);
    } else {
      storage.sql.exec(migration.sql);
    }
    // Record only AFTER the migration succeeds — a throw above leaves this
    // version unrecorded so a re-run resumes cleanly (R4).
    //
    // INSERT OR IGNORE (not a bare INSERT): if two runtimes open the SAME FRESH
    // DB concurrently, both can run a given migration before either records it,
    // and the loser would otherwise throw SQLITE_CONSTRAINT_PRIMARYKEY here
    // (`version` is INTEGER PRIMARY KEY) — a spurious open failure. Migration
    // bodies are already idempotent (CREATE TABLE/INDEX IF NOT EXISTS), so
    // ignoring the duplicate bookkeeping row is safe.
    storage.sql.exec(
      "INSERT OR IGNORE INTO _migrations (version, applied_at) VALUES (?, ?)",
      migration.version,
      now,
    );
  }
}
