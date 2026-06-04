#!/usr/bin/env bash
set -euo pipefail

API="http://localhost:8787"
TOKEN="tila_dev_token_localonly"
PROJECT="dev-project"
BASE="$API/projects/$PROJECT"

auth() {
  curl -s -H "Authorization: Bearer $TOKEN" "$@"
}

post() {
  local path="$1"; shift
  auth -X POST -f "$BASE$path" -H "Content-Type: application/json" -d "$@" > /dev/null
}

get_fence() {
  local resource="$1"
  auth "$BASE/claims" | python3 -c "
import sys, json
claims = json.load(sys.stdin).get('claims', [])
for c in claims:
    if c['resource'] == '$resource':
        print(c['fence'])
        sys.exit(0)
print('0')
"
}

echo "=== Seeding dev project with realistic data ==="
echo ""

# --- Schema push ---
echo "→ Pushing schema"
SCHEMA_TOML=$(cat packages/cli/tila.schema.toml)
auth -X POST "$BASE/schema" -H "Content-Type: application/json" \
  -d "$(jq -n --arg def "$SCHEMA_TOML" '{definition: $def}')"

# --- Tasks: 3-level hierarchy (epic → milestone → task) ---
echo "→ Creating tasks"

# Epic
post /tasks '{"id":"epic.q3-api-overhaul","type":"epic","data":{"title":"Q3 API Overhaul","priority":"high","status":"in-progress"}}'

# Milestones
post /tasks '{"id":"milestone.auth-system","type":"milestone","data":{"title":"Auth System","priority":"high","status":"in-progress"}}'
post /tasks '{"id":"milestone.api-layer","type":"milestone","data":{"title":"API Layer","priority":"high","status":"in-progress"}}'

# Tasks under auth-system milestone
post /tasks '{"id":"task.auth-middleware","type":"task","data":{"title":"Implement auth middleware","priority":"high","status":"in-progress","assigned_to":"claude-agent-m1"}}'
post /tasks '{"id":"task.db-migrations","type":"task","data":{"title":"Write database migrations","priority":"medium","status":"done","assigned_to":"claude-agent-m1"}}'
post /tasks '{"id":"task.integration-tests","type":"task","data":{"title":"Write integration test suite","priority":"high","status":"in-progress","assigned_to":"claude-agent-m3"}}'

# Tasks under api-layer milestone
post /tasks '{"id":"task.api-routes","type":"task","data":{"title":"Add CRUD API routes","priority":"high","status":"done","assigned_to":"claude-agent-m2"}}'
post /tasks '{"id":"task.rate-limiting","type":"task","data":{"title":"Add rate limiting to API","priority":"medium","status":"queued","assigned_to":null}}'
post /tasks '{"id":"task.error-handling","type":"task","data":{"title":"Standardize error responses","priority":"low","status":"queued","assigned_to":null}}'
post /tasks '{"id":"task.ci-pipeline","type":"task","data":{"title":"Set up CI/CD pipeline","priority":"medium","status":"done","assigned_to":"human-dawid"}}'
post /tasks '{"id":"task.docs-api","type":"task","data":{"title":"Document API endpoints","priority":"low","status":"queued","assigned_to":null}}'

echo "  10 tasks created (1 epic, 2 milestones, 7 tasks)"

# --- Relationships ---
echo "→ Creating relationships"

# Parent-child hierarchy
post /tasks/relationships '{"from_id":"epic.q3-api-overhaul","to_id":"milestone.auth-system","type":"parent-child"}'
post /tasks/relationships '{"from_id":"epic.q3-api-overhaul","to_id":"milestone.api-layer","type":"parent-child"}'
post /tasks/relationships '{"from_id":"milestone.auth-system","to_id":"task.auth-middleware","type":"parent-child"}'
post /tasks/relationships '{"from_id":"milestone.auth-system","to_id":"task.db-migrations","type":"parent-child"}'
post /tasks/relationships '{"from_id":"milestone.auth-system","to_id":"task.integration-tests","type":"parent-child"}'
post /tasks/relationships '{"from_id":"milestone.api-layer","to_id":"task.api-routes","type":"parent-child"}'
post /tasks/relationships '{"from_id":"milestone.api-layer","to_id":"task.rate-limiting","type":"parent-child"}'
post /tasks/relationships '{"from_id":"milestone.api-layer","to_id":"task.error-handling","type":"parent-child"}'
post /tasks/relationships '{"from_id":"milestone.api-layer","to_id":"task.ci-pipeline","type":"parent-child"}'
post /tasks/relationships '{"from_id":"milestone.api-layer","to_id":"task.docs-api","type":"parent-child"}'

