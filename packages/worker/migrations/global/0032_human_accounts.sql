-- Preserve existing membership identities while admitting native users.
CREATE TABLE _project_memberships_new (
  membership_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'oidc', 'service', 'user')),
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

CREATE TABLE _human_users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
 disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE _human_sessions (
 id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES _human_users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 ip_address TEXT, user_agent TEXT, authenticated_at INTEGER, device INTEGER NOT NULL DEFAULT 0,
 device_name TEXT, parent_session_id TEXT, project_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_human_sessions_user ON _human_sessions(user_id);
CREATE INDEX idx_human_sessions_parent ON _human_sessions(parent_session_id);
CREATE TABLE _human_accounts (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES _human_users(id) ON DELETE CASCADE,
 access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER,
 refresh_token_expires_at INTEGER, scope TEXT, password TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(provider_id,account_id)
);
CREATE TABLE _human_verifications (
 id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_human_verification_identifier ON _human_verifications(identifier);
CREATE TABLE _human_device_codes (
 id TEXT PRIMARY KEY, device_code TEXT NOT NULL UNIQUE, user_code TEXT NOT NULL UNIQUE,
 user_id TEXT, expires_at INTEGER NOT NULL, status TEXT NOT NULL, last_polled_at INTEGER,
 polling_interval INTEGER, client_id TEXT, scope TEXT, authenticated_at INTEGER
);
CREATE TABLE _human_rate_limits (
 id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, last_request INTEGER NOT NULL
);
CREATE TABLE _human_invitations (
 hash TEXT PRIMARY KEY, email TEXT NOT NULL, role TEXT NOT NULL,
 project_id TEXT, project_role TEXT NOT NULL, created_by TEXT NOT NULL,
 expires_at INTEGER NOT NULL, accepted_user_id TEXT
);
CREATE TABLE _human_handoffs (
 hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE _human_recoveries (
 hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, claim TEXT
);
