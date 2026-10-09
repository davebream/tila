CREATE TABLE _runtime_enrollments (
  enrollment_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  principal_id TEXT NOT NULL UNIQUE, sponsor_id TEXT, sponsor_context_json TEXT,
  invitation_hash TEXT UNIQUE, jkt TEXT NOT NULL, policy_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER,
  CHECK (kind IN ('personal', 'shared')),
  CHECK ((kind = 'personal' AND sponsor_id IS NOT NULL) OR (kind = 'shared' AND sponsor_id IS NULL))
);
CREATE INDEX _runtime_enrollments_project ON _runtime_enrollments(project_id, sponsor_id);
CREATE TABLE _runtime_invitations (
  invitation_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  policy_json TEXT NOT NULL, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE _runtime_runs (
  run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, enrollment_id TEXT,
  workload_binding_id TEXT, workload_context_json TEXT,
  principal_id TEXT NOT NULL, participant_id TEXT NOT NULL UNIQUE, jkt TEXT NOT NULL,
  policy_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active',
  lease_expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, current_token_id TEXT NOT NULL,
  CHECK (state IN ('active', 'closed', 'revoked')),
  CHECK ((enrollment_id IS NULL) != (workload_binding_id IS NULL))
);
CREATE INDEX _runtime_runs_project ON _runtime_runs(project_id, enrollment_id);
CREATE TABLE _runtime_credentials (
  token_id TEXT PRIMARY KEY, predecessor_id TEXT UNIQUE, purpose TEXT NOT NULL, enrollment_id TEXT, run_id TEXT,
  expires_at INTEGER, retire_at INTEGER,
  CHECK (purpose IN ('enrollment', 'run')),
  CHECK ((purpose = 'enrollment' AND enrollment_id IS NOT NULL AND run_id IS NULL)
      OR (purpose = 'run' AND run_id IS NOT NULL))
);

CREATE TABLE _runtime_assertions (
  assertion_hash TEXT PRIMARY KEY, binding_id TEXT NOT NULL,
  run_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE _runtime_proofs (
  proof_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
);
CREATE INDEX _runtime_proofs_expiry ON _runtime_proofs(expires_at);
