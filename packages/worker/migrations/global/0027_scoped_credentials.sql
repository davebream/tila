-- Preserve existing membership identities while admitting native services.
CREATE TABLE _project_memberships_new (
  membership_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'oidc', 'service')),
  identity_host TEXT NOT NULL, subject_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('human', 'service')),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'participant', 'maintainer', 'owner')),
  display_name TEXT, granted_by TEXT NOT NULL, granted_at INTEGER NOT NULL,
  revoked_by TEXT, revoked_at INTEGER
);
INSERT INTO _project_memberships_new SELECT * FROM _project_memberships;
DROP TABLE _project_memberships;
ALTER TABLE _project_memberships_new RENAME TO _project_memberships;
CREATE UNIQUE INDEX idx_project_memberships_active ON _project_memberships(project_id, principal_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_project_memberships_project ON _project_memberships(project_id);

CREATE TABLE _service_accounts (
  principal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  display_name TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX idx_service_accounts_name ON _service_accounts(project_id, name) WHERE revoked_at IS NULL;
CREATE TABLE _credentials (
  credential_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  name TEXT NOT NULL, note TEXT, policy_json TEXT NOT NULL, current_token_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL, revoked_at INTEGER, revoked_by TEXT,
  workload_binding_id TEXT
);
CREATE UNIQUE INDEX idx_credentials_name ON _credentials(project_id, name) WHERE revoked_at IS NULL;
CREATE INDEX idx_credentials_principal ON _credentials(project_id, principal_id);
CREATE TABLE _credential_versions (
  token_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL,
  expires_at INTEGER, retire_at INTEGER
);
CREATE INDEX idx_credential_versions_credential ON _credential_versions(credential_id);
CREATE TABLE _workload_bindings (
  binding_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  name TEXT NOT NULL, provider TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  policy_json TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, revoked_at INTEGER
);
CREATE UNIQUE INDEX idx_workload_binding_subject ON _workload_bindings(project_id, provider, issuer, subject);
CREATE TABLE _credential_events (
  event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, actor_principal_id TEXT NOT NULL,
  actor_token_id TEXT, target_id TEXT NOT NULL, action TEXT NOT NULL, occurred_at INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_credential_events_project ON _credential_events(project_id, occurred_at);

-- Scoped versions use opaque internal names; logical names remain unique with
-- the legacy API even when old and new issuance requests race.
CREATE TRIGGER credentials_legacy_name BEFORE INSERT ON _credentials
WHEN EXISTS (SELECT 1 FROM _tokens WHERE project_id = NEW.project_id AND name = NEW.name AND revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: credential name'); END;
CREATE TRIGGER tokens_credential_name BEFORE INSERT ON _tokens
WHEN EXISTS (SELECT 1 FROM _credentials WHERE project_id = NEW.project_id AND name = NEW.name AND revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: credential name'); END;

-- Workload assertions remain consumed after revocation.
CREATE UNIQUE INDEX _workload_exchange_once ON _credentials(project_id, workload_binding_id, name) WHERE workload_binding_id IS NOT NULL;
