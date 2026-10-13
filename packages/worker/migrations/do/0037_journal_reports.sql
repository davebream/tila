CREATE TABLE IF NOT EXISTS journal_report_receipts (
  key TEXT PRIMARY KEY, project_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  participant_id TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_report_receipts_expiry ON journal_report_receipts(expires_at);
CREATE TABLE IF NOT EXISTS journal_report_rates (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_journal_report_rates_window ON journal_report_rates(window_start);
CREATE INDEX IF NOT EXISTS idx_journal_custom_name ON journal(json_extract(data, '$.event_name'), seq) WHERE kind = 'custom.reported';
CREATE INDEX IF NOT EXISTS idx_journal_custom_correlation ON journal(json_extract(data, '$.correlation_id'), seq) WHERE kind = 'custom.reported';
