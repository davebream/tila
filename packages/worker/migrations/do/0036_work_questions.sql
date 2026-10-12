CREATE TABLE IF NOT EXISTS work_questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES entities(id),
  attempt_id TEXT NOT NULL REFERENCES work_attempts(id),
  requester_principal_id TEXT NOT NULL,
  responder_principal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','answered','cancelled','superseded')),
  snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_questions_task ON work_questions(task_id, state, id);
CREATE INDEX IF NOT EXISTS work_questions_requester ON work_questions(requester_principal_id, state, id);
CREATE INDEX IF NOT EXISTS work_questions_attempt ON work_questions(attempt_id, state, id);
CREATE INDEX IF NOT EXISTS work_questions_responder ON work_questions(responder_principal_id, state, id);
CREATE TABLE IF NOT EXISTS question_receipts (
  key TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  question_id TEXT NOT NULL REFERENCES work_questions(id),
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
