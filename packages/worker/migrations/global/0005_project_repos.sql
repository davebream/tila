-- D1 repo allowlist for GitHub-scoped auth
CREATE TABLE IF NOT EXISTS _project_repos (
  project_id            TEXT    NOT NULL,
  github_host           TEXT    NOT NULL DEFAULT 'github.com',
  github_owner          TEXT    NOT NULL,
  github_repo           TEXT    NOT NULL,
  github_repo_id        INTEGER NOT NULL,
  min_read_permission   TEXT    NOT NULL DEFAULT 'read',
  min_write_permission  TEXT    NOT NULL DEFAULT 'write',
  enabled               INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL,
  created_by            TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_repos_lookup
  ON _project_repos (project_id, github_host, github_repo_id);
