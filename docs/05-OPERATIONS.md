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

### Human accounts, invitations, and CLI login

Apply `0032_human_accounts.sql` before deploying this version. It adds Better Auth
users, password/OAuth accounts, browser/device sessions, invitation and recovery
records, and native `user:<uuid>` project identities. Existing memberships and API
credentials are preserved. New token-to-browser exchanges return `410`; existing
legacy cookies retain their existing expiry and revocation checks. A valid legacy
bootstrap cookie without canonical project membership returns
`401 account-migration-required`; the browser shows account sign-in and recovery
guidance instead of opening a dashboard that subsequently denies access. Direct
bearer use of the bootstrap token retains its existing API authority. The cookie
does not inherit that authority, and retrying it cannot create membership.

Browser access uses email/password. Open registration is disabled. Email delivery
is optional: administrators can copy invitation and password recovery links from
**Account** and share them privately. An invitation names an email, account role,
and optional project membership; it expires in seven days and can be used once.
Manually shared invitations do not mark email ownership as verified.

Create the first administrator with the infrastructure owner's credential (a
project API token cannot create an instance administrator):

```sh
tila auth setup --url https://tila.example.com --email admin@example.com --project my-project
```

This prints a private invitation. The command reads the existing provisioning
credential or `TILA_INFRA_ADMIN_TOKEN`. Subsequent users are invited in **Account**.
An instance administrator manages users; project access still requires a canonical
project membership. Existing GitHub/OIDC identities are not automatically merged
with email accounts. Grant an existing native user additional project access in
project settings using the user ID shown in account settings.

#### Recovering a legacy bootstrap browser login (#328)

If the browser reports `account-migration-required`, use one of these paths:

- **An administrator account already exists:** ask that administrator for an
  invitation including the intended project and role. If you already have an
  account, sign in and have an authorized project owner grant your native
  `user:<uuid>` identity membership. Recover a forgotten password through the
  administrator's account recovery flow; do not repeat first-administrator setup.
- **No administrator account exists:** on the provisioning machine, run
  `tila auth setup --url https://tila.example.com --email admin@example.com --project my-project`
  using the infrastructure owner credential. Open the private invitation, create
  the account, and sign in. The project argument grants ownership of that existing
  project when the invitation is accepted. Environment-only setup can use
  `TILA_INFRA_ADMIN_TOKEN`. A project bootstrap API token cannot create an instance
  administrator; contact the infrastructure owner if that is your only credential.

Creating an account alone does not grant project access. Existing token, GitHub,
and OIDC identities are not automatically linked to a native account. The legacy
session can still be signed out, and its original expiry and source-token
revocation remain effective. Signing into a valid account takes precedence over
an accompanying legacy cookie. No membership or identity is created by the
migration-required response.

The Worker requires `AUTH_SECRET` (at least 32 random characters) or the existing
`INFRA_ADMIN_TOKEN`. When only the latter exists, tila derives a purpose-separated
signing secret. Rotating that source invalidates account cookies; coordinate this
with users. `nodejs_compat` is required and is included in generated deployment
configuration. Better Auth's pinned password utility selects native scrypt for
Workers; local runtime tests cover password creation and verification. Production
CPU limits must accommodate password hashing; do not reduce hash strength to fit
a smaller execution budget.

```sh
tila login --url https://tila.example.com
tila open
tila logout
```

`tila login` shows a code, opens the browser, and waits for explicit device approval.
It stores the login only in the OS credential store (no plaintext fallback).
`tila open` issues a one-minute, single-use browser link; `--print` prints it for
manual use. Treat printed links as secrets. The browser shows the target email and
asks for confirmation. URL secrets use fragments and are removed from browser
history when read. Opening a browser preserves the original authentication time.

CLI login expires after 30 days; transferred browser sessions expire within eight
hours and cannot outlive their parent. Revoking a device invalidates its transferred
browser sessions. Role/membership changes and suspension are checked against D1 on
each authenticated request. Sensitive operations use `STEP_UP_MAX_AGE_SECONDS`
(default ten minutes). Sign in again when prompted. CLI account fallback is for
interactive terminal use; managed runtimes and CI never inherit it.

**Account → Your API tokens** issues project-scoped personal credentials, displays
the secret once, and lists status/expiry. Rotation has a five-minute overlap and
retains the original expiry; revocation is immediate. Tokens never authorize account
login or browser handoffs. Project owners retain project-wide credential controls;
service-account and workload credentials keep their existing authorization rules.

A lost password can be recovered using an administrator-shared one-hour recovery
link. Redeeming it invalidates all account sessions. If all administrators are
locked out, the infrastructure owner can run:

```sh
tila auth recover-account --url https://tila.example.com --email admin@example.com
```

Optional invitation email delivery requires the Worker secrets `RESEND_API_KEY`
and `EMAIL_FROM` (a sender on a verified domain). The invitation remains copyable if
delivery fails. tila never requires email delivery for account creation or recovery.

### GitHub browser login (explicit opt-in)

Email/password login is available independently of GitHub. Set Worker secrets
`GITHUB_LOGIN_ENABLED=true`, `GITHUB_APP_CLIENT_ID`, and
`GITHUB_APP_CLIENT_SECRET` to enable GitHub for human accounts. Configure the OAuth
callback as `https://<instance-host>/api/account/auth/callback/github`.
The account configuration endpoint reports availability without returning secrets.

Sign in with your password first, then use **Account → Link your GitHub account**.
New GitHub accounts cannot self-register, and matching emails are not implicitly
linked. Keep email/password access for recovery. Disabling `GITHUB_LOGIN_ENABLED`
blocks new GitHub sign-ins without disabling password login.

Legacy GitHub CLI exchanges and existing GitHub sessions remain supported. Their
older OAuth endpoint uses `/api/auth/github/oauth/callback` and additionally
requires `GITHUB_SESSION_HMAC_KEY`. Do not remove that callback or secret while
clients still depend on it. Neither legacy nor personal API tokens can use the new
human browser handoff endpoint.

### GitHub Session Auth (CLI)

Uses GitHub repository permissions as the authorization source. The CLI exchanges a GitHub token for a short-lived (1-hour) tila session token signed with HMAC-SHA256. This compatibility path remains available; use `tila login` for remembered human account access.

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

