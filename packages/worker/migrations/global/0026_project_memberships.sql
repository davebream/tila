-- Canonical project membership policy (issue #184).

ALTER TABLE _projects
  ADD COLUMN membership_mode TEXT NOT NULL DEFAULT 'explicit'
  CHECK (membership_mode IN ('explicit', 'github-mirrored', 'hybrid', 'service-only'));

-- Preserve existing repository-derived admission. Fresh projects and fresh
-- links retain the fail-closed defaults from the Drizzle schema.
UPDATE _projects SET membership_mode = 'hybrid';

ALTER TABLE _project_repos
  ADD COLUMN membership_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (membership_enabled IN (0, 1));
ALTER TABLE _project_repos
  ADD COLUMN membership_role_cap TEXT NOT NULL DEFAULT 'participant'
  CHECK (membership_role_cap IN ('viewer', 'participant', 'maintainer'));

UPDATE _project_repos
SET membership_enabled = CASE WHEN enabled = 1 THEN 1 ELSE 0 END,
    membership_role_cap = CASE max_permission
      WHEN 'read' THEN 'viewer'
      WHEN 'admin' THEN 'maintainer'
      ELSE 'participant'
    END;

ALTER TABLE _sessions ADD COLUMN role TEXT;
ALTER TABLE _sessions ADD COLUMN membership_source TEXT;
ALTER TABLE _sessions ADD COLUMN source_repo_id INTEGER;

-- Existing browser sessions do not carry enough adapter provenance to apply
-- current membership policy. Bearer sessions remain verifiable and are checked
-- by the new request-time resolver.
DELETE FROM _sessions WHERE project_id <> '' AND token_hash = '';

CREATE TABLE _project_memberships (
  membership_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'oidc')),
  identity_host TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('human', 'service')),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'participant', 'maintainer', 'owner')),
  display_name TEXT,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_by TEXT,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX idx_project_memberships_active
  ON _project_memberships(project_id, principal_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_project_memberships_project
  ON _project_memberships(project_id);

CREATE TABLE _membership_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  principal_id TEXT,
  actor_principal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  source TEXT NOT NULL,
  role TEXT,
  github_repo_id INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_membership_events_project_time
  ON _membership_events(project_id, occurred_at DESC, event_id DESC);

-- Active GitHub administrators become explicit owners. Legacy rows remain as
-- immutable history and are no longer consulted by authorization.
INSERT INTO _project_memberships (
  membership_id, project_id, principal_id, provider, identity_host, subject_id,
  subject_kind, role, display_name, granted_by, granted_at
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  project_id,
  'github:' || identity_host || ':' || subject_id,
  'github', identity_host, subject_id, 'human', 'owner', github_login_snapshot,
  CASE WHEN granted_by_user_id IS NULL THEN 'bootstrap:migration'
       ELSE 'github:github.com:' || CAST(granted_by_user_id AS TEXT) END,
  granted_at
FROM _admin_grants
WHERE revoked_at IS NULL;

-- The old generic OIDC allowlist represented workload identities. Convert it
-- to explicit service membership while retaining the old table for history.
INSERT OR IGNORE INTO _project_memberships (
  membership_id, project_id, principal_id, provider, identity_host, subject_id,
  subject_kind, role, display_name, granted_by, granted_at
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  project_id,
  'oidc:' || rtrim(lower(issuer), '/') || ':' || subject,
  'oidc', rtrim(lower(issuer), '/'), subject, 'service',
  CASE permission WHEN 'admin' THEN 'maintainer'
                  WHEN 'write' THEN 'participant' ELSE 'viewer' END,
  subject, created_by, created_at
FROM _oidc_principals
WHERE enabled = 1;

INSERT INTO _membership_events (
  event_id, project_id, principal_id, actor_principal_id, action, source, role,
  details_json, occurred_at
)
SELECT
  lower(hex(randomblob(16))), project_id, principal_id, granted_by,
  'grant', 'explicit', role, '{"migrated":true}', granted_at
FROM _project_memberships;
