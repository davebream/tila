-- GitHub Actions OIDC repository policy hardening (issue #182).
-- Every existing repository link is explicitly disabled and deprivileged.
-- Operators must configure a complete policy before Actions may exchange tokens.
ALTER TABLE _project_repos ADD COLUMN oidc_enabled INTEGER NOT NULL DEFAULT 0 CHECK (oidc_enabled IN (0, 1));
ALTER TABLE _project_repos ADD COLUMN oidc_max_permission TEXT NOT NULL DEFAULT 'read' CHECK (oidc_max_permission IN ('read', 'write', 'admin'));
ALTER TABLE _project_repos ADD COLUMN oidc_subject_pattern TEXT;
ALTER TABLE _project_repos ADD COLUMN oidc_allowed_events TEXT NOT NULL DEFAULT '[]';
ALTER TABLE _project_repos ADD COLUMN oidc_allowed_refs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE _project_repos ADD COLUMN oidc_allowed_environments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE _project_repos ADD COLUMN oidc_allowed_workflows TEXT NOT NULL DEFAULT '[]';

UPDATE _project_repos
SET oidc_enabled = 0,
    oidc_max_permission = 'read',
    oidc_subject_pattern = NULL,
    oidc_allowed_events = '[]',
    oidc_allowed_refs = '[]',
    oidc_allowed_environments = '[]',
    oidc_allowed_workflows = '[]';
