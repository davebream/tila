import { ArtifactCommitRecordSchema, artifactRevisionKey } from "@tila/schemas";
/**
 * Bootstrap migration: creates the _migrations tracking table.
 * Uses CREATE TABLE IF NOT EXISTS so it is safe to run on every cold start
 * without version-checking (this runs BEFORE the version-checked loop).
 */
export const MIGRATION_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

export type MigrationSqlResult<T> = {
  toArray(): T[];
};

export type MigrationStorage = {
  sql: {
    exec(
      statement: string,
      ...bindings: unknown[]
    ): MigrationSqlResult<unknown>;
  };
};

export type Migration =
  | { version: number; sql: string }
  | { version: number; run: (storage: MigrationStorage) => void };

function assertIdentifier(identifier: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
}

export function columnExists(
  storage: MigrationStorage,
  table: string,
  column: string,
): boolean {
  assertIdentifier(table);
  assertIdentifier(column);
  const cols = storage.sql.exec(`PRAGMA table_info(${table})`).toArray() as {
    name: string;
  }[];
  return cols.some((c) => c.name === column);
}

function tableExists(storage: MigrationStorage, table: string): boolean {
  assertIdentifier(table);
  const rows = storage.sql
    .exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      table,
    )
    .toArray();
  return rows.length > 0;
}

/**
 * Embedded DDL from migrations/do/0001_initial.sql.
 * All statements use CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 * so they are idempotent on every DO cold start.
 *
 * IMPORTANT: When updating 0001_initial.sql, update this file to match.
 */
export const MIGRATION_0001 = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_relationships (
  from_id TEXT NOT NULL CHECK(from_id NOT LIKE '%/%'),
  to_id TEXT NOT NULL CHECK(to_id NOT LIKE '%/%'),
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, type),
  FOREIGN KEY (from_id) REFERENCES entities(id),
  FOREIGN KEY (to_id) REFERENCES entities(id)
);

CREATE TABLE IF NOT EXISTS artifact_pointers (
  r2_key TEXT PRIMARY KEY CHECK(r2_key LIKE '%/%'),
  resource TEXT,
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  fence INTEGER,
  mime_type TEXT NOT NULL,
  produced_at INTEGER NOT NULL,
  produced_by TEXT NOT NULL,
  expires_at INTEGER,
  tombstoned INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (resource) REFERENCES entities(id)
);

CREATE TABLE IF NOT EXISTS entity_artifact_references (
  entity_id TEXT NOT NULL CHECK(entity_id NOT LIKE '%/%'),
  artifact_key TEXT NOT NULL CHECK(artifact_key LIKE '%/%'),
  slot TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_id, artifact_key, slot),
  FOREIGN KEY (entity_id) REFERENCES entities(id),
  FOREIGN KEY (artifact_key) REFERENCES artifact_pointers(r2_key)
);

CREATE TABLE IF NOT EXISTS artifact_relationships (
  from_key TEXT NOT NULL CHECK(from_key LIKE '%/%'),
  to_key TEXT,
  to_uri TEXT,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_key, target, type),
  FOREIGN KEY (from_key) REFERENCES artifact_pointers(r2_key)
);

CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  kind TEXT NOT NULL,
  resource TEXT NOT NULL,
  actor TEXT NOT NULL,
  fence INTEGER,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS claims (
  resource TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('exclusive', 'owner', 'presence')),
  fence INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS fences (
  resource TEXT PRIMARY KEY,
  current_fence INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS presence (
  machine TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  info TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS _schema_history (
  version INTEGER PRIMARY KEY,
  definition TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  applied_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_produced ON artifact_pointers(resource) WHERE resource IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_sources ON artifact_pointers(r2_key) WHERE resource IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_resource ON journal(resource);
CREATE INDEX IF NOT EXISTS idx_journal_kind ON journal(kind);
CREATE INDEX IF NOT EXISTS idx_claims_expires ON claims(expires_at);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_artifact_rels_to_key_type ON artifact_relationships(to_key, type);
`;

export const MIGRATION_0002 = `
ALTER TABLE _schema_history ADD COLUMN change_summary TEXT;
ALTER TABLE _schema_history ADD COLUMN strategy TEXT;
`;

export function runMigration0002(storage: MigrationStorage): void {
  if (!columnExists(storage, "_schema_history", "change_summary")) {
    storage.sql.exec(
      "ALTER TABLE _schema_history ADD COLUMN change_summary TEXT",
    );
  }
  if (!columnExists(storage, "_schema_history", "strategy")) {
    storage.sql.exec("ALTER TABLE _schema_history ADD COLUMN strategy TEXT");
  }
}

export const MIGRATION_0003 = `
CREATE TABLE IF NOT EXISTS artifact_search_docs (
  artifact_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  resource TEXT,
  title TEXT,
  body_text TEXT,
  indexed_at INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (artifact_key) REFERENCES artifact_pointers(r2_key)
);

CREATE INDEX IF NOT EXISTS idx_asd_kind ON artifact_search_docs(kind);
CREATE INDEX IF NOT EXISTS idx_asd_resource ON artifact_search_docs(resource);
CREATE INDEX IF NOT EXISTS idx_asd_tombstoned ON artifact_search_docs(tombstoned);
CREATE INDEX IF NOT EXISTS idx_asd_indexed_at ON artifact_search_docs(indexed_at);

CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search_docs_fts USING fts5(
  title,
  body_text,
  content=artifact_search_docs,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS asd_ai AFTER INSERT ON artifact_search_docs BEGIN
  INSERT INTO artifact_search_docs_fts(rowid, title, body_text)
  VALUES (new.rowid, new.title, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS asd_au AFTER UPDATE ON artifact_search_docs BEGIN
  INSERT INTO artifact_search_docs_fts(artifact_search_docs_fts, rowid, title, body_text)
  VALUES ('delete', old.rowid, old.title, old.body_text);
  INSERT INTO artifact_search_docs_fts(rowid, title, body_text)
  VALUES (new.rowid, new.title, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS asd_ad AFTER DELETE ON artifact_search_docs BEGIN
  INSERT INTO artifact_search_docs_fts(artifact_search_docs_fts, rowid, title, body_text)
  VALUES ('delete', old.rowid, old.title, old.body_text);
END;
`;

export const MIGRATION_0004 = `
ALTER TABLE journal ADD COLUMN token_id TEXT;
`;

export function runMigration0004(storage: MigrationStorage): void {
  if (!columnExists(storage, "journal", "token_id")) {
    storage.sql.exec("ALTER TABLE journal ADD COLUMN token_id TEXT");
  }
}

export const MIGRATION_0005 = `
CREATE INDEX IF NOT EXISTS idx_er_to_id_type ON entity_relationships(to_id, type);
`;

export const MIGRATION_0006 = `
CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  await_type TEXT NOT NULL CHECK(await_type IN ('ci', 'pr', 'timer', 'human', 'webhook')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'resolved', 'timed_out', 'cancelled')),
  fence INTEGER NOT NULL,
  timeout_at INTEGER,
  resolved_at INTEGER,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  token_id TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_gates_resource ON gates(resource);
CREATE INDEX IF NOT EXISTS idx_gates_status ON gates(status);
CREATE INDEX IF NOT EXISTS idx_gates_timeout ON gates(timeout_at) WHERE timeout_at IS NOT NULL;
`;

export const MIGRATION_0007 = `
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  resource TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_signals_target ON signals(target);
CREATE INDEX IF NOT EXISTS idx_signals_expires ON signals(expires_at);
`;

export const MIGRATION_0008 = `
CREATE TABLE IF NOT EXISTS records (
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  value_sha256 TEXT NOT NULL,
  revision INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (type, key)
);

CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
CREATE INDEX IF NOT EXISTS idx_records_archived ON records(type, archived);

CREATE TABLE IF NOT EXISTS record_tags (
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (type, key, tag),
  FOREIGN KEY (type, key) REFERENCES records(type, key)
);

CREATE INDEX IF NOT EXISTS idx_record_tags_tag ON record_tags(tag);

CREATE TABLE IF NOT EXISTS record_revisions (
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('created', 'set', 'patch', 'archived', 'unarchived')),
  schema_version INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  value_sha256 TEXT NOT NULL,
  canonical_artifact_key TEXT,
  source_artifact_key TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  message TEXT,
  PRIMARY KEY (type, key, revision),
  FOREIGN KEY (type, key) REFERENCES records(type, key)
);

CREATE INDEX IF NOT EXISTS idx_record_revisions_record
  ON record_revisions(type, key, revision);
`;

export const MIGRATION_0009 = `
CREATE TABLE IF NOT EXISTS entity_search_docs (
  entity_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  name TEXT,
  indexed_at INTEGER NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES entities(id)
);

CREATE INDEX IF NOT EXISTS idx_esd_entity_type ON entity_search_docs(entity_type);
CREATE INDEX IF NOT EXISTS idx_esd_indexed_at ON entity_search_docs(indexed_at);

CREATE VIRTUAL TABLE IF NOT EXISTS entity_search_docs_fts USING fts5(
  name,
  content=entity_search_docs,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS esd_ai AFTER INSERT ON entity_search_docs BEGIN
  INSERT INTO entity_search_docs_fts(rowid, name)
  VALUES (new.rowid, new.name);
END;

CREATE TRIGGER IF NOT EXISTS esd_au AFTER UPDATE ON entity_search_docs BEGIN
  INSERT INTO entity_search_docs_fts(entity_search_docs_fts, rowid, name)
  VALUES ('delete', old.rowid, old.name);
  INSERT INTO entity_search_docs_fts(rowid, name)
  VALUES (new.rowid, new.name);
END;

CREATE TRIGGER IF NOT EXISTS esd_ad AFTER DELETE ON entity_search_docs BEGIN
  INSERT INTO entity_search_docs_fts(entity_search_docs_fts, rowid, name)
  VALUES ('delete', old.rowid, old.name);
END;
`;

export const MIGRATION_0010 = `
CREATE TABLE IF NOT EXISTS claims (
  resource TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('exclusive', 'owner', 'presence')),
  fence INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);
ALTER TABLE claims ADD COLUMN machine TEXT NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN user TEXT NOT NULL DEFAULT '';
UPDATE claims SET machine = holder, user = holder WHERE machine = '';
`;

export function runMigration0010(storage: MigrationStorage): void {
  // A v23 database may replay this migration if the bookkeeping table was
  // lost. Its canonical claim table intentionally has no legacy holder column.
  if (columnExists(storage, "claims", "principal_id")) return;

  storage.sql.exec(`
CREATE TABLE IF NOT EXISTS claims (
  resource TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('exclusive', 'owner', 'presence')),
  fence INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);
`);
  const hasMachine = columnExists(storage, "claims", "machine");
  const hasUser = columnExists(storage, "claims", "user");
  if (!hasMachine) {
    storage.sql.exec(
      "ALTER TABLE claims ADD COLUMN machine TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!hasUser) {
    storage.sql.exec(
      "ALTER TABLE claims ADD COLUMN user TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!hasMachine || !hasUser) {
    storage.sql.exec(
      "UPDATE claims SET machine = holder, user = holder WHERE machine = ''",
    );
  }
}

export const MIGRATION_0011 = `
ALTER TABLE artifact_pointers ADD COLUMN content_inline TEXT;
`;

export function runMigration0011(storage: MigrationStorage) {
  if (!columnExists(storage, "artifact_pointers", "content_inline")) {
    storage.sql.exec(MIGRATION_0011);
  }
}

export const MIGRATION_0012 = `
CREATE TABLE IF NOT EXISTS record_search_docs (
  record_type TEXT NOT NULL,
  record_key TEXT NOT NULL,
  body_text TEXT,
  indexed_at INTEGER NOT NULL,
  value_sha256 TEXT NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (record_type, record_key),
  FOREIGN KEY (record_type, record_key) REFERENCES records(type, key)
);

CREATE INDEX IF NOT EXISTS idx_rsd_indexed_at ON record_search_docs(indexed_at);
CREATE INDEX IF NOT EXISTS idx_rsd_tombstoned ON record_search_docs(tombstoned);

CREATE VIRTUAL TABLE IF NOT EXISTS record_search_docs_fts USING fts5(
  body_text,
  content=record_search_docs,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS rsd_ai AFTER INSERT ON record_search_docs BEGIN
  INSERT INTO record_search_docs_fts(rowid, body_text)
  VALUES (new.rowid, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS rsd_au AFTER UPDATE ON record_search_docs BEGIN
  INSERT INTO record_search_docs_fts(record_search_docs_fts, rowid, body_text)
  VALUES ('delete', old.rowid, old.body_text);
  INSERT INTO record_search_docs_fts(rowid, body_text)
  VALUES (new.rowid, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS rsd_ad AFTER DELETE ON record_search_docs BEGIN
  INSERT INTO record_search_docs_fts(record_search_docs_fts, rowid, body_text)
  VALUES ('delete', old.rowid, old.body_text);
END;
`;

export const MIGRATION_0013 = `
ALTER TABLE journal ADD COLUMN source TEXT DEFAULT NULL;
ALTER TABLE journal ADD COLUMN source_version TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_source ON journal(source);
`;

export function runMigration0013(storage: MigrationStorage): void {
  if (!columnExists(storage, "journal", "source")) {
    storage.sql.exec("ALTER TABLE journal ADD COLUMN source TEXT DEFAULT NULL");
  }
  if (!columnExists(storage, "journal", "source_version")) {
    storage.sql.exec(
      "ALTER TABLE journal ADD COLUMN source_version TEXT DEFAULT NULL",
    );
  }
  storage.sql.exec(
    "CREATE INDEX IF NOT EXISTS idx_journal_source ON journal(source)",
  );
}

export const MIGRATION_0014 = `
ALTER TABLE record_revisions ADD COLUMN token_id TEXT DEFAULT NULL;
ALTER TABLE record_revisions ADD COLUMN source TEXT DEFAULT NULL;
ALTER TABLE record_revisions ADD COLUMN source_version TEXT DEFAULT NULL;
`;

export function runMigration0014(storage: MigrationStorage): void {
  if (!columnExists(storage, "record_revisions", "token_id")) {
    storage.sql.exec(
      "ALTER TABLE record_revisions ADD COLUMN token_id TEXT DEFAULT NULL",
    );
  }
  if (!columnExists(storage, "record_revisions", "source")) {
    storage.sql.exec(
      "ALTER TABLE record_revisions ADD COLUMN source TEXT DEFAULT NULL",
    );
  }
  if (!columnExists(storage, "record_revisions", "source_version")) {
    storage.sql.exec(
      "ALTER TABLE record_revisions ADD COLUMN source_version TEXT DEFAULT NULL",
    );
  }
}

export const MIGRATION_0015 = `
CREATE TABLE IF NOT EXISTS _journal_archive_watermark (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  last_archived_seq INTEGER NOT NULL,
  archived_at INTEGER NOT NULL
);
`;

export const MIGRATION_0016 = `
ALTER TABLE artifact_pointers ADD COLUMN tombstoned_at INTEGER;
`;

export function runMigration0016(storage: MigrationStorage): void {
  if (!columnExists(storage, "artifact_pointers", "tombstoned_at")) {
    storage.sql.exec(
      "ALTER TABLE artifact_pointers ADD COLUMN tombstoned_at INTEGER",
    );
  }
}

/**
 * C7 fence-resource unification: backfill canonical `<type>:<id>` fence rows.
 *
 * For every entity that has a bare-id fence row (from legacy acquires), ensure
 * the typed `<type>:<id>` fence row exists and holds MAX(typed, bare). This is
 * monotonic — no fence value ever decreases. Idempotent (uses MAX so safe to
 * re-run). Entities with only a typed row are untouched.
 *
 * After this migration:
 * - `assertResourceFence` canonicalizes bare entity ids → typed rows before
 *   the exact-match shortcut, giving a single authoritative fence per entity.
 * - Bare-id fence rows become inert (superseded by typed rows). Deletion is
 *   deferred to a future cleanup migration to avoid orphaning in-flight claims.
 */
export function runMigration0017(storage: MigrationStorage): void {
  // Enumerate all bare-id fence rows that correspond to entities (i.e. the
  // fence resource exists as an entity id).  For each, upsert the typed fence
  // row with MAX(existing typed current_fence, bare current_fence).
  const rows = storage.sql
    .exec(
      `
      SELECT f.resource AS bare_resource, f.current_fence AS bare_fence,
             e.type AS entity_type
      FROM fences f
      JOIN entities e ON e.id = f.resource
      `,
    )
    .toArray() as {
    bare_resource: string;
    bare_fence: number;
    entity_type: string;
  }[];

  for (const row of rows) {
    const typedResource = `${row.entity_type}:${row.bare_resource}`;
    // Upsert: if typed row exists, set current_fence = MAX(existing, bare).
    // If absent, insert with bare_fence.
    storage.sql.exec(
      `INSERT INTO fences(resource, current_fence)
         VALUES(?, ?)
         ON CONFLICT(resource) DO UPDATE
           SET current_fence = MAX(current_fence, excluded.current_fence)`,
      typedResource,
      row.bare_fence,
    );
  }
}

export const MIGRATION_0018 = `
CREATE TABLE IF NOT EXISTS entity_tags (
  entity_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (entity_id, tag),
  FOREIGN KEY (entity_id) REFERENCES entities(id)
);

CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag);

CREATE TABLE IF NOT EXISTS artifact_tags (
  artifact_key TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (artifact_key, tag),
  FOREIGN KEY (artifact_key) REFERENCES artifact_pointers(r2_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_artifact_tags_tag ON artifact_tags(tag);
`;

export const MIGRATION_0019 = `
CREATE INDEX IF NOT EXISTS idx_entity_relationships_to_id_type
ON entity_relationships(to_id, type);

CREATE INDEX IF NOT EXISTS idx_presence_last_seen
ON presence(last_seen);
`;

/**
 * Add `blob_deleted_at` to artifact_pointers so the tombstoned-pointer
 * hard-delete (`deleteTombstonedPointers`) can be gated on CONFIRMED R2 blob
 * deletion rather than the time-based grace alone. Without it, a tombstoned
 * pointer whose R2 blob delete permanently failed would be hard-deleted after
 * the grace window, stranding the orphan blob.
 *
 * Backfill: existing tombstoned rows predate the confirmation signal. The old
 * sweep already hard-deleted them at the grace boundary regardless of blob
 * state, so treat them as blob-deletion-presumed-done (blob_deleted_at =
 * tombstoned_at). This preserves GC progress for legacy rows; only NEW
 * tombstones are subject to the stricter confirmed-delete gate.
 */
export function runMigration0020(storage: MigrationStorage): void {
  if (!columnExists(storage, "artifact_pointers", "blob_deleted_at")) {
    storage.sql.exec(
      "ALTER TABLE artifact_pointers ADD COLUMN blob_deleted_at INTEGER",
    );
  }
  // Backfill only when tombstoned_at exists. On a reshuffled OLD-style local DB
  // where v16 is recorded-but-not-applied, the column can be absent — guard so
  // the migration never references a missing column.
  if (columnExists(storage, "artifact_pointers", "tombstoned_at")) {
    storage.sql.exec(
      `UPDATE artifact_pointers
         SET blob_deleted_at = tombstoned_at
         WHERE tombstoned = 1
           AND tombstoned_at IS NOT NULL
           AND blob_deleted_at IS NULL`,
    );
  }
}

/**
 * DO-side idempotency dedup table (audit finding B1). A fence-mutating write
 * co-commits a dedup row here inside its own DO SQLite transaction, so a replay
 * after a cross-store crash returns the prior result without re-executing.
 *
 * Strictly additive + idempotent (CREATE … IF NOT EXISTS) so it is safe to apply
 * against production DO SQLite. `request_hash` is nullable to mirror the worker
 * middleware's null-hash "always replay" path. Named `_do_idempotency` to avoid
 * collision with the embedded-only `_idempotency` table.
 *
 * FOLLOW-UP (tracked, not this PR): rows accumulate unbounded; a GC pass folded
 * into the daily sweep is needed (see schema.ts doIdempotency comment).
 */
export const MIGRATION_0021 = `
CREATE TABLE IF NOT EXISTS _do_idempotency (
  key           TEXT PRIMARY KEY,
  request_hash  TEXT,
  status_code   INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_do_idempotency_created
ON _do_idempotency(created_at);
`;

/**
 * Partial index on entities to accelerate the FTS join on active (non-archived)
 * entities. The FTS search queries join entities on `e.id` with `WHERE e.archived = 0`;
 * this index covers that filter on the join key.
 *
 * Shape: entities(id) WHERE archived = 0
 * Chosen over bare entities(archived) because the FTS join predicate is on e.id
 * and this partial covering form avoids a full table scan for the archived filter.
 * Validated informally via EXPLAIN QUERY PLAN; planner-selection is informational
 * (migration-applies is the blocking guarantee).
 */
export const MIGRATION_0022 = `
CREATE INDEX IF NOT EXISTS idx_entities_archived ON entities(id) WHERE archived = 0;
`;

/**
 * Split authenticated principal, independent participant, and untrusted
 * environment identity. Active legacy claims and presence cannot be assigned a
 * truthful participant, so they are intentionally discarded. Fence rows are
 * untouched and therefore remain monotonic.
 */
export function runMigration0023(storage: MigrationStorage): void {
  storage.sql.exec("DROP TABLE IF EXISTS claims");
  storage.sql.exec(`
    CREATE TABLE claims (
      resource TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT '{}',
      mode TEXT NOT NULL CHECK(mode IN ('exclusive', 'owner', 'presence')),
      fence INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      metadata TEXT DEFAULT '{}'
    )
  `);
  storage.sql.exec(
    "CREATE INDEX IF NOT EXISTS idx_claims_expires ON claims(expires_at)",
  );

  storage.sql.exec("DROP TABLE IF EXISTS presence");
  storage.sql.exec(`
    CREATE TABLE presence (
      principal_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT '{}',
      last_seen INTEGER NOT NULL,
      info TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (principal_id, participant_id)
    )
  `);
  storage.sql.exec(
    "CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON presence(last_seen)",
  );

  if (tableExists(storage, "journal")) {
    if (!columnExists(storage, "journal", "principal_id")) {
      storage.sql.exec("ALTER TABLE journal ADD COLUMN principal_id TEXT");
    }
    if (!columnExists(storage, "journal", "participant_id")) {
      storage.sql.exec("ALTER TABLE journal ADD COLUMN participant_id TEXT");
    }
    if (!columnExists(storage, "journal", "environment")) {
      storage.sql.exec("ALTER TABLE journal ADD COLUMN environment TEXT");
    }
    storage.sql.exec(`
      UPDATE journal
         SET principal_id = COALESCE(principal_id, 'legacy-principal:' || actor),
             participant_id = COALESCE(participant_id, 'legacy-event:' || seq),
             environment = COALESCE(
               environment,
               CASE
                 WHEN source IS NULL THEN '{}'
                 WHEN source_version IS NULL THEN json_object('client_name', source)
                 ELSE json_object('client_name', source, 'client_version', source_version)
               END
             )
    `);
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_journal_participant ON journal(participant_id)",
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_journal_client_name ON journal(json_extract(environment, '$.client_name'))",
    );
  }
}

/**
 * Singleton project transfer lock plus idempotent accepted-chunk ledger.
 * Export sessions carry a renewable expiry. Import and rollback sessions store
 * NULL in expires_at and therefore fail closed until explicitly completed.
 */
export const MIGRATION_0024 = `
CREATE TABLE IF NOT EXISTS _project_transfer_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  session_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('export', 'import', 'rollback')),
  owner TEXT NOT NULL,
  archive_digest TEXT,
  safety_archive TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  applying INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS _project_transfer_chunks (
  session_id TEXT NOT NULL,
  section TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, section, chunk_index)
);
`;

const TRANSFER_GUARDED_TABLES = [
  "entities",
  "entity_relationships",
  "artifact_pointers",
  "entity_artifact_references",
  "artifact_relationships",
  "journal",
  "_journal_archive_watermark",
  "claims",
  "fences",
  "presence",
  "_schema_history",
  "artifact_search_docs",
  "entity_search_docs",
  "gates",
  "signal_groups",
  "signal_group_members",
  "signals",
  "signal_deliveries",
  "records",
  "entity_tags",
  "artifact_tags",
  "record_tags",
  "record_revisions",
  "record_search_docs",
] as const;

export function runMigration0024(storage: MigrationStorage): void {
  storage.sql.exec(MIGRATION_0024);
  for (const table of TRANSFER_GUARDED_TABLES) {
    const exists =
      storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          table,
        )
        .toArray().length > 0;
    if (!exists) continue;
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      storage.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS transfer_guard_${table}_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table}
        WHEN EXISTS (
          SELECT 1 FROM _project_transfer_state
          WHERE singleton = 1 AND applying = 0
            AND (expires_at IS NULL OR expires_at > (unixepoch('subsec') * 1000))
        )
        BEGIN
          SELECT RAISE(ABORT, 'project-maintenance');
        END;
      `);
    }
  }
}

/**
 * Replace display-name-addressed signals with participant-scoped deliveries.
 * Legacy rows cannot be mapped to canonical identities safely, so this
 * migration intentionally purges them by rebuilding the signals table.
 */
export function runMigration0025(storage: MigrationStorage): void {
  storage.sql.exec("DROP TABLE IF EXISTS signal_deliveries");
  storage.sql.exec("DROP TABLE IF EXISTS signals");
  storage.sql.exec("DROP TABLE IF EXISTS signal_group_members");
  storage.sql.exec("DROP TABLE IF EXISTS signal_groups");
  storage.sql.exec(`
    CREATE TABLE signal_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by_principal_id TEXT NOT NULL,
      created_by_participant_id TEXT NOT NULL,
      updated_by_principal_id TEXT NOT NULL,
      updated_by_participant_id TEXT NOT NULL
    );

    CREATE TABLE signal_group_members (
      group_id TEXT NOT NULL REFERENCES signal_groups(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      added_by_principal_id TEXT NOT NULL,
      added_by_participant_id TEXT NOT NULL,
      PRIMARY KEY (group_id, principal_id)
    );
    CREATE INDEX idx_signal_group_members_principal
      ON signal_group_members(principal_id);

    CREATE TABLE signals (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      resource TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      sender_principal_id TEXT NOT NULL,
      sender_participant_id TEXT NOT NULL,
      sender_display_name TEXT,
      sender_environment TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_signals_expires ON signals(expires_at);

    CREATE TABLE signal_deliveries (
      signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
      recipient_principal_id TEXT NOT NULL,
      recipient_participant_id TEXT NOT NULL,
      recipient_display_name TEXT,
      recipient_environment TEXT NOT NULL DEFAULT '{}',
      acknowledged_at INTEGER,
      acknowledged_by_principal_id TEXT,
      acknowledged_by_participant_id TEXT,
      acknowledged_by_display_name TEXT,
      acknowledged_by_environment TEXT,
      PRIMARY KEY (
        signal_id,
        recipient_principal_id,
        recipient_participant_id
      )
    );
    CREATE INDEX idx_signal_deliveries_inbox ON signal_deliveries(
      recipient_principal_id,
      recipient_participant_id,
      acknowledged_at
    );
  `);

  installTransferGuards(storage, [
    "signal_groups",
    "signal_group_members",
    "signals",
    "signal_deliveries",
  ]);
}

function installTransferGuards(
  storage: MigrationStorage,
  tables: string[],
): void {
  for (const table of tables) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      storage.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS transfer_guard_${table}_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table}
        WHEN EXISTS (
          SELECT 1 FROM _project_transfer_state
          WHERE singleton = 1 AND applying = 0
            AND (expires_at IS NULL OR expires_at > (unixepoch('subsec') * 1000))
        )
        BEGIN
          SELECT RAISE(ABORT, 'project-maintenance');
        END;
      `);
    }
  }
}

export function runMigration0027(storage: MigrationStorage): void {
  for (const [name, type] of [
    ["lineage_id", "TEXT"],
    ["revision", "INTEGER"],
    ["restored_from", "TEXT"],
  ]) {
    if (!columnExists(storage, "artifact_pointers", name)) {
      storage.sql.exec(
        `ALTER TABLE artifact_pointers ADD COLUMN ${name} ${type}`,
      );
    }
  }
  storage.sql.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_revision ON artifact_pointers(lineage_id, revision);
    CREATE TABLE IF NOT EXISTS artifact_lineages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      resource TEXT, next_revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS artifact_revision_operations (
      id TEXT PRIMARY KEY, lineage_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','accepted','published','aborted')),
      record TEXT NOT NULL, search_text TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_operations_lineage ON artifact_revision_operations(lineage_id, state);
  `);
  for (const table of ["artifact_lineages", "artifact_revision_operations"]) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      storage.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS transfer_guard_${table}_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table}
        WHEN EXISTS (SELECT 1 FROM _project_transfer_state WHERE singleton = 1 AND applying = 0
          AND (expires_at IS NULL OR expires_at > (unixepoch('subsec') * 1000)))
        BEGIN SELECT RAISE(ABORT, 'project-maintenance'); END;
      `);
    }
  }
}

/**
 * Ordered migration registry. Each entry maps a version number to SQL or a
 * guarded function.
 * The runner executes only versions not yet recorded in _migrations.
 */
export const MIGRATION_0026 = `
CREATE TABLE IF NOT EXISTS journal_cursors (
  principal_id TEXT NOT NULL, participant_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq >= 0), updated_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, participant_id)
);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, participant_id TEXT NOT NULL,
  created_seq INTEGER NOT NULL UNIQUE, request_json TEXT NOT NULL, snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_creator ON handoffs(principal_id, participant_id, created_seq);
