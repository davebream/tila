import {
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type Migration,
  type MigrationStorage,
} from "@tila/ops-sqlite";

type TransactionalMigrationStorage = MigrationStorage & {
  transactionSync<T>(callback: () => T): T;
};

export type PitrStorage = TransactionalMigrationStorage & {
  getCurrentBookmark(): Promise<string>;
  onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
};

/**
 * Run all pending project migrations with PITR (point-in-time recovery) as the
 * cross-migration atomicity boundary.
 *
 * ## Atomicity model (load-bearing — read before changing migration commits)
 *
 * `runProjectMigrations` commits **each** migration in its own
 * `storage.transactionSync` and records it in `_migrations` immediately. There
 * is deliberately **no single SQLite transaction spanning the whole pending
 * set**: DO SQLite cannot reliably wrap the full multi-statement DDL sequence
 * (and the per-migration `transactionSync` calls do not nest), so SQLite-level
 * atomicity across the set is not available. Cross-migration atomicity is
 * provided **here** instead — capture a PITR bookmark first, and on ANY
 * migration error schedule a restore-to-bookmark for the next session and
 * re-throw (the caller aborts the DO → an intentional crash loop until an
 * operator intervenes). **PITR is therefore the sole cross-migration atomicity
 * boundary.** It is production-only (30-day window); in local/dev there is no
 * bookmark and a failed migration simply throws.
 *
 * Partial-failure recovery has two independent layers: (1) PITR restore returns
 * the DO to the pre-migration snapshot; (2) even without PITR the routine is
 * idempotent and resumable — `runProjectMigrations` skips versions already in
 * `_migrations`, so a retry continues from the last committed migration.
 */
export async function runMigrationsWithPitrRollback(
  storage: PitrStorage,
  onFatal: () => void = () => {},
  now?: number,
): Promise<void> {
  const bookmark = await storage.getCurrentBookmark();
  try {
    runProjectMigrations(storage, now);
  } catch (err) {
    await storage.onNextSessionRestoreBookmark(bookmark);
    onFatal();
    throw err;
  }
}

const REQUIRED_TABLE_COLUMNS: Record<string, string[]> = {
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
  entity_search_docs: ["entity_id", "entity_type", "name", "indexed_at"],
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
  // v21 (audit B1): DO-side idempotency dedup table.
  _do_idempotency: [
    "key",
    "request_hash",
    "status_code",
    "response_json",
    "created_at",
  ],
};

function runMigration(storage: MigrationStorage, migration: Migration): void {
  if ("run" in migration) {
    migration.run(storage);
    return;
  }
  storage.sql.exec(migration.sql);
}

/**
 * Apply every not-yet-applied migration from MIGRATIONS, in order.
 *
 * Each migration runs in its OWN `transactionSync`, committing its DDL together
 * with its `_migrations` row atomically. A mid-sequence failure therefore
 * leaves earlier migrations committed — this is intentional; cross-migration
 * atomicity is the caller's PITR boundary (see `runMigrationsWithPitrRollback`),
 * not a single wrapping transaction. The applied-version guard makes the whole
 * routine **idempotent and resumable**: re-running skips already-committed
 * migrations and continues from the first pending one.
 */
export function runProjectMigrations(
  storage: TransactionalMigrationStorage,
  now = Date.now(),
): void {
  let ranAny = false;
  storage.sql.exec(MIGRATION_BOOTSTRAP);

  const applied = new Set(
    (
      storage.sql.exec("SELECT version FROM _migrations").toArray() as {
        version: number;
      }[]
    ).map((r) => r.version),
  );

  if (applied.size === 0) {
    const hasEntities = storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'",
      )
      .toArray();
    if (hasEntities.length > 0) {
      storage.transactionSync(() => {
        storage.sql.exec(
          "INSERT INTO _migrations (version, applied_at) VALUES (1, ?), (2, ?), (3, ?)",
          now,
          now,
          now,
        );
      });
      ranAny = true;
      applied.add(1);
      applied.add(2);
      applied.add(3);
    }
  }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    storage.transactionSync(() => {
      runMigration(storage, migration);
      storage.sql.exec(
        "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)",
        migration.version,
        now,
      );
    });
    ranAny = true;
    applied.add(migration.version);
  }

  if (ranAny) {
    validateProjectSchema(storage);
  }
}

export function validateProjectSchema(storage: MigrationStorage): void {
  const errors: string[] = [];

  for (const [table, requiredColumns] of Object.entries(
    REQUIRED_TABLE_COLUMNS,
  )) {
    const rows = storage.sql.exec(`PRAGMA table_info(${table})`).toArray() as {
      name: string;
    }[];

    if (rows.length === 0) {
      errors.push(`${table} table missing`);
      continue;
    }

    const actual = new Set(rows.map((r) => r.name));
    const missing = requiredColumns.filter((column) => !actual.has(column));
    if (missing.length > 0) {
      errors.push(`${table} missing columns: ${missing.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Schema validation failed: ${errors.join("; ")}`);
  }
}
