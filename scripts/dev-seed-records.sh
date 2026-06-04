#!/usr/bin/env bash
set -euo pipefail

API="http://localhost:8787"
TOKEN="tila_dev_token_localonly"
PROJECT="dev-project"
BASE="$API/projects/$PROJECT"

auth() {
  curl -s -H "Authorization: Bearer $TOKEN" "$@"
}

post_json() {
  local path="$1"; shift
  auth -X POST "$BASE$path" -H "Content-Type: application/json" -d "$@"
}

put_json() {
  local path="$1"; shift
  auth -X PUT "$BASE$path" -H "Content-Type: application/json" -d "$@"
}

echo "=== Seeding records with realistic data ==="
echo ""

# --- Step 1: Apply schema with record types ---
echo "→ Applying schema with record types"

SCHEMA_TOML='schema_version = 1

[work_units.task]
fields = [
  { name = "title",       required = true,  type = "string" },
  { name = "description", required = false, type = "text" },
  { name = "status",      required = true,  type = "enum",
    values = ["open", "in_progress", "blocked", "done", "cancelled"] },
]
parents = []

[records.session]
format = "json"
history = "revision"
key_description = "Machine session identifier (e.g. sess-a8f3)"

[records.agent-config]
format = "json"
history = "revision"
key_description = "Agent configuration profile name"

[records.checkpoint]
format = "json"
history = "revision"
key_description = "Task checkpoint identifier"

[records.deployment]
format = "json"
history = "revision"
key_description = "Deployment identifier (e.g. deploy-20260528-01)"

[records.incident]
format = "json"
history = "revision"
key_description = "Incident tracking identifier"
'

RESULT=$(post_json /schema "{\"definition\": $(python3 -c "import json; print(json.dumps('''$SCHEMA_TOML'''))")}" 2>&1)
echo "  Schema applied: $RESULT" | head -1

# --- Step 2: Create session records ---
echo "→ Creating session records"

post_json /records/session '{
  "key": "sess-a8f3",
  "value": {
    "machine": "m1-macbook-pro",
    "agent": "claude-code/1.0.42",
    "os": "darwin",
    "arch": "arm64",
    "started_at": 1748390400,
    "working_on": "task.auth-middleware",
    "files_modified": ["src/middleware/auth.ts", "src/middleware/auth.test.ts", "src/types.ts"],
    "commits": 3,
    "status": "active"
  },
  "tags": ["active", "m1"]
}' > /dev/null

post_json /records/session '{
  "key": "sess-b2e1",
  "value": {
    "machine": "m2-linux-workstation",
    "agent": "claude-code/1.0.42",
    "os": "linux",
    "arch": "x86_64",
    "started_at": 1748386800,
    "working_on": "task.integration-tests",
    "files_modified": ["test/integration/auth.test.ts", "test/helpers.ts"],
    "commits": 7,
    "status": "active"
  },
  "tags": ["active", "m2"]
}' > /dev/null

post_json /records/session '{
  "key": "sess-c7d4",
  "value": {
    "machine": "m3-github-actions",
    "agent": "claude-code/1.0.41",
    "os": "linux",
    "arch": "x86_64",
    "started_at": 1748380200,
    "working_on": "task.ci-pipeline",
    "files_modified": [".github/workflows/ci.yml"],
    "commits": 1,
    "status": "completed"
  },
  "tags": ["completed", "ci"]
}' > /dev/null

post_json /records/session '{
  "key": "sess-d1f7",
  "value": {
    "machine": "m1-macbook-pro",
    "agent": "claude-code/1.0.40",
    "os": "darwin",
    "arch": "arm64",
    "started_at": 1748293800,
    "working_on": "task.db-migrations",
    "files_modified": ["migrations/001_users.sql", "migrations/002_sessions.sql"],
    "commits": 4,
    "status": "completed"
  },
  "tags": ["completed", "m1"]
}' > /dev/null

post_json /records/session '{
  "key": "sess-e3a2",
  "value": {
    "machine": "m2-linux-workstation",
    "agent": "claude-code/1.0.42",
    "os": "linux",
    "arch": "x86_64",
    "started_at": 1748340600,
    "working_on": "task.api-routes",
    "files_modified": ["src/routes/users.ts", "src/routes/sessions.ts", "src/routes/index.ts"],
    "commits": 12,
    "status": "completed"
  },
  "tags": ["completed", "m2"]
}' > /dev/null