CREATE TABLE IF NOT EXISTS handoff_references (
  handoff_id TEXT NOT NULL, resource TEXT NOT NULL, PRIMARY KEY(handoff_id, resource)
);
CREATE INDEX IF NOT EXISTS idx_handoff_resource ON handoff_references(resource);
`;

export function runMigration0026(storage: MigrationStorage): void {
  storage.sql.exec(MIGRATION_0026);
  installTransferGuards(storage, [
    "journal_cursors",
    "handoffs",
    "handoff_references",
  ]);
}

export function runMigration0028(storage: MigrationStorage): void {
  // Older embedded databases may predate artifact tags. Preserve their existing
  // migration compatibility without inventing tags that were never stored.
  const hasTags =
    storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_tags'",
      )
      .toArray().length > 0;
  const tags = hasTags
    ? "json((SELECT json_group_array(tag) FROM artifact_tags WHERE artifact_key = r2_key))"
    : "json('[]')";
  const lineageColumns = storage.sql
    .exec("PRAGMA table_info(artifact_lineages)")
    .toArray() as Array<{ name: string }>;
  if (!lineageColumns.some((column) => column.name === "destroyed_at"))
    storage.sql.exec(
      "ALTER TABLE artifact_lineages ADD COLUMN destroyed_at INTEGER",
    );
  const pointerColumns = new Set(
    (
      storage.sql
        .exec("PRAGMA table_info(artifact_pointers)")
        .toArray() as Array<{ name: string }>
    ).map((column) => column.name),
  );
  const tombstonedAt = pointerColumns.has("tombstoned_at")
    ? "tombstoned_at"
    : "NULL";
  const blobDeletedAt = pointerColumns.has("blob_deleted_at")
    ? "blob_deleted_at"
    : "NULL";
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS artifact_revisions (
      r2_key TEXT PRIMARY KEY, lineage_id TEXT NOT NULL, revision INTEGER NOT NULL,
      metadata TEXT NOT NULL, retention_assigned INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_identity ON artifact_revisions(lineage_id, revision);
    CREATE TABLE IF NOT EXISTS artifact_lifecycle_operations (
      id TEXT PRIMARY KEY, lineage_id TEXT NOT NULL, record TEXT NOT NULL, request_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_due ON artifact_lifecycle_operations(state, retry_at);
    CREATE TABLE IF NOT EXISTS artifact_retention_state (
      id INTEGER PRIMARY KEY, policy TEXT NOT NULL, cursor TEXT, complete INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO artifact_revisions(r2_key, lineage_id, revision, metadata)
      SELECT r2_key, lineage_id, revision, json_object(
        'r2_key', r2_key, 'lineage_id', lineage_id, 'revision', revision,
        'restored_from', restored_from, 'resource', resource, 'kind', kind, 'sha256', sha256,
        'bytes', bytes, 'fence', fence, 'mime_type', mime_type, 'produced_at', produced_at,
        'produced_by', produced_by, 'expires_at', expires_at, 'tombstoned', tombstoned,
        'tombstoned_at', ${tombstonedAt}, 'blob_deleted_at', ${blobDeletedAt},
        'tags', ${tags}
      ) FROM artifact_pointers WHERE lineage_id IS NOT NULL;
    INSERT OR IGNORE INTO artifact_revisions(r2_key, lineage_id, revision, metadata)
      SELECT json_extract(record, '$.pointer.r2_key'), lineage_id,
        json_extract(record, '$.pointer.revision'),
        json_set(json_extract(record, '$.pointer'), '$.tombstoned', 1, '$.tombstoned_at', created_at)
      FROM artifact_revision_operations WHERE state = 'published' AND json_valid(record);
  `);
  installTransferGuards(storage, [
    "artifact_revisions",
    "artifact_lifecycle_operations",
    "artifact_retention_state",
  ]);
}