# Blocking relationships (dependency graph)
post /tasks/relationships '{"from_id":"task.db-migrations","to_id":"task.auth-middleware","type":"blocks"}'
post /tasks/relationships '{"from_id":"task.db-migrations","to_id":"task.api-routes","type":"blocks"}'
post /tasks/relationships '{"from_id":"task.api-routes","to_id":"task.integration-tests","type":"blocks"}'
post /tasks/relationships '{"from_id":"task.auth-middleware","to_id":"task.integration-tests","type":"blocks"}'
post /tasks/relationships '{"from_id":"task.api-routes","to_id":"task.docs-api","type":"blocks"}'
post /tasks/relationships '{"from_id":"task.integration-tests","to_id":"task.ci-pipeline","type":"blocks"}'

echo "  16 relationships created (10 parent-child, 6 blocking)"

# --- Records ---
echo "→ Creating records"
post /records/deploy_config '{"key":"main","value":{"region":"eu-west","provider":"cloudflare","workers_route":"api.example.com/*","r2_bucket":"app-artifacts"}}'
post /records/db_schema '{"key":"users","value":{"table_name":"users","columns":["id","email","name","created_at","updated_at"],"version":3}}'
post /records/db_schema '{"key":"sessions","value":{"table_name":"sessions","columns":["id","user_id","token_hash","expires_at","created_at"],"version":1}}'
echo "  3 records created"

# --- Claims: agents holding work ---
echo "→ Acquiring claims"

auth -X POST "$BASE/claims/acquire" -H "Content-Type: application/json" \
  -d '{"resource":"task.auth-middleware","mode":"exclusive","ttl_ms":600000}' > /dev/null
FENCE1=$(get_fence "task.auth-middleware")
echo "  task.auth-middleware claimed (fence=$FENCE1)"

auth -X POST "$BASE/claims/acquire" -H "Content-Type: application/json" \
  -d '{"resource":"task.integration-tests","mode":"exclusive","ttl_ms":600000}' > /dev/null
FENCE2=$(get_fence "task.integration-tests")
echo "  task.integration-tests claimed (fence=$FENCE2)"

# --- Presence: heartbeats from machines ---
echo "→ Sending presence heartbeats"

auth -X POST "$BASE/claims/acquire" -H "Content-Type: application/json" \
  -d '{"resource":"machine.m1-macbook-pro","mode":"presence","ttl_ms":120000,"metadata":{"os":"darwin","arch":"arm64","agent":"claude-code/1.0.42","session":"sess-a8f3"}}' > /dev/null
auth -X POST "$BASE/claims/acquire" -H "Content-Type: application/json" \
  -d '{"resource":"machine.m2-linux-workstation","mode":"presence","ttl_ms":120000,"metadata":{"os":"linux","arch":"x86_64","agent":"claude-code/1.0.42","session":"sess-b2e1"}}' > /dev/null
auth -X POST "$BASE/claims/acquire" -H "Content-Type: application/json" \
  -d '{"resource":"machine.m3-github-actions","mode":"presence","ttl_ms":120000,"metadata":{"os":"linux","arch":"x86_64","agent":"claude-code/1.0.41","session":"sess-c7d4"}}' > /dev/null

echo "  3 machines registered"

# --- Artifacts: code and docs produced by agents ---
echo "→ Producing artifacts"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

