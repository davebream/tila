/**
 * bun:sqlite-compatible replacement for MIGRATION_0001.
 *
 * The shared MIGRATION_0001 (from @tila/ops-sqlite) uses COALESCE() in a PRIMARY KEY
 * for the artifact_relationships table. This is valid in Cloudflare DO's SQLite
 * (built from newer SQLite source) but is not supported by bun:sqlite 3.51.x, which
 * prohibits expressions in PRIMARY KEY and UNIQUE constraints.
 *
 * This local version replaces the compound COALESCE PK with (from_key, type),
 * accepting that a given (from_key, type) pair may only have one relationship per type.
 * This is sufficient for local single-machine use.
 */
export const MIGRATION_0001_LOCAL = `
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
  content_inline TEXT,
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
  metadata TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_key, type),
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

/**
 * MIGRATION_0005: Idempotency table.
 * In Cloudflare mode, idempotency lives in D1 (packages/backend-d1). In local
 * mode, it folds into the same project SQLite database for same-transaction
 * atomicity guarantees. The project_id column is omitted because each local
 * DB file is scoped to exactly one project.
 */
export const MIGRATION_0005_IDEMPOTENCY = `
CREATE TABLE IF NOT EXISTS _idempotency (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  status_code INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON _idempotency(created_at);
`;

/**
 * Local-only migrations. Version 1 replaces the shared MIGRATION_0001 with a
 * bun:sqlite-compatible variant. Versions 2-4 use the shared migrations verbatim.
 * Version 5 adds the idempotency table.
 *
 * Note: The connection layer uses LOCAL_MIGRATION_0001 instead of the shared
 * MIGRATION_0001 for version 1.
 */
export const LOCAL_MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 5, sql: MIGRATION_0005_IDEMPOTENCY },
];
