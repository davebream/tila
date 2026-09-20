-- Bound human repository-derived authority independently from read admission.
-- Existing links keep normal collaboration but no longer grant implicit admin.
ALTER TABLE _project_repos
  ADD COLUMN max_permission TEXT NOT NULL DEFAULT 'write'
  CHECK (max_permission IN ('read', 'write', 'admin'));

UPDATE _project_repos SET max_permission = 'write';

-- Project-scoped browser sessions derived from GitHub have no source-repository
-- binding. Force them through workspace selection so the new policy is applied.
-- Token-backed cookie sessions have a non-empty token_hash and are preserved.
DELETE FROM _sessions
WHERE project_id <> '' AND token_hash = '';