echo "  5 session records created"

# --- Step 3: Create agent-config records ---
echo "→ Creating agent-config records"

post_json /records/agent-config '{
  "key": "default",
  "value": {
    "model": "claude-sonnet-4-6",
    "max_tokens": 8192,
    "temperature": 0.3,
    "tools": ["read", "write", "bash", "grep"],
    "auto_commit": true,
    "review_before_push": true,
    "max_retries": 3
  },
  "tags": ["production"]
}' > /dev/null

post_json /records/agent-config '{
  "key": "research",
  "value": {
    "model": "claude-opus-4-6",
    "max_tokens": 16384,
    "temperature": 0.5,
    "tools": ["read", "grep", "web-search", "web-fetch"],
    "auto_commit": false,
    "review_before_push": true,
    "max_retries": 5
  },
  "tags": ["production", "deep-work"]
}' > /dev/null

post_json /records/agent-config '{
  "key": "ci-runner",
  "value": {
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 4096,
    "temperature": 0.1,
    "tools": ["read", "bash"],
    "auto_commit": false,
    "review_before_push": false,
    "max_retries": 1
  },
  "tags": ["ci", "fast"]
}' > /dev/null

post_json /records/agent-config '{
  "key": "code-review",
  "value": {
    "model": "claude-sonnet-4-6",
    "max_tokens": 12288,
    "temperature": 0.2,
    "tools": ["read", "grep", "bash"],
    "auto_commit": false,
    "review_before_push": false,
    "max_retries": 2,
    "review_scope": "security,correctness,performance"
  },
  "tags": ["production", "review"]
}' > /dev/null

echo "  4 agent-config records created"

# --- Step 4: Create checkpoint records ---
echo "→ Creating checkpoint records"

post_json /records/checkpoint '{
  "key": "task.auth-middleware/phase-1",
  "value": {
    "task": "task.auth-middleware",
    "phase": "design",
    "status": "passed",
    "agent": "claude-code/1.0.42",
    "machine": "m1-macbook-pro",
    "summary": "Auth middleware design doc approved. Bearer token verification via D1TokenStore. Hono middleware pattern.",
    "duration_ms": 45200,
    "artifacts_produced": 1
  },
  "tags": ["design", "passed"]
}' > /dev/null

post_json /records/checkpoint '{
  "key": "task.auth-middleware/phase-2",
  "value": {
    "task": "task.auth-middleware",
    "phase": "implementation",
    "status": "in_progress",
    "agent": "claude-code/1.0.42",
    "machine": "m1-macbook-pro",
    "summary": "Implementing bearerAuth middleware with D1 token verification. 2 of 4 acceptance criteria met.",
    "duration_ms": 128300,
    "artifacts_produced": 2,
    "tests_passing": 5,
    "tests_failing": 2
  },
  "tags": ["implementation", "in-progress"]
}' > /dev/null

post_json /records/checkpoint '{
  "key": "task.api-routes/phase-3",
  "value": {
    "task": "task.api-routes",
    "phase": "review",
    "status": "passed",
    "agent": "claude-code/1.0.42",
    "machine": "m2-linux-workstation",
    "summary": "All CRUD routes reviewed. 0 critical, 2 advisory findings addressed. 12 tests passing.",
    "duration_ms": 67800,
    "artifacts_produced": 3,
    "tests_passing": 12,
    "tests_failing": 0
  },
  "tags": ["review", "passed"]
}' > /dev/null

post_json /records/checkpoint '{
  "key": "task.db-migrations/phase-3",
  "value": {
    "task": "task.db-migrations",
    "phase": "verification",
    "status": "passed",
    "agent": "claude-code/1.0.40",
    "machine": "m1-macbook-pro",
    "summary": "Migration scripts verified against schema.user and schema.session entities. Indexes validated.",
    "duration_ms": 23100,
    "artifacts_produced": 1
  },
  "tags": ["verification", "passed"]
}' > /dev/null

post_json /records/checkpoint '{
  "key": "task.integration-tests/phase-1",
  "value": {
    "task": "task.integration-tests",
    "phase": "planning",
    "status": "passed",
    "agent": "claude-code/1.0.42",
    "machine": "m2-linux-workstation",
    "summary": "Test plan covers auth, CRUD, error handling, rate limiting. 24 test cases identified.",
    "duration_ms": 31500,
    "artifacts_produced": 1
  },
  "tags": ["planning", "passed"]
}' > /dev/null

