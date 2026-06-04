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

export async function runMigrationsWithPitrRollback(
  storage: PitrStorage,
  now?: number,
): Promise<void> {
  const bookmark = await storage.getCurrentBookmark();
  try {
    runProjectMigrations(storage, now);
  } catch (err) {
    await storage.onNextSessionRestoreBookmark(bookmark);
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
};

function runMigration(storage: MigrationStorage, migration: Migration): void {
  if ("run" in migration) {
    migration.run(storage);
    return;
  }
  storage.sql.exec(migration.sql);
}

export function runProjectMigrations(
  storage: TransactionalMigrationStorage,
  now = Date.now(),
): void {
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
    applied.add(migration.version);
  }

  validateProjectSchema(storage);
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
