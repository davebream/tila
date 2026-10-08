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

### Enabling GitHub Actions OIDC exchange

Repository links do not authorize Actions OIDC exchange by default. After registering the
repository, use an admin credential to replace its complete policy:

```bash
curl --fail-with-body --request PUT \
  --header "Authorization: Bearer <admin-token>" \
  --header "Content-Type: application/json" \
  --data '{
    "enabled": true,
    "max_permission": "write",
    "subject_pattern": "repo:acme/api:*",
    "allowed_events": ["push", "workflow_dispatch"],
    "allowed_refs": ["refs/heads/main", "refs/tags/v1.2.3"],
    "allowed_environments": ["production"],
    "allowed_workflows": [
      "acme/platform/.github/workflows/deploy.yml@refs/tags/v1"
    ]
  }' \
  "https://<tila-host>/api/repos/<numeric-repo-id>/oidc-policy"
```

Read the current policy with `GET /api/repos/<numeric-repo-id>/oidc-policy`. PUT is full
replacement: omitted fields fail validation. Events, refs, environments, and complete workflow
refs use exact matching. Only `subject_pattern` supports a wildcard, where case-sensitive `*`
matches zero or more characters across the full subject.

When either refs or environments are configured, one of those two context values must match. All
other configured categories must also match. A constrained environment or reusable workflow claim
that GitHub omitted is denied. See
[`docs/10-AUTH-IMPLEMENTATION.md`](10-AUTH-IMPLEMENTATION.md) for the full evaluation model and
branch, tag, environment, and reusable-workflow examples.

Migration `0024_repo_oidc_policy.sql` explicitly disables OIDC exchange and resets the maximum
permission to `read` for every existing repository link. The provisioning command prints one
warning with the affected link count only when that migration is first applied. It does not warn
for a fresh database with no links or on subsequent provisioning runs. Existing minted sessions
remain valid until their normal expiry; the new policy is checked before every later exchange or
cached replay.

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

The scheduled cron handler calls `runSweep(env)` directly (`scheduled()` in `packages/worker/src/index.ts`) — it does **not** go through the HTTP endpoint, so `SWEEP_SECRET` is not required for the cron to run. `SWEEP_SECRET` only authenticates the manual `/_internal/sweep` HTTP trigger. It is **not** the same key as `INFRA_ADMIN_TOKEN` and must be stored as a separate Worker secret.

#### Setup

