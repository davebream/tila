-- DO SQLite records schema migration
-- Applied via blockConcurrencyWhile; idempotent (IF NOT EXISTS guards on all statements)
-- IMPORTANT: Keep in sync with MIGRATION_0008 in packages/ops-sqlite/src/migrations-sql.ts

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
