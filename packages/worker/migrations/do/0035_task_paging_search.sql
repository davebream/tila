-- #300: deterministic keyset paging for task lists, and task ids in search.
CREATE INDEX IF NOT EXISTS idx_entities_created_id ON entities(created_at, id);
CREATE INDEX IF NOT EXISTS idx_entities_updated_id ON entities(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_entities_type_id ON entities(type, id);

DROP TRIGGER IF EXISTS esd_ai;
DROP TRIGGER IF EXISTS esd_au;
DROP TRIGGER IF EXISTS esd_ad;
DROP TABLE IF EXISTS entity_search_docs_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS entity_search_docs_fts USING fts5(
  name,
  entity_id,
  content=entity_search_docs,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS esd_ai AFTER INSERT ON entity_search_docs BEGIN
  INSERT INTO entity_search_docs_fts(rowid, name, entity_id)
  VALUES (new.rowid, new.name, new.entity_id);
END;

CREATE TRIGGER IF NOT EXISTS esd_au AFTER UPDATE ON entity_search_docs BEGIN
  INSERT INTO entity_search_docs_fts(entity_search_docs_fts, rowid, name, entity_id)
  VALUES ('delete', old.rowid, old.name, old.entity_id);
  INSERT INTO entity_search_docs_fts(rowid, name, entity_id)
  VALUES (new.rowid, new.name, new.entity_id);
END;

CREATE TRIGGER IF NOT EXISTS esd_ad AFTER DELETE ON entity_search_docs BEGIN
  INSERT INTO entity_search_docs_fts(entity_search_docs_fts, rowid, name, entity_id)
  VALUES ('delete', old.rowid, old.name, old.entity_id);
END;

INSERT INTO entity_search_docs_fts(entity_search_docs_fts) VALUES ('rebuild');
