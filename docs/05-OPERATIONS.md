# Operations Guide

> Production procedures for running tila on Cloudflare. Covers observability, maintenance, troubleshooting, and recovery.

> **Install distribution runbook** (enabling curl/PowerShell/Homebrew one-liners, creating the tap repo, cutting the first verified release): see [docs/12-INSTALL-DISTRIBUTION.md](./12-INSTALL-DISTRIBUTION.md).

## Contents

1. [Log Streaming (wrangler tail)](#log-streaming-wrangler-tail)
2. [Journal Inspection (tila journal tail)](#journal-inspection-tila-journal-tail)
3. [Analytics Queries (Workers Analytics Engine)](#analytics-queries-workers-analytics-engine)
4. [tila doctor Reference](#tila-doctor-reference)
5. [Authentication Setup](#authentication-setup)
6. [Troubleshooting](#troubleshooting)
7. [Backup and Recovery](#backup-and-recovery)
8. [Performance Guidance](#performance-guidance)
9. [R2 Lifecycle Backstop](#r2-lifecycle-backstop)
10. [Search Index](#search-index)
11. [D1 Migrations](#d1-migrations)
12. [Migration Safety (PITR Rollback)](#migration-safety-pitr-rollback)
13. [Local Development with Production Data](#local-development-with-production-data)

## Log Streaming (wrangler tail)

Stream live Worker logs using Cloudflare's Tail Workers feature. This shows HTTP routing events, analytics emission, auth failures, and Worker-level errors. It does NOT show Durable Object internal events (use `tila journal tail` for those).

### Usage

```bash
wrangler tail --format pretty
```

### Recommended filters

| Flag | Purpose | Example |
|------|---------|---------|
| `--status error` | Show only 4xx/5xx responses | `wrangler tail --format pretty --status error` |
| `--search <pattern>` | Filter by log message content | `wrangler tail --format pretty --search "sweep"` |
| `--sampling-rate 1` | Full sampling (default may sample) | `wrangler tail --format pretty --sampling-rate 1` |

### Output format

Each log line follows:

```
[timestamp] [levelName] <message>
```

Request-level lines include HTTP method, path, status code, and latency.

### Common use cases

- **Diagnosing 4xx/5xx errors in production:** `wrangler tail --format pretty --status error`
- **Verifying analytics emission:** `wrangler tail --format pretty --search "ANALYTICS"`
- **Confirming auth flow:** `wrangler tail --format pretty --search "token"`
- **Monitoring sweep cron:** `wrangler tail --format pretty --search "sweep"`

## Journal Inspection (tila journal tail)

Inspect recent state changes from the Durable Object's journal. Unlike `wrangler tail` (which shows Worker-level HTTP events), `tila journal tail` shows entity lifecycle events, claim acquisitions, artifact operations, and sweep results.

### Usage

```bash
tila journal tail [--resource=<id>] [--kind=<event>] [--limit=N]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--resource` | string | (none) | Filter by resource identifier (e.g., `entity:abc`, `artifact:xyz`) |
| `--kind` | string | (none) | Filter by event kind (e.g., `claim.acquired`, `artifact.expired`, `entity.created`) |
| `--limit` | number | 20 | Number of events to return |

### Output format

```
[seq] ISO-timestamp  kind  resource  actor=actor fence=N
```

The `fence` field is omitted when `null` (e.g., read-only events that do not involve claims).

### Examples

```bash
# Show last 20 events (default)
tila journal tail

# Trace what happened to a specific resource
tila journal tail --resource=entity:proj-abc/my-entity

# Inspect recent claim events
tila journal tail --kind=claim.acquired

# Show last 50 events
tila journal tail --limit=50

# Debug sweep results
tila journal tail --kind=artifact.expired --limit=100
```

## Analytics Queries (Workers Analytics Engine)

tila writes to the `tila-analytics` dataset on every Worker request and every DO operation. Query this data via the [Workers Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

### Dataset schema

Both request and DO operation datapoints share the `tila-analytics` dataset. Use `blob4` (type discriminator) to filter by event type.

**Request datapoints** (`blob4 = 'request'`):

| Field | Column | Example |
|-------|--------|---------|
| Route pattern | `blob1` | `/projects/:projectId/entities` |
| HTTP method | `blob2` | `GET` |
| Project ID | `blob3` | `proj-abc` (or empty for unauthenticated) |
| Type | `blob4` | `request` |
| Latency (ms) | `double1` | `42` |
| Status code | `double2` | `200` |
| Index (partition) | `index1` | Project ID or `anonymous` |

**DO operation datapoints** (`blob4 = 'do_operation'`):

| Field | Column | Example |
|-------|--------|---------|
| Table | `blob1` | `entities` |
| Operation type | `blob2` | `create` |
| Project ID | `blob3` | `proj-abc` |
| Type | `blob4` | `do_operation` |
| Latency (ms) | `double1` | `15` |
| Rows affected | `double2` | `0` (always 0 in v0.1) |
| Index (partition) | `index1` | Project ID |

> **Note:** `double2` (rows affected) is always `0` in v0.1 because the DO response envelope does not yet carry structured row counts. This will be populated in v0.2 when the DO response schema is standardized.

### Canonical queries

#### 1. Error rate by route (last 24 hours)

```sql
SELECT
  blob1 AS route,
  SUM(IF(double2 >= 400, 1, 0)) AS errors,
  COUNT() AS total,
  SUM(IF(double2 >= 400, 1, 0)) / COUNT() AS error_rate
FROM tila-analytics
WHERE
  blob4 = 'request'
  AND timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY route
ORDER BY error_rate DESC
```

#### 2. Request latency p95 by route (last hour)

```sql
SELECT
  blob1 AS route,
  QUANTILEWEIGHTED(0.95)(double1, 1) AS p95_ms,
  QUANTILEWEIGHTED(0.50)(double1, 1) AS p50_ms,
  COUNT() AS requests
FROM tila-analytics
WHERE
  blob4 = 'request'
  AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY route
ORDER BY p95_ms DESC
```

#### 3. DO operation latency p95 by table and operation (last hour)

```sql
SELECT
  blob1 AS table_name,
  blob2 AS operation,
  QUANTILEWEIGHTED(0.95)(double1, 1) AS p95_ms,
  COUNT() AS ops
FROM tila-analytics
WHERE
  blob4 = 'do_operation'
  AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY table_name, operation
ORDER BY p95_ms DESC
```

#### 4. Claim acquisition throughput (per minute, last hour)

```sql
SELECT
  TOSTARTOFINTERVAL(timestamp, INTERVAL '1' MINUTE) AS minute,
  COUNT() AS claim_ops
FROM tila-analytics
WHERE
  blob4 = 'do_operation'
  AND blob2 = 'acquire'
  AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY minute
ORDER BY minute ASC
```

### Running queries

```bash
curl "https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql" \
  -H "Authorization: Bearer {token}" \
  -d "SELECT blob1 AS route, COUNT() AS requests FROM tila-analytics WHERE blob4 = 'request' GROUP BY route"
```

Replace `{account_id}` and `{token}` with your Cloudflare account ID and API token (requires `analytics_engine:read` permission).

For the full schema reference, see [`docs/analytics-queries.md`](./analytics-queries.md).

## tila doctor Reference

`tila doctor` is the single maintenance command for verifying project health. It runs a suite of checks against your deployed tila infrastructure and reports pass/warn/fail status for each.

### Usage

```bash
tila doctor [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--reconcile` | boolean | false | Walk R2 blobs and detect orphaned artifact pointers |
| `--apply` | boolean | false | Materialize pointer recovery (implies `--reconcile`; default is dry-run) |
| `--search-drift` | boolean | false | Check FTS5 search index for drift from artifact_pointers |
| `--search-rebuild` | boolean | false | Rebuild the FTS5 search index from artifact_pointers (dry-run by default, use `--apply` to write) |
| `--json` | boolean | false | Output results as structured JSON |
| `--skip-auth` | boolean | false | Skip wrangler install, login, and account-match checks |

### Check reference

| Check name | Pass | Warn | Fail |
|-----------|------|------|------|
| `worker-reachable` | Worker responds to `/api/health` | -- | No response or non-200 |
| `d1-reachable` | `/api/whoami` succeeds (D1 token lookup) | -- | Token invalid or D1 unreachable |
| `do-reachable` | Probe RTT measured; `doRttMs` reported | -- | 502 or timeout |
| `r2-reachable` | List probe on `produced/` prefix succeeds | -- | R2 unreachable |
| `expired-claims` | `expiredClaimsCount == 0` | `expiredClaimsCount > 0` | -- |
| `journal-size` | `journalRows < 10,000` | `journalRows >= 10,000` | -- |
| `reconcile` | No orphans detected | -- | Orphans found (only with `--reconcile`) |
| `search-missing-doc` | -- | -- | Artifact pointer exists but no search doc (only with `--search-drift`) |
| `search-orphan-doc` | -- | -- | Search doc exists but no pointer (only with `--search-drift`) |
| `search-tombstone-leak` | -- | -- | Tombstoned pointer still has search doc (only with `--search-drift`) |
| `search-unsupported-kind` | -- | Search doc for non-searchable kind | -- (only with `--search-drift`) |
| `search-stale-index` | -- | Body hash mismatch | -- (only with `--search-drift`) |
| `search-rebuild` | Rebuild complete | -- | Unrecoverable entries (only with `--search-rebuild`) |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All checks pass |
| 1 | At least one check warns |
| 2 | At least one check fails |

### JSON output

```bash
tila doctor --json
```

Returns:

```json
{
  "checks": [
    { "name": "worker-reachable", "status": "pass", "detail": "200 OK in 42ms" },
    { "name": "expired-claims", "status": "warn", "detail": "3 expired claims pending sweep" }
  ],
  "summary": { "passed": 4, "warned": 1, "failed": 0 }
}
```

### CI usage

Suitable for weekly cron or pre-deploy health check:

```bash
tila doctor
echo "Exit code: $?"
# 0 = healthy, 1 = warnings, 2 = failures
```

## Authentication Setup

Two auth paths are available; choose based on your deployment model. For technical internals of each path, see [`docs/10-AUTH-IMPLEMENTATION.md`](10-AUTH-IMPLEMENTATION.md).

### Prerequisites: Cloudflare Account API Token

All provisioning paths require a Cloudflare Account API Token. Create one at `https://dash.cloudflare.com/profile/api-tokens` with these permissions:

| Permission | Level | Required |
|---|---|---|
| Workers Scripts | Edit | Yes |
| D1 | Edit | Yes |
| R2 Storage | Edit | Yes |
| Account Analytics | Edit | Yes |

Export the token before running any `tila init` command:

```bash
export CLOUDFLARE_API_TOKEN=<your-token>
```

### GitHub Session Auth (Default)

Uses GitHub repository permissions as the authorization source. The CLI exchanges a GitHub token for a short-lived (1-hour) tila session token signed with HMAC-SHA256. This is the recommended auth path for all new projects.

**Step 1: Generate and set the HMAC signing key**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Copy the output and set it as a Cloudflare secret:

```bash
wrangler secret put GITHUB_SESSION_HMAC_KEY
```

Paste the key when prompted. This key signs all GitHub session tokens — treat it as a production secret.

**Step 2: Register repos in the allowlist**

From your repo root:

```bash
tila infra provision
```

This derives owner/repo from the git remote and registers the repo via `POST /api/repos`. For private repos, it optionally accepts a GitHub token to resolve the repo ID.

**Step 3: Configure CLI auth mode**

Add to `.tila/config.toml` (committed to the repo):

```toml
[auth]
mode = "github-repo"

[github]
host = "github.com"
owner = "<your-org>"
repo = "<your-repo>"
```

**Step 4: GitHub Actions CI setup**

GitHub Actions provides `GITHUB_TOKEN` automatically. Add the environment variable to your workflow:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

With `auth.mode = "github-repo"` in the committed `.tila/config.toml`, the CLI resolves the token from the environment and exchanges it automatically.

**Step 5: Verify**

Run any `tila` command (e.g., `tila doctor`). The CLI will exchange the GitHub token for a session and cache the result to `.tila/.session`.

**Session behavior:**
- Sessions last 1 hour
- The CLI auto-refreshes 10 minutes before expiry
- Cached sessions are stored in `.tila/.session` (mode 0o600, gitignored)

### D1 API Tokens (Admin/Bootstrap)

Administrative credential for initial provisioning and machine-to-machine access. A shared API token is hashed and stored in D1. Use this path for CI pipelines or service accounts that do not have a GitHub identity.

**First project setup:**

```bash
tila infra provision   # one-time account setup (D1, GitHub App)
tila project create    # per-project (Worker, DO, R2, token)
```

This provisions the Worker, D1 database, R2 bucket, and issues the first API token. The token is written to `.tila/.env` (mode 0o600, gitignored).

**Teammate onboarding (token-based):**

```bash
tila init
```

Reads `.tila/config.toml` (committed to repo), prompts for the shared token, writes to `.tila/.env`.

**Token management:**

```bash
tila token list             # List active tokens
tila token issue --name ci  # Issue a new token
tila token revoke --name ci # Revoke a token
```

**Token resolution order:**
1. `TILA_API_TOKEN` environment variable
2. `.tila/.env` file

### Migrating from D1 Tokens

Existing D1 API tokens continue to work — they are not deprecated. This section describes how to adopt GitHub auth alongside an existing token-based setup.

**D1 tokens remain valid** for CI pipelines, service accounts, and bootstrap access. GitHub auth adds per-developer repo-scoped authorization on top. Both can coexist in the same project.

**Steps to adopt GitHub auth:**

1. Generate and set the HMAC signing key (see [GitHub Session Auth (Default)](#github-session-auth-default) Step 1).
2. Register your repo in the allowlist:
   ```bash
   tila infra provision
   ```
3. Update `.tila/config.toml` to set `auth.mode = "github-repo"` and `[github]` section (see Step 3 above).
4. Commit `.tila/config.toml` — teammates pull and run `tila init` (no token needed with GitHub auth).
5. Optionally revoke the shared D1 token once all developers have switched:
   ```bash
   tila token revoke --name default
   ```

### Infra Admin Token (`INFRA_ADMIN_TOKEN`)

`INFRA_ADMIN_TOKEN` is the infra-owner admin secret — a single, shared, identity-less credential (NOT a per-project token). When set, the `/_internal/admin/*` routes accept a matching `Authorization: Bearer <token>`; when unset, those routes return 404 (invisible). It authorizes cross-project infra operations such as destroying a project by slug without that project's own token. `tila infra provision` sets it; it is stored as a Worker secret and locally in `~/.tila/infra.toml` (`infra_admin_token`).

#### Mandatory: alert on auth-failure volume

Because this is a shared secret with no per-caller identity, **a spike in failed authentications is the only compromise signal** — there is no "wrong user" to flag, only wrong-token attempts. Wiring an Analytics Engine alert on the `auth-failure` outcome volume is **mandatory**, not optional.

Infra-admin datapoints land in the `tila-analytics` dataset with `blob3 = 'infra_admin'`. The outcome lives in the **`blob2`** column (`auth-failure`, `project-not-found`, `confirm-slug-mismatch`, success, etc.); `double1` carries the status code. Alert on the **`outcome` blob (`blob2`)** — NOT on the `projectId` index (`index1` / `blob1`): a brute-force attacker controls or omits the project slug, so partitioning by project hides the attack. Count `auth-failure` outcomes across all projects.

Baseline query (raise an alert when the count over a short window exceeds your normal floor, which should be ~0):

```sql
SELECT
  COUNT() AS auth_failures
FROM tila-analytics
WHERE
  blob3 = 'infra_admin'
  AND blob2 = 'auth-failure'
  AND timestamp > NOW() - INTERVAL '15' MINUTE
```

Run it on a schedule (or via Cloudflare's notification tooling) and page on a non-trivial count. Even a handful of `auth-failure` events is suspicious, because legitimate infra-admin calls come from the CLI with the correct secret.

#### Rotation

Rotate the secret periodically and immediately on any suspected compromise:

```bash
tila infra provision --rotate-admin-token
```

This generates a new `INFRA_ADMIN_TOKEN`, invalidating the previous one. Recommended cadence: **annually**, plus on-demand whenever compromise is suspected or an operator with access leaves. Rotation takes effect within seconds as the new secret propagates to all edge locations; an admin call made during propagation may return **403** — retry, and it will succeed once propagation completes.

#### Pre-deploy action: delete the orphaned `INFRA_DESTROY_TOKEN` secret (RC-7)

The infra-admin secret was previously named `INFRA_DESTROY_TOKEN`. Worker secrets **survive deploys** — a `wrangler deploy` never deletes a secret just because the new config/code no longer references it. So in any environment where the old `INFRA_DESTROY_TOKEN` secret was set, it would linger inert after this change ships, an orphaned long-lived credential with no consumer.

**Before** the first deploy of this change to such an environment, delete it:

```bash
wrangler secret delete INFRA_DESTROY_TOKEN
```

Do this as a pre-deploy step for each affected environment. It is a cleanup action to perform up front, not a post-deploy verification — the goal is that the obsolete secret never coexists with the new deployment.

### Sweep Secret (`SWEEP_SECRET`)

`SWEEP_SECRET` authenticates the `/_internal/sweep` endpoint. The Worker compares the `X-Sweep-Secret` request header against this secret using a constant-time comparison (HMAC key `tila-sweep-compare`, distinct from the infra admin key). When `SWEEP_SECRET` is unset or the header value does not match, the endpoint returns **403 Forbidden** — the sweep will not run.

The cron trigger defined in `wrangler.toml` passes this secret automatically on each scheduled invocation. It is **not** the same key as `INFRA_ADMIN_TOKEN` and must be stored as a separate Worker secret.

#### Setup

Generate a 32-byte random value and store it as a Worker secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
wrangler secret put SWEEP_SECRET
```

If `SWEEP_SECRET` is missing, every scheduled sweep invocation returns 403 and logs a `sweep_error` Analytics datapoint. You can verify the secret is set by running:

```bash
wrangler secret list | grep SWEEP_SECRET
```

#### Manual trigger with the secret

To trigger the sweep manually (e.g. during incident response):

```bash
curl -X POST https://<worker-url>/_internal/sweep \
  -H "X-Sweep-Secret: <your-sweep-secret>"
```

#### Rotation

Rotate on any suspected compromise or on the same cadence as `INFRA_ADMIN_TOKEN`:

```bash
wrangler secret put SWEEP_SECRET   # enter new value at the prompt
```

The old secret is invalidated immediately; the next scheduled cron invocation will use the new value automatically.

## Troubleshooting

Common failure modes and remediation steps.

| Symptom | Likely cause | Remediation |
|---------|-------------|-------------|
| `worker-reachable` FAIL | Worker not deployed or URL misconfigured | Check `.tila/config.toml` `worker_url`; run `wrangler deploy` |
| `d1-reachable` FAIL | Token invalid or D1 not provisioned | Run `tila token list`; re-run `tila project create` |
| `do-reachable` FAIL + 502 | DO cold start race or DO eviction in progress | Retry once; if persistent, run `tila doctor --json` for structured output |
| `doRttMs` > 200ms | Smart Placement not yet converged or disabled | Check `wrangler.toml` `[placement] mode = "smart"`; wait 24h for convergence |
| `expired-claims` WARN | Sweep cron did not run | Check `wrangler tail` for sweep errors; trigger manually via `/_internal/sweep` if needed |
| `journal-size` WARN (>= 10,000 rows) | High write volume without archival | Monitor growth rate; journal archival is v0.2; no action required unless near 10GB DO SQLite limit |
| `search-missing-doc` FAIL | Index drift from interrupted sweep | Run `tila doctor --search-drift --search-rebuild --apply` |
| R2 objects absent, no `artifact.expired` journal events | R2 lifecycle backstop fired | Run `tila doctor --reconcile --apply` to sync DO state with R2 |
| Schema version mismatch in Worker logs | Worker and DO on different schema versions | Redeploy Worker: `wrangler deploy`; DO migrates on next request |
| `HMAC_NOT_CONFIGURED` on GitHub exchange | HMAC signing key not set | Generate key and run `wrangler secret put GITHUB_SESSION_HMAC_KEY`; see [Authentication Setup](#authentication-setup) |
| `REPO_NOT_REGISTERED` on GitHub exchange | Repo not in project allowlist | Run `tila infra provision` from the repo root |
| `SESSION_EXPIRED` during CLI operation | Session older than 1 hour or revoked | Re-run the CLI command (auto-refreshes); check server/client clock sync |
| `PERMISSION_INSUFFICIENT` on GitHub exchange | GitHub permission below minimum | Check repo collaborator settings; verify allowlist `min_read_permission` |
| GitHub exchange succeeds, CLI errors on API call | Git remote doesn't match `[github]` config | Check CLI warning about remote mismatch; update `.tila/config.toml` `[github]` section |

## Backup and Recovery

### v0.1 backup story

Cloudflare manages DO SQLite point-in-time recovery automatically. There is no user-controllable backup export in v0.1. The recovery story relies on:

1. **DO SQLite durability** -- Cloudflare's built-in PIT recovery restores DO state to a recent snapshot. Users do not trigger this manually; it is infrastructure-level protection.
2. **R2 as long-tail backstop** -- Artifact blobs in R2 survive DO state loss. `tila doctor --reconcile` can reconstruct `artifact_pointers` from R2 object metadata.
3. **`tila reset --force`** -- Last resort: wipes the project and starts fresh.

### Recovery scenarios

| Scenario | Recovery path |
|----------|--------------|
| DO eviction (idle, normal) | Automatic -- state survives in DO SQLite, cold start adds ~50-100ms |
| DO evicted, state intact | `tila doctor` to verify; `tila doctor --reconcile` if R2 drift suspected |
| Partial R2 loss | `tila doctor --reconcile --apply` to sync DO pointers with remaining R2 objects |
| Full DO loss (Cloudflare incident) | Contact Cloudflare support for PIT recovery; then `tila doctor --reconcile --apply` |
| Intentional reset | `tila reset --force` |

### What is NOT available in v0.1

- `tila restore --from-r2-and-backup` -- external backup export/import is a v0.2 feature
- Manual DO SQLite snapshots -- not exposed by the Cloudflare API
- Journal archival or export -- v0.2 scope

### Artifact recovery detail

When running `tila doctor --reconcile --apply`:

1. Walks all R2 objects under `produced/` prefix
2. For each object, checks if a matching `artifact_pointers` row exists in the DO
3. If missing: synthesizes a pointer from R2 object metadata (key, size, content-type)
4. Emits `artifact.reconciled` journal events for each recovered pointer
5. Idempotent -- running multiple times produces the same result

## Performance Guidance

### Smart Placement

Enabled by default (`[placement] mode = "smart"` in `wrangler.toml`). Verify with `tila doctor`:

- `do-reachable` check passes -- Worker can reach the DO
- `doRttMs < 50ms` under normal load -- Smart Placement has converged

If `doRttMs > 200ms` persistently:
1. Confirm `wrangler.toml` has `[placement] mode = "smart"`
2. Wait 24 hours for Cloudflare's placement algorithm to converge
3. If still elevated: your traffic pattern may be too distributed for single-region placement

### DO cold start

First request after idle eviction adds ~50-100ms latency. Subsequent requests are fast. There are no user-configurable knobs to prevent eviction in v0.1. The DO evicts after ~30 seconds of inactivity.

**Mitigation:** For latency-sensitive workloads, send a periodic keepalive (e.g., `tila doctor` on a 20-second interval). This is generally unnecessary for production workloads with regular traffic.

### Journal growth monitoring

`tila doctor` reports `journalRows` and `maxSeq`. The warn threshold is 10,000 rows (`JOURNAL_WARN_THRESHOLD` in CLI source).

- Below 10,000: healthy
- Above 10,000: monitor growth rate; no immediate action required
- Journal archival is v0.2 -- no manual cleanup mechanism exists in v0.1
- DO SQLite limit is ~10GB -- journal rows are small (~200 bytes each), so 10,000 rows is trivial storage-wise

### Cron sweep health

The sweep runs daily at `/_internal/sweep`. It is now a **budgeted, multi-run, per-project** process — read this before treating an elevated backlog as a failure.

**Backlog draining is multi-run by design.** A single sweep invocation self-throttles on two budgets: a subrequest ceiling (`SWEEP_SUBREQUEST_BUDGET`, a conservative self-limit that stays safe even on the smallest plan — see `packages/worker/src/config.ts`) and a wall-clock budget (`SWEEP_TIME_BUDGET_MS`). When either is exhausted, the run stops cleanly and records a `resumePoint` (the project/phase frontier) in the sweep summary; the next daily run continues from there. **A large expired-artifact or journal backlog therefore drains across several daily runs — an elevated `expired-claims` count is often expected progress, not a stuck cron.** It is a problem only if it keeps climbing across many consecutive days with no `resumePoint` movement.

**One project's failure no longer aborts the run.** Each project is swept in isolation: a failing sub-step (expired-artifact drain, journal archive, or search-drift reconcile) marks only that project `degraded` (`status: "degraded"` in its per-project status) and the run continues to its siblings. A pre-loop crash (e.g. the project-registry read failing) is caught and recorded rather than silently aborting the whole nightly sweep.

**`claim.expired` journal events.** When the sweep reaps an expired claim it now writes a `claim.expired` journal event (actor = the holder whose lease lapsed, with the claim's fence) in the same transaction as the delete. This is the audit trail behind the `expired-claims` doctor check: a healthy sweep both clears the pending count AND leaves a `claim.expired` trace per reaped claim, so you can distinguish a lease that **expired** from one that was explicitly **released**.

**Observability surface (Analytics Engine).** Each run emits structural-only datapoints (no secrets/tokens) to the `ANALYTICS` dataset:
- one **per-project** datapoint (tag `sweep_project`): `projectId`, rollup `status`, per-step outcomes, and `expired`/`remaining`/`truncated` counts;
- one **run-level rollup** datapoint (tag `sweep_rollup`, indexed under `sweep`): `projectsSwept`, `projectsDegraded`, `artifactsExpired`, `journalEventsArchived`, `driftReconciled`, and how many per-project datapoints were actually emitted;
- a **`sweep_error`** datapoint if the run throws before the per-project loop.

> **Per-project emission ceiling (~250-project fleets).** Analytics Engine hard-caps `writeDataPoint` at **250 calls per Worker invocation**. The sweep self-limits below that: `degraded`/`truncated` projects always emit, healthy projects emit only up to `SWEEP_ANALYTICS_MAX_PROJECT_DATAPOINTS` (200), and the rollup always emits. On a fleet larger than ~250 projects, healthy per-project datapoints beyond the cap are intentionally dropped — rely on the **rollup** datapoint for aggregate observability at that scale, and on the always-emitted `degraded`/`truncated` per-project datapoints for the projects that need attention.

If sweep is failing:
1. `wrangler tail --format pretty --search "sweep"` to see errors
2. Inspect the `sweep_rollup` / `sweep_error` Analytics datapoints for run-level health
3. Manual trigger: `curl -X POST https://<worker-url>/_internal/sweep`

### What is NOT tunable in v0.1

- Custom `blockConcurrencyWhile` hints -- no API exists
- R2 batch sizes -- not configurable
- Connection pooling -- handled by Cloudflare automatically
- Prometheus/metrics endpoint -- v0.2

These are v0.2 scope items. v0.1 relies on Cloudflare's built-in optimizations.

## R2 Lifecycle Backstop

### Overview

R2 lifecycle rules are a backstop safety net for artifact expiry. The primary cleanup mechanism is the Worker-driven sweep (daily cron at `/_internal/sweep`). R2 lifecycle only fires when the Worker sweep has failed for an extended period (365+ days).

See `docs/01-DECISIONS.md` section 5 for the architectural decision rationale.

### Rules

The lifecycle configuration is written to `.tila/lifecycle.json` (gitignored) during `tila project create` and applied via `wrangler r2 bucket lifecycle set`.

| Rule ID | Prefix | Expiry | Status | Purpose |
|---------|--------|--------|--------|---------|
| `backstop-produced-1y` | `produced/` | 365 days | Enabled | Removes orphaned produced artifacts after 1 year |
| `keep-sources-forever` | `sources/` | -- | Disabled | Sources are never auto-expired |
| `keep-indexes-forever` | `indexes/` | -- | Disabled | Indexes are never auto-expired |
| `abort-incomplete-uploads-1d` | (all) | 1 day | Enabled | Cleans up abandoned multipart uploads |

### When R2 Lifecycle Fires

R2 lifecycle is supplementary. It fires only when:
- The Worker-driven sweep cron (`/_internal/sweep`) has not run for 365+ days
- An object under `produced/` has exceeded its 365-day age

Observable signal: R2 objects disappear without corresponding `artifact.expired` journal events. This indicates the backstop fired rather than the Worker sweep.

Recovery: run `tila doctor --reconcile` to sync DO state with R2 reality.

### Re-applying Lifecycle Rules

Re-run `tila project create` to reapply the lifecycle configuration. The operation is idempotent -- it overwrites the existing rules.

Note: R2 lifecycle rules take effect asynchronously. Cloudflare applies them within approximately 24 hours of configuration.

### Modifying Lifecycle Rules

To manually adjust rules:
1. Edit `.tila/lifecycle.json`
2. Run: `wrangler r2 bucket lifecycle set <bucket-name> --file .tila/lifecycle.json`

The `.tila/lifecycle.json` file is gitignored by design -- it contains bucket-specific configuration generated during provisioning.

## Search Index

### Overview

The FTS5 `artifact_search_docs` table in DO SQLite can drift from `artifact_pointers` when the sweep cron is interrupted or a Worker deployment races with an artifact write. tila provides two CLI commands for diagnosis and recovery.

### Diagnosing drift

Run:

```
tila doctor --search-drift
```

This calls the DO `/artifact/search-drift` endpoint and returns a structured `SearchDriftReport` with findings. Each finding has a check name, status (`fail` or `warn`), count of affected artifacts, a detail message, and example artifact keys.

**Check names:**

| Check | Status | Meaning |
|-------|--------|---------|
| `search-missing-doc` | fail | Artifact pointer exists for a searchable kind but no matching search doc |
| `search-orphan-doc` | fail | Search doc exists but no matching artifact pointer |
| `search-tombstone-leak` | fail | Tombstoned artifact pointer still has a search doc |
| `search-unsupported-kind` | warn | Search doc exists for a kind that is not marked `searchable = true` |
| `search-stale-index` | warn | Search doc body_text hash does not match current artifact content |

Zero-finding output prints `No search index drift detected.` (exit 0).

Use `--json` for machine-readable output:

```
tila doctor --search-drift --json
```

### Rebuilding the index

Run:

```
tila doctor --reconcile --search-rebuild
```

The `--search-rebuild` flag triggers a full rebuild of the FTS5 search index. The rebuild:

1. Scans `artifact_pointers` for all pointers whose kind is `searchable = true`
2. Fetches the R2 blob content for each pointer
3. Normalizes the text (strips YAML frontmatter, collapses whitespace, truncates at 64 KB)
4. Inserts or replaces the corresponding row in `artifact_search_docs`
5. Tombstones any orphaned search docs (search doc exists but pointer is missing or non-searchable)

The rebuild is **idempotent** — running it multiple times produces the same result. It is safe to run while the Worker is live. R2 content is not modified.

Note: `tila doctor --reconcile` alone handles pointer recovery (syncing `artifact_pointers` with R2 reality). The `--search-rebuild` flag additionally recovers the FTS5 index from pointer state.

## D1 Migrations

D1 (the global database) has its own migration files at `packages/worker/migrations/global/`. These are separate from the per-project DO SQLite migrations that run automatically via `blockConcurrencyWhile` on DO cold start.

D1 migrations must be applied **before** deploying a new Worker version when the update includes schema changes to the global D1 tables (tokens, projects, sessions, repos).

### Manual application

```bash
wrangler d1 migrations apply DB --remote --config .tila/wrangler.toml
```

Verify current migration state:

```bash
wrangler d1 migrations list DB --config .tila/wrangler.toml
```

Wrangler automatically captures a D1 backup before applying migrations. If a migration fails, it is rolled back and the last successful migration remains applied.

### Order of operations

1. Apply D1 migrations first (additive schema changes)
2. Deploy the Worker (`wrangler deploy`)

This order ensures the Worker code can rely on new D1 columns/tables being present.

### CI/CD automation

If you maintain your own deploy pipeline, add D1 migrations as a pre-deploy step. Example for GitHub Actions with `cloudflare/wrangler-action`:

```yaml
- uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    preCommands: wrangler d1 migrations apply DB --remote
    command: deploy
```

Known gotchas:
- Pass `--database DB` by binding name (not database ID) — the binding name matches `wrangler.toml`
- `wrangler-action` skips interactive confirmation prompts in CI (non-TTY environment)
- If migrations fail in CI, check that the `wrangler.toml` path and database binding name are correct

## Migration Safety (PITR Rollback)

Per-project DO SQLite migrations run automatically inside `blockConcurrencyWhile` on every cold start. To protect against bad migrations corrupting a DO's SQLite state, the migration runner captures a **PITR (Point-in-Time Recovery) bookmark** before applying any pending migrations.

### How it works

1. On Worker deploy, each `ProjectDO` wakes and enters `blockConcurrencyWhile`.
2. Before running migrations, the DO calls `storage.getCurrentBookmark()` and saves the returned bookmark string.
3. Migrations run as before (each in its own `transactionSync` wrapper).
4. If any migration throws an error:
   - The DO calls `storage.onNextSessionRestoreBookmark(bookmark)` with the pre-migration bookmark.
   - The error is re-thrown, causing the `blockConcurrencyWhile` callback to reject.
   - The DO crashes and Cloudflare schedules a restart.
5. On the next restart, Cloudflare restores the DO's SQLite state to the bookmark, unwinding the failed migration.
6. The same (buggy) Worker code will attempt the migration again on restart and fail again — the DO is stuck in a crash loop. **This is intentional: data is safe until a corrected deployment is pushed.**

### Operator response to a migration crash loop

1. **Identify the crashing DOs** via Cloudflare Dashboard → Workers → Durable Objects → Errors, or via `ANALYTICS` (Analytics Engine) error events.
2. **Push a corrected Worker deployment** with the fixed migration SQL. On the next cold start, the bookmark restore ensures the migration runs against the pre-failure state.
3. If a manual restore to an earlier state is needed (e.g., the bad migration was applied on a previous deploy before PITR capture was in place), use the **Cloudflare Dashboard**:
   - Navigate to Workers & Pages → Durable Objects → your DO namespace → the specific DO ID → PITR.
   - Select a bookmark from the **30-day window** and restore.

### Caveats

- PITR is only available in production (Cloudflare managed infrastructure). In local dev (`wrangler dev`) and miniflare, `getCurrentBookmark` / `onNextSessionRestoreBookmark` are not available — the migration runner's PITR path is not exercised locally.
- The 30-day PITR window is a Cloudflare platform guarantee. Bookmarks older than 30 days cannot be used for restore.
- PITR restores the full DO SQLite state. Any writes made by other operations between the bookmark and the restore are lost. For `ProjectDO`, the only writes inside `blockConcurrencyWhile` are migration-related, so this risk is limited to the migration window itself.

### C7 fence-resource convention migration (deploy guidance)

Migration 17 (C7) backfills canonical `<type>:<id>` fence rows from any pre-existing bare-id fence rows. **Deploy during low activity**: any agent that held a bare-id entity claim before deploy will have its fence superseded by the MAX-backfilled typed row on the first post-deploy request; a stale bare fence will be rejected and the agent must re-acquire. This is a one-time effect — after migration 17 runs, all new acquires use the canonical typed form and no re-acquire is needed.

## Local Development with Production Data

Use `wrangler dev --remote` to run a local Worker process that connects to your live
Cloudflare bindings (DO, D1, R2, secrets). This is useful for debugging production-only
issues or verifying Worker behaviour against real data without a full deployment.

### Command

Build the UI first, then start wrangler in remote mode:

```bash
pnpm --filter @tila/ui build && pnpm --filter @tila/worker exec wrangler dev --remote
```

### UI assets

Wrangler snapshots the UI assets from the `[assets].directory` path at startup. There is
no hot reload — the snapshot is taken once when wrangler starts. After changing UI source
files, rebuild and restart:

```bash
pnpm --filter @tila/ui build
# then restart: Ctrl-C and re-run wrangler dev --remote
```

### DO migration risk

> **Warning:** `blockConcurrencyWhile` in `project-do.ts` runs all pending SQLite
> migrations against **production** DO SQLite on the first request to each Durable Object.
> Never iterate on schema migrations while connected with `--remote` — a bad migration will
> corrupt production data and cannot be rolled back automatically. Only use `--remote` with
> a migration state that is identical to what is already deployed.

### Secrets

Secrets set via `wrangler secret put` are automatically available — no local `.dev.vars`
file is required when running `--remote`.

### D1

All D1 queries (token lookups, idempotency checks, project registry) hit the production
D1 database directly. Writes made during a `--remote` session are real and durable.

### Auth

Cookie sessions work on `localhost:8787` — the UI's API layer uses `window.location.origin`
as the base URL, so authentication flows behave the same as in production. A valid D1 API
token or GitHub session token is required.

### Restart after UI changes

After modifying any UI source file, rebuild with `pnpm --filter @tila/ui build` and
restart wrangler. The running process does not detect file changes automatically.

## One-time migration: orphaned Pages project (pre-Option-A environments)

**Affected operators:** environments first provisioned before the same-origin Static Assets
("Option A") model was adopted. In those environments, `tila infra provision` created a
Cloudflare Pages project to serve the UI. After the migration to the Worker-hosted static
assets model (Option A), re-provisioning no longer creates a Pages project — but the old
one is left behind in your Cloudflare account as an orphaned resource.

**Symptom:** After running `tila infra provision --force-redeploy` on a pre-Option-A
environment, a stale Cloudflare Pages project remains visible in the Cloudflare dashboard
(Workers & Pages → Pages). The Worker and all other resources are up to date; only the
Pages project is orphaned.

The orphaned Pages project is **benign** — the Worker now serves the UI same-origin, so the
stale Pages project serves nothing and incurs no meaningful cost. You can leave it in place.

**Do NOT run `tila infra teardown` just to remove it.** `tila infra teardown` is a *full*
account-level teardown: it refuses to run until every project is destroyed, then deletes the
Worker, R2 bucket, D1 database, GitHub App, **and** the Pages project. Running it on a live
environment would destroy that environment, not just the orphaned Pages project.

**To remove the orphan now**, delete it manually — there is no standalone CLI command for a
Pages-only cleanup:

- Cloudflare dashboard → Workers & Pages → Pages → select the orphaned project → Settings →
  *Delete project*, **or**
- the Cloudflare API: `DELETE /accounts/{account_id}/pages/projects/{project_name}`.

Otherwise, the orphan is cleaned up automatically the next time you fully decommission the
environment: `tila infra teardown` calls `deletePagesProject` idempotently as one of its
teardown steps (a no-op for environments that never had a Pages project).

## Pre-Tag Gates (env-gated, run before every release tag)

These gates exercise live infrastructure. They are **not** part of CI (no live infrastructure in CI) and must be run manually before each release tag.

### Gate 1: DO-state survival after restart

Verifies that Durable Object SQLite state survives an eviction+restart cycle. Catches any regression where state is held only in memory.

**Requirements:**
- `TILA_BASE_URL` — live worker URL (e.g. `https://your-worker.workers.dev`)
- `TILA_TOKEN` — an **admin-scoped** token. `POST /projects/:id/admin/restart` is protected by `requirePermission("admin")`. A 403 response means the token is not admin-scoped. Create one with: `tila token create --scope admin`

```bash
TILA_BASE_URL=https://your-worker.workers.dev \
TILA_TOKEN=your_admin_token \
pnpm --filter @tila/integration-tests exec vitest run src/do-eviction.test.ts
```

The test:
1. Writes a uniquely-stamped task to the live project.
2. POSTs `/_internal/projects/:id/admin/restart` — evicts the DO from memory.
3. Reads the task back — **hard assertion:** if the data is absent, SQLite persistence is broken.
4. Runs a best-of-3 read latency check — **advisory only:** fails are logged as warnings, never blocking. A latency above 5 000 ms is noted but does not fail the release.

### Gate 2: Full test suite + typecheck

```bash
pnpm run typecheck && pnpm run check && pnpm test
```

`pnpm test` includes `pnpm run test:scripts` — the `scripts/*.test.mjs` suite covering version-policy, changelog, license-in-tarball, docs-rename, and repo-hygiene checks.

### Gate 3: Biome formatting gate

`pnpm run check` (Biome `--write`) must produce no diff after running. If it reformats files, stage and commit the result before tagging. CI runs `pnpm lint` (read-only) — format drift that slips past pre-commit will cause a red CI build on the tagged commit.

See also `OSS-RELEASE-RUNBOOK.md §7` for the full pre-tag checklist.
