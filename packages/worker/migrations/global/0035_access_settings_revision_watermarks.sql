-- Keep revision history outside the project backup, including deleted links.
-- This table intentionally has no cascading project foreign key.
CREATE TABLE _project_settings_revision_watermarks (
  project_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991)
);

INSERT INTO _project_settings_revision_watermarks (project_id, revision)
SELECT project_id, MAX(revision) FROM (
  SELECT project_id, settings_revision AS revision FROM _projects
  UNION ALL
  SELECT project_id, access_policy_revision AS revision FROM _project_repos
  UNION ALL
  SELECT project_id, oidc_policy_revision AS revision FROM _project_repos
) GROUP BY project_id;

CREATE TRIGGER project_settings_revision_insert AFTER INSERT ON _projects
BEGIN
  INSERT INTO _project_settings_revision_watermarks (project_id, revision)
  VALUES (NEW.project_id, NEW.settings_revision)
  ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision
  WHERE excluded.revision > _project_settings_revision_watermarks.revision;
END;

CREATE TRIGGER project_settings_revision_update AFTER UPDATE OF settings_revision ON _projects
BEGIN
  INSERT INTO _project_settings_revision_watermarks (project_id, revision)
  VALUES (NEW.project_id, NEW.settings_revision)
  ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision
  WHERE excluded.revision > _project_settings_revision_watermarks.revision;
END;

CREATE TRIGGER repo_settings_revision_insert AFTER INSERT ON _project_repos
BEGIN
  INSERT INTO _project_settings_revision_watermarks (project_id, revision)
  VALUES (NEW.project_id, MAX(NEW.access_policy_revision, NEW.oidc_policy_revision))
  ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision
  WHERE excluded.revision > _project_settings_revision_watermarks.revision;
END;

CREATE TRIGGER repo_settings_revision_update AFTER UPDATE OF access_policy_revision, oidc_policy_revision ON _project_repos
BEGIN
  INSERT INTO _project_settings_revision_watermarks (project_id, revision)
  VALUES (NEW.project_id, MAX(NEW.access_policy_revision, NEW.oidc_policy_revision))
  ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision
  WHERE excluded.revision > _project_settings_revision_watermarks.revision;
END;
