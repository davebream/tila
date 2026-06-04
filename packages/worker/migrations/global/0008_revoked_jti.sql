CREATE TABLE IF NOT EXISTS _revoked_jti (
  jti TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_jti_project ON _revoked_jti(project_id);
