-- #298: revision preconditions for browser-edited access settings.
-- Each repository link carries one revision per policy, and the project row a
-- revision for its display metadata. Existing rows start at revision 1.
ALTER TABLE _project_repos ADD COLUMN access_policy_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE _project_repos ADD COLUMN oidc_policy_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE _projects ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 1;

-- Runtime invitations gain a public identifier (the bearer hash stays private)
-- and an explicit revocation. Invitations created before this migration have
-- no recorded creation time.
ALTER TABLE _runtime_invitations ADD COLUMN invitation_id TEXT;
ALTER TABLE _runtime_invitations ADD COLUMN created_at INTEGER;
ALTER TABLE _runtime_invitations ADD COLUMN revoked_at INTEGER;
ALTER TABLE _runtime_invitations ADD COLUMN revoked_by TEXT;
UPDATE _runtime_invitations
SET invitation_id = lower(hex(randomblob(16)))
WHERE invitation_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_invitations_id
  ON _runtime_invitations(invitation_id);
CREATE INDEX IF NOT EXISTS idx_runtime_invitations_project
  ON _runtime_invitations(project_id, expires_at);
