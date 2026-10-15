ALTER TABLE _project_transfer_state ADD COLUMN recovery_context TEXT;
CREATE TABLE IF NOT EXISTS _project_recovery_receipts (
  operation_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  archive_digest TEXT NOT NULL,
  context TEXT NOT NULL,
  completed_at INTEGER NOT NULL
);
