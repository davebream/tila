-- DO SQLite search schema migration
-- Applied via blockConcurrencyWhile; idempotent (IF NOT EXISTS guards on all statements)
-- IMPORTANT: Keep in sync with MIGRATION_0003 in src/migrations-sql.ts

CREATE TABLE IF NOT EXISTS artifact_search_docs (
  artifact_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  resource TEXT,
  title TEXT,
  body_text TEXT,
  indexed_at INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (artifact_key) REFERENCES artifact_pointers(r2_key)
);

CREATE INDEX IF NOT EXISTS idx_asd_kind ON artifact_search_docs(kind);
CREATE INDEX IF NOT EXISTS idx_asd_resource ON artifact_search_docs(resource);
CREATE INDEX IF NOT EXISTS idx_asd_tombstoned ON artifact_search_docs(tombstoned);
CREATE INDEX IF NOT EXISTS idx_asd_indexed_at ON artifact_search_docs(indexed_at);

CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search_docs_fts USING fts5(
  title,
  body_text,
  content=artifact_search_docs,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS asd_ai AFTER INSERT ON artifact_search_docs BEGIN
  INSERT INTO artifact_search_docs_fts(rowid, title, body_text)
  VALUES (new.rowid, new.title, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS asd_au AFTER UPDATE ON artifact_search_docs BEGIN
  INSERT INTO artifact_search_docs_fts(artifact_search_docs_fts, rowid, title, body_text)
  VALUES ('delete', old.rowid, old.title, old.body_text);
  INSERT INTO artifact_search_docs_fts(rowid, title, body_text)
  VALUES (new.rowid, new.title, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS asd_ad AFTER DELETE ON artifact_search_docs BEGIN
  INSERT INTO artifact_search_docs_fts(artifact_search_docs_fts, rowid, title, body_text)
  VALUES ('delete', old.rowid, old.title, old.body_text);
END;
