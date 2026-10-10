ALTER TABLE _runtime_runs ADD COLUMN agent_id TEXT;
ALTER TABLE _runtime_runs ADD COLUMN run_role TEXT NOT NULL DEFAULT 'acting'
  CHECK (run_role IN ('acting', 'relay'));
CREATE INDEX _runtime_runs_agent ON _runtime_runs(project_id, agent_id);