post_json /records/checkpoint '{
  "key": "task.integration-tests/phase-2",
  "value": {
    "task": "task.integration-tests",
    "phase": "implementation",
    "status": "in_progress",
    "agent": "claude-code/1.0.42",
    "machine": "m2-linux-workstation",
    "summary": "Writing integration tests. Auth suite complete (8/8). CRUD suite in progress (3/10).",
    "duration_ms": 189400,
    "artifacts_produced": 2,
    "tests_passing": 11,
    "tests_failing": 0,
    "tests_pending": 13
  },
  "tags": ["implementation", "in-progress"]
}' > /dev/null

echo "  6 checkpoint records created"

# --- Step 5: Create deployment records ---
echo "→ Creating deployment records"

post_json /records/deployment '{
  "key": "deploy-20260527-01",
  "value": {
    "environment": "staging",
    "commit_sha": "a3f7c2d",
    "branch": "feat/auth-middleware",
    "triggered_by": "human-dawid",
    "status": "success",
    "started_at": 1748370600,
    "finished_at": 1748370780,
    "duration_ms": 180000,
    "worker_version": "2026.05.27-01",
    "migrations_applied": 2,
    "rollback_available": true
  },
  "tags": ["staging", "success"]
}' > /dev/null

post_json /records/deployment '{
  "key": "deploy-20260527-02",
  "value": {
    "environment": "production",
    "commit_sha": "b1e4f8a",
    "branch": "main",
    "triggered_by": "ci-pipeline",
    "status": "success",
    "started_at": 1748374200,
    "finished_at": 1748374440,
    "duration_ms": 240000,
    "worker_version": "2026.05.27-02",
    "migrations_applied": 0,
    "rollback_available": true
  },
  "tags": ["production", "success"]
}' > /dev/null

post_json /records/deployment '{
  "key": "deploy-20260528-01",
  "value": {
    "environment": "staging",
    "commit_sha": "e9d2b7f",
    "branch": "feat/integration-tests",
    "triggered_by": "claude-code/1.0.42",
    "status": "failed",
    "started_at": 1748390400,
    "finished_at": 1748390520,
    "duration_ms": 120000,
    "worker_version": "2026.05.28-01",
    "migrations_applied": 0,
    "rollback_available": false,
    "error": "Typecheck failed: src/routes/users.ts(42): Property 'email' does not exist on type 'Session'"
  },
  "tags": ["staging", "failed"]
}' > /dev/null

echo "  3 deployment records created"

# --- Step 6: Create incident records ---
echo "→ Creating incident records"

post_json /records/incident '{
  "key": "inc-20260526-rate-limit",
  "value": {
    "severity": "p2",
    "title": "Rate limiter rejecting valid requests during burst",
    "status": "resolved",
    "detected_at": 1748268000,
    "resolved_at": 1748275200,
    "duration_ms": 7200000,
    "affected_service": "worker",
    "root_cause": "Token bucket refill interval set to 60s instead of 1s",
    "resolution": "Fixed refill interval in rate-limit middleware config",
    "responders": ["human-dawid", "claude-code/1.0.42"],
    "postmortem_url": null
  },
  "tags": ["resolved", "p2", "rate-limiting"]
}' > /dev/null

post_json /records/incident '{
  "key": "inc-20260524-do-migration",
  "value": {
    "severity": "p1",
    "title": "DO migration failed on production — entity table locked",
    "status": "resolved",
    "detected_at": 1748095200,
    "resolved_at": 1748098800,
    "duration_ms": 3600000,
    "affected_service": "backend-do",
    "root_cause": "Long-running transaction held lock during blockConcurrencyWhile migration",
    "resolution": "Added transaction timeout and retry logic to migration runner",
    "responders": ["human-dawid"],
    "postmortem_url": null
  },
  "tags": ["resolved", "p1", "migration"]
}' > /dev/null

echo "  2 incident records created"

echo ""
echo "=== Record seed complete ==="
echo "  5 record types: session, agent-config, checkpoint, deployment, incident"
echo "  20 total records"
echo "  Dashboard: http://localhost:5174/p/dev-project/records"