post_artifact_file() {
  local file="$1" kind="$2" mime="$3" resource="${4:-}" fence="${5:-}"
  python3 -c "
import json, sys
content = open('$file').read()
payload = {'content': content, 'kind': '$kind', 'mime_type': '$mime'}
if '$resource': payload['resource'] = '$resource'
if '$fence': payload['fence'] = int('$fence')
print(json.dumps(payload))
" | auth -X POST "$BASE/artifacts/text" -H "Content-Type: application/json" -d @- > /dev/null
}

post /artifacts/text "{
  \"content\": \"import { Hono } from 'hono';\\nimport { bearerAuth } from 'hono/bearer-auth';\\nimport { D1TokenStore } from '@tila/backend-d1';\\n\\nexport function authMiddleware(env) {\\n  return bearerAuth({\\n    verifyToken: async (token) => {\\n      const store = new D1TokenStore(env.DB);\\n      const result = await store.verify(token);\\n      return result !== null;\\n    },\\n  });\\n}\",
  \"kind\": \"source\",
  \"mime_type\": \"text/plain\",
  \"resource\": \"task.auth-middleware\",
  \"fence\": $FENCE1
}"

post_artifact_file "$SCRIPT_DIR/seed-data/auth-middleware-design.md" "document" "text/markdown" "task.auth-middleware" "$FENCE1"

post_artifact_file "$SCRIPT_DIR/seed-data/project-status-report.md" "document" "text/markdown" "task.integration-tests" "$FENCE2"

post /artifacts/text "{
  \"content\": \"import { describe, it, expect } from 'vitest';\\nimport { createTestApp } from '../helpers';\\n\\ndescribe('auth middleware', () => {\\n  it('rejects missing token', async () => {\\n    const app = createTestApp();\\n    const res = await app.request('/api/tasks');\\n    expect(res.status).toBe(401);\\n  });\\n\\n  it('accepts valid token', async () => {\\n    const app = createTestApp();\\n    const res = await app.request('/api/tasks', {\\n      headers: { Authorization: 'Bearer test_token_123' },\\n    });\\n    expect(res.status).toBe(200);\\n  });\\n\\n  it('rejects revoked token', async () => {\\n    const app = createTestApp();\\n    const res = await app.request('/api/tasks', {\\n      headers: { Authorization: 'Bearer revoked_token' },\\n    });\\n    expect(res.status).toBe(401);\\n    const body = await res.json();\\n    expect(body.error.code).toBe('TOKEN_REVOKED');\\n  });\\n});\",
  \"kind\": \"test\",
  \"mime_type\": \"text/plain\",
  \"resource\": \"task.integration-tests\",
  \"fence\": $FENCE2
}"

post /artifacts/text "{
  \"content\": \"CREATE TABLE IF NOT EXISTS users (\\n  id TEXT PRIMARY KEY,\\n  email TEXT NOT NULL UNIQUE,\\n  name TEXT,\\n  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),\\n  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\\n);\\n\\nCREATE TABLE IF NOT EXISTS sessions (\\n  id TEXT PRIMARY KEY,\\n  user_id TEXT NOT NULL REFERENCES users(id),\\n  token_hash TEXT NOT NULL UNIQUE,\\n  expires_at INTEGER NOT NULL,\\n  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\\n);\\n\\nCREATE INDEX idx_sessions_token ON sessions(token_hash);\\nCREATE INDEX idx_sessions_user ON sessions(user_id);\",
  \"kind\": \"migration\",
  \"mime_type\": \"text/plain\"
}"

echo "  5 artifacts produced"

echo ""
echo "=== Seed complete ==="
echo ""
echo "Dashboard: http://localhost:5173"
echo "  10 tasks (1 epic, 2 milestones, 7 tasks)"
echo "  3 records (1 deploy_config, 2 db_schema)"
echo "  16 relationships (10 parent-child, 6 blocking)"
echo "  2 active claims (auth-middleware, integration-tests)"
echo "  3 machines present (m1-macbook-pro, m2-linux-workstation, m3-github-actions)"
echo "  5 artifacts (source code, 2 markdown docs, test suite, migration SQL)"
