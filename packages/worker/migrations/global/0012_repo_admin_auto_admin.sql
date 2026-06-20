-- Per-project opt-in: treat a live GitHub repo-admin session as a tila admin
-- (epic #95, issue #101). Default 0 (off) — existing projects keep D1-token-only
-- admin until an operator explicitly opts in. INTEGER boolean (0/1), matching the
-- existing _projects.archived convention.
ALTER TABLE _projects ADD COLUMN repo_admin_auto_admin INTEGER NOT NULL DEFAULT 0;
