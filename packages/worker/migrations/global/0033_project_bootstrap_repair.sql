-- Repair project-create writes made after the original one-time backfills (#360).
-- Existing credentials retain their digest, permissions and revocation state.
UPDATE _tokens SET token_id = lower(hex(randomblob(16))) WHERE token_id IS NULL;

-- Recover only unambiguous bootstrap seeds. The legacy roster is immutable
-- history: a canonical grant, event or subject revocation always takes priority.
-- In particular, never revive a revoked owner or overwrite a demotion.
INSERT OR IGNORE INTO _project_memberships (
  membership_id, project_id, principal_id, provider, identity_host, subject_id,
  subject_kind, role, display_name, granted_by, granted_at
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  a.project_id, 'github:github.com:' || CAST(a.github_user_id AS TEXT),
  'github', 'github.com', CAST(a.github_user_id AS TEXT), 'human', 'owner',
  a.github_login_snapshot, 'bootstrap:repair-360', a.granted_at * 1000
FROM _admin_grants AS a
JOIN _projects AS p ON p.project_id = a.project_id AND p.archived = 0
WHERE a.revoked_at IS NULL
  AND a.granted_by_user_id IS NULL
  AND lower(trim(a.github_host)) = 'github.com'
  AND lower(trim(a.identity_host)) = 'github.com'
  AND typeof(a.github_user_id) = 'integer' AND a.github_user_id > 0
  AND (a.subject_id = '' OR a.subject_id = CAST(a.github_user_id AS TEXT))
  AND NOT EXISTS (
    SELECT 1 FROM _project_memberships AS m
    WHERE m.project_id = a.project_id
      AND m.principal_id = 'github:github.com:' || CAST(a.github_user_id AS TEXT)
  )
  AND NOT EXISTS (
    SELECT 1 FROM _membership_events AS e
    WHERE e.project_id = a.project_id
      AND e.principal_id = 'github:github.com:' || CAST(a.github_user_id AS TEXT)
  )
  AND NOT EXISTS (
    SELECT 1 FROM _revoked_subjects AS r
    WHERE r.project_id = a.project_id AND r.identity_host = 'github.com'
      AND r.subject_id = CAST(a.github_user_id AS TEXT)
  )
  AND NOT EXISTS (
    SELECT 1 FROM _project_memberships AS m
    WHERE m.project_id = a.project_id AND m.provider = 'github'
      AND (
        m.identity_host = '' OR m.identity_host <> lower(trim(m.identity_host))
        OR CAST(m.subject_id AS INTEGER) <= 0
        OR m.subject_id <> CAST(CAST(m.subject_id AS INTEGER) AS TEXT)
        OR m.principal_id <> 'github:' || m.identity_host || ':' || m.subject_id
      )
  );

-- The membership's persisted UUID is also the repair event's stable UUID.
-- The CLI migration runner executes statements separately: if it stops after
-- the grant, replay completes the audit event without granting again.
INSERT OR IGNORE INTO _membership_events (
  event_id, project_id, principal_id, actor_principal_id, action, source, role,
  details_json, occurred_at
)
SELECT membership_id, project_id, principal_id, granted_by,
  'grant', 'explicit', 'owner', '{"repair":"project-bootstrap-360"}', granted_at
FROM _project_memberships
WHERE granted_by = 'bootstrap:repair-360';
