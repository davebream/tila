-- Global D1 initial migration
-- Applied via wrangler d1 migrations apply during tila init

CREATE TABLE IF NOT EXISTS _projects (
  project_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  cloudflare_account_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS _tokens (
  token_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES _projects(project_id),
  name TEXT NOT NULL,
  note TEXT,
  scopes TEXT NOT NULL DEFAULT 'full',
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_project_name ON _tokens(project_id, name) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tokens_project ON _tokens(project_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS _idempotency (
  key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  status_code INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON _idempotency(created_at);
