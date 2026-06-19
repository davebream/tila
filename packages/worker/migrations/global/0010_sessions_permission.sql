-- Add normalized permission column to _sessions.
-- SQLite's ADD COLUMN with a constant NOT NULL DEFAULT backfills all existing
-- rows to 'read' at migration time, so no NULLs can appear on the NOT NULL column.
-- Default 'read' is intentional: legacy sessions fail closed to least privilege
-- rather than accidentally granting admin.
ALTER TABLE _sessions ADD COLUMN permission TEXT NOT NULL DEFAULT 'read';
