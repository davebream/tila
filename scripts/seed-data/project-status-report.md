# Sprint 3 Status Report

## Summary

Sprint 3 focused on hardening the coordination layer: auth middleware, fencing token validation, and the artifact storage pipeline. Two of three tracks are complete; the integration test suite is still in progress.

---

## Track Status

### Auth Middleware (Complete)

The unified auth layer is deployed and handling both GitHub sessions and API tokens. Key metrics from the first 48 hours:

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| p50 latency | 2.1ms | < 5ms | On target |
| p99 latency | 8.4ms | < 20ms | On target |
| Token resolutions | 14,203 | — | Baseline |
| Auth failures | 47 (0.33%) | < 1% | On target |
| D1 read errors | 0 | 0 | Clean |

Two edge cases surfaced during rollout:

1. **Stale GitHub tokens after org permission changes** — GitHub revokes `ghs_` tokens silently when org SSO settings change. Our middleware correctly returns `UNAUTHORIZED`, but the error message could be more specific. Filed as a follow-up.

2. **Rate limiting interaction** — when an agent hits the rate limit (429) and retries with backoff, the retry counter resets correctly. No issues observed.

### Artifact Storage Pipeline (Complete)

Content-addressed storage via R2 is working. Deduplication is effective:

```bash
# Sample artifact upload with deduplication
$ tila artifact push --kind source --resource task.api-routes ./src/routes.ts
  sha256: 7a3b4c...  bytes: 2,847  deduplicated: false

# Same content, different resource — deduplication kicks in
$ tila artifact push --kind source --resource task.api-v2 ./src/routes.ts
  sha256: 7a3b4c...  bytes: 2,847  deduplicated: true
```

The lifecycle sweep (daily cron at 03:00 UTC) successfully tombstoned 12 orphaned artifacts in the first run. R2 blob deletion is best-effort after tombstoning.

### Integration Tests (In Progress)

The test suite covers 67% of the coordination API surface:

- [x] Entity CRUD and relationship management
- [x] Claim acquisition and fencing validation
- [x] Artifact text upload and retrieval
- [x] Presence heartbeat lifecycle
- [ ] Concurrent claim contention (first-writer-wins)
- [ ] Cross-store consistency (DO SQLite + D1 + R2)
- [ ] Artifact search via FTS5

Remaining tests depend on `@cloudflare/vitest-pool-workers` support for concurrent DO access patterns. The pool currently serializes requests to the same DO, which makes contention tests non-trivial.

> **Blocked:** concurrent claim tests need a pool configuration that allows parallel requests to the same Durable Object stub. Tracking in issue #142.

## Schema Changes

Migration `0008_add_session_metadata.sql` adds an optional `metadata` JSONB column to the sessions table:

```sql
ALTER TABLE _sessions ADD COLUMN metadata TEXT DEFAULT '{}';

CREATE INDEX idx_sessions_metadata_agent
  ON _sessions(json_extract(metadata, '$.agent'));
```

This enables querying active sessions by agent version, which is useful for tracking rollout of new agent builds across machines.

## Architecture Decision

**ADR-012: No in-memory token cache**

We evaluated adding a 30-second TTL cache for D1 token lookups to reduce read pressure from rapid agent requests. Decision: **rejected**.

*Rationale:*

- Token revocation must be immediate for security. A 30s cache window means a revoked token could be used for up to 30 additional seconds.
- D1 read latency (2ms p50) is already well within our latency budget.
- The coordination engine handles ~200 requests/minute at peak. D1 can sustain 10,000+ reads/minute per database without breaking a sweat.

The cost-benefit ratio does not justify the complexity. Revisit only if D1 latency degrades by 10x or request volume increases by 50x.

## Next Sprint

1. Complete integration test suite (contention + cross-store)
2. Add `tila status` CLI command for machine-local state summary
3. Implement artifact relationship graph (references, supersedes, derived-from)
4. Dashboard polish: wider artifact previews, markdown rendering improvements