export function runMigration0029(storage: MigrationStorage): void {
  const columns = new Set(
    (
      storage.sql.exec("PRAGMA table_info(artifact_pointers)").toArray() as {
        name: string;
      }[]
    ).map((c) => c.name),
  );
  for (const column of ["provenance", "revision_creation"]) {
    if (!columns.has(column))
      storage.sql.exec(
        `ALTER TABLE artifact_pointers ADD COLUMN ${column} TEXT`,
      );
  }
  // Only a published, non-deduplicated commit identifies this revision's creator.
  // Never guess a principal from a display name or the actor of a deduplicated put.
  for (const row of storage.sql
    .exec(
      "SELECT record FROM artifact_revision_operations WHERE state = 'published'",
    )
    .toArray() as { record: string }[]) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.record);
    } catch {
      continue;
    }
    const parsed = ArtifactCommitRecordSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.deduplicated ||
      !parsed.data.origin.principalId ||
      !parsed.data.origin.participantId
    )
      continue;
    const record = parsed.data;
    const p = record.pointer;
    if (
      p.r2_key !==
      artifactRevisionKey(
        record.project_id,
        p.lineage_id,
        p.revision,
        p.sha256,
        p.mime_type,
      )
    )
      continue;
    const creator = {
      principal_id: record.origin.principalId,
      participant_id: record.origin.participantId,
      created_at: p.produced_at,
      environment: record.origin.environment,
      client_name:
        record.origin.environment.client_name ?? record.origin.source ?? null,
      client_version:
        record.origin.environment.client_version ??
        record.origin.sourceVersion ??
        null,
    };
    const provenance =
      p.provenance === undefined
        ? p.restored_from
          ? null
          : creator
        : p.provenance;
    storage.sql.exec(
      "UPDATE artifact_pointers SET provenance = ?, revision_creation = ? WHERE r2_key = ? AND provenance IS NULL AND revision_creation IS NULL",
      provenance === null ? null : JSON.stringify(provenance),
      JSON.stringify(p.revision_creation ?? creator),
      p.r2_key,
    );
  }
  storage.sql.exec(`
    UPDATE artifact_revisions SET metadata = json_set(metadata,
      '$.provenance', json((SELECT provenance FROM artifact_pointers WHERE r2_key = artifact_revisions.r2_key)),
      '$.revision_creation', json((SELECT revision_creation FROM artifact_pointers WHERE r2_key = artifact_revisions.r2_key)))
      WHERE EXISTS (SELECT 1 FROM artifact_pointers WHERE r2_key = artifact_revisions.r2_key AND revision_creation IS NOT NULL);
    CREATE TRIGGER IF NOT EXISTS artifact_revision_provenance_immutable BEFORE UPDATE OF metadata ON artifact_revisions
      WHEN json_extract(NEW.metadata, '$.provenance') IS NOT json_extract(OLD.metadata, '$.provenance')
        OR json_extract(NEW.metadata, '$.revision_creation') IS NOT json_extract(OLD.metadata, '$.revision_creation')
      BEGIN SELECT RAISE(ABORT, 'artifact-provenance-immutable'); END;
    CREATE TABLE IF NOT EXISTS artifact_reviews (
      artifact_key TEXT NOT NULL,
      review_revision INTEGER NOT NULL CHECK(review_revision > 0),
      principal_id TEXT NOT NULL, participant_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('trusted','rejected','superseded','revoked')),
      reason TEXT, operation_id TEXT NOT NULL, request_json TEXT NOT NULL,
      PRIMARY KEY(artifact_key, review_revision)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_reviews_operation ON artifact_reviews(operation_id);
    CREATE TRIGGER IF NOT EXISTS artifact_provenance_immutable BEFORE UPDATE OF provenance, revision_creation ON artifact_pointers
      WHEN NEW.provenance IS NOT OLD.provenance OR NEW.revision_creation IS NOT OLD.revision_creation
      BEGIN SELECT RAISE(ABORT, 'artifact-provenance-immutable'); END;
    CREATE TRIGGER IF NOT EXISTS artifact_reviews_immutable BEFORE UPDATE ON artifact_reviews
      BEGIN SELECT RAISE(ABORT, 'artifact-review-immutable'); END;
    CREATE TRIGGER IF NOT EXISTS artifact_reviews_no_delete BEFORE DELETE ON artifact_reviews
      WHEN (EXISTS (SELECT 1 FROM artifact_pointers WHERE r2_key = OLD.artifact_key) OR EXISTS (SELECT 1 FROM artifact_revisions WHERE r2_key = OLD.artifact_key)) AND NOT EXISTS (SELECT 1 FROM _project_transfer_state WHERE singleton = 1 AND applying = 1)
      BEGIN SELECT RAISE(ABORT, 'artifact-review-immutable'); END;
  `);
  installTransferGuards(storage, ["artifact_reviews"]);
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, sql: MIGRATION_0001 },
  { version: 2, run: runMigration0002 },
  { version: 3, sql: MIGRATION_0003 },
  { version: 4, run: runMigration0004 },
  { version: 5, sql: MIGRATION_0005 },
  { version: 6, sql: MIGRATION_0006 },
  { version: 7, sql: MIGRATION_0007 },
  { version: 8, sql: MIGRATION_0008 },
  { version: 9, sql: MIGRATION_0009 },
  { version: 10, run: runMigration0010 },
  { version: 11, run: runMigration0011 },
  { version: 12, sql: MIGRATION_0012 },
  { version: 13, run: runMigration0013 },
  { version: 14, run: runMigration0014 },
  { version: 15, sql: MIGRATION_0015 },
  { version: 16, run: runMigration0016 },
  { version: 17, run: runMigration0017 },
  { version: 18, sql: MIGRATION_0018 },
  { version: 19, sql: MIGRATION_0019 },
  { version: 20, run: runMigration0020 },
  { version: 21, sql: MIGRATION_0021 },
  { version: 22, sql: MIGRATION_0022 },
  { version: 23, run: runMigration0023 },
  { version: 24, run: runMigration0024 },
  { version: 25, run: runMigration0025 },
  { version: 26, run: runMigration0026 },
  { version: 27, run: runMigration0027 },
  { version: 28, run: runMigration0028 },
  { version: 29, run: runMigration0029 },
];
