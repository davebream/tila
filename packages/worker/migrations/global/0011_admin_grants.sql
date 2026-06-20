-- D1 per-project admin roster for GitHub-scoped governance (epic #95)
CREATE TABLE IF NOT EXISTS _admin_grants (
  project_id            TEXT    NOT NULL,
  github_host           TEXT    NOT NULL DEFAULT 'github.com',
  github_user_id        INTEGER NOT NULL,           -- immutable identity; logins change (docs/07:75)
  github_login_snapshot TEXT,                        -- display/audit only, never identity
  granted_by_user_id    INTEGER,                     -- NULL only for infra-owner-seeded rows
  granted_at            INTEGER NOT NULL,            -- Unix seconds (not ms); cf. _revoked_jti which uses ms
  revoked_at            INTEGER,                     -- Unix seconds (not ms); cf. _revoked_jti which uses ms
  revoked_by_user_id    INTEGER
);
-- One ACTIVE grant per identity per project; revoked rows are excluded so
-- re-granting after a revoke is allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_grants_active
  ON _admin_grants (project_id, github_host, github_user_id)
  WHERE revoked_at IS NULL;
