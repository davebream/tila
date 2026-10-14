ALTER TABLE _service_accounts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision >= 1 AND revision <= 9007199254740991);
ALTER TABLE _workload_bindings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision >= 1 AND revision <= 9007199254740991);

-- Retain the destination's revision history outside metadata backups.
INSERT INTO _project_settings_revision_watermarks (project_id, revision)
SELECT project_id, MAX(revision) FROM (
  SELECT project_id, revision FROM _service_accounts
  UNION ALL
  SELECT project_id, revision FROM _workload_bindings
) GROUP BY project_id
ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision
WHERE excluded.revision > _project_settings_revision_watermarks.revision;

CREATE TRIGGER service_identity_revision_insert AFTER INSERT ON _service_accounts
BEGIN
  INSERT INTO _project_settings_revision_watermarks (project_id, revision)
  VALUES (NEW.project_id, NEW.revision)
  ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision
  WHERE excluded.revision > _project_settings_revision_watermarks.revision;
END;

CREATE TRIGGER service_identity_revision_update AFTER UPDATE OF revision ON _service_accounts
BEGIN
  INSERT INTO _project_settings_revision_watermarks (project_id, revision)
  VALUES (NEW.project_id, NEW.revision)
  ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision
  WHERE excluded.revision > _project_settings_revision_watermarks.revision;
END;

CREATE TRIGGER workload_binding_revision_insert AFTER INSERT ON _workload_bindings
BEGIN
  INSERT INTO _project_settings_revision_watermarks (project_id, revision)
  VALUES (NEW.project_id, NEW.revision)
  ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision
  WHERE excluded.revision > _project_settings_revision_watermarks.revision;
END;

CREATE TRIGGER workload_binding_revision_update AFTER UPDATE OF revision ON _workload_bindings
BEGIN
  INSERT INTO _project_settings_revision_watermarks (project_id, revision)
  VALUES (NEW.project_id, NEW.revision)
  ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision
  WHERE excluded.revision > _project_settings_revision_watermarks.revision;
END;
