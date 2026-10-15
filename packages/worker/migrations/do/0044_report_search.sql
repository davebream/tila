CREATE TABLE IF NOT EXISTS report_search_docs (
  seq INTEGER PRIMARY KEY, t INTEGER NOT NULL, resource TEXT NOT NULL,
  principal_id TEXT NOT NULL, event_name TEXT NOT NULL, correlation_id TEXT,
  corrects_seq INTEGER, body_text TEXT NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS report_search_docs_fts USING fts5(
  event_name, correlation_id, body_text, content=report_search_docs, content_rowid=seq
);
CREATE TRIGGER IF NOT EXISTS report_search_ai AFTER INSERT ON report_search_docs BEGIN
  INSERT INTO report_search_docs_fts(rowid, event_name, correlation_id, body_text)
  VALUES (new.seq, new.event_name, new.correlation_id, new.body_text);
END;
CREATE TRIGGER IF NOT EXISTS report_search_ad AFTER DELETE ON report_search_docs BEGIN
  INSERT INTO report_search_docs_fts(report_search_docs_fts, rowid, event_name, correlation_id, body_text)
  VALUES ('delete', old.seq, old.event_name, old.correlation_id, old.body_text);
END;
CREATE TRIGGER IF NOT EXISTS report_search_au AFTER UPDATE ON report_search_docs BEGIN
  INSERT INTO report_search_docs_fts(report_search_docs_fts, rowid, event_name, correlation_id, body_text)
  VALUES ('delete', old.seq, old.event_name, old.correlation_id, old.body_text);
  INSERT INTO report_search_docs_fts(rowid, event_name, correlation_id, body_text)
  VALUES (new.seq, new.event_name, new.correlation_id, new.body_text);
END;
CREATE TABLE IF NOT EXISTS report_search_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
  indexed_through_seq INTEGER NOT NULL CHECK(indexed_through_seq >= 0),
  target_through_seq INTEGER NOT NULL CHECK(target_through_seq >= indexed_through_seq),
  generation TEXT NOT NULL, error TEXT
);
CREATE TRIGGER IF NOT EXISTS transfer_guard_report_search_docs_insert
BEFORE INSERT ON report_search_docs
WHEN EXISTS (SELECT 1 FROM _project_transfer_state WHERE singleton = 1 AND applying = 0
AND (expires_at IS NULL OR expires_at > (unixepoch('subsec') * 1000)))
BEGIN SELECT RAISE(ABORT, 'project-maintenance'); END;
CREATE TRIGGER IF NOT EXISTS transfer_guard_report_search_docs_update
BEFORE UPDATE ON report_search_docs
WHEN EXISTS (SELECT 1 FROM _project_transfer_state WHERE singleton = 1 AND applying = 0
AND (expires_at IS NULL OR expires_at > (unixepoch('subsec') * 1000)))
BEGIN SELECT RAISE(ABORT, 'project-maintenance'); END;
CREATE TRIGGER IF NOT EXISTS transfer_guard_report_search_docs_delete
BEFORE DELETE ON report_search_docs
WHEN EXISTS (SELECT 1 FROM _project_transfer_state WHERE singleton = 1 AND applying = 0
AND (expires_at IS NULL OR expires_at > (unixepoch('subsec') * 1000)))
BEGIN SELECT RAISE(ABORT, 'project-maintenance'); END;
CREATE TRIGGER IF NOT EXISTS transfer_guard_report_search_state_insert
BEFORE INSERT ON report_search_state
WHEN EXISTS (SELECT 1 FROM _project_transfer_state WHERE singleton = 1 AND applying = 0
AND (expires_at IS NULL OR expires_at > (unixepoch('subsec') * 1000)))
BEGIN SELECT RAISE(ABORT, 'project-maintenance'); END;
CREATE TRIGGER IF NOT EXISTS transfer_guard_report_search_state_update
BEFORE UPDATE ON report_search_state
WHEN EXISTS (SELECT 1 FROM _project_transfer_state WHERE singleton = 1 AND applying = 0
AND (expires_at IS NULL OR expires_at > (unixepoch('subsec') * 1000)))
BEGIN SELECT RAISE(ABORT, 'project-maintenance'); END;
CREATE TRIGGER IF NOT EXISTS transfer_guard_report_search_state_delete
BEFORE DELETE ON report_search_state
WHEN EXISTS (SELECT 1 FROM _project_transfer_state WHERE singleton = 1 AND applying = 0
AND (expires_at IS NULL OR expires_at > (unixepoch('subsec') * 1000)))
BEGIN SELECT RAISE(ABORT, 'project-maintenance'); END;
