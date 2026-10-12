CREATE TABLE IF NOT EXISTS queue_policy (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  paused INTEGER NOT NULL DEFAULT 1 CHECK(paused IN (0,1)),
  execution_limit INTEGER CHECK(execution_limit > 0),
  wip_limit INTEGER CHECK(wip_limit > 0),
  lease_ms INTEGER NOT NULL DEFAULT 60000 CHECK(lease_ms BETWEEN 1000 AND 86400000),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  CHECK(enabled = 0 OR execution_limit IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS queue_entries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES entities(id),
  state TEXT NOT NULL CHECK(state IN ('queued','admitted','finished','withdrawn')),
  priority INTEGER NOT NULL DEFAULT 0,
  enqueue_order INTEGER NOT NULL,
  required_capabilities TEXT NOT NULL,
  target_principal TEXT,
  retry_policy TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS queue_entries_unfinished_task ON queue_entries(task_id) WHERE state IN ('queued','admitted');
CREATE INDEX IF NOT EXISTS queue_entries_order ON queue_entries(priority, enqueue_order, id);
CREATE TABLE IF NOT EXISTS work_attempts (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES queue_entries(id),
  task_id TEXT NOT NULL REFERENCES entities(id),
  resource TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','starting','running','suspended','resume_pending','uncertain','terminal')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  fence INTEGER NOT NULL CHECK(fence > 0),
  lease_expires_at INTEGER,
  accepted_at INTEGER,
  session TEXT,
  checkpoint TEXT,
  cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancellation_requested IN (0,1)),
  suspension_requested INTEGER NOT NULL DEFAULT 0 CHECK(suspension_requested IN (0,1)),
  predecessor_id TEXT REFERENCES work_attempts(id),
  outcome TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  CHECK((state = 'terminal') = (outcome IS NOT NULL)),
  CHECK((state = 'terminal') = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS work_attempts_nonterminal_task ON work_attempts(task_id) WHERE state != 'terminal';
CREATE INDEX IF NOT EXISTS work_attempts_entry ON work_attempts(entry_id, created_at);
CREATE INDEX IF NOT EXISTS work_attempts_expiry ON work_attempts(state, lease_expires_at);
CREATE TABLE IF NOT EXISTS execution_reservations (
  task_id TEXT PRIMARY KEY REFERENCES entities(id),
  entry_id TEXT NOT NULL REFERENCES queue_entries(id),
  attempt_id TEXT NOT NULL REFERENCES work_attempts(id),
  execution_held INTEGER NOT NULL CHECK(execution_held IN (0,1)),
  wip_held INTEGER NOT NULL CHECK(wip_held IN (0,1)),
  updated_at INTEGER NOT NULL,
  CHECK(execution_held = 0 OR wip_held = 1)
);
CREATE TABLE IF NOT EXISTS queue_operation_receipts (
  key TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  result TEXT NOT NULL,
  entry_id TEXT REFERENCES queue_entries(id),
  attempt_id TEXT REFERENCES work_attempts(id),
  created_at INTEGER NOT NULL
);
