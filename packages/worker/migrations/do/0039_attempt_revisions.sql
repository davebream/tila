ALTER TABLE work_attempts ADD COLUMN revisions TEXT;
CREATE INDEX IF NOT EXISTS work_attempts_owner ON work_attempts(principal_id, participant_id, state);