**Use a maintenance window. Setting a previously absent pepper is also a rotation.**
D1 bearer tokens and legacy cookie/workspace session lookups use
`hashToken(raw, HASH_PEPPER)`. Changing the secret makes existing digests unusable;
there is no previous-pepper fallback. A scoped token's overlap window does not
bridge different peppers. Do not use this procedure merely to enable conversations:
use the independent `CONVERSATION_CURSOR_KEY` described under
[Durable conversation operations](#durable-conversation-operations).

This procedure uses existing APIs and requires a current human owner in every
project. It does not introduce an offline hash rewrite, a new token issuer, or
zero-downtime verification. An old digest cannot be converted to a new digest
without the original plaintext.

#### 1. Inventory and prove recovery before changing anything

Inventory **all projects in this deployment**, including inactive consumers that
may restart later. Keep a private checklist with project, credential/enrollment ID,
current token ID, principal, role/policy, expiry, proof-key thumbprint if bound,
consumer location, responsible operator, and replacement/verification status.
`/api/tokens` uses the human session’s selected project; select and verify the
project before every inventory, issuance or rotation batch. Never include plaintext credentials, cookies, password-reset links, stored credential digests or
secret values in the checklist or issue evidence.

| Inventory class | Source and required action |
|---|---|
| Legacy full tokens | `GET /api/tokens` entries with `legacy:true` and `scopes:"full"` (runtime entries are also marked legacy by this listing; classify `runtime-v1` separately). Move each consumer to a named human/service scoped credential, test its intended operations, then `DELETE /api/tokens/:name`. A replacement service has an intentional new principal: transfer required memberships/room access and finish old claims/runs before retiring it. |
| Scoped personal/service tokens | Same inventory, `legacy:false` (after selecting that project). Record `token_id`, `credential_id`, principal, policy and expiry. Preserve the consumer's proof key. Rotate after the pepper changes. Human-owned tokens are also visible at `GET /api/account/tokens?projectId=...`. |
| Legacy browser/workspace sessions | Inventory clients still using `tila_session`. They must sign in through current human accounts; token-to-cookie exchange is retired. They do not automatically repair themselves after a pepper change. Retire their source credentials where applicable. |
| Runtime installations, runs and pending invitations | `GET /projects/:projectId/runtime/enrollments`, `/runtime/runs` and, as project owner, `/runtime/invitations`. The invitation listing returns each `invitation_id`, `state` (`pending`, `revoked`, `expired`), `expires_at` and `enrollments`, never the bearer value; record those fields, not a locally retained setup value. Drain runs and revoke old installations. A pending old invitation cannot be redeemed under the new pepper but is **not** revoked: see [rollback and re-application](#invitations-and-pepper-restoration). |
| Workload exchanges | Inventory workload bindings and each CI/provider consumer. Obtain a fresh signed upstream assertion and re-exchange after cutover. Already exchanged assertions cannot be replayed, and workload credentials cannot use ordinary token rotation. |

Human account passwords, `tila-account` sessions/device logins, account recovery
links, and signed GitHub/OIDC session JWTs do **not** use `HASH_PEPPER`. Their
independent secrets and authorization checks still apply. Keep `AUTH_SECRET`,
`INFRA_ADMIN_TOKEN`, `GITHUB_SESSION_HMAC_KEY` and any dedicated conversation key
unchanged. A JWT consumer with a configured workload binding instead receives a
D1-backed credential and belongs in the affected workload row above.

Before proceeding:

1. Verify a human account can freshly sign in, select **each** project, read its
   tasks and memberships, and manage its scoped credentials as canonical owner.
   Bootstrap an account with `POST /api/account/setup` only when no human account
   exists; otherwise use the existing account/membership administration workflows.
   Setup is not an overwrite or repair command for existing accounts.
2. Prove infrastructure recovery in the isolated rehearsal, and verify the
   production operator holds the correct independent `INFRA_ADMIN_TOKEN` and
   Cloudflare access for the explicitly selected Worker. Recovery is
   `POST /api/account/recovery/owner` with `{ "email": "owner@example.com" }`,
   authenticated with that infrastructure token. Its one-use URL resets the
   account password; it does not create missing project ownership.
3. Migrate and revoke legacy full-token consumers **before** changing the pepper.
   Use `POST /projects/:projectId/service-accounts` to create a service where needed, then
   `POST /api/tokens` with `name`, `principal_id`, the reviewed
   `policy`, optional `expires_at` and existing `jkt`. Use `POST /api/account/tokens` for personal tokens (`projectId`, `name`,
   `policy`, `expiresAt`); `/api/tokens` issuance accepts service principals only.
   Fresh human owners can issue
   scoped tokens, but cannot mint legacy full tokens. Do not solve that by
   re-running project creation or editing D1 hashes.
4. Secure a recoverable copy of the old pepper if one exists, the planned new
   pepper, and a normal backup. A backup is not authorization to restore old
   authentication/revocation state. For first activation record only “previously
   unset”. Pause CI, automation, connectors and credential issuers; drain work,
   close runs, release claims and reconcile pending deliveries before cutover.

**Stop** for an unknown consumer, missing owner, untested recovery, missing proof
key, unresolved active work or unverified Worker/account selection. A green
`/api/health` alone proves none of these prerequisites.

#### 2. Private operator session and exact API requests

The examples below run in **bash** (`bash` from a fish terminal). Work in a private
terminal without tracing or recording. Use the actual Worker origin, project ID
and deployed Worker name; independently check these against the deployment
inventory before touching a secret. Temporary files contain credentials and must
not enter logs, backups, shell history, commits or issue attachments.

```bash
set +x
set -euo pipefail
umask 077
cutover_dir=$(mktemp -d)
trap 'rm -rf -- "$cutover_dir"' EXIT
read -r -p 'Worker origin (https://...): ' cutover_origin
read -r -p 'Project ID: ' cutover_project
read -r -p 'Worker name: ' cutover_worker
export CUTOVER_DIR="$cutover_dir"

# Each response goes to a private file, never to the terminal.
# Stop on HTTP failures; inspect only error code/message, not a successful secret response.
cutover_request() {
  local method="$1" path="$2"
  shift 2
  curl --silent --show-error --fail-with-body \
    --request "$method" "$cutover_origin$path" \
    --header "Origin: $cutover_origin" \
    --header 'Content-Type: application/json' \
    --header 'X-Tila-Participant-Id: pepper-cutover' \
    --cookie "$cutover_dir/cookies" --cookie-jar "$cutover_dir/cookies" \
    --output "$cutover_dir/response.json" "$@"
}

# Hidden input, JSON encoding and file permissions protect password material.
python3 - <<'PYLOGIN'
import getpass, json, os
from pathlib import Path
Path(os.environ["CUTOVER_DIR"], "login.json").write_text(json.dumps({
    "email": input("Owner email: "), "password": getpass.getpass("Password: ")
}))
PYLOGIN
cutover_request POST /api/account/auth/sign-in/email \
  --data-binary "@$cutover_dir/login.json"
rm "$cutover_dir/login.json"
jq -n --arg project "$cutover_project" '{project_id:$project}' > "$cutover_dir/select.json"
cutover_request POST /api/workspace/select --data-binary "@$cutover_dir/select.json"
cutover_request GET "/projects/$cutover_project/tasks"
cutover_request GET "/api/tokens"
jq '[.tokens[] | {name,legacy,scopes,token_id,credential_id,principal_id,policy,expires_at}]' \
  "$cutover_dir/response.json" > "$cutover_dir/inventory.json"
```

Require 200 for login, project selection and reads. Protect the cookie jar like a
password. Repeat selection/inventory for every project. Copy only reviewed
non-secret inventory fields to the operator checklist. The generic API examples
below use URL-safe credential names; percent-encode other names as path segments.

The infrastructure recovery request uses a private curl configuration, keeping
its bearer value out of process arguments:

```bash
read -rs -p 'Infrastructure token: ' cutover_infra
printf '\n'
printf 'header = "Authorization: Bearer %s"\n' "$cutover_infra" > "$cutover_dir/infra.conf"
unset cutover_infra
read -r -p 'Existing owner email: ' cutover_email
jq -n --arg email "$cutover_email" '{email:$email}' > "$cutover_dir/recovery.json"
cutover_request POST /api/account/recovery/owner \
  --config "$cutover_dir/infra.conf" --data-binary "@$cutover_dir/recovery.json"
```

Require 200 and handle `response.json`'s `url` privately. Open its recovery page,
or submit its fragment as `token` with a new `password` to
`POST /api/account/recovery/accept` (200). Reuse must fail. Recovery invalidates
old human sessions; sign in again and select the project. Wrong infrastructure
authority must fail (403; 404 if the endpoint is not configured). Do not publish
or print the recovery URL as evidence.

#### 3. Change the pepper, replace credentials, then resume

Only after all prerequisites pass, use the secret prompt for the named Worker:

```bash
pnpm --filter @tila/worker exec wrangler secret put HASH_PEPPER --name "$cutover_worker"
```

Enter the new value from the private secret store. Do not rotate other secrets or
redeploy through ad hoc Wrangler deployment commands. Allow the secret update to
complete before verification. Request failures or mixed observed behavior keep
the maintenance window open; do not assume all isolates changed at once.

Freshly sign in as the verified human owner and select the project again. A
pre-cutover affected token must fail an ordinary protected request (401); the
owner's task/membership reads must succeed. Rotate each **ordinary scoped**
credential, using the current token ID from a fresh inventory:

```bash
read -r -p 'Scoped credential name: ' cutover_name
read -r -p 'Current token ID: ' cutover_token_id
jq -n --arg id "$cutover_token_id" \
  '{expected_token_id:$id,overlap_seconds:0}' > "$cutover_dir/rotate.json"
cutover_request POST "/api/tokens/$cutover_name/rotate" \
  --data-binary "@$cutover_dir/rotate.json"
```

Require 201. Deliver the returned `token` directly from the private file to the
consumer's secret store; retain only the returned IDs in the checklist. Compare
`credential_id`, `principal_id`, `policy` and `expires_at` to the inventory. The
existing proof binding is preserved; the consumer must still hold its private
key. Prove the intended read/write operation succeeds and a forbidden operation
still fails before marking that consumer ready. A 409 means the version changed:
read the current inventory and reconcile; never blindly retry the old ID.

| Consumer | Replacement after the pepper changes |
|---|---|
| Human-owned scoped token | Project owner rotation above, or a fresh human login using `POST /api/account/tokens/:name?projectId=...` with the same rotation body. |
| Legacy browser session | Sign in through current human accounts. There is no background renewal guarantee for `tila_session`. |
| Shared runtime installation | Revoke old enrollment with `POST /projects/:projectId/runtime/enrollments/:id/revoke` and `{}` (200). Issue `POST /projects/:projectId/runtime/invitations` with `{ "name": "host" }` and its reviewed `policy` (200); record the returned `invitation_id` and `expires_at` (invitations last 10 minutes) and deliver `invitation` privately to normal runtime setup in a new isolated runtime home. Redeem with installation proof, then start a fresh run. Do not delete unrelated local runtime state. |
| Personal runtime installation | Use its original authorized sponsor and retained installation proof/operation IDs to rerun the existing enrollment flow, where that authentication path supports it. Otherwise explicitly revoke and replace through an owner-issued shared invitation. Verify the replacement identity and its required bindings rather than silently treating it as the old run. |
| Bound OIDC workload | Obtain a new provider assertion, then `POST /api/auth/oidc/exchange` with `project_id`, `oidc_token`, and the existing proof/runtime fields where applicable (200). Keep assertion material in a private request file. For GitHub Actions use the existing `/api/auth/github/exchange-oidc` flow. A replay returns 409; ordinary scoped rotation is not supported for these credentials. |

New runtime installations can have new service principals and runs always have
new participant authority. Restore their intended agent/room bindings explicitly;
do not transfer stale claims or fenced writes. Existing scoped consumers retain
their canonical principals through rotation.

##### Invitations and pepper restoration

An invitation is stored under a digest of its secret computed with the pepper in
force when it was issued. Redemption recomputes the digest with the *current*
pepper. Changing the pepper therefore makes every pending invitation fail with 403
`invitation-invalid` while leaving it `pending`: it is neither revoked nor expired.
Restoring that pepper makes it redeemable again, and the same is true of an
invitation issued during the transition under the new pepper if that pepper is
re-applied after a rollback. The Worker adds no guard against this; the local
rehearsal observes both directions. A rejected redemption, an entry visible in the
listing, or the absence of a retained setup value is **not** evidence of closure.
Only a `revoked` or `expired` state is, and obtaining it is an operator
prerequisite for every step that restores or re-applies a pepper:

1. As project owner with a recent sign-in, list `GET /projects/:projectId/runtime/invitations`
   for **every** project. D1 migration `0034` backfills the `invitation_id` this
   listing and revocation depend on; apply it first.
2. For each `pending` entry, revoke it with
   `POST /projects/:projectId/runtime/invitations/:invitationId/revoke` and `{}`
   (200 `revoked:true`; a repeat returns `revoked:false`, an unknown ID 404, a stale
   session 403 `step-up-required`), or wait until after its `expires_at`. The CLI
   equivalents are `tila machine invitations` and `tila machine revoke-invitation <id>`.
3. List again. Every invitation issued before **or during** the cutover must show
   `revoked` or `expired`. The re-read listing is the proof, not the revoke response.

A `pending` entry, an unreadable listing, or an unrecorded invitation blocks the
rollback or re-application. Revocation stops only later redemption: an enrollment
already created from the invitation stays valid until it is revoked with
`POST /projects/:projectId/runtime/enrollments/:enrollmentId/revoke`.

##### Conversations stay independent of the pepper

Enabling conversation routes needs only `CONVERSATION_CURSOR_KEY` and changes no
credential hash. A credential migration needs `HASH_PEPPER` and this whole
procedure. Neither is a prerequisite of the other, with one coupling:
`HASH_PEPPER` is the cursor-signing fallback when no dedicated key exists.

With a dedicated `CONVERSATION_CURSOR_KEY` held constant, send and read a message
with authorized principals and verify existing history/cursors still work. If
conversations previously derived their key from `HASH_PEPPER`, expect old cursors
to fail with `invalid-cursor`; restart pagination. A dedicated key shorter than 32
characters never falls back to the pepper. On a deployment with **neither** secret,
setting `HASH_PEPPER` also supplies the fallback key, so conversation routes start
answering instead of returning 503 `config-unavailable`. Treat that as a separate,
explicitly authorized activation, or set the dedicated key first.

Resume consumers individually only after their checks pass. Keep unavailable
consumers paused with an assigned operator. `tila project create` on a peppered
deployment requires the matching private `TILA_HASH_PEPPER`; it is not this
procedure's recovery path for existing projects.

#### 4. Interruption and rollback

| Interruption | Recovery and verification |
|---|---|
| Secret changed, no replacements issued | Use the independent human login or infrastructure owner recovery. Prefer continuing. If aborting, first prove every invitation `revoked` or `expired` ([above](#invitations-and-pepper-restoration)), then explicitly restore the old pepper (or delete `HASH_PEPPER` only if previously absent), then recheck every consumer and revocation. Never delete an existing prior pepper as a rollback shortcut. |
| Rotation returned but plaintext was lost | Inventory the current `token_id`, rotate that version again with zero overlap, and deliver the new plaintext once. The first result cannot be fetched or replayed. The old expected ID must return 409. |
| Some consumers already replaced | Keep the new pepper and finish recovery. Removing it rejects new credentials. Restoring it does not undo rotation retirement or revocation; consumers can end up with no usable version under the old configuration. |
| Runtime setup interrupted | Use setup's saved operation/proof state only when its authorization is still valid. Old pepper-hashed invitations cannot recover a shared enrollment under the new pepper; use the explicit replacement flow above. |

For an approved abort before replacement, and only after the invitation listing
shows nothing `pending`, the explicit commands are
`wrangler secret put HASH_PEPPER --name <worker>` (supply the previous value), or
`wrangler secret delete HASH_PEPPER --name <worker>` **only for a previously unset
pepper**, through the same package-local Wrangler invocation above. Verify the
Worker target again. Do not restore D1/project snapshots or undo revocations to
make old credentials work. An unchanged, unrevoked old token can become valid
again when its old pepper returns; invalid hashing was never revocation.

#### Rehearsal evidence and production activation gate (#307)

`packages/integration-tests/runtime/hash-pepper-cutover.test.ts` rehearses the
procedure with synthetic credentials, a real local Worker and D1/DO storage. It
changes bindings over the same existing database, exercises owner recovery and
lost-response recovery, checks scoped authority/proof preservation, replaces
runtime credentials, and verifies signed OIDC re-exchange. Only the external OIDC
discovery/JWKS transport uses a fixture; authentication is not mocked. The suite
also covers rollback, old-credential rejection and conversation send/read with an
unchanged dedicated key. A fifth case observes that pending invitations become
redeemable again when a pepper is restored or re-applied, including those issued
during the transition, while owner-revoked invitations stay unusable. It
rehearses the [invitation prerequisite](#invitations-and-pepper-restoration); it
is not a product guard. These are local Cloudflare runtime cases (workerd with
local D1/DO/R2), never a deployed or live check. `packages/worker/src/version.ts`
is generated and gitignored, so a fresh checkout must generate it first; the
root `pnpm test:runtime` does so itself:

```bash
node scripts/generate-version.mjs worker
node scripts/generate-version.mjs sdk
pnpm --filter @tila/integration-tests test:runtime hash-pepper-cutover
pnpm test:runtime
```

The sanitized audit of the last candidate run, with its source revision and the
criteria that remain open, is
[`evidence/issue-307-readiness-v1.json`](evidence/issue-307-readiness-v1.json).

**Production activation: outstanding; this runbook and local rehearsal do not
set/rotate any production secret.** Record the following separately for an
explicitly authorized production execution:

| Evidence | Record without secrets |
|---|---|
| Identity | UTC date, operator, deployment/Worker, tested commit, deployed health release/commit and API compatibility |
| Preparation | All-project inventory reviewed, legacy migration complete, recovery verified, consumers paused |
| Cutover | Previous pepper state (unset/set only), owner login and principal/membership checks, replacement IDs and each consumer's protected-operation result, and every project's invitation `state` (`revoked`/`expired` only) before any pepper is restored or re-applied |
| Conversations | Authorized send/read, preserved history, cursor behavior, existing-principal access; health alone is insufficient |
| Recovery/result | Rehearsal test command/results, interruption and rollback outcomes, unresolved consumers, resumed/paused status, explicit production performed/not-performed decision |

The local fixture does not prove production secret propagation, provider
availability, consumer rollout, or live installation rebinding. Attach only
sanitized results to #307 after review; never attach private request/response
files. Cold-read the status update without relying on session context.

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

D1 migration 0035 keeps each project's highest access-settings revision outside the backup, including revisions of deleted repository links. Apply it before deploying the Worker that uses it. Import and rollback give restored repository access policies, OIDC policies, and project display metadata revisions above that recorded maximum, in the same transaction as the restored rows. After restore finishes, editors using older revisions receive `412 revision-conflict` and must reload before saving. Backups made before migration 0034 remain supported. Tracking starts with revisions present when 0035 is applied; it cannot recover already-deleted revision history or protect against a whole-database infrastructure rollback.

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

### CLI deployment

`tila deploy` selects saved infrastructure for the active instance and verifies
the Cloudflare account, Worker, D1 `DB` binding and R2 `ARTIFACTS` binding before
any migration or upload. A repository pointing at instance A cannot silently
deploy global infrastructure B. Custom domains are matched to their Worker through
Cloudflare's domain API; matching URL strings alone is insufficient.

```bash
tila deploy                         # Infrastructure matching this repository
tila deploy --instance <key>         # Explicit registered instance
tila deploy --infra <slug>           # Explicit saved installation
tila deploy --infra <slug> --instance <key> # Assert both identify the same Worker
```

Explicit flags override ambient context. Otherwise selection follows
`TILA_INSTANCE`, the config file named by `TILA_CONFIG`, the walked-up repository
config, then the registry's current context. An invalid selection stops the
command. Without a selected instance, provide `--infra` or `--instance`, even if
only one installation is saved. Deployment uses the Cloudflare API token and
does not require a Tila login, read the keychain, or use `--token`/`TILA_TOKEN`
to select infrastructure.

The global `--project` flag remains an assertion against the repository's
`project_id`, including with explicit deployment selectors. When an inline
Tila token would make other commands target the repository URL, deploy also
verifies that URL identifies the chosen Worker. For example, repository A plus
`TILA_TOKEN` and `TILA_INSTANCE=B` refuses instead of checking A and deploying B.
Use `--infra` to intentionally select infrastructure independently of ambient
authentication context.

Saved installations are read from `~/.tila/infra/<slug>.toml`, with legacy
`~/.tila/infra.toml` also supported; `TILA_HOME` replaces `~/.tila` in both paths.
A per-installation record supersedes a legacy record with the same slug. The
Worker name is `infra_slug`, or the filename slug when that field is absent
from a per-installation record (legacy files default to `tila`). These files
must supply the account and D1 identifiers; existing R2 defaults remain supported
only when they match the Worker's actual binding. No metadata is automatically
created or rewritten by deployment.

Automatic selection must establish exactly one match. If another account is
inaccessible, or matching records are ambiguous, use `--infra` to narrow the
selection. Incorrect bindings, missing Workers, API failures and unprovable
routing stop deployment. Direct Worker custom domains and workers.dev URLs are
supported; proxied URLs, path-based routes, service environments and non-default
R2 jurisdictions require a separate deployment workflow.

Before mutation, stderr reports the installation, selection source, account,
Worker, database and bucket. Successful `--json` output includes these fields
in `target`; stdout remains one result document. An explicit selector does not
bypass resource verification and does not require an extra confirmation prompt.

Normal deployment preserves the Worker's existing secrets. It no longer reloads
HMAC or GitHub App credentials from local files. Secret setup and rotation remain
separate infrastructure operations; select and verify that operation's own
configuration before using it.

`tila deploy` applies pending bundled D1 migrations before uploading the Worker
and UI. A migration error stops deployment. The completion summary includes the
latest applied migration filename; `--json` includes it in
`migrations.watermark`, alongside the applied/skipped counts and applied names.

Release binaries carry the Worker, UI and D1 migrations they deploy. On first
use the CLI verifies them against the embedded manifest and stages them under
`~/.tila/cache/deploy-payload/<version>-<digest>/`, so the deployed Worker always
matches the CLI version. `tila deploy --dry-run` checks that payload and reports
what would be uploaded without contacting Cloudflare. `TILA_WORKER_DIST`,
`TILA_UI_DIST` and `TILA_MIGRATIONS_DIR` override individual parts. From a source
checkout the CLI uses `packages/worker` and builds `packages/ui` instead.

For pipelines that apply migrations separately, use `tila deploy --no-migrate`.
It reads both tila's `_d1_migrations` tracker and Wrangler's `d1_migrations`
tracker without changing the database. If any bundled migrations are pending,
it lists their filenames and refuses to deploy. Query failures also block deployment.

The CLI records a migration only after every statement succeeds. Its statements
are not wrapped in a file-wide transaction, so failures can leave partial changes.
After resolving the cause, rerunning skips existing tables, indexes, triggers and
columns. For the interrupted `0027_scoped_credentials.sql` trigger failure,
rerunning with the fixed CLI completes the migration and records it.

### Definition revision warnings (#416)

This is an additive response/journal change with no DDL migration. Upgrade the
Worker to record it and clients to display it. Non-managed projects continue to
accept definition applies without `expected_revision`, with a structured
`schema-revision-deprecated` warning. These writes can overwrite newer edits.
Managed projects keep rejecting revision omission with `schema-revision-required`,
including retries of legacy receipts. No date or release is set for requiring
revisions on every project.

`tila schema apply` still accepts omission; use `--expected-revision` from a
reviewed diff or `--review`. CLI `schema import`, the dashboard definition
editor/importer and MCP `tila_schema_import` apply conditionally. SDK/API callers
and MCP `tila_schema_update` should preview, retain `revision` and
`reviewed_definition`, and submit both with a stable idempotency key. A stale
revision still returns 412; read and review again rather than automatically
retrying against the newer revision. A lost response must retry the original
payload, revision and key.

SDK warnings use `console.warn` by default; supply `warningSink` to route them to
your application's diagnostics. CLI warnings use stderr even with `--json`,
whose stdout result also retains structured warnings. MCP includes them in
text and structured results. An unmodified old binary may ignore the new field.
Inspect the durable evidence with:

```bash
tila journal list --kind schema.revisionless_applied --json
```

Each successful revisionless state change records one event atomically with
history and its receipt. The event carries principal, participant, environment,
actor, idempotency context and observed/result revisions, without definitions.
An exact retry returns its original warning without another event or revision.
A no-change request warns but records no state-change event. Invalid or rejected
requests never claim an apply occurred. Receipts from before this change get a
warning on replay with the recorded result revision; an unknown prior revision
is omitted, and no historical warning event is fabricated.

### Access settings revisions (#298)

`tila deploy` applies `0034_access_settings_revisions.sql` before uploading the
Worker; with a separate pipeline, apply it first. It is additive: repository links
gain `access_policy_revision` and `oidc_policy_revision`, projects gain
`settings_revision` (all starting at 1), and runtime invitations gain a public
`invitation_id` (backfilled for existing rows), `created_at`, `revoked_at` and
`revoked_by`. A Worker deployed ahead of it fails every repository link read,
including GitHub repository sign-in and mirrored membership, as well as project
settings and invitations, so apply the migration first. The same release adds project (DO)
migration 42, which every project applies on its first request.

After deploy, repository and cookie-session owners see two behaviour changes:
repository link and policy writes from an interactive session now need recent
authentication (step-up), and a stale `expected_revision` returns 412
`revision-conflict`. Clients that omit `expected_revision` keep the previous
unconditional writes.

### Service identity revisions (#439)

Apply `0036_service_identity_revisions.sql` before deploying the Worker; `tila deploy` applies pending D1 migrations before upload. Existing and new service
accounts and workload bindings start at revision 1. List, create and update
responses include `revision`. Each successful display-name or binding-policy
PATCH increments it once, including legacy writes that omit `expected_revision`.
A stale supplied revision returns 412 `revision-conflict` with the current
`revision` and `resource`; a missing/revoked target returns 404 without a revision.
Failed updates append no successful credential audit event. Binding policies
remain capped by live canonical membership and refuse bootstrap-only capabilities.
Revocation takes no revision.

The SDK accepts the optional revision as the last argument of `update` and
`updateWorkloadBinding`. Both CLI update commands accept `--expected-revision`.
Settings › Service identities sends the drawer's opened revision, retains edits
on conflict, and offers an explicit rebase or reload after fetching the current
values. A failed refresh keeps the draft without silently retrying the save.

D1 metadata backups include service/binding revisions but exclude the destination
watermark and bearer credentials. Import and rollback assign revisions above the
maximum of snapshot revisions and retained destination history in the replacement
transaction. Older archives without these fields remain supported. This protects
project metadata restore, including deleted-row history since migration tracking
began; a whole-database infrastructure rollback remains outside this guarantee.

### Project bootstrap repair (#360)

Upgrade the CLI and Worker together. `tila deploy` applies
`0033_project_bootstrap_repair.sql` before uploading the Worker. With a separate
deployment pipeline, apply pending global D1 migrations first using the manual
application commands below. The repair is data-only and can resume after an
interrupted CLI migration run.

The migration assigns an ID to every `_tokens` row whose `token_id` is NULL. It
preserves existing IDs, token hashes, scopes and revocation state, so consumers
keep their existing credentials. Do not rerun `project create` merely to repair
an existing token: that command replaces the active `init` token.

Active legacy `_admin_grants` with no granting user are bootstrap seeds. The
repair imports them as GitHub project owners only for existing, unarchived
projects and valid positive numeric GitHub IDs. It handles the old seed's empty
`subject_id` and records grants and audit events with `bootstrap:repair-360`.
Legacy timestamps are converted from seconds to milliseconds. The old roster
remains unchanged.

Canonical access decisions take priority: any matching membership (including
revoked rows), membership event or subject-revocation record prevents import.
A malformed canonical GitHub identity anywhere in that project also prevents
import. Non-bootstrap grants, other GitHub hosts, conflicting legacy subjects
and archived projects require explicit review rather than automatic recovery.

Verify the repair in global D1:

```sql
SELECT COUNT(*) AS missing_token_ids FROM _tokens WHERE token_id IS NULL;

SELECT m.project_id, m.principal_id, m.role, m.granted_at,
       e.event_id, e.occurred_at
FROM _project_memberships AS m
LEFT JOIN _membership_events AS e ON e.event_id = m.membership_id
WHERE m.granted_by = 'bootstrap:repair-360';
```

`missing_token_ids` should be zero; every recovered owner should have an audit
event with the same millisecond timestamp. `tila whoami --json` with an existing
bootstrap token should report its nonempty `token_id` and `token:<id>` principal.
`tila admin list --json` reads the canonical owner roster.

List legacy bootstrap seeds that still lack an active canonical owner:

```sql
SELECT a.project_id, a.github_host, a.github_user_id, a.subject_id,
       p.archived,
       EXISTS (SELECT 1 FROM _project_memberships AS m
         WHERE m.project_id = a.project_id
           AND m.principal_id = 'github:github.com:' || CAST(a.github_user_id AS TEXT)
       ) AS has_membership_history,
       EXISTS (SELECT 1 FROM _membership_events AS e
         WHERE e.project_id = a.project_id
           AND e.principal_id = 'github:github.com:' || CAST(a.github_user_id AS TEXT)
       ) AS has_event_history,
       EXISTS (SELECT 1 FROM _revoked_subjects AS r
         WHERE r.project_id = a.project_id AND r.identity_host = 'github.com'
           AND r.subject_id = CAST(a.github_user_id AS TEXT)
       ) AS has_subject_revocation
FROM _admin_grants AS a
LEFT JOIN _projects AS p ON p.project_id = a.project_id
WHERE a.revoked_at IS NULL AND a.granted_by_user_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM _project_memberships AS m
    WHERE m.project_id = a.project_id
      AND m.principal_id = 'github:github.com:' || CAST(a.github_user_id AS TEXT)
      AND m.role = 'owner' AND m.revoked_at IS NULL);

SELECT project_id, membership_id, identity_host, subject_id, principal_id
FROM _project_memberships
WHERE provider = 'github' AND (
  identity_host = '' OR identity_host <> lower(trim(identity_host))
  OR CAST(subject_id AS INTEGER) <= 0
  OR subject_id <> CAST(CAST(subject_id AS INTEGER) AS TEXT)
  OR principal_id <> 'github:' || identity_host || ':' || subject_id
);
```

Review outstanding seeds against the current membership roster and audit history.
An old active admin row alone does not authorize reversing a later revoke or
demotion. After explicitly deciding to restore an owner, use the existing
project configuration and bootstrap credential:

```fish
set -x TILA_TOKEN 'your-existing-bootstrap-token'
tila admin grant 12345
tila admin list --json
set -e TILA_TOKEN
```

Use the intended numeric GitHub ID, rather than a login snapshot. If the target
already has a lower role, update that membership explicitly with
`PATCH /projects/{projectId}/memberships/{membershipId}` and `{"role":"owner"}`;
granting again does not promote it. Revoke an incorrectly formed membership
through `DELETE /projects/{projectId}/memberships/{membershipId}` before granting
the reviewed numeric identity. These operations preserve canonical audit history.

New `project create --admin-github-user` calls require a reachable Worker and the
correct `TILA_HASH_PEPPER` for a peppered deployment. A failed seed exits nonzero
and reports partial failure; bring the Worker up or correct the credential
configuration, then rerun project creation. Existing owner seeds are idempotent;
existing lower roles remain unchanged and cause a failure requiring an explicit
role update. This workflow grants a GitHub **project owner**; native instance
administrator setup and legacy browser-session recovery are separate workflows.

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

This section defines what each gate must show. The step-by-step procedure, including disposable gate infrastructure that never touches the production D1 database or R2 bucket, is the `tila-release` skill in `.agents/skills/tila-release/` (`reference/live-gates.md`).

### Gate 1: DO-state survival after restart

Verifies that Durable Object SQLite state survives an eviction+restart cycle. Catches any regression where state is held only in memory.

**Requirements:**
- `TILA_BASE_URL` — live worker URL (e.g. `https://your-worker.workers.dev`)
- `TILA_TOKEN` — a full-scope D1 token for the project. `POST /projects/:id/admin/restart` is protected by `requireProjectAdmin`. A 403 response means the credential cannot administer that project.

```bash
TILA_BASE_URL=https://your-worker.workers.dev \
TILA_TOKEN=your_admin_token \
pnpm --filter @tila/integration-tests exec vitest run src/do-eviction.test.ts
```

The test:
1. Writes a uniquely-stamped task to the live project.
2. POSTs `/projects/:id/admin/restart` — evicts the DO from memory and requires `200 { ok: true }`. The Worker acknowledges the specific remote exception from the deliberate abort; other exceptions and HTTP errors, including 5xx, remain failures. The benchmark's `cold-start` scenario uses the same contract.
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
pagination, so a restricted listing that is empty cannot be told apart from one
that was filtered; `GET /records/_types` likewise never reports `incomplete`
(schema fetch or parse failures) to a restricted key. Restricted keys cannot use
project-wide search, journal, summary,
exports, artifact access or global maintenance. Unsafe derived task views are
also denied, including journal replay, handoffs, and re-entry. Unrestricted
handoff access requires journal, task, record, artifact, and claim read capabilities;
creation also requires `tasks:write`. Re-entry additionally requires summary and
signal reads. Updating a journal cursor requires `journal:read` and at least
participant membership. Template expansion checks every generated task before any write.
Ordinary writes do not imply delete: archive/unarchive and relationship removal
require explicit delete capabilities. A service promotion cannot expand a key's
issuance ceiling; demotions and revocations immediately reduce current authority.
To remove what an automated run created without widening its key, see
[Cleaning up automated run resources](#cleaning-up-automated-run-resources-362).

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

Handoffs accept an optional `kind`: `work` for authored context or `shutdown` for
automatic coordination snapshots. Omission is treated as work during selection
and remains omitted in storage and retry requests. Re-entry selects the newest
work handoff in the participant or requested resource scope, falling back to the
newest shutdown snapshot if no work handoff exists (or null if there are none).
An explicit `handoff_id` selects that exact snapshot; listing still returns all
handoffs newest first. Saved handoffs and their historical claims remain immutable.

Only explicitly marked shutdown snapshots are skipped in favor of work. Older
unmarked shutdown snapshots retain their existing selection behavior; no legacy
message detection, record rewrite, or database migration is performed. Deploy
backend support before updating lifecycle clients: older servers reject `kind`
under strict request validation. Upgrade SDK/MCP readers before enabling new
lifecycle writers too: older strict response schemas reject marked handoffs.
Write failures remain visible as retryable, degraded shutdowns; clients do not
drop the marker to bypass validation.

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

### Disposable deployed artifact verification

The artifact-version integration suite has an explicit live gate. Ordinary test
runs skip it, even when credentials are available. From the checkout root, run:

```bash
env TILA_RUN_LIVE_ARTIFACT_TESTS=1 \
  TILA_BASE_URL=https://tila.breamcode.workers.dev \
  pnpm --filter @tila/integration-tests exec vitest run \
  src/artifact-versions.test.ts -t 'live artifact revision verification'
```

Use the infrastructure configuration created by `tila init` under the configured
tila home. `TILA_BASE_URL` must match that configuration's Worker origin. The
Cloudflare API credential (environment `CLOUDFLARE_API_TOKEN` or the existing
tila home credential file) must allow D1 query and R2 lifecycle inspection. If
the Worker uses `HASH_PEPPER`, supply the matching `TILA_HASH_PEPPER` privately.
Missing prerequisites fail an enabled run; they do not silently skip it.

Each run provisions a new UUID project and temporary project token with the
existing provisioning helpers. It refuses an existing project identity. Writes
use stable idempotency keys and requests have bounded timeouts. The gate checks
exact restored bytes, tags, metadata, paginated history, restore retry identity,
same-byte revision creation, project DO restart, repeated reconciliation, and
deleted-content 410 responses with retained history. It also verifies that the
only enabled R2 object expiration rule is the 365-day `produced/` backstop;
versioned content and recovery records must remain exempt.

For an attended browser check, optionally set
`TILA_LIVE_ARTIFACT_UI_READY_FILE` to an operator-selected private file path.
The test creates a temporary service with viewer membership and a scoped read-only
credential, writes a mode-0600 JSON receipt containing the disposable project URL
and that token, then waits up to three minutes. In the existing browser,
verify the read-only drawer, revision links and Back navigation; save screenshots
outside the receipt. Acknowledge by writing the receipt's exact `projectId` to
the same path with `.done` appended. The receipt and acknowledgement are removed
during cleanup. Do not commit or publish the credential receipt.

Cleanup runs after success or failure. Before destroying project resources, it
compares the run's creation receipt against fresh deployed registry identity.
It wipes only that project's DO/R2 resources, verifies empty domain stores, then
removes D1 metadata, browser service/membership/credential records, project
registration and test tokens and confirms their
absence. A cleanup failure reports the project ID and remaining resource class
without printing credentials; resolve those resources before rerunning. Existing
projects remain outside the mutation scope. This gate neither deploys code nor
simulates SQLite loss or multi-day retention expiry: local lifecycle and recovery
tests cover those cases. Record deployment/version metadata alongside behavioral
results; health output alone does not identify the deployed source revision.

## Cleaning up automated run resources (#362)

A key issued with the `worker` preset (and a runtime run, whose ceiling is a
superset of it) can create records and upload artifacts but cannot archive or
delete them: it holds no `records:delete`, `artifacts:delete` or `tasks:delete`,
and the Worker answers `403 permission-denied`. That is deliberate and is not
changed here. Tila has **no** creator-based deletion ("let a key remove what it
wrote") and **no** time-to-live on a namespace, so do not plan around either.
Cleanup is a separate, owner-reviewed step that acts only on resources a run
reported in a receipt.

### What each removal needs

| Resource | Operation | Capability | Also required | Effect |
| --- | --- | --- | --- | --- |
| Record | `POST /records/<type>/~/archive/<key>`; CLI `tila record archive <type> <key> --fence <n>` | `records:delete` | participant membership; the record's current fence | Marks the record archived and bumps its fence. Value and revision history stay; `unarchive` reverses it. There is no record byte-delete short of destroying the project. |
| Task | `POST /tasks/<id>/archive` | `tasks:delete` | the task's claim fence | Archive only. Restrictions match whole task *types*, never id prefixes, so a per-run task cleaner cannot be expressed. |
| Versioned artifact revision | `DELETE /artifacts/<key>?fence=<n>` with an `Idempotency-Key`; SDK `artifacts.delete` | `artifacts:delete` | a **live claim** on `artifact:<lineage_id>` and its current fence | Durable tombstone, answered `202 cleanup_pending`. Bytes leave R2 later (see below). |
| Whole lineage | `POST /artifacts/~/destroy/<lineage_id>` with an `Idempotency-Key`; SDK `artifacts.destroyLineage` | `artifacts:delete` | same claim and fence | Permanently retires the lineage and every revision in it. Metadata and history are kept. |
| Legacy artifact (`sources/<sha256>.<ext>`, `produced/<resource>/<sha256>.<ext>`) | `DELETE /artifacts/<key>` | `artifacts:delete` | nothing | Tombstones the pointer and deletes the blob immediately, with no fence and no claim. |

The CLI has no `artifact delete` or `artifact destroy` subcommand; artifact
removal uses the SDK or HTTP. Do not add a wrapper that guesses keys.

### Choose a path

1. **Run-owned disposable project (preferred).** The orchestrator, not the run,
   owns a project created for that one run. The run gets only a `worker` key for
   it and never sees an owner credential. Cleanup is the existing owner
   `tila project destroy`, after the receipt is checked.
2. **A separate cleanup identity in an existing project.** Usable for records
   under a key prefix. Artifacts cannot be restricted this way (below), so
   artifact cleanup in a shared project is attended, short-lived and driven by an
   exact manifest.
3. **Leave it.** If neither fits, the resources remain until an owner removes them
   deliberately. Nothing expires them automatically.

### Path 1: run-owned disposable project

Orchestrator side, with the owner credential, in a private per-run directory.
Flags below are from `tila <command> --help`; creating and destroying a project
needs a provisioned deployment, so this sequence is not exercised by the local
runtime suite (see Validation).

```sh
tila project create --name rehearsal-<run-id> --json   # owner token lands in this directory's .tila/.env
tila service-account create --name rehearsal --display-name "Rehearsal run" --role participant --json
tila token issue --name rehearsal-key --principal 'service:<uuid>' --preset worker --expires <ISO-8601> --json
```

Give the run the base URL, project ID and the issued key only. A service created
with the default `--role viewer` cannot write even with the `worker` preset,
because effective authority is the lower of key and membership. After the run,
the run's receipt is reviewed (below). Then, still in the same directory:

```sh
tila token inspect --json    # project_id and instance_id must equal the receipt's
tila project destroy --force --json
```

Without `--force` the command asks you to type the project slug. It wipes the
project's Durable Object and R2 state, cleans D1 records, verifies the domain
stores are empty and then removes `.tila/`. `--json` reports
`{ ok, stores: { do, r2, d1, local }, failures }` and exits non-zero on any
failure. `r2: "gc-skipped"` means some blobs were not removed and nothing will
reclaim them later; treat the run as incomplete and record the project ID for
attended follow-up. After a failure `.tila/` is kept so the command can be re-run;
a project whose state is already empty counts as wiped. Confirm with
`tila project list` that the slug is gone.
`tila project destroy <slug>` destroys by slug without local configuration and
needs `INFRA_ADMIN_TOKEN` and a Cloudflare API token; use it only attended.

Never run destroy against a project the receipt does not name. The command acts
on the configuration in the current directory; check `project_id` first.

### Path 2: a separate cleanup identity in an existing project

**Records.** Record keys can be restricted by type and slash-delimited key
prefix. Create one cleaner per run namespace, owned and reviewed by an owner:

```sh
tila service-account create --name cleanup-run-0001 --display-name "Cleanup run-0001" --role participant --json
tila token issue --name cleanup-run-0001-key --principal 'service:<uuid>' \
  --role participant --capabilities records:read,records:delete \
  --restrictions '{"records":[{"type":"rehearsal","key_prefixes":["run-0001"]}]}' \
  --expires <ISO-8601> --json
```

Both `--role participant` flags matter. `--capabilities` replaces the preset's
list but not its role, so omitting `--role` on the key, or leaving the service at
its `viewer` default, still issues a key, but one that cannot archive: the lower
role silently drops the delete capability. `tila token inspect --json` then shows
`role: viewer` and a `policy.capabilities` without `records:delete`; check it
before the run.

The prefix `run-0001` permits `run-0001` and `run-0001/...` but not `run-00010`.
It is a **namespace boundary, not ownership**: any principal that wrote under that
prefix can also be archived by this key. Make the run ID unique and never reuse
it. A namespace-restricted key reaches only tasks, records, claims, templates,
queue, attempts, questions and exact search; every other route is refused.

**Artifacts.** A credential with any namespace restriction is refused on every
artifact route, so there is no prefix-scoped artifact cleaner. An artifact
cleaner needs `artifacts:read,artifacts:delete,claims:read,claims:acquire,claims:release`
and is then **project-wide**: with a lineage claim it can remove any lineage, and
a legacy key removes any run's bytes. Three properties make that sharper than it
looks, each covered by a test:

- A lineage fence is not bound to its holder. The server checks that the fence is
  current and that *some* claim on the lineage is live. A key that only reads
  claim state can delete using another participant's live fence.
- Uploads without a `lineage_id` are content-addressed. Two runs that upload the
  same bytes share one key (the second is `deduplicated`), and deleting that key
  removes the bytes for both, with no fence.
- Authorization never consults who wrote an artifact. Provenance is recorded but
  not enforced, so "the run's artifacts" exists only in the receipt.

So do not run an unattended artifact janitor in a shared project and do not call
it creator-only deletion. Issue the artifact cleaner for one cleanup, short
expiry, from a reviewed manifest; revoke it afterwards with
`tila token revoke <name>` (and `tila service-account revoke <principal>`).
For runs that must be cleaned without an operator, use Path 1.

### The run receipt

The receipt is a convention for this procedure; Tila neither stores nor validates
it. The run reports it, an owner reviews it, and cleanup refuses anything not in
it.

```json
{
  "project_id": "rehearsal-run-0001",
  "instance_id": "<deployment instance_id from GET /api/whoami at run start>",
  "run_id": "run-0001",
  "reviewed_by": "owner display name or ticket (recorded, not verified by Tila)",
  "cleanup_principal_ids": ["service:<records-cleaner>", "service:<artifacts-cleaner>"],
  "retention": "delete-bytes",
  "records": [{ "type": "rehearsal", "key": "run-0001/main" }],
  "artifacts": [
    {
      "lineage_id": "run-0001-report",
      "revisions": [{ "r2_key": "versioned/...", "revision": 1, "sha256": "<hex>" }],
      "destroy_lineage": true
    }
  ]
}
```

- **Identity.** `project_id`, `instance_id` and `cleanup_principal_ids` are checked
  against the cleaner's own `GET /api/whoami` (`tila token inspect --json`:
  `project_id`, `instance_id`, `principal_id`). `instance_id` comes from the
  deployment's own database, so every hostname of one deployment reports the same
  value; compare it, not the URL.
  `reviewed_by` is an audit note; nothing can verify it, so do not describe the
  procedure as having checked the reviewer.
- **Retention.** `archive-only` means records are archived and **no artifact
  bytes are removed**; the artifact phase refuses to start. `delete-bytes` is the
  owner's explicit authorization to remove the listed artifacts. Records are
  archived under either, since there is no record byte-delete.
- **Artifacts.** List exact revision keys, numbers and hashes. Set
  `destroy_lineage` only when the lineage is exclusive to the run. Have the run
  write under a unique `lineage_id` and release its claim when done; avoid
  lineage-less uploads. For `history = "snapshot"` record types, the canonical and
  source snapshot artifacts are separate legacy keys that archiving the record does
  not remove; they appear in `tila record history <type> <key> --values --json`
  and belong in the receipt if they should go.

### Procedure

Fail closed: each step stops the whole run on mismatch or uncertainty, and
nothing is inferred from a prefix or a listing.

**This is not atomic.** Records and artifacts are separate operations in separate
stores, and artifacts are removed one request at a time. Verifying everything
before the first destructive call limits the damage from a mismatch; it does not
make cleanup transactional. If a call fails after others succeeded, those stay
removed. Stop, keep the receipt, and re-run once the cause is understood.

0. **Receipt.** Refuse a receipt that repeats a record, a lineage or a revision
   key (within a lineage or across lineages), repeats a revision number within a
   lineage, or lists a lineage with no revisions. A repeated key can make a count
   agree with the live set while an unlisted revision stays live. This needs no
   request.
1. **Identity.** Read `GET /api/whoami` with the cleanup key. Refuse unless
   project, deployment and `principal_id` match the receipt.
2. **Scope.** Refuse any target not in the receipt, before any request that
   changes state. Refuse the artifact phase unless `retention` is `delete-bytes`.
3. **Records.** `tila record get <type> <key> --json` for each listed record.
   If it cannot be read (including `403`), stop: that is uncertainty, not "done".
   Skip records already archived. Archive with the fence just read:
   `tila record archive <type> <key> --fence <fence>`. The fence is a
   compare-and-set, so a record changed after the read is refused rather than
   archived.
4. **Claims first.** For each listed lineage, in a fixed order, acquire an
   exclusive claim on `artifact:<lineage_id>` **before reading anything that will
   justify a deletion**. A claim is exclusive, so no writer can append between
   verification and the destructive call. A read taken before the claim proves
   nothing: a writer can append and release in the gap. If a claim is held
   (`409 already-held`), release what you hold and stop.
5. **Verify under the claims.** Page through
   `GET /artifacts/~/history/<revision key>`. Every receipt revision must be
   present with the receipt's `lineage_id`, `revision` and `sha256`. If
   `destroy_lineage` is set, compare the actual key sets, never counts: refuse if
   any revision that is still available (not tombstoned, `blob_deleted_at` unset)
   is not in the receipt. All lineages are verified before any is changed.
6. **Destructive calls.** With each claim's own fence and a stable per-item
   idempotency key (`cleanup:<run_id>:delete:<key>` or
   `cleanup:<run_id>:destroy:<lineage_id>`): `artifacts.delete(key, { fence,
   idempotencyKey })` for each receipt revision, or one
   `artifacts.destroyLineage(lineage, { fence, idempotencyKey })` when the
   lineage is exclusive. Per-revision deletion leaves any revision a writer added
   after review untouched.
7. **Release** every claim in `finally`; a release failure does not change the
   outcome and the claim expires with its TTL.

Steps 4–6 as SDK calls (these are the calls the tested fixture makes):

```ts
const claims = createClaimMethods(client, projectId);
const artifacts = createArtifactMethods(client, projectId);

const claim = await claims.acquire(`artifact:${lineage}`, "exclusive", 60_000);
try {
  const history = await artifacts.history(firstRevisionKey, { limit: 100 });
  // ...verify every receipt revision against `history.items`; refuse on mismatch...
  await artifacts.destroyLineage(lineage, {
    fence: claim.fence,
    idempotencyKey: `cleanup:${runId}:destroy:${lineage}`,
  });
} finally {
  await claims.release(`artifact:${lineage}`, claim.fence);
}
```

The executable reference is `cleanFromReceipt` in
`packages/integration-tests/runtime/run-cleanup.test.ts`. It is test code, not a
shipped tool; Tila has no cleanup subcommand or daemon.

### Responses and retries

Reuse the same idempotency key for the same item. A key replays its original
outcome even after the claim has expired; a different key, or no key, is a new
operation.

| Response | Meaning | Do |
| --- | --- | --- |
| `403 permission-denied` | Missing capability, restriction, or membership role | Stop. Do not widen the key; have the owner fix and review the cleaner. |
| `409 stale-fence` | Fence is old, or no claim on the lineage is live | Re-acquire, re-read, re-verify against the receipt, then retry with the new fence. Never reuse an old fence. |
| `409 already-held` | Someone holds the lineage claim | Stop; do not force. Retry after it expires or is released. |
| `409 invalid-state` "already archived" | Record is archived (checked before the fence, so a stale fence gives this too) | Read the record; if archived and listed in the receipt, count it done. |
| `404 not-found` | Record or revision missing | Stop and investigate; absent is not "removed by me". |
| `400 missing-fence` / `400 missing-idempotency-key` | Request malformed | A cleaner bug; fix before retrying. |
| `202 cleanup_pending` | Tombstone is durable; bytes pending | Verify later (below). |
| `410 artifact-unavailable` | Content is unavailable: returned as soon as the tombstone is durable, **before** the bytes are deleted. History remains. | Count the revision as retired, not as removed. Confirm byte removal with `blob_deleted_at` (below). |
| `409 artifact-lineage-busy` (retryable) | A revision is still publishing | Retry the same request later. |
| `503 artifact-storage-unavailable` (retryable), timeout, network error | Outcome unknown | Do not assume either way. Retry with the same key and fence while the claim lives; once it lapsed, re-acquire and re-verify, then reuse the key. |
| `422 idempotency-key-conflict` | Key reused with different input | Do not mint a new key to push through; re-read and re-verify. |

Rerunning the whole procedure is safe: archived records and tombstoned revisions
are skipped, and an unchanged receipt sends no destructive request.

### Archive, bytes, retention and audit

- **Archive versus byte deletion.** Record archive is soft and reversible. Artifact
  tombstone makes content unavailable (`410`) at once but the bytes remain in R2
  until the lifecycle queue deletes them; lineage destroy is permanent. Revision
  metadata and history survive byte removal.
- **Asynchronous drain.** `202` means the retirement record is durable, not that
  bytes are gone. The project's alarm and the daily sweep process the queue; a
  failure keeps its work item and retries with exponential backoff capped at one
  hour. Confirm removal per revision: `GET /artifacts/~/history/<key>` shows
  `blob_deleted_at` as a number (`tila artifact history <key> --json`). Neither a
  `410` on download nor the table view's `Unavailable` column shows that: both are
  already true at tombstone, so they cannot tell "tombstoned" from "bytes gone".
- **Protected heads.** Configured per-kind `retention_days` removes only
  non-head revisions older than the period, and only once a newer live revision
  exists. A live head is never expired automatically; explicit delete or destroy
  with a current fence is the only way its bytes leave. A deployment-wide R2
  `produced/` expiration (365 days) is a Worker-sweep backstop, not a per-run or
  per-namespace TTL.
- **Audit retention.** Cleanup does not remove audit data. Archive and tombstone
  append `record.archived` and `artifact.tombstoned` journal events with the
  actor and participant; record history and artifact revision metadata remain.
  Journal maintenance may move old events to archive objects; destroying the
  project removes them.
- **Verify exact removal.** Check each receipt item by name: records via
  `tila record get <type> <key> --json` (`archived: 1`); artifacts via history,
  where `blob_deleted_at` set is the only API evidence that bytes were removed. A
  `410` on download verifies only that the content is unavailable. Until
  `blob_deleted_at` is set, the revision is retired but its bytes may still exist;
  report it as pending, not removed. An empty prefix listing, or the absence of an
  error, is not verification, and a restricted key cannot list artifacts at all.

### Validation

`packages/integration-tests/runtime/run-cleanup.test.ts` runs against the real
Worker, Durable Object, D1 and R2 with synthetic identities only:

- the `worker` preset gets `403` for record archive, artifact delete and lineage
  destroy, and nothing changes;
- a prefix-restricted record cleaner archives with the current fence, is refused
  with a stale fence, outside its prefix or type, and when the membership or the
  key role is only `viewer`;
- an artifact cleaner is refused while the run holds the claim, with a stale or
  missing fence, and succeeds with its own claim; download answers `410` and
  `blob_deleted_at` stays unset while the bytes remain, until the queue drains;
- the receipt procedure archives and retires exactly the listed resources,
  refuses before any state-changing request for project, deployment, principal,
  scope, `archive-only` and repeated record, lineage or revision keys, refuses
  under the claims when history no longer matches, refuses to retire a lineage a
  writer extended after review (comparing key sets, not counts), and excludes
  writers between verification and deletion;
- the limits above: artifact routes refuse restricted keys, a live fence is not
  holder-bound, and legacy keys are shared and fence-free.

`tila project create`, `tila project destroy` and `tila token issue` flags were
checked against `--help`; the policy a flag set produces is the CLI's own
`policyFromArgs` in the test. Project creation and destruction against a deployed
instance are covered by the live gate in "Disposable deployed artifact
verification", not by this suite.

## Runtime enrollment and unattended runs

Version 0.4.0 separates operator credentials, installation authorization, and run access. CLI operators retain existing human authentication and administrative commands. MCP accepts only a shared-server project run. No compatibility adapter or automatic authentication fallback is provided.

### Installation authorization

| Kind | Initial authorization | Ongoing authority |
| --- | --- | --- |
| Personal | Authenticated human with participant-or-higher project membership | Initial worker ceiling intersected with service membership and the sponsor’s current project authority |
| Shared | Owner creates a restricted invitation | Project-owned service membership; independent of the authorizing owner’s later membership |
| OIDC job | Existing provider, audience, repository policy and workload binding | Original binding/ceiling/proof key and current workload restrictions |

Each enrollment reuses one canonical service membership. Every run has its own participant, initial ceiling, credential versions, and lease. Installation IDs identify enrollments, not physical hardware. Names and environment metadata grant no authority.

```sh
# Personal installation; use the normal human login first.
tila --instance https://tila.example.com --project my-project machine enroll

# Owner side: capture this one-use invitation securely; validity is ten minutes.
tila --instance https://tila.example.com --project my-project machine authorize --name runner --json

# Runner side: deliver the invitation through stdin, not command arguments.
# Select file storage explicitly for a headless Linux account.
tila --instance https://tila.example.com --project my-project machine enroll --invitation-stdin --file-store /absolute/private/tila-runtime

# Thereafter no owner credential or interactive login is needed.
tila --instance https://tila.example.com --project my-project run exec -- your-command
```

The invitation response is intentionally secret. Enrollment output contains references only. The OS secret store is the default; an explicit file store requires a private directory and files owned by the current account (0700/0600). Storage errors stop setup. Runtime storage is separate from operator credentials and does not change general CI/keychain-write restrictions.

Setup persists its operation ID and installation proof key before provisioning. Rerunning interrupted setup with the original human authorization or invitation recovers the existing enrollment and replaces its authenticator; it does not create another service identity. Keep the private store and non-secret runtime references together when recovering a setup. If the key is lost, authorize a new installation and revoke the old one; there is no secret-recovery bypass. A revoked enrollment cannot be revived. Use a new isolated runtime home for replacement enrollment, or remove that revoked enrollment’s local reference/secret after checking its ID. Never delete another active installation’s state.

### Runtime and CI

`run exec` creates one run, supplies its local socket capability to the command, renews automatically, and closes access after cleanup. Managed CLI commands share the same participant and reject credential, deployment, project, or participant overrides. Ordinary CLI invocations outside a managed session continue to support administration.

GitHub Actions jobs with an existing service workload binding can use:

```yaml
permissions:
  contents: read
  id-token: write
steps:
  - run: tila --instance https://tila.example.com --project my-project run exec --oidc -- your-command
```

The helper fetches fresh Actions assertions automatically. The audience is the deployment origin; configure the existing provider/repository policy accordingly. Renewals cannot change workload binding, repository context, proof key, or the original run ceiling. Upstream assertion expiry can shorten the normal credential lifetime. Other pipelines use enrolled shared runners. The typed SDK also exposes runtime OIDC exchange for callers that supply fresh assertions from supported configured providers.

| Timing | Behavior |
| --- | --- |
| Credential | At most 15 minutes, capped by upstream authorization |
| Renewal | Two minutes before expiry, jitter, one request in flight |
| Heartbeat / lease | Every 60 seconds / expires after five minutes |
| Replacement overlap | At most 60 seconds; closure/revocation overrides it |
| Normal shutdown | At most five minutes of handoff/cursor/exact-claim cleanup, then access closes |

The broker keeps installation credentials and keys out of child environments. Its socket capability is limited to a single run and bound deployment/endpoints. Temporary failures use bounded retry while authorization remains valid. Expired, closed, or revoked runs cannot be renewed into existence. After helper loss, start a replacement session and recover through a handoff. Task attempts and authentication runs remain separate concepts.

The broker does not isolate hostile processes sharing an OS account. Use separate OS accounts or host-runtime isolation where that boundary is required.

### Inspection, revocation, and diagnostics

```sh
tila machine list --json
tila machine inspect ENROLLMENT_ID --json
tila machine revoke ENROLLMENT_ID
tila run list --json
tila run inspect RUN_ID --json
tila run revoke RUN_ID
```

Pass explicit instance/project flags when the directory does not select the intended deployment. Members see/manage their personal installations; owners can inspect shared infrastructure and revoke any enrollment/run. Enrollment revocation blocks all descendants; run revocation affects only that run. Already-authorized in-flight requests can finish. Project restore revokes runtime access along with existing credentials and cannot resurrect it.

`GET /api/runtime/context` is authoritative and separate from best-effort identity diagnostics. It includes deployment UUID, project, purpose, principal, run, participant, effective policy and expiry. Missing runtime protocol support produces an upgrade error. Authorization-store failures deny access before project reads, cached responses, or write replay.

Credential events record creation, replacement, closure, revocation, and denied escalation with trusted identity links. Request analytics record failure codes, including `runtime-purpose-denied`, `runtime-binding-mismatch`, `runtime-proof-replayed`, `enrollment-revoked`, `run-closed`, `run-expired`, and `runtime-authorization-unavailable`. Run inspection exposes active/closed/revoked/expired states. Lifecycle status and stderr report incomplete cleanup. Never log bearer credentials, invitations, socket capabilities, private keys, or proofs. Scheduled maintenance prunes expired proof/assertion replay records.

### Coordinated 0.4.0 cutover

1. Complete authentication-boundary review and isolated deployment validation. Keep the PR outside the merge queue until that review is satisfied.
2. Apply additive D1 migration `0030_runtime_credentials.sql`, then deploy the compatible backend. Preserve project data, canonical memberships, and recoverable owner access.
3. Upgrade CLI, SDK and MCP together to 0.4.0. Enroll installations and regenerate client settings with `tila mcp init`; settings pin the compatible MCP version.
4. Restart coding sessions under new run credentials and verify concurrent members/machines, revocation isolation, renewal and cleanup. Remove superseded MCP credentials/configuration.
5. Retain additive schema changes during rollback. Rollback is an explicit operator action; requests never retry with an older or stronger credential.

`pnpm dev:setup` also provisions a runtime enrollment for the local Cloudflare Worker in an isolated development auth home. Stop the existing development server before setup; it already clears local fixture state. Contributor MCP templates wrap the source MCP command in source `run exec` and require no repository secrets.

## Agent bindings and account profiles

Issue #283 slice 1 adds agent identity and binding management. Durable messages
and inbox commands are introduced in slice 2 below; automatic wake arrives in a
later slice.

Apply `0031_runtime_agents.sql` to global D1 before deploying this Worker. The DO
and embedded stores apply shared migration 30. Deploy the compatible backend
before upgrading clients. Existing unpinned runs and the default `worker` policy
keep their existing authority. Read paths ignore unknown capability strings;
issuance rejects unknown names.

| Operation | Required authority |
|---|---|
| Register agent | `agents:manage`, maintainer or higher |
| List/inspect agents | `agents:read`, viewer or higher; binding details are redacted |
| Attach acting run | `agent-bindings:attach`, explicit agent grant, agent-pinned current run |
| Replace binding | Current epoch plus same enrollment, owner/manage, or terminal previous run |
| Release binding | Current epoch plus holder or owner/manage authority |

The owner explicitly authorizes an enrollment policy containing `agents:read` and
`agent-bindings:attach` before runs can request those capabilities. Obtain its
service principal from `tila machine inspect`. Register that principal in the
agent's grants with `tila agent register worker --name Worker
--allow-principals service:<uuid>`. Registration is retry-safe for identical input;
a conflicting registration fails. Agent grants are registration-time configuration
in this slice.

`--capabilities` replaces a preset. Keep the worker capabilities needed by the
session and add the two agent capabilities to both enrollment and run policy.
A relay requests only `agent-bindings:attach` and `dispatch:relay`. It supplies
`acting_run_id` to the SDK/HTTP bind operation; D1 verifies that acting run belongs
to the same enrollment and agent. Relay credentials cannot list agents or act as
the mailbox consumer.

Profiles are local to one host and never selected through shared hook or MCP
configuration. Create a separate owner-only config directory for each account,
authenticate the provider using that directory, then register the trusted local
launcher and the expected account email:

```sh
tila profile add claude-one --harness claude-code --launcher /absolute/path/to/claude --config-dir /absolute/private/claude-one --credential-store file --account one@example.com
tila profile verify claude-one
tila profile list
# Add --capabilities with the explicitly authorized run policy when binding.
tila run exec --agent worker --profile claude-one -- claude
# From the resulting managed session:
tila agent inspect worker
tila agent bind worker --harness claude-code --expected-epoch 0
```

`profile add` replaces an existing profile with a higher revision. Removing and
adding the same ID cannot reuse an old revision. Config directories require mode
0700; profile files require 0600. Launchers must be executable regular files owned
by this user or root without group/other writes. Symlinked profile files and config
directories fail closed. The launcher is resolved locally at registration.

The child environment contains a small base allowlist plus explicit profile
`env_allowlist` names. Tila credentials, Actions assertions and conflicting provider
home variables are excluded. `TILA_PROFILE_ID` and `TILA_PROFILE_REVISION` pin the
selection. Codex observers use the selected launcher and `CODEX_HOME`; Claude uses
`CLAUDE_CONFIG_DIR`. Account references are HMACs under a private host key; raw
account emails are not persisted by Tila. Keyring/auto stores and Claude Console
logins can share credentials: verification reports `declared`, never verified
account isolation.

`run exec` checks the selected account before launch and every 30 seconds while
running. A mismatch closes run access and requests child termination. Native
lifecycle helpers check their profile while monitoring liveness. Profile changes
require a new session. The profile revision qualifies lifecycle keys without
rewriting older unprofiled identities.

Revocation first blocks access in D1 and then expires the DO binding projection.
A failed projection update logs a metadata-only warning; subsequent authentication
still rejects the run. An already-authorized in-flight request can complete, and
inspection may show a stale binding until replacement or reconciliation. Do not
treat the copied DO lease as authorization. Backup restore invalidates all copied
bindings and bumps epochs; fresh runs must attach again. Local mode explicitly
returns `unsupported-capability` for agent operations.

## Coding-client lifecycle integration

The opt-in lifecycle adapters support **Claude Code CLI and Codex CLI on macOS
and Linux**, using a configured Cloudflare-backed Tila project. Operator CLI use and CLI/SDK local mode remain available; MCP requires runtime access. Desktop clients, Conductor-managed
sessions, Windows, and independent subagent participants are outside this initial
integration. Tila never takes control of client execution.

### Install and remove

Use a CLI and MCP server build that both include lifecycle support. From the
project root, after `tila machine enroll`:

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
creates `npx -y tila-mcp-server@0.4.0`; source checkouts should configure their existing
source MCP command first. It records ownership under the private `$TILA_HOME/client-lifecycle/installations`
directory (default `~/.tila/client-lifecycle/installations`) and refuses to
replace a Tila MCP entry subsequently edited by the user. JSON/TOML formatting and
TOML comments may change during serialization; configuration values are preserved.
Dry-run reports affected files without exposing configuration secrets.

```sh
tila lifecycle status
tila lifecycle retry                 # Retry only while the original helper/run is active
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
`CLAUDE_ENV_FILE`; Codex shell commands resolve their `CODEX_THREAD_ID`. Conflicting
CLI participant or credential overrides are rejected. MCP tool calls resolve identity for
each request, so one Codex daemon connection can serve concurrent sessions safely.
Codex subagent MCP calls use their parent session's identity. MCP resources, prompts, and discovery resolve the same per-request run mapping.

Startup/resume supplies a bounded re-entry page containing summary, changes,
active claims, pending signals, and the latest work handoff (or latest shutdown
snapshot when no work handoff exists). Later hooks confirm the observed cursor.
Presence updates run while client liveness is verified; authentication heartbeats run every 60 seconds. Claim leases are not automatically renewed.

A clean SessionEnd queues a `kind: "shutdown"` handoff containing coordination
facts only, then acknowledges observed journal events and releases eligible claims. Owner claims
are preserved; release always uses the captured fencing token. Cleanup can finish
after the client exits. A crash sends no fabricated handoff or acknowledgment and
lets leases expire. In default Codex mode, closing a frontend connection can leave
the daemon's thread alive; the session ends according to Codex's SessionEnd rules,
not merely when a terminal disappears.

Network failures do not block local work. Hook stderr and `tila lifecycle status`
report degradation; the next prompt retries re-entry. If the Codex observer cannot
verify thread status, heartbeats pause. Incomplete shutdown intent remains recorded, but cleanup stops after five minutes and runtime access closes. Retry during the original active helper lifetime; after closure, recover in a new run through a handoff. A killed local lock holder may take ten
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
Environment-gated integration tests are not cached. Every CI run still runs the
full suite. The affected task list in `selection.json` informs Mergify scopes,
but does not select which tests CI executes.
Enable selective execution in a follow-up change only after ten paired PR runs
prove selection includes required tests for schema, SQLite, migration, SDK, UI,
installer, root-config and lockfile changes. Missing Git history falls back to full
execution. Revert to full selection immediately if any dependency is missed.

Manual CI dispatch with `benchmark=true` runs the baseline and Turbo concurrency
2/4 × Vitest workers 1/2, three times each on one revision. It does not tune CI
automatically. Select the lowest median with no failures and at most 10% extra
runner time; retain the baseline if none qualifies. Reports last seven days.

### Mergify scopes and batching

Mergify processes one batch at a time, with up to three ready PRs and a maximum
30-second wait to fill a batch. Apply `merge-ready` once the PR is pushed and
validated locally; Mergify queues it and waits for `ci`. Keep GitHub's required `ci` check, but leave "Require branches to
be up to date before merging" disabled: Mergify validates the combined changes
against `main` on a temporary batch PR.

Scopes use the `manual` source, meaning CI supplies them automatically. The
selector uses Mergify's queue-aware base/head commits and Turbo's `--affected`
package set, including downstream consumers. A UI change therefore includes the
Worker; shared SQLite changes include both cloud and local consumers. The shared
integration-test package intentionally makes many changes overlap.

Package manifest changes, files outside known packages (including documentation,
CI and build tooling), missing history, empty selections, or detection errors
set `all_scopes: true`. These changes become barriers: they are validated alone.
Renames include both paths and deletions retain the old package's scope.

A separate `scopes` job uploads only JSON to Mergify, keyed by the PR head SHA,
after `verify` succeeds. It executes no repository code and holds the
`MERGIFY_TOKEN` secret only during upload. The token must be a Mergify application
key with the `ci` scope; an admin-only key is not sufficient. Missing tokens or
failed uploads block the required `ci` gate on same-repository PRs. Fork and
Dependabot PRs skip upload and use Mergify's catch-all behavior.

Scopes affect merge safety: Mergify can skip queue CI when intervening recorded
merges touch only unrelated scopes. Keep the scope contract tests green and
retain full test execution inside CI. To roll back scopes, set
`scopes.source: null` in `.mergify.yml`; batching and full CI remain available.
See [Mergify scopes](https://docs.mergify.com/merge-queue/scopes/) and
[Direct Merge](https://docs.mergify.com/merge-queue/direct-merge/).

### Local Cloudflare runtime validation

`pnpm test:runtime` runs the required Workers suite with local DO SQLite, D1 and
R2. It uses the production compatibility date/flags and real migration sources,
resets data between tests, and rejects unexpected outbound fetches. The suite
checks exclusive claims/fences, stale writes, migration upgrades and transaction
rollback, eviction/reconstruction, D1 authorization/revocation, and recovery of
interrupted artifact commit publication without duplicates. JSON reports reject
skipped, TODO, failed or empty runtime results. Placeholder-only tests in the
older integration suite are explicitly TODO; meaningful assertions are retained.

Primary CI uses Node 24. Node 22 SDK/MCP compatibility remains a full-run check
on the daily schedule, manual full validation, and release validation. Bun and
pnpm remain pinned. Runtime tests run in parallel with verification and secret
scanning and are required by `ci`. They do **not** prove production PITR or
remote latency/performance: keep the existing manual live-infrastructure release
gates above.

### Release artifacts and rehearsals

The Release workflow validates the exact checkout before packaging. A publish tag
must equal `v<product version>` and point to a commit reachable from main. Run the
manual pre-tag live-infrastructure gates above before creating a release tag;
local runtime validation does not replace them.

The pipeline runs full lint/version, typecheck, Node/Bun package tests, root script
tests, local runtime tests and audit. It builds a fresh workspace with no restored
Turbo output, generates one Worker bundle and deploy payload, compiles eight
binaries and packs all eleven public npm packages. Each binary embeds the deploy
payload (Worker bundle, a UI build made with an empty `VITE_API_URL`, and the D1
migrations) with `bun build --compile --asset`, so an installed CLI can run
`tila deploy` and `tila infra provision` without a source checkout. `manifest.json` records the revision, version, compiler,
commit timestamp, target inventory, tarball integrity and every file checksum.

Clean-directory consumers install the tarballs and check SDK ESM/CommonJS local
SQLite persistence, MCP stdio initialization/tool discovery through a private managed-run broker, and the npm CLI. The MCP probe also checks that discovery fails after broker access is revoked.
Node 22/24 consumers exercise both SQLite 12.10.0 and 13.0.3. Each SDK/MCP package
must resolve the selected driver; the smoke test opens a native database and resolves the shipped WebSocket dependency. MCP no longer ships the keyring addon or accepts local SQLite configuration; the broker fixture uses no real credentials or native sessions.
Native Linux, macOS and Windows x64/arm64 runners also test packed SDK/MCP consumers
with SQLite 13.0.3, execute the binaries and run local installer fixtures; both musl binaries run in native-architecture Alpine containers.
The raw binary, the installer-installed copy and the npm CLI each run
`tila deploy --dry-run --json`, which must report the release version, an embedded
payload, at least one D1 migration and a UI `index.html`.
The POSIX installer detects musl and selects that target. SDK private implementation
packages are bundled build dependencies, never unpublished npm runtime dependencies.

Only after all smoke checks pass are provenance/SBOM attestations generated and
verified against this repository, release workflow and source revision. Publishing
jobs download the same payload, reverify it, and never rebuild. SDK/platform
packages publish before MCP/the main CLI; the GitHub release follows successful
npm publication. A retry skips an existing npm version only if registry integrity
matches the tested tarball. Retry failed jobs while their seven-day artifacts remain
available; a complete rebuild may produce different binary bytes and must not be
silently substituted for a partly published release.

Use Actions → Release → Run workflow, selecting the desired branch, for a rehearsal.
It performs validation, packing, platform/consumer smoke tests and attestation
verification, but cannot publish npm packages, a GitHub release or Homebrew changes.
Locally, after `pnpm build`, `pnpm --filter tila-cli compile` builds all targets;
standalone `compile:<target>` commands remain supported. `node scripts/release-pack.mjs`
requires a fresh `.release` output directory. `node scripts/release-smoke.mjs .release
consumer` installs into a temporary directory and tests the local platform.

Homebrew updating is a downstream reusable workflow, no longer a release-event
listener. It remains disabled unless a maintainer explicitly enables the workflow,
sets `ENABLE_HOMEBREW_PUBLISH=true`, and supplies the tap credential. A rehearsal
never calls it. No release versions, production settings or schemas change here.

### CI rollout measurements

The initial observed median was about four minutes. Stage-one hosted verification
completed in 3m35s on its final run. Stage-two's first cache-cold PR verification
completed in 4m56s; successful main validation then seeded the trusted cache. The
Node-24 runtime stage passed hosted verification in 3m16s with a 34s parallel
runtime job. These are individual observations, not comparable cold/warm medians.
Use the saved step timings and Turbo summaries for comparison; the concurrency
benchmark runs fifteen samples on one fixed revision. Keep the baseline until a
candidate meets the speed, zero-failure and runner-time criteria. Affected-only
execution remains disabled pending ten paired PR observations. The under-two-minute
warm-PR target is not yet demonstrated.

## Dependency update policy

Renovate owns routine version updates. Dependabot owns immediate security fixes;
its version-update limit is zero, while repository security updates and alerts
remain enabled. Renovate vulnerability PRs are disabled to avoid duplicate fixes.
Do not disable Dependabot security updates when changing this configuration.

Routine updates are collected on Mondays (Europe/Warsaw),
with at most three open Renovate PRs and two new PRs per hour. Existing branches
can receive new versions or conflict repairs outside that window. Renovate only
rebases conflicts; Mergify owns integration checks against current `main`.
Compatible updates are grouped by runtime libraries, build/test tools, UI,
Cloudflare tooling, experiments, and GitHub Actions. SHA-pinned actions stay pinned.
Shared runtime libraries stay in one group even when test fixtures declare them
as development dependencies. The weekly shared lockfile refresh stays in the
overnight window and is reviewed because it includes runtime tooling.

Major updates require approval on the Dependency Dashboard and remain separate
migrations. Pre-1.0 minor upgrades also require approval because their APIs can
break. npm releases wait three days before routine updates. Renovate does not
enable GitHub auto-merge or apply `merge-ready`. After reviewing an update and
completing local validation, add `merge-ready`; Mergify waits for the required
`ci` check. Mergify validates serial batches of up to three PRs
against current `main`, then merges them;
verify the actual queue state rather than treating the label as proof of admission.

Node 24 runs builds, while Node 22 remains the supported public-consumer floor.
The Node 22 consumer job and Node 22 type definitions must not be upgraded just
to clear dashboard entries. Public SQLite peer ranges, native binary runner
baselines, and Cloudflare/Vitest compatibility also require migration-specific
validation rather than blanket approval of every major update.

For each approved migration, run package tests, type checks, and the relevant
packed-consumer or native-runner checks. Changes to Cloudflare tooling must pass
`pnpm test:runtime`; changes to workflows must preserve the required `ci` gate.
Keep security overrides until the vulnerable dependency chain is demonstrably
fixed. Do not widen an override's major-version range simply to remove an alert.

### Major migrations held after the October 2026 catch-up

The catch-up includes Cloudflare types/SDK, native SQLite/keyring, jsdom,
jest-dom, Lefthook, dotenv and GitHub Actions majors after their targeted checks.
Production Zod stays on v3; the standalone experiment already uses v4. These
remaining dashboard entries need the following work before approval:

| Update | Evidence or compatibility constraint | Work needed before merging |
| --- | --- | --- |
| TypeScript 7 | The SDK declaration build crashes in tsup/rollup-plugin-dts while reading `useCaseSensitiveFileNames`; the native compiler no longer provides the same JavaScript compiler API. | Adopt a declaration-build path that supports the compiler, then build and test packed SDK/MCP consumers. |
| Vitest 5 | The pinned Cloudflare Vitest plugin requires Vitest 4. | Upgrade to a plugin release with matching peers and pass the required DO SQLite, D1 and R2 runtime gate. |
| MSW 3 | Vitest 4 declares an optional MSW 2 peer for its mocker package, while the required Cloudflare plugin holds Vitest at v4. | Upgrade the compatible test-tooling combination first, then migrate MSW imports and strict unhandled-request settings together. |
| Biome 2 | Migrating the configuration and running v2 on the current tree produced 363 errors and 231 warnings. | Land a dedicated configuration, formatting and rule migration with a clean lint gate. |
| pnpm 12 | The trial moves configuration into the workspace file, ignores the old `package.json` override location, and rejects fresh dependencies under its new default release-age policy. | Migrate overrides and dependency build approvals explicitly, review the release-age policy, and validate frozen installs plus native consumers. Keep supply-chain checks enabled. |
| Production Zod 4 | Schemas and inferred types are shared public SDK/API contracts. | Migrate schemas, error/default behavior and consumers together, with compatibility tests and an explicit API-impact review. |
| Undici 8 overrides | Current Miniflare tooling depends on Undici 7; overrides intentionally constrain that supported major. | Wait for a supported parent dependency migration, then recheck security and runtime behavior. |
| Node/Ubuntu baselines | Node 22 is the public consumer floor; Ubuntu 24.04 sets the native Linux binary baseline. | Change the support contract and validate packed consumers/native binaries before raising either baseline. |

Keep these migrations visible on the Dependency Dashboard. Do not approve all
pending entries merely to empty it, or disable the existing runtime, lint,
security or consumer gates to make a dependency update pass.

## Durable conversation operations

Deploy compatible server behavior before clients. Slice 2 needs shared DO/embedded
migration 31 and the slice-1 D1 migration 0031; it adds no further D1 migration.
Conversation cursors are signed with a per-project key derived from the first
configured Worker secret:

| Order | Secret | Notes |
|-------|--------|-------|
| 1 | `CONVERSATION_CURSOR_KEY` | Dedicated key, at least 32 random characters. A shorter value fails closed instead of falling back. |
| 2 | `HASH_PEPPER` | Same derivation as 0.4.0, so deployments that already set a pepper keep outstanding cursors. |

With neither, conversation routes return 503 `config-unavailable`. Callers that
can manage conversations also get `details.reason` (`missing` or
`cursor-key-too-short`); other callers get only the code. Tasks, records,
artifacts and settings are unaffected.

To enable conversations on a deployment without `HASH_PEPPER`:

```bash
openssl rand -base64 32 | wrangler secret put CONVERSATION_CURSOR_KEY
```

This changes no credential hash, so tokens and sessions keep working. Do not set
or rotate `HASH_PEPPER` to enable conversations: it changes every stored
credential hash; see [Rotate `HASH_PEPPER`](#rotate-hash_pepper).

Adding, rotating or removing the winning secret invalidates outstanding
conversation cursors only. History and inbox page requests that carry an old
cursor get 400 `invalid-cursor`; restart them without a cursor. Pending
deliveries, messages, credentials and sessions are unaffected.

| Symptom | Recovery |
|---------|----------|
| `stale-binding` | Inspect the current agent epoch and stop using the old binding; replace only with authorized current state |
| `cursor-expired` | Restart history; fetch the inbox without a cursor to recover pending work |
| `fetched-not-acked` | Inspect the session; fetch does not accept responsibility and may indicate a crash |
| `budget-suppressed` | Inspect the delivery timeline and loop cause; a maintainer can use `tila inbox resume AGENT --delivery ID` |
| Uncertain native wake | Reconcile `dispatch.status(agent, leaseToken)`; fetched/acked observations are metadata only |
| Unknown delivery outcome | Browse `GET /deliveries` (filters `agent`, `room`, `state`, `id`) as a manager, or read `GET /rooms/:room/messages/:message/deliveries`. Acknowledged is not completed: `work_result` reports only the explicit result of the message's `attempt_id` (`pending`, `reported`, `unlinked`, `hidden`), or `not-reported` when the message names no attempt |

Room membership controls publication and private history. Creating rooms and
changing members requires `conversations:manage`. Explicit enrollment policies
must grant mailbox capabilities; no existing worker credential gains them silently.
Relay policy allows only `dispatch:relay` and `agent-bindings:attach`; relay runs
cannot fetch bodies, publish replies or acknowledge processing.

The daily sweep and lazy fetch/lease expiry mark overdue deliveries expired while
retaining messages. Backups carry all conversation tables. Restore verifies the
snapshot, invalidates copied bindings, clears dispatch leases, resets reply context
and changes cursor generation. Reattach valid current runs after restoration;
exact-binding deliveries never transfer to replacement sessions. Project destruction
includes every conversation table.

A watched mailbox holds at most two waiters for at most 25 seconds. Clients should
re-poll with jitter; timeout is a successful `changed:false` response. Native wake
and unattended restoration require the later connector and live acceptance gates.


### Host conversation connector

`tila connector start|status|register|unregister|stop` manages a single private
macOS/Linux relay process. Registration takes a discovered native lifecycle key
and an expected binding epoch; the existing acting run remains the mailbox holder.
Use separately verified provider profiles and explicit enrollment conversation
capabilities. [Connector operations](../packages/connector/README.md) documents
native support, pending wake recovery, explicit attended restoration, and limits.

Deploy the additive dispatch status `attempt`/`server_now` metadata before connector
clients. No new migration is required for this slice. Missing metadata, unverified
process/profile identity, unsupported native guarantees, and uncertain wake outcomes
leave delivery pending. Do not repair these states by acknowledging unread inboxes.

### Dashboard conversation recovery

Open **Rooms** to read recent shared messages and existing threads. Use **Older
messages** to page back and **Latest messages** to restart at the tail. Expired or
restored cursors require Latest; they do not alter pending inbox delivery. The
**Agents** page displays mailbox attachment/lease status and links each agent to
its deliveries. Select **Deliveries** under a message to see its outcome: room
readers get counts (stored, pending, acknowledged, expired); managers also get each
recipient with a **Trace** link. The **Deliveries** page browses and filters traces
by agent, room, state or message/delivery ID without copying IDs from CLI output.
A trace shows Stored, Wake, Fetched, Acknowledged and Work result separately.
Acknowledged means accepted for processing, not finished work. Work result shows
the explicit outcome of the attempt the message names, "Pending" while that
attempt runs, and "Not reported" when the message names no attempt. Expired delivery metadata does not
mean the message was never sent; room history keeps it. Trace URLs stay
project-scoped and shareable, and opening one never fetches or acknowledges.
The **Signals** page (admin) pages through unexpired signal history and shows each
signal's resource, payload, expiry and per-recipient stored/acknowledged state.
Signals have no wake stage. Swept (expired) signals are no longer listed, which is
not evidence that they were never sent.

Replies are saved in sessionStorage for the current tab and principal. After a
network failure or fresh sign-in, use **Retry saved reply**. It resends the frozen
payload with its original operation ID. Editing the textarea creates a newer draft;
the previous uncertain publication must be reconciled before the newer draft can
be sent. Closing the tab clears browser recovery state. If storage is unavailable,
copy the draft before leaving; the reauthentication button will not navigate away.

Deploy the compatible backward-history and `tail_cursor` server behavior before
this dashboard. There are no new database migrations in this slice. Preserve the
D1-before-Worker ordering for slice 1. The stacked PRs remain held for explicit
authentication-boundary review; passing UI or connector fixtures is not live
multi-account acceptance. See the versioned [acceptance evidence](evidence/issue-283-acceptance-v3.json).

## Managed queue activation and recovery

Managed dispatch is disabled and paused by default. Install lifecycle metadata
for each dispatched work type before enrolling work. Read the current schema and
queue revisions, then enable a fixture project with an explicit positive execution
limit. WIP is uncapped unless configured. Once enabled, configuration writes must
remain revision-aware even if the queue is subsequently disabled.

Use `tila queue inspect --json` for occupancy, oldest waiting age, blocked work
and policy revision. `tila attempt list --data '{"state":"uncertain"}' --json`
locates executions requiring reconciliation. A restarted wrapper lists its own
unfinished work with
`tila attempt list --data '{"principal_id":"<principal>","participant_id":"<participant>","active":true}' --json`. Journal domain events retain grant
denials, expiry, suspension, recovery and terminal outcomes. Queue/attempt history
and safety-critical receipts are included in backup and are not removed by the
seven-day generic deduplication sweep.

Pausing blocks new grants and resumed execution. Existing accepted work can finish;
heartbeats, cancellation and reconciliation remain available. Lowering capacity
does not evict work. Cancellation is a request until the adapter reports stopped
execution or another valid terminal outcome. Do not manually delete reservations
to free slots while execution may still exist.

Cancellation, suspension, resume and explicit retry requests must come from the
attempt's current owner, the principal that enrolled the work, or a maintainer.
Edit and withdraw belong to the enrolling principal or a maintainer. Other
members, including a worker whose attempt was rebound or replaced, get
`403 queue-authority-lost`. Work enrolled before this rule (migration 38) has no
recorded enroller; it accepts control from the owner or a maintainer only. If an
`enroll` retry under a new idempotency key returns `409 queue-conflict`, the
message and `details.entry_id` name the enrollment that already exists for the
task; inspect it instead of enrolling again.

For uncertain execution, inspect the recorded provider session first. Reconnect
or rebind a confirmed live session; reconcile a confirmed stopped session with an
explicit outcome. If the recorded session stopped but the work continues in a new
provider session, the owner calls `tila attempt replace-session` with the recorded
fence, the old session as `previous_session`, `previous_stopped: true` and the new
session. The attempt keeps its ID and gets a fresh fence; the old session can no
longer heartbeat or report a result.

If a regression appears after an accepted result, do not edit or re-finish the
original attempt. Create or choose the corrective task, then link it:
`tila attempt correct <attempt-id> --data '{"idempotency_key":"<key>","task_id":"<task>","reason":"<why>"}' --json`.
The original outcome stays as evidence, `GET /attempts/:id` lists the link, and
delivery traces for that attempt show the result as corrected.

If a result fails with `422 constraint-violation` or `409 queue-conflict` and the
message names a current and a captured definition version, the definition
changed during the attempt and now rejects the lifecycle transition. Nothing was committed. Restore a lifecycle mapping or
field rule that accepts the transition (as a new definition revision), then
finish or reconcile again. An unreachable session remains uncertain even when the work was
declared retry-safe. Maintainer force recovery requires a reason and records
abandonment with unresolved external execution; it cannot kill an unreachable
process. Reconcile restored suspended sessions with `observation: "suspended"`,
`execution_quiescent: true`, their matching session and checkpoint before releasing
execution occupancy.

Restored projects stay paused and invalidate old authority. Reconcile every saved
execution before enabling admission. Rollback is to pause, preserve durable state,
and retain completion/reconciliation endpoints. Do not downgrade to a version
that ignores managed-task guards or remove queue tables. The SDK execution helper,
CLI, MCP tools and Queue dashboard use this shared contract. Actual coding-provider
and multi-host release evidence remains governed by #283; fixture processes do not
satisfy those separate live-runtime obligations.

### Queue dashboard

Open **Queue** in the project navigation or **View or enroll in queue** from a
work item's detail. Enrollment is explicit. The dashboard never starts coding
processes: repository wrappers obtain and accept their own grants.

The view pages through all matching entries and separates execution occupancy
from work in progress. Filter backlog, active, suspended, uncertain or terminal
work, with optional type, priority, target principal and capability filters.
Queue settings control admission and limits; pausing preserves running work's
completion and reconciliation access. Limits below current occupancy prevent
additional grants without evicting existing execution.

Attempt details link task, provider session, host/worktree and result evidence.
Cancellation, suspension and resume buttons record intent. Only confirmed stopped
execution or safe quiescence releases the applicable reservation. Maintainers
can record verified observations, rebind the same recorded execution, or force
recovery with a reason. Force recovery records unresolved external execution;
it does not kill a process.

Actions follow current role and credential capabilities. When permission queries
are unavailable, the queue remains visible but actions are disabled. Failed
refreshes show the last known state with a stale notice. Revision conflicts retain
form input: inspect the updated state, choose **Use latest revision**, and submit
again. Task links keep their existing URLs, and a task-scoped queue link works
regardless of which list page contains its enrollment.


### Queue rollout and diagnostics

1. Deploy code with the queue disabled. Confirm `/api/health` advertises
   `managed-queue-v1`. Existing task creation and un-enrolled claims keep their
   previous behavior.
2. Review and apply revision-aware lifecycle metadata. Explicitly distinguish
   dependency success from cancellation/failure. Configure start/outcome mappings
   only when Tila should change task status; otherwise the repository owns it.
   A retry still needs a dispatchable task, so map failure/abandonment to an eligible
   status if the project expects immediate replacement.
3. Enable an isolated fixture project with a positive execution limit and optional
   WIP limit. Enroll work explicitly. Run the SDK example in
   `packages/sdk/examples/queue-worker/README.md` with an executable/argument array,
   stable worker principal/participant and durable launch directory. Test stop,
   restart, cancellation and unknown execution before connecting a real pipeline.
4. Enable a real project explicitly after its adapter's duplicate detection and
   session inspection have been verified. One orchestrator may enroll/target and
   start wrappers; each wrapper obtains its own grant. Ten hosts with ten wrappers
   share the same project capacity. Independent local database files do not.
5. Roll back operationally by pausing admission. Keep completion, heartbeat,
   cancellation and reconciliation endpoints available. Do not evict workers by
   reducing limits, delete reservations or run old code that ignores managed work.

`queue.inspect` (SDK), `tila queue inspect --json`, `tila_queue` with `inspect`,
and the dashboard return the same policy, queue counts and eligibility reasons.
The inspection's `diagnostics` object reports project-wide operational totals from
retained journal rows in the last 24 hours: grant denials by reason, expired
unaccepted reservations, uncertainty events, reconnections/stopped reconciliations,
retries and forced abandonments. Receipt replay does not count another denial.
These are retained-event totals, not lifetime counters; archival or restoration
can reduce coverage. Current execution/WIP occupancy and expired accepted leases
come from durable state and remain authoritative regardless of journal retention.
A stored running attempt with an expired lease has no execution authority even
before a sweep changes its state. The dashboard flags those leases, and admission
and mutation paths reconcile expiry before granting authority.

SDK helpers inspect a recorded session before external actions after a restart.
Expired accepted work is reconciled to the same session with fresh authority or
left uncertain; an unaccepted expired reservation is released without launching.
A revision conflict causes another inspection, never a blind repeat of a launch.
A lost authority signal cannot undo an external effect already performed.

### Queue restore preflight

Replacing a project requires a quiescent destination: no nonterminal attempts and
no execution/WIP reservations, including suspended work and pending retries. The
check runs under the transfer lock before deleting rows or swapping the local
file. Rejected fresh imports and safety-export promotions preserve current state
and release their lock so executions can finish. Inspect and reconcile existing
sessions first; force recovery is not a way to prove they stopped and creates a
replacement reservation that also blocks restore until resolved.

Exports may contain active, suspended and uncertain source work. Importing those
snapshots into an empty or quiescent destination preserves history and permanent
receipts, advances fences beyond both source and destination, revokes old grants,
marks unfinished executions uncertain and pauses dispatch. Confirm a checkpoint
is still safely suspended before releasing its execution slot. Older compatible
prequeue snapshots restore with dispatch disabled. A snapshot cannot reconstruct
external work omitted from that snapshot: keep the verified safety backup and
reconcile against the runtime's durable launch records before enabling work.

### Queue acceptance evidence

| Boundary | Repeatable evidence | What it proves |
|---|---|---|
| Shared contract | `packages/integration-tests/src/queue-conformance.ts`, invoked by embedded and required Worker runtime tests | Identical public operations for ordering, capability/target filtering, execution/WIP separation, pause/resume, cancellation, receipts and force recovery |
| Distributed admission | `packages/integration-tests/runtime/queue.test.ts` and `queue-api.test.ts` | 100 concurrent consumers with limit 20, duplicate requests, real DO SQLite atomicity and eviction/cold-start persistence; authenticated D1 membership and scope checks |
| Shared local file | `packages/ops-sqlite/test/queue-contention.test.ts` | Separate Node and Bun processes contend on one WAL database with embedded busy retries |
| Recovery and compatibility | Queue/attempt operations, SDK executor, backup, upgrade and required `queue-restore.test.ts` suites | Expiry without timely sweeps, stale fences, outcomes, retries, active-destination restore rejection and prequeue restore/upgrade |
| Client surfaces | CLI/MCP integration tests and `packages/ui/test/pages/queue.test.tsx` | Equivalent backend actions, >250 entries, permission/query failures and retained input after conflicts |
| Foreground OS processes | `packages/sdk/examples/queue-worker/process-adapter.test.mjs` on macOS locally and Linux CI | Attempt-keyed launch deduplication, restart inspection, observed exits and cooperative cancellation using real OS processes |

The authenticated browser fixture uses isolated local Worker/DO/D1 state with
260 enrolled items. It exercises pagination, pause/resume, durable cancellation
intent and a failed permission query while retaining queue data. Its execution
records are simulated. The OS fixture launches Node foreground processes, not
coding-provider sessions. Neither is evidence that an unreachable coding runtime
was forcibly stopped. Broader issue acceptance stays open where these queue
scenarios satisfy only one portion (#300/#305/#301, #308/#193 and #283).

### Worker questions and owner decisions

Use project-scoped `GET /questions` and `GET /questions/:id` to inspect durable
question state. `POST /questions` asks; `POST /questions/:id/answer`, `/escalate`,
`/cancel`, and `/link-discussion` perform explicit mutations. All mutations carry
an `idempotency_key`; reuse the exact command after an ambiguous response. An
optional `Idempotency-Key` header must match the command key.

The CLI exposes `tila question ask|get|list|answer|escalate|cancel|link-discussion`
with `--data` JSON or `--file`; `--json` returns a structured result. The SDK
exposes `questions` and MCP exposes `tila_question` in the default queue group.
These share the same contracts in remote and embedded modes.

```sh
tila question list --data '{"state":"open","responder_principal_id":"user:OWNER_ID","limit":100}' --json
tila question get QUESTION_UUID --json
```

Asking requires `id` (UUID), `attempt_id`, `expected_revision` (current attempt),
`fence`, `text`, and `responder_principal_id`. Answering requires `question_id`,
`expected_revision` (current question), `attempt_id`, `attempt_revision` and
`attempt_fence` from the saved question, plus `text`. Escalation replaces `text`
with `responder_principal_id` and `reason`; cancellation supplies `reason`.
Discussion linking supplies `discussion: {room_id, message_id}`. Each command
also requires its stable operation key. Responder principals must have current
project membership; escalated responders must be owners.

List filters include task, attempt, requester principal, responder principal,
state, and `escalated` (`true` or `false`). Each page reports `total`, the number
of questions matching the same filters across all pages. Continue a page with
`after_id` equal to `next_after_id` and unchanged filters. Use journal replay with its fixed `through_seq` for recovery across
concurrent writes; acknowledge only processed changes. Reads never acknowledge.

If `answer_applicable` is false, keep the answer as evidence. Reconcile execution
with the attempt API, then ask a new question referencing the old question through
`predecessor_id`. Obtain fresh confirmation; do not copy an old answer into an
execution command. A question answer never substitutes for a current claim fence.

Deployment adds project migration 36 without changing generic task or attempt
commands. Back up with a client supporting `work-questions-v1`; older clients
must not export or restore the new schema as an older snapshot.


## Project-reported journal events

Use custom reports for meaningful observations. Put large logs/test evidence in
artifacts, then pass their canonical keys in `artifact_refs`.

```sh
# The JSON file contains the JournalAppendRequest contract, including target.
tila journal append --file report.json --idempotency-key run-abc-unit --json
cat report.json | tila journal append --file - --idempotency-key run-abc-unit --json
tila journal tail --event-name pipeline.tests_passed --correlation-id run-abc --json
```

The SDK exposes `journal.append(input, { idempotencyKey })`; MCP exposes
`tila_journal_append` with `input` and `idempotency_key`. The dashboard's Journal
page provides Report event and inspection filters. It labels project reports
separately and shows recorded time, reporter, and optional reported occurrence
time. Payloads are untrusted text/JSON, never executable instructions.

CLI JSON output retains its standard `{ "ok": true, "result": { "event": {...},
"dedup_expires_at": ... } }` envelope. SDK callers receive the HTTP receipt
directly; MCP returns it in structured output.

| Outcome | Action |
| --- | --- |
| HTTP 200 with `event.seq` | Durable acceptance; retain the key and `dedup_expires_at` |
| Lost response | Retry identical input with the same key within seven days; current authority must still be valid |
| `idempotency-key-conflict` (422) | Inspect the original submission; do not change input under a previously used key |
| `validation-error` (400), `payload-too-large` (413) | Correct the contract or move evidence to artifacts; no report was accepted |
| `rate-limited` (429) | Wait for `Retry-After`, then retry with the same key |

Limits are 60 new reports per principal per UTC minute and 300 per project per
UTC minute, across credentials and participants. Identical accepted retries do
not consume additional quota. Failed writes roll back their counters and receipt.
Expired receipts/counters are cleaned on append and during the daily sweep.

Authorization failures, missing participants, missing references, and stale
claims/fences never append a report. The worker credential preset now includes
`journal:append`; existing scoped credentials require explicit reissuance to gain
it. Private resources and namespace-restricted credentials remain unsupported.
Completion-like event names do not change work state. Cursor acknowledgments
must follow processing the complete replay page, not a filtered display.

Monitor HTTP error codes and journal/receipt storage using existing request and
DO operation telemetry. A restored project keeps receipt expiration unchanged;
claim-bound retries may fail after restore invalidates execution authority.
