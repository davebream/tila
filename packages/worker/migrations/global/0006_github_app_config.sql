-- GitHub App installation config
CREATE TABLE IF NOT EXISTS _github_app_config (
  project_id         TEXT    NOT NULL PRIMARY KEY,
  installation_id    INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  created_by         TEXT    NOT NULL
);
