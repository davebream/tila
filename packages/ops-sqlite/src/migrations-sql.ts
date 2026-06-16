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
 * Ordered migration registry. Each entry maps a version number to SQL or a
 * guarded function.
 * The runner executes only versions not yet recorded in _migrations.
 */
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
];
