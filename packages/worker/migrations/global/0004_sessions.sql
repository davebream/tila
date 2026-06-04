-- D1 session store for UI httpOnly cookie sessions
CREATE TABLE IF NOT EXISTS _sessions (
  session_hash TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  actor_name   TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT 'full',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON _sessions (expires_at);
