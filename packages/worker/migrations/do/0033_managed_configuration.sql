ALTER TABLE queue_policy ADD COLUMN revision_required INTEGER NOT NULL DEFAULT 0 CHECK(revision_required IN (0,1));
UPDATE queue_policy SET revision_required = 1 WHERE enabled = 1;
