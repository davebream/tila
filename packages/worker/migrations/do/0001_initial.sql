-- DO SQLite initial migration
-- Applied via blockConcurrencyWhile on first DO startup

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
  metadata TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type),
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

CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Partial indexes for artifact queries
CREATE INDEX IF NOT EXISTS idx_artifacts_produced ON artifact_pointers(resource) WHERE resource IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_sources ON artifact_pointers(r2_key) WHERE resource IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_resource ON journal(resource);
CREATE INDEX IF NOT EXISTS idx_journal_kind ON journal(kind);
CREATE INDEX IF NOT EXISTS idx_claims_expires ON claims(expires_at);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
