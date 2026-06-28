-- WI-B2: generic OIDC principal allowlist (issue #125, epic #122)
-- Non-GitHub analog of _project_repos: authorizes (project_id, issuer, subject) triples.
-- created_at is Unix seconds (not ms) — matching _project_repos / _admin_grants convention.
-- permission defaults to 'read' (least privilege, unlike _project_repos.oidc_permission='write').
CREATE TABLE IF NOT EXISTS _oidc_principals (
  project_id  TEXT    NOT NULL,
  issuer      TEXT    NOT NULL,
  subject     TEXT    NOT NULL,
  permission  TEXT    NOT NULL DEFAULT 'read',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  created_by  TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oidc_principals_lookup
  ON _oidc_principals (project_id, issuer, subject);
