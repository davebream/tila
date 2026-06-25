-- Stable per-deployment identity singleton (epic #122, issue #128).
-- One row, enforced by CHECK (id = 1). Seeded by CLI provision (C7) and
-- backfilled idempotently by the runtime accessor (C2) on first use.
CREATE TABLE IF NOT EXISTS _deployment_meta (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
