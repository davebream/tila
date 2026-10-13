ALTER TABLE agents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE rooms ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE signal_groups ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE agents ADD COLUMN profile_selection TEXT;
CREATE TABLE IF NOT EXISTS _config_revision_seq (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO _config_revision_seq (singleton, value) VALUES (1, 1);
