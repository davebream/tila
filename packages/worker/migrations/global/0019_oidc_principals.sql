-- Generic OIDC principal allowlist (WI-B2, issue #125, epic #122).
-- Non-GitHub analog of _project_repos: authorizes a specific (issuer, subject)
-- pair for a project to exchange an OIDC token for a tila session. `subject`
-- is the upstream `sub` claim (TEXT, opaque, locally unique to the issuer).
-- `permission` defaults to 'read' (least privilege; cf. _project_repos which
-- defaults oidc_permission to 'write'). Time columns are Unix seconds.
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
