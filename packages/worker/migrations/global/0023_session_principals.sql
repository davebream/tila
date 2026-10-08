-- Browser sessions created before canonical immutable subjects were persisted
-- cannot be backfilled safely from their display names. Rebuild the ephemeral
-- session table empty so those users authenticate again.
DROP TABLE IF EXISTS _sessions;

CREATE TABLE _sessions (
  session_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'full',
  permission TEXT NOT NULL DEFAULT 'read',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_expires ON _sessions (expires_at);