Generate a 32-byte random value and store it as a Worker secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
wrangler secret put SWEEP_SECRET
```

If `SWEEP_SECRET` is missing, the scheduled cron sweep still runs (it calls `runSweep` directly and does not use the secret); only the manual `/_internal/sweep` HTTP trigger returns 403. You can verify the secret is set by running:

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

## Auth: Revocation & Pepper Rotation

Operational procedures for the multi-instance auth controls. The timing guarantees and the
constants behind them are documented once in
[`docs/13-MULTI-INSTANCE-AUTH.md`](13-MULTI-INSTANCE-AUTH.md) — this runbook covers the *steps*.

### Revoke a principal (bulk kill-switch)

To lock out a user across a project, write a `_revoked_subjects` tombstone for the canonical
principal `(project_id, identity_host, subject_id)` via the admin revoke entry point. Effect is
**instant on the revoking isolate** and propagates to other isolates within the cross-isolate cache
window; an unrevoked session otherwise expires on its own within its tier TTL. For the exact SLA and
the cache-window value, see [`docs/13`](13-MULTI-INSTANCE-AUTH.md) § Revocation and SLA. To revoke a
single session instead of a whole principal, use the per-`jti` kill-switch (see
[`docs/01-DECISIONS.md`](01-DECISIONS.md) § C9). The revocation read fails closed — if D1 is
unavailable the request is denied, not allowed.

### Revocation garbage collection

Revocation tombstones are bounded, not unbounded: the daily cron sweep
(`packages/worker/src/lib/sweep.ts`) prunes expired `_revoked_subjects` and `_revoked_jti` rows
once they are older than the retention window (long enough to outlive any session they suppress —
value in [`docs/13`](13-MULTI-INSTANCE-AUTH.md)). Sweep failures are logged and non-fatal; no manual
GC is normally required. If tombstone growth is ever a concern, confirm the cron is firing via
`wrangler tail` (look for `[sweep] pruned … revoked … rows`).

### Rotate `HASH_PEPPER`

> **`HASH_PEPPER` rotation is a breaking change — not zero-downtime.** Setting or rotating it changes
> every token digest; a zero-downtime dual-verify path is a tracked follow-up that is not yet
> implemented. See [`docs/13`](13-MULTI-INSTANCE-AUTH.md) § Migration Guide for the rationale.

Steps:

1. Set the new secret: `wrangler secret put HASH_PEPPER` (enter the new value at the prompt).
2. **Re-issue every D1 API token** — tokens hashed under the old pepper no longer validate. Notify
   token holders and issue replacements via the normal token-creation flow.
3. Cookie/workspace sessions re-authenticate automatically within their TTL; no action needed beyond
   informing users they may be prompted to log in again.

Do not rotate `HASH_PEPPER` expecting a grace period — plan the re-issue before rotating.

## Troubleshooting

Common failure modes and remediation steps.

| Symptom | Likely cause | Remediation |
|---------|-------------|-------------|
| `worker-reachable` FAIL | Worker not deployed or URL misconfigured | Check `.tila/config.toml` `worker_url`; run `wrangler deploy` |
| `d1-reachable` FAIL | Token invalid or D1 not provisioned | Run `tila token list`; re-run `tila project create` |
| `do-reachable` FAIL + 502 | DO cold start race or DO eviction in progress | Retry once; if persistent, run `tila doctor --json` for structured output |
| `doRttMs` > 200ms | Smart Placement not yet converged or disabled | Check `wrangler.toml` `[placement] mode = "smart"`; wait 24h for convergence |
| `expired-claims` WARN | Sweep cron did not run | Check `wrangler tail` for sweep errors; trigger manually via `/_internal/sweep` if needed |
| `journal-size` WARN (>= 10,000 rows) | High write volume without recent archival | Run the journal archive operation, then create and verify a project backup |
| `search-missing-doc` FAIL | Index drift from interrupted sweep | Run `tila doctor --search-drift --search-rebuild --apply` |
| R2 objects absent, no `artifact.expired` journal events | R2 lifecycle backstop fired | Run `tila doctor --reconcile --apply` to sync DO state with R2 |
| Schema version mismatch in Worker logs | Worker and DO on different schema versions | Redeploy Worker: `wrangler deploy`; DO migrates on next request |
| `HMAC_NOT_CONFIGURED` on GitHub exchange | HMAC signing key not set | Generate key and run `wrangler secret put GITHUB_SESSION_HMAC_KEY`; see [Authentication Setup](#authentication-setup) |
| `REPO_NOT_REGISTERED` on GitHub exchange | Repo not in project allowlist | Run `tila infra provision` from the repo root |
| `SESSION_EXPIRED` during CLI operation | Session older than 1 hour or revoked | Re-run the CLI command (auto-refreshes); check server/client clock sync |
| `PERMISSION_INSUFFICIENT` on GitHub exchange | No enabled repository link admits the user under its current thresholds and cap | Check collaborator access and the link's complete access policy with `GET /api/repos/:repoId/access-policy` |
| GitHub exchange succeeds, CLI errors on API call | Git remote doesn't match `[github]` config | Check CLI warning about remote mismatch; update `.tila/config.toml` `[github]` section |

## Backup and Recovery

### Create and verify a backup

```bash
tila project export --output /absolute/path/project.tila-backup
```

Export refuses to overwrite its destination. It freezes writes, leaves reads available, streams a consistent snapshot, verifies the final manifest and checksums, rechecks the D1 ACL digest, then unlocks. A failed client eventually releases an export lock through its renewable TTL; missing blobs, archive gaps, contradictory journal ranges, corruption, duplicate paths, and unsafe paths fail visibly and do not produce a completed archive.

The archive deliberately excludes bearer credentials and hashes, sessions, rate limits, idempotency caches, revoked JTIs/subjects, and deployment-global metadata. Store the archive outside the source Cloudflare account. Archives are not encrypted; protect them with the storage system's encryption and access controls.

### Restore, resume, and roll back

```bash
# New local destination
tila project import /absolute/path/project.tila-backup --local

# Replace the configured project (prompts for its exact slug)
tila project import /absolute/path/project.tila-backup --replace

# Continue a matching fail-closed session
tila project import /absolute/path/project.tila-backup --resume

