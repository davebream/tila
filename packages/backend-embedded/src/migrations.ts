/**
 * Embedded migration set — the bun/node-safe migration sequence used by the
 * runtime-agnostic embedded backend (and, once Task 4 re-points it, by
 * `@tila/backend-local`).
 *
 * SCHEMA IDENTITY IS THE #1 INVARIANT. Versions 1–18 reuse the canonical DO
 * `MIGRATIONS` SQL / run-functions from `@tila/ops-sqlite` VERBATIM, so an
 * embedded SQLite file is byte-for-byte schema-identical to a DO project for
 * every shared version. There is NO embedded-specific variant of `MIGRATION_0001`:
 * the canonical schema is already standard-SQLite-portable (verified executable
 * under bun:sqlite with `foreign_keys=ON` — `artifact_relationships` carries
 * `target TEXT NOT NULL` with PRIMARY KEY `(from_key, target, type)` and all FK
 * clauses). The previous COALESCE-in-PK rationale was obsolete: the canonical
 * `artifact_relationships` PK was long ago refactored to the plain-`target`
 * form precisely to be portable, so no divergence is needed or wanted.
 *
 * Two deliberate, narrowly-scoped deltas vs the DO set:
 *
 *  1. Version 15 (`_journal_archive_watermark`) is SKIPPED: journal archival to
 *     R2 is a DO-only feature with no embedded equivalent. Skipping it does not
 *     affect any shared table.
 *
 *  2. An embedded-only idempotency table (`MIGRATION_IDEMPOTENCY`) is appended
 *     at a non-canonical version ABOVE the shared range (1000). In Cloudflare
 *     mode idempotency lives in D1 (`@tila/backend-d1`); in embedded mode it
 *     lives in the same project SQLite file (one fewer store to coordinate).
 *     The store is a standalone INSERT OR IGNORE, not folded into the mutating
 *     operation's own transaction.
 *     The `project_id` column is omitted because each embedded DB file is
 *     scoped to exactly one project. It is given a version OUTSIDE the canonical
 *     1–18 range (rather than hijacking canonical slot 5, which the DO uses for
 *     the `idx_er_to_id_type` index) so it is purely additive and never shadows
 *     or collides with a canonical migration. Every canonical version, including
 *     v5, applies exactly as upstream.
 *
 * The runner is storage-agnostic: it operates purely against an injected
 * `MigrationStorage`, so the host supplies the concrete SQLite driver.
 */

import {
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type Migration,
  type MigrationStorage,
} from "@tila/ops-sqlite";

export type { Migration, MigrationStorage } from "@tila/ops-sqlite";

/**
 * Canonical version slot for the journal-archive watermark table. Skipped in
 * embedded mode (DO-only feature).
 */
const SKIPPED_VERSIONS = new Set<number>([15]);

/** Version assigned to the embedded-only idempotency overlay (outside the
 *  canonical 1–18 range so it is purely additive). */
export const IDEMPOTENCY_MIGRATION_VERSION = 1000;

/**
 * Embedded-only idempotency table.
 *
 * In Cloudflare mode, idempotency lives in D1 (`@tila/backend-d1`). In embedded
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
 * = canonical DO `MIGRATIONS` (verbatim) minus the skipped versions, with the
 * embedded-only idempotency overlay appended above the canonical range. Every
 * shared version reuses the exact same SQL / run-function object as the DO, so
 * schema identity is structurally guaranteed (no copy that can drift).
 */
export const EMBEDDED_MIGRATIONS: ReadonlyArray<Migration> = [
  ...MIGRATIONS.filter((m) => !SKIPPED_VERSIONS.has(m.version)),
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
    storage.sql.exec(
      "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)",
      migration.version,
      now,
    );
  }
}
