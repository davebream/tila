CREATE TABLE IF NOT EXISTS attempt_corrections (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES work_attempts(id),
  task_id TEXT NOT NULL REFERENCES entities(id),
  reason TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(attempt_id, task_id)
);
CREATE INDEX IF NOT EXISTS attempt_corrections_task ON attempt_corrections(task_id, created_at);
CREATE TRIGGER IF NOT EXISTS attempt_corrections_append_only
BEFORE UPDATE ON attempt_corrections
BEGIN
  SELECT RAISE(ABORT, 'attempt-correction-immutable');
END;
CREATE TRIGGER IF NOT EXISTS work_attempts_terminal_immutable
BEFORE UPDATE ON work_attempts
WHEN OLD.state = 'terminal' AND (
  NEW.state IS NOT OLD.state OR
  NEW.outcome IS NOT OLD.outcome OR
  NEW.finished_at IS NOT OLD.finished_at
)
BEGIN
  SELECT RAISE(ABORT, 'attempt-terminal-immutable');
END;