# Restore the adjacent timestamped pre-restore safety archive
tila project import /absolute/path/project.tila-backup --rollback
```

Use `--force` only to skip typed confirmation in automation. Existing restore automatically creates `<timestamp>-<project>-pre-restore.tila-backup` beside the input archive. After that verified export, the same cloud lock is promoted to a non-expiring import lock: the project stays hidden and all normal access returns `423 project-maintenance` until finalize, resume, or rollback verifies the semantic digest. Existing destination tokens and revocation tables remain untouched. A new cloud destination receives one fresh bootstrap token after successful ACL restore; source credentials never cross the archive boundary.

Local replace builds and verifies sibling temporary database/artifact paths before swapping them. A pre-swap failure leaves the original untouched. Cloud restore uploads checksum-addressed R2 bytes before DO pointers, restores DO rows in dependency order and the exact journal sequence, replaces approved D1 ACL metadata in a batch, rebuilds FTS, then unlocks.

Cross-backend restore supports local→local, cloud→cloud, local→cloud, and cloud→local without changing the project ID. Source account and GitHub installation identifiers remain in the manifest for audit. `cloudflare_account_id` stays the destination value. GitHub installation metadata is retained only when already usable at the destination; otherwise restore warns and requires reconnection.

### Recovery scenarios

| Scenario | Recovery path |
|----------|--------------|
| DO eviction (idle, normal) | Automatic -- state survives in DO SQLite, cold start adds ~50-100ms |
| DO evicted, state intact | `tila doctor` to verify; `tila doctor --reconcile` if R2 drift suspected |
| Partial R2 loss | `tila doctor --reconcile --apply` to sync DO pointers with remaining R2 objects |
| Full project-store loss | Import the latest verified `.tila-backup`, then run `tila doctor` |
| Intentional reset | `tila reset --force` |

### Recovery objectives and unsupported cases

- **RPO (data-loss window):** time since the latest verified export. A completed archive is consistent at its maintenance-freeze boundary.
- **RTO (recovery duration):** depends on row count, blob bytes, and network throughput. Export/import report measured rows, bytes, and elapsed time; format v1 has no fixed recovery-time SLA.
- Unsupported: project renaming, online/no-downtime restore, encrypted archives, secret-bearing annexes, and importing a newer unsupported DO migration.

Run a recovery drill periodically: seed representative entities, relationships, claims/fences, schemas, records/revisions, live and archived journal events, tombstones, ACL rows, and blobs; export; isolate or destroy the source; import into a clean destination; compare the reported semantic/blob digests; then perform one fenced write. Record archive bytes plus export/restore elapsed time.

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

First request after idle eviction pays the DO startup cost; measure it with the `cold-start` benchmark scenario against your deployment (`docs/benchmarks/README.md`; the project baseline is in `docs/benchmarks/BASELINE.md`). Subsequent requests are fast. There are no user-configurable knobs to prevent eviction in v0.1. The idle window before eviction is not measured by tila; do not poll a DO to find it, every request resets the timer.

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

D1 migrations must be applied **before** deploying a new Worker version when the update includes schema changes to the global D1 tables (tokens, projects, sessions, repos). For example, `0028_session_authenticated_at.sql` adds the column that session creation writes; a Worker deployed ahead of it cannot create browser sessions.

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

### V23 canonical identity migration (deploy guidance)

Migration 23 intentionally clears active claims and presence rows because legacy rows do not contain a recoverable participant identity. Fence counters are preserved unchanged, so reacquiring never reuses a stale fence. Historical journal rows are retained and marked with explicit `legacy-principal:<actor>` and `legacy-event:<seq>` identities. The corresponding D1 migration clears browser sessions that lack a stored immutable principal, requiring affected users to authenticate again.

Migration 25 intentionally discards pending legacy signals while rebuilding signal storage around canonical principal/participant identities. Legacy signal targets and acknowledgers were display-name strings and cannot be authorized safely. Their TTL was capped at 24 hours, so the migration does not preserve or translate them. New signals use immutable per-participant deliveries and principal-based group membership.

Deploy upgraded clients with the Worker. Older clients may continue reading the clean claim, presence, and journal response shapes, but mutations without `X-Tila-Participant-Id` fail with `400 participant-required` and an upgrade message.

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
- `TILA_TOKEN` — an **admin-scoped** token. `POST /projects/:id/admin/restart` is protected by `requirePermission("admin")`. A 403 response means the token lacks admin permission. Issue one with: `tila token issue --name <name>` from an admin credential.

```bash
TILA_BASE_URL=https://your-worker.workers.dev \
TILA_TOKEN=your_admin_token \
pnpm --filter @tila/integration-tests exec vitest run src/do-eviction.test.ts
```

The test:
1. Writes a uniquely-stamped task to the live project.
2. POSTs `/projects/:id/admin/restart` — evicts the DO from memory.
3. Reads the task back — **hard assertion:** if the data is absent, SQLite persistence is broken.
4. Runs a best-of-3 read latency check — **advisory only:** fails are logged as warnings, never blocking. A latency above 5 000 ms is noted but does not fail the release.

### Gate 2: Full test suite + typecheck

```bash
pnpm run typecheck && pnpm run check && pnpm test
```

`pnpm test` includes `pnpm run test:scripts` — the `scripts/*.test.mjs` suite covering version-policy, changelog, license-in-tarball, docs-rename, and repo-hygiene checks.

### Gate 3: Biome formatting gate

`pnpm run check` (Biome `--write`) must produce no diff after running. If it reformats files, stage and commit the result before tagging. CI runs `pnpm lint` (read-only) — format drift that slips past pre-commit will cause a red CI build on the tagged commit.

### Gate 4: Coordination benchmarks

Run the deployed benchmark matrix against a throwaway project and compare it with the previous baseline. CI only runs the in-process smoke subset; this gate is the only place deployed throughput and tail latency are measured. Full methodology, flags and the throwaway-project flow are in `docs/benchmarks/README.md`.

**Requirements:** `TILA_BASE_URL`, `TILA_TOKEN` (full-scope token of the throwaway project; `cold-start` needs it for `POST /admin/restart`), `TILA_PROJECT_ID`, and `TILA_BENCH_ALLOW_REMOTE=1`.

```bash
TILA_BENCH_ALLOW_REMOTE=1 TILA_BASE_URL=https://your-worker.workers.dev \
TILA_TOKEN=<throwaway project token> TILA_PROJECT_ID=tila-bench-<date> \
pnpm bench -- --tier http --scenario all --participants 8 --duration 30s --warmup 5s --md
# then: claims-contended --mode owner --participants 24, claims-uncontended --cadence 500ms --participants 6, cold-start
pnpm bench:report -- --in packages/bench/results --out docs/benchmarks/BASELINE.md
```

What to compare against the previous `docs/benchmarks/BASELINE.md`:
1. **Hard:** every scenario reports `PASS` for all invariants and an error rate of 0. A failing invariant (a second winner on an exclusive claim, an accepted stale fence, a journal gap) blocks the tag.
2. **Advisory:** p95 for `acquire`, `update`/`set`, `send` and `replay` within ~25% of the previous deployed baseline on the same colo; `missed_cadence_deadlines` of the 500 ms cadence run stays 0; `cold_first_request` p50 has not doubled. Investigate regressions beyond that before tagging; they are not automatically blocking because colo, time of day and Cloudflare load move the numbers.
3. Commit the regenerated `BASELINE.md` with the release. Raw JSON stays in `packages/bench/results/` (gitignored).

Also run this gate after any material change to claims, fences, journal, signals, presence or artifact metadata paths, not only before tags.

See also `OSS-RELEASE-RUNBOOK.md §7` for the full pre-tag checklist.

---

## Admin Bootstrap: Break-glass Seeder and CI Token Fallback

This section covers the two admin-bootstrap escape hatches for cases where the normal admin roster is empty (chicken-and-egg bootstrap state).

### Break-glass `/_internal` seeder

The `POST /_internal/admin/projects/:projectId/admins` endpoint seeds an admin directly in D1 without going through the roster auth check. It is guarded by `requireInfraPrincipal` (the `INFRA_ADMIN_TOKEN` Worker secret):

- The endpoint is **404-invisible** when `INFRA_ADMIN_TOKEN` is unset — it does not exist until the secret is configured.
- Authentication: `Authorization: Bearer <INFRA_ADMIN_TOKEN>` header.
- The endpoint writes D1 only and never materializes the Durable Object.
- Accepts `{ github_user_id: <number> }` or `{ login: "<string>" }` (server resolves login via the GitHub App).
- Returns `{ ok: true, github_user_id, granted }` on success; 422 on login-unresolved (GitHub App not configured); 404 on unknown project.

**When to use:** CI pipelines where a Worker is deployed and the GitHub App is configured, but no admin has been seeded yet.

```bash
# Seed an admin via the break-glass seeder
curl -X POST https://<worker-url>/_internal/admin/projects/<projectId>/admins \
  -H "Authorization: Bearer $INFRA_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"github_user_id": <your-github-user-id>}'
```

### `TILA_TOKEN` / `--token` CLI bootstrap fallback

The `tila admin` command group accepts a full-scope D1 init token as a bypass credential. When supplied, it creates the HTTP client directly (no Cloudflare auth steps required — no `CLOUDFLARE_API_TOKEN` needed).

**Token precedence:** `--token` flag > `TILA_TOKEN` env var > normal `resolveContext()` token resolution.

**Security:**
- Prefer `TILA_TOKEN` (env var) over `--token` — the `--token` value is visible to other local users in `ps aux`.
- `TILA_TOKEN` is a full-scope secret: mask it in CI logs and do NOT set it in persistent shell rc files (`.bashrc` / `.zshrc`). Treat it with the same care as `CLOUDFLARE_API_TOKEN`.
- The admin commands never persist the token to disk.
- Only **full-scope** D1 tokens bypass the admin roster check. Read-only or project-scoped tokens are denied.

**When to use:** CI automation where the roster is empty and you hold the full-scope D1 init token issued by `tila project create`.

```bash
# In CI (preferred — env var is not visible in ps aux)
export TILA_TOKEN=<your-d1-init-token>
tila admin grant <github-user-id>

# Interactive one-off (--token is visible in ps aux — a warning is printed)
tila admin grant <github-user-id> --token <your-d1-init-token>

# List current admins to verify
tila admin list
```

The full-scope D1 init token is printed by `tila project create` in `--json` mode (`result.token` field) and written to `.tila/.env` on disk. It bypasses `requireProjectAdmin` at `packages/worker/src/middleware/require-project-admin.ts` lines 117-122.


## Protected operations unavailable during permission verification

A `503 permission-recheck-unavailable` response means a mirrored GitHub membership
could not be verified. The write or administrative operation has not run. Ordinary
reads remain governed by existing authentication and D1 membership checks.
Explicit Tila memberships that independently authorize the operation, and service
principals using those memberships, do not depend on GitHub availability.

| Response detail | Operator action |
|---|---|
| Missing or invalid `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | Configure the deployed Worker's App ID and matching private key; never expose the private key in logs |
| Missing installation or GitHub installation-token 404 | Confirm the App is installed and linked to the project, with access to the selected repository; reinstall/relink if needed |
| GitHub error with `retryable: true` | Check GitHub availability/rate limits and retry after 10 seconds |
| D1 error or `membership-unavailable` | Restore D1 availability; the request must not fall back to session authority |
| `401 unauthorized` requesting sign-in | Exchange a fresh bearer session carrying a revocable `jti` |

Confirmed loss of collaborator permission returns `403 permission-revoked`, distinct
from unavailable verification. Do not solve an outage by granting new membership
unless that grant is independently intended. Existing explicit owners and bootstrap
credentials retain their own authorization and revocation rules.

GitHub observations and settled failures are cached per isolate for up to 60 seconds;
transient failures are cached for 10 seconds and remain denied throughout backoff.
Current D1 installation/repository policy is checked before cached grants. External
uninstall/revocation becomes visible when the verified entry expires or is invalidated;
there is no cross-isolate instant-invalidation guarantee. After expiry, failure to
verify denies the operation without using the stale grant.

## Scoped service credentials (#185)

Integrations authenticate as stable project service principals (`service:<uuid>`).
A credential version identifies a secret, while `X-Tila-Participant-Id` identifies
a running participant. Rotation changes the version, preserving the principal and
canonical membership. Domain mutations keep both principal and participant
attribution. Credential audit events record the authenticated principal, version,
target and timestamp; they never contain bearer secrets or secret hashes.

### Migration and compatibility

Apply `packages/worker/migrations/global/0027_scoped_credentials.sql` to D1 **before**
deploying the Worker and updated clients. It preserves existing token hashes, IDs,
memberships and historical attribution, and adds service accounts, logical
credentials, secret versions, workload bindings and audit events. No CI changes or
automatic deployment are part of this change. Review and merge the authentication
change explicitly before deploying it.

Existing `full` keys retain their legacy compatibility policy. The old SDK
`tokens.issue(name, note?)` signature remains supported, but legacy issuance is
deprecated with no removal date. Only a legacy full bearer key can issue another
legacy full key. Existing GitHub and OIDC login flows and canonical human memberships
remain supported. Native services use the existing membership API to change roles.
Project backups preserve service identities, workload bindings and audit history;
API secrets are excluded, as with existing token backups. Issue fresh keys after a
restore. Old secret versions do not become valid merely because metadata is restored.

### Issuance examples

Create a service with the required membership, then copy its returned `principal_id`
into issuance. Owner membership and the explicit management capability are required
for scoped callers; a legacy full bearer remains a bootstrap administrator.

```sh
tila service-account create --name reporter --display-name "Read-only reporting" --role viewer --json
tila token issue --name reporter-key --principal 'service:<uuid>' --preset read-only --json

# Coordination only: create this service with participant membership.
tila token issue --name coordinator --principal 'service:<uuid>' --preset coordination-only --json

# Upload artifacts without deletion: participant membership.
tila token issue --name publisher --principal 'service:<uuid>' --preset artifact-writer --json

# Exact task types and slash-delimited record prefixes: participant membership.
tila token issue --name team-a --principal 'service:<uuid>' --role participant \
  --capabilities tasks:read,tasks:write,records:read,records:write \
  --restrictions '{"task_types":["task"],"records":[{"type":"config","key_prefixes":["team/a"]}]}' --json
```

The updated CLI requires a principal and defaults to the viewer/read-only preset.
SDK object issuance accepts `{ name, principal_id, policy?, expires_at?, jkt? }`;
omitting `policy` with a principal selects the same read-only preset. Presets expand
to explicit capability lists, never wildcards. Use `tila token inspect --json` or
`GET /api/whoami` to inspect principal, effective role/capabilities, restrictions,
expiry and legacy status. `GET /api/tokens` also returns logical/version IDs, policy,
effective policy, status, expiry and version retirement deadlines, without secrets.

Absent namespace restrictions mean unrestricted; empty arrays grant nothing.
Task types match exactly. Record prefix `team/a` permits that key and descendants
such as `team/a/config`, but excludes `team/ab`. Lists filter before counts and
pagination. Restricted keys cannot use project-wide search, journal, summary,
exports, artifact access or global maintenance. Unsafe derived task views are
also denied, including journal replay, handoffs, and re-entry. Unrestricted
handoff access requires journal, task, record, artifact, and claim read capabilities;
creation also requires `tasks:write`. Re-entry additionally requires summary and
signal reads. Updating a journal cursor requires `journal:read` and at least
participant membership. Template expansion checks every generated task before any write.
Ordinary writes do not imply delete: archive/unarchive and relationship removal
require explicit delete capabilities. A service promotion cannot expand a key's
issuance ceiling; demotions and revocations immediately reduce current authority.

### Expiry, rotation and revocation

New scoped keys expire after 90 days. Owners can specify an ISO timestamp or Unix
seconds with `--expires`, or explicitly request `--expires never`. Save the returned
secret once: it is never persisted for response replay.

```sh
tila token rotate reporter-key --expected-token-id '<current-version-uuid>' --json
# Optional overlap, capped at 86,400 seconds:
tila token rotate reporter-key --expected-token-id '<current-version-uuid>' --overlap-seconds 60 --json
tila token revoke reporter-key --json
tila service-account revoke 'service:<uuid>' --json
```

Rotation returns 409 for stale/concurrent version IDs and preserves policy and DPoP
binding. Previous secrets retire immediately unless overlap is explicit. Subsequent
rotations cannot extend an earlier retirement deadline. Revoking a logical
credential rejects every version and derived browser session. Service revocation
atomically disables its credentials, membership and workload bindings, while
preserving last-owner protection.

Every request revalidates D1 credential/session/binding and membership state against
the primary database; positive authentication caches never establish continuing
validity. Lookup failures fail closed with retryable errors. Revocation applies to
requests authenticated after its commit, not mutations already authorized and
executing. Scoped responses use `Cache-Control: no-store`. Retry identities include
credential version and policy; resource authorization precedes transactional DO
replay. Unbound keys may create cookies with the same lineage and capped expiry;
DPoP-bound keys cannot exchange into cookies.

### Workload bindings

Owners configure exact verified issuer/subject mappings to service principals:

```sh
tila service-account workload create 'service:<uuid>' --name ci --provider github-actions \
  --issuer https://token.actions.githubusercontent.com \
  --subject 'repo:owner/repository:ref:refs/heads/main' --preset artifact-writer --json
tila service-account workload list 'service:<uuid>' --json
tila service-account workload update 'service:<uuid>' --binding '<binding-uuid>' --preset read-only --json
tila service-account workload revoke 'service:<uuid>' --binding '<binding-uuid>' --json
```

Both existing exchange endpoints accept these bindings after validating the
upstream signature, configured issuer/audience and existing repository/workflow
restrictions. Generic OIDC bindings use `--provider oidc`. The optional `jkt` exchange
field binds the resulting opaque bearer to the existing DPoP proof verifier.
Unconfigured identities retain existing compatibility flows. A revoked binding
remains a tombstone so its subject cannot fall back into an unrestricted exchange.

Workload sessions last at most 15 minutes and cannot outlive the upstream assertion.
Each assertion exchanges once; replay returns 409 without storing a reusable secret.
Get a new upstream assertion for renewal. Issued sessions retain their original
policy and intersect it with current binding policy and membership on every request.
Tighter binding policy is immediate; later expansion does not expand an old session.
Monitor `authorization/denied` and `auth/lookup` analytics alongside ordinary request
errors and latency. Telemetry excludes bearer credentials and hashes.

### Browser administration (#102)

The dashboard's **Settings** page (`/p/<project>/settings`) lets a project owner
administer memberships and credentials from a browser session. It is an
observation and administration surface only: it never launches, assigns,
schedules, cancels or retries agents, and it exposes no project destroy or
archive operation.

What it can do:

- List explicit memberships (GitHub, OIDC and service principals), change roles,
  revoke memberships and grant new ones. GitHub logins are resolved to numeric
  user ids in the browser via GitHub's public API, so explicit-membership projects
  need no GitHub App. A manual id field covers lookup failures and rate limits.
- Change the membership policy mode. Leaving `explicit` asks for confirmation
  because it widens access to GitHub collaborators.
- Show the mirrored-access policy of each linked repository (`membership_enabled`
  and `membership_role_cap`) and explain where the caller's own role comes from.
  Mirrored members are evaluated per request and are **not** materialized, so they
  cannot be listed.
- List credentials with principal, status, effective policy, expiry and last-use
  metadata, and revoke them with a typed-name confirmation. No secret material is
  ever requested or shown.

What it cannot do: issue or rotate credentials (use the CLI commands above),
delete service accounts, or destroy/archive the project.

Controls render only when `GET /auth/session/status` reports
`capabilities.memberships_manage` / `capabilities.credentials_manage`. The Worker
computes those flags with the same explicit-owner checks that guard the routes;
GitHub repository permission, the legacy `permission` field and `scopes:"full"`
are never consulted. When the membership store cannot be reached the flags are
false and `membership_available` is false, and the page shows an unavailable
state with no controls.

Mutations from an interactive cookie session additionally require a recent
sign-in (step-up reauthentication). A session older than
`STEP_UP_MAX_AGE_SECONDS` (default 600) receives `403 step-up-required`; the UI
offers to sign in again and returns to the page afterwards without replaying the
change. Set the optional `STEP_UP_MAX_AGE_SECONDS` secret to adjust the window.
Bearer credentials cannot re-authenticate interactively and are exempt. Migration
`0028_session_authenticated_at.sql` records the authentication time and must be
applied before deploying this Worker.

## Journal continuity and archival recovery

Migration 26 adds durable participant cursors, immutable handoffs, and handoff
reference indexes to the shared cloud/local schema. Project export, restore,
diagnostics, and destruction include these tables. The backup SDK accepts schema
versions through 26; older backups restore with empty continuity tables.

The continuity HTTP surface is project-scoped: `GET /journal/replay`,
`GET /journal/cursor`, `PUT /journal/cursor` with `{ "seq": n }`, `POST /handoffs`,
`GET /handoffs`, `GET /handoffs/:id`, and `GET /reentry`. All require an authenticated
principal and `X-Tila-Participant-Id`. Reads require project read access; cursor and
handoff writes require write access. These responses bypass shared caches.

Re-entry reads database state and the replay boundary in one transaction, then
streams immutable archives. New archive objects retain canonical principal,
participant, and environment fields, carry sequence-range metadata, and use keys
containing both the batch's upper sequence and the object's first sequence. This
prevents overlapping archive runs from overwriting different ranges. Deletion is
confirmed only after every object write succeeds. Age-based archival stops at the
first recent sequence, even if subsequent event timestamps move backwards.

Existing JSONL archives remain readable. Missing identity fields are represented
with the migration's `legacy-principal:<actor>` and `legacy-event:<seq>` markers;
historical authenticated identity cannot be reconstructed. Legacy objects without
range metadata require streaming scans, so replay of old history can be slower.
A missing/corrupt archive produces `journal-history-unavailable`; conflicting
versions of a sequence produce `journal-history-conflict`. Neither advances the
saved cursor. Restore missing history from a verified backup before retrying;
do not acknowledge past unavailable history as a repair.

## Versioned artifact lifecycle

Migration 28 applies configured per-kind retention to existing revisions using
one persisted policy snapshot. A non-head revision older than `retention_days`
can become immediately eligible. Before deploying, review configured retention
and take a project backup if old content must remain available. Zero or omitted
retention keeps content indefinitely. Live heads are protected regardless of age.

The daily sweep and shared DO alarm process `artifact_lifecycle_operations`.
Failures retain their work item, increment attempts, and retry with exponential
backoff capped at one hour. The sweep response includes lifecycle deleted/error
counts and a pending indicator. An unavailable R2 bucket cannot authorize byte
deletion; failed tombstone HTTP responses also prevent the legacy sweep deleting
content. Embedded callers can run `artifacts.drainLifecycle()` explicitly.

A 410 `artifact-unavailable` response means the revision is known but its content
has been removed; history/meta still return its metadata. The seven-day grace
applies to pointer rows, not to availability of deleted bytes. Group destruction
permanently retires a lineage while retaining revision metadata. It requires a
current lineage fence and returns 202 once retirement is durable; physical cleanup
continues in the background. Retrying an accepted request with its original
idempotency key is safe after lease expiry.

Preserve all commit and lifecycle JSON records under `versioned/` during manual
maintenance. They are required to recover deletion state after SQLite loss.
Never add a bucket lifecycle rule that expires this prefix. The provisioning
rules keep the existing 365-day `produced/` backstop and one-day incomplete-upload
cleanup. Backup/restore carries lifecycle records and metadata; full project
destruction also removes the private versioned prefix.

## Coding-client lifecycle integration

The opt-in lifecycle adapters support **Claude Code CLI and Codex CLI on macOS
and Linux**, using a configured Cloudflare-backed Tila project. Existing manual
CLI/MCP use and local mode remain available. Desktop clients, Conductor-managed
sessions, Windows, and independent subagent participants are outside this initial
integration. Tila never takes control of client execution.

### Install and remove

Use a CLI and MCP server build that both include lifecycle support. From the
project root, with normal Tila authentication already configured:

```sh
tila lifecycle install claude-code --dry-run
tila lifecycle install claude-code
# Or, for Codex (the default shared daemon is supported):
tila lifecycle install codex --dry-run
tila lifecycle install codex
```

Restart the client, review the installed hooks, and approve its normal project
and hook trust prompts. Installation does not grant trust or override managed
policy. Codex hooks must be enabled, and `codex app-server proxy --help` must be
available. Claude Code must use its native CLI installation (opaque Node/npm
launch wrappers cannot be identified safely) and support SessionStart, SessionEnd, UserPromptSubmit,
PreToolUse, Stop, and `CLAUDE_ENV_FILE`. Codex must supply `sessionId` (or root
`threadId`) in MCP request metadata. Missing MCP session metadata fails with a degraded state instead of silently
sharing a participant. If no session appears in lifecycle status after startup,
verify hook support, configuration, and trust in the client. See the supported
[Claude hook interfaces](https://code.claude.com/docs/en/hooks) and
[Codex hook interfaces](https://learn.chatgpt.com/docs/hooks).

| Client | Project hooks | Project MCP configuration |
| --- | --- | --- |
| Claude Code | `.claude/settings.local.json` | `.mcp.json` |
| Codex | `.codex/hooks.json` | `.codex/config.toml` |

The installer preserves other hook commands and MCP entries. It adds
`TILA_LIFECYCLE_CLIENT` only to the Tila MCP entry. If no Tila entry exists, it
creates `npx -y tila-mcp-server`; source checkouts should configure their existing
source MCP command first. It records ownership under the private `$TILA_HOME/client-lifecycle/installations`
directory (default `~/.tila/client-lifecycle/installations`) and refuses to
replace a Tila MCP entry subsequently edited by the user. JSON/TOML formatting and
TOML comments may change during serialization; configuration values are preserved.
Dry-run reports affected files without exposing configuration secrets.

```sh
tila lifecycle status
tila lifecycle retry                 # Retry incomplete clean shutdowns
tila lifecycle remove claude-code
tila lifecycle remove codex
```

Removal deletes only the installed hook commands and restores the previous Tila
MCP entry. Restart the client after removal. Existing helper processes finish
with their sessions; removal does not kill a client or discard pending cleanup.
Lifecycle state remains available for diagnosis and retry.

### Identity, presence, and shutdown

Each native session gets a stable participant scoped to Worker URL, project, and
client. The adapters attach machine, repository, worktree, branch, commit, client,
and version metadata. Claude shell commands inherit the participant through
`CLAUDE_ENV_FILE`; Codex shell commands resolve their `CODEX_THREAD_ID`. Explicit
CLI participant overrides retain precedence. MCP tool calls resolve identity for
each request, so one Codex daemon connection can serve concurrent sessions safely.
Codex subagent MCP calls use their parent session's identity. MCP resources and
prompts retain their existing read-only connection identity.

Startup/resume supplies a bounded re-entry page containing summary, changes,
active claims, pending signals, and the latest handoff. Later hooks confirm the
observed cursor. Presence updates run every 15 seconds while client liveness is
verified. Claim leases are not automatically renewed.

A clean SessionEnd queues a handoff containing coordination facts only, then
acknowledges observed journal events and releases eligible claims. Owner claims
are preserved; release always uses the captured fencing token. Cleanup can finish
after the client exits. A crash sends no fabricated handoff or acknowledgment and
lets leases expire. In default Codex mode, closing a frontend connection can leave
the daemon's thread alive; the session ends according to Codex's SessionEnd rules,
not merely when a terminal disappears.

Network failures do not block local work. Hook stderr and `tila lifecycle status`
report degradation; the next prompt retries re-entry. If the Codex observer cannot
verify thread status, heartbeats pause. Failed clean shutdowns remain `closing`
with retryable intent; repair connectivity/authentication and run `tila lifecycle
retry` before resuming that session. A killed local lock holder may take ten
seconds to become recoverable. Never delete a live session's state to force cleanup.

The implementation drives actual CLI hooks and detached helpers for two concurrent
native-client fixtures and SIGKILL against the shared SQLite backend, plus hook
installation/removal and interleaved MCP metadata.
Upstream client behavior is represented by protocol fixtures; a real-client smoke
check remains advisable when upgrading either client. The separate Incur trial in
`experiments/incur-parity` documents why this integration retains existing frameworks.

## Repository CI

Pull requests and main pushes run read-only lint/version checks, typechecking,
package tests, root script tests, and a high-severity dependency audit. Secret
scanning runs independently. The required `ci` check succeeds only when every
required job succeeds, including after failures, cancellations, or skips.

New pushes cancel superseded runs for the same PR. Main and release runs are not
cancelled by this policy. Full validation is also available through the CI
workflow's manual dispatch and runs daily at 04:17 UTC; those runs bypass Turbo
result reuse. Diagnostic artifacts retain command logs (including test counts),
step timings, and Turbo run summaries for seven days, including on failures.

### Cache correctness and affected-selection rollout

Root Turbo commands resolve the checked-out revision and runtime/platform identity
before computing task hashes. CLI/SDK/DO version modules are generated, ignored
outputs; run the documented root commands or the package version generators before
invoking compilers directly. Worker dry-run output is explicit and cacheable.

PRs restore caches only. Successful main verification saves download and Turbo
caches keyed by toolchain, lockfile and commit. Release output must be built fresh.
Environment-gated integration tests are not cached. CI still runs the full suite:
the affected task list is recorded in `selection.json` for observation only.
Enable selective execution in a follow-up change only after ten paired PR runs
prove selection includes required tests for schema, SQLite, migration, SDK, UI,
installer, root-config and lockfile changes. Missing Git history falls back to full
execution. Revert to full selection immediately if any dependency is missed.

Manual CI dispatch with `benchmark=true` runs the baseline and Turbo concurrency
2/4 × Vitest workers 1/2, three times each on one revision. It does not tune CI
automatically. Select the lowest median with no failures and at most 10% extra
runner time; retain the baseline if none qualifies. Reports last seven days.
