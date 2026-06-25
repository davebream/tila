# GitHub-scoped auth and repo allowlisting

## Status

Production. This is the default auth model for tila. For implementation details, see [`docs/10-AUTH-IMPLEMENTATION.md`](10-AUTH-IMPLEMENTATION.md).

## Problem

The original v0.1 auth model used tila project API tokens stored as hashes in D1. That worked for small teams sharing a token through a secret manager, but it did not let GitHub repo access be the source of truth.

The target model is:

- GitHub determines who may use a tila project.
- Cloudflare still hosts and bills the tila infrastructure.
- A public Worker URL must not be enough to use a tila instance for arbitrary repositories.
- A tila instance must only handle repositories explicitly registered for that instance.

## Decision Direction

Cloudflare and GitHub should remain separate planes:

| Plane | Responsibility |
|---|---|
| Cloudflare account | Owns Worker, Durable Object namespace, D1, R2, billing, data residency, operational access |
| GitHub repo/org/team | Determines runtime user access to tila |
| tila project | Binds one Cloudflare-hosted state engine to one or more explicitly allowed GitHub repositories |

Do not try to map Cloudflare users to GitHub users. The Cloudflare account is the infrastructure owner. GitHub is the runtime authorization authority.

## Recommended Runtime Flow

1. User runs a tila command inside a GitHub checkout.
2. CLI reads `.tila/config.toml`.
3. CLI obtains a GitHub token from `gh auth token` or from `GITHUB_TOKEN` in CI.
4. CLI sends the GitHub token to the tila Worker exchange endpoint.
5. Worker verifies the GitHub identity and repository permission.
6. Worker checks that the repository is registered in the server-side allowlist for this tila project.
7. Worker mints a short-lived tila session token bound to:
   - `project_id`
   - `github_host`
   - `github_repo_id`
   - `github_login` / `github_user_id`
   - effective permission
   - expiration time
8. CLI uses the short-lived tila session token for normal API calls.

The Worker must never persist, log, or return the raw GitHub token.

## Server-side Repo Allowlist

The allowed repository list must live in Cloudflare persistence, not only in local config. Client-side config is useful for UX but is not a security boundary.

Add a D1 table similar to:

```sql
CREATE TABLE _project_repos (
  project_id TEXT NOT NULL,
  github_host TEXT NOT NULL DEFAULT 'github.com',
  github_owner TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  github_repo_id INTEGER NOT NULL,
  min_read_permission TEXT NOT NULL DEFAULT 'read',
  min_write_permission TEXT NOT NULL DEFAULT 'write',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (project_id, github_host, github_repo_id),
  FOREIGN KEY (project_id) REFERENCES _projects(project_id)
);

CREATE INDEX idx_project_repos_lookup
  ON _project_repos(project_id, github_host, github_repo_id);
```

Use `github_repo_id` as the canonical repository identity because owner/name can change after a rename or transfer.

## Worker Enforcement Rules

Every authenticated project request must satisfy all of these:

```text
session.project_id == route projectId
session.github_repo_id is enabled for route projectId
session.permission is sufficient for the route
session has not expired
```

The current `projectMiddleware` derives a Durable Object stub from `:projectId`. A GitHub-scoped auth implementation must also reject project/session mismatches before routing to the DO.

Knowing the Worker URL must not grant any capability.

## Exchange Endpoint

Add:

```http
POST /api/auth/github/exchange
```

Request:

```json
{
  "project_id": "tila-a1b2c3",
  "github_token": "gho_..."
}
```

Response:

```json
{
  "ok": true,
  "session_token": "tila_session_...",
  "expires_at": 1760000000,
  "project_id": "tila-a1b2c3",
  "github_login": "alice",
  "github_repo_id": 123456789,
  "permission": "write"
}
```

The Worker should call GitHub to:

- identify the token holder
- resolve the registered repository by stable id
- verify the holder has the required permission

If the GitHub token is valid but the repo is not in `_project_repos`, return `403`.

## CLI Behavior

Add an auth mode to `.tila/config.toml`:

```toml
[auth]
mode = "github-repo"

[github]
host = "github.com"
owner = "acme"
repo = "app"
repo_id = 123456789
```

CLI behavior:

- If a cached tila session exists and is still valid, use it.
- Otherwise call `gh auth token --hostname <host>` or read `GITHUB_TOKEN` in CI.
- Exchange the GitHub token for a tila session.
- Store only the tila session locally, not the GitHub token.
- Optionally compare the current git remote to `[github]` config and warn on mismatch.

Local git remote checks are only UX. Server-side allowlist enforcement is the security boundary.

## Admin And Provisioning

Only admins should register repositories for a tila project.

Acceptable admin paths:

- Cloudflare admin runs `tila infra provision` + `tila project create` and registers the initial repo.
- A bootstrap/admin tila token registers additional repos.
- **Per-project opt-in** (`repo_admin_auto_admin`, default off): when enabled, a GitHub session
  with `admin`-tier repository permission — either a CLI bearer session or a browser cookie
  session — is admitted to all project-admin operations without needing an explicit entry in
  the `_admin_grants` roster. Covered operations include managing the admin roster, DO restart,
  repo registration, and token management. When the flag is off (the default), these operations
  require a D1 full-scope token.

  To enable for a specific project:

  ```bash
  wrangler d1 execute <DB> --command \
    "UPDATE _projects SET repo_admin_auto_admin = 1 WHERE project_id = '<id>'"
  ```

Normal repo members may use an already registered repo, but must not be able to add unrelated repos to the same tila instance.

## Single-repo vs Multi-repo Projects

Default to one tila project per GitHub repo:

```text
tila project -> one GitHub repo id
```

Allow multiple repo rows only for explicit multi-repo workflows, monorepos with companion repos, or framework-managed project groups.

## Browser UI

The browser dashboard cannot use `gh auth token`. It needs a separate web login path:

- GitHub OAuth web flow, or
- CLI-generated short browser session.

The UI should use the same server-side repo allowlist and project/session checks as the CLI.

## Existing Token Mode

Keep the current tila token model as an auth mode:

```toml
[auth]
mode = "tila-token"
```

GitHub-scoped auth can be introduced as:

```toml
[auth]
mode = "github-repo"
```

This avoids forcing every self-hosted or non-GitHub project into GitHub identity.

## Non-goals

- Do not use GitHub Issues, GitHub Contents, or pull requests as the primary state backend.
- Do not rely on Worker URL secrecy.
- Do not authorize by client-provided owner/repo strings without checking the server-side allowlist.
- Do not persist raw GitHub tokens.
- Do not require normal users to have Cloudflare account access.

## Implementation Sketch

1. Extend config schema with `[auth]` and `[github]`.
2. Add D1 `_project_repos` and `_sessions` or signed session-token support.
3. Add GitHub exchange route.
4. Add GitHub API client helper in the Worker.
5. Update auth middleware to support both `tila-token` and `tila-session`.
6. Enforce `token/session project_id == route projectId`.
7. Add route-level permission checks.
8. Update CLI auth resolution to exchange `gh` credentials.
9. Add tests for:
   - unknown Worker URL with no auth returns 401
   - valid GitHub token for unregistered repo returns 403
   - valid GitHub token for registered repo returns session
   - session cannot access a different `project_id`
   - read session cannot perform write operations
   - revoked repo allowlist row blocks new exchanges

## DPoP Sender-Constrained Tokens

> **Status:** Production (WI-G). Implemented as an opt-in per-credential mechanism per RFC 9449.

A DPoP-bound credential is tied to a P-256 key pair the client holds. A stolen token alone is
useless: the attacker cannot mint a valid DPoP proof without the matching private key.

### Overview

Both credential kinds that the Worker accepts via `Authorization: Bearer` support optional binding:

| Credential | Where the binding lives | When it is enforced |
|---|---|---|
| GitHub session token | `cnf.jkt` JWT claim | At every request when `cnf.jkt` is present |
| D1 API token | `_tokens.cnf_jkt` D1 column | At every request when `cnf_jkt` is non-NULL |

Binding is **opt-in**: credentials issued without a `jkt` retain the existing bearer behaviour
unchanged. No existing clients or pre-binding tokens are affected.

### Binding a Credential

**Session token (default auth mode):** the CLI automatically supplies its public key thumbprint
(`jkt`) when it runs the GitHub exchange. No user action is required beyond having a DPoP key pair.

```http
POST /api/auth/github/exchange
Content-Type: application/json

{
  "auth_method": "user_token",
  "project_id": "tila-abc123",
  "user_token": "gho_...",
  "jkt": "abc123..."          // 43-char base64url SHA-256 JWK thumbprint
}
```

The minted session JWT carries `cnf: { jkt: "<thumbprint>" }`.

**D1 API token:** supply `jkt` in the token-issue request body.

```http
POST /api/tokens
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "my-pipeline-token",
  "jkt": "abc123..."
}
```

The `jkt` is stored in the `_tokens.cnf_jkt` column. It cannot be changed after issue; to rebind,
issue a new token and revoke the old one.

### The DPoP Proof Contract

On every request that uses a bound credential, the client must include a `DPoP` header containing a
signed proof JWT. The proof must satisfy all of the following:

| Claim / field | Value | Rule |
|---|---|---|
| `typ` (header) | `dpop+jwt` | Exact match |
| `alg` (header) | `ES256` | Only algorithm accepted |
| `jwk` (header) | P-256 public key (`kty:"EC"`, `crv:"P-256"`) | Must not contain `d` (private key) |
| `htm` (payload) | HTTP method | Case-insensitive match to the request method |
| `htu` (payload) | Canonical request URI | `scheme://host/path` — no query string, no fragment |
| `iat` (payload) | Current Unix timestamp (seconds) | Within `[now - 60s, now + 5s]` |
| `jti` (payload) | UUID | Present; not checked for replay (see Residual Risk below) |
| Signature | ES256 over the header + payload using the private key matching `jwk` | Verified by the Worker |

The Worker recomputes the RFC 7638 SHA-256 JWK thumbprint of the `jwk` in the proof and verifies
it equals the bound `jkt`. A mismatch yields `401 dpop-invalid`.

**`htu` canonicalization:** `lowercase(scheme) + "://" + lowercase(host) + path`. Default ports
(443 for https, 80 for http) are dropped. Query strings and fragments are stripped. The Worker
derives `htu` from `c.req.url`; the SDK derives it from the exact URL it dials. Both sides use the
same algorithm so the comparison is stable across custom domains and `*.workers.dev` deployments.

### Opt-in Semantics

- A credential **without** a bound `jkt` (`cnf_jkt IS NULL` / `cnf.jkt` absent) is accepted
  exactly as before. The DPoP verifier is not invoked.
- A credential **with** a bound `jkt` requires a valid `DPoP` header on every request. A missing
  header returns `401 dpop-required`; an invalid proof returns `401 dpop-invalid`.
- There is no mechanism in this implementation to force binding on all credentials. Mandatory
  binding is a follow-up policy decision.

### No-Nonce Stateless Profile

tila uses the **no-nonce stateless profile** of RFC 9449. The Worker verifies:

1. Proof signature (ES256 with the embedded public key).
2. JWK thumbprint matches the bound `jkt`.
3. `htm` / `htu` match the current request.
4. `iat` is within the freshness window.

The Worker does **not** track proof `jti` values across isolates. This means a captured DPoP proof
can be replayed within the `iat` window.

**Confirmed residual risk:** `DPOP_PROOF_MAX_AGE_MS = 60_000` — a captured proof is replayable for
up to 60 seconds. Full single-use protection requires a Durable Object keyed by proof `jti` and is
explicitly out of scope. The 60-second window is the stateless mitigation; it limits the replay
window to the period during which an attacker could observe and reuse the proof in-flight.

### Recovering a Lost DPoP Key

If the private key is lost or corrupted (e.g. after a keychain wipe or machine replacement), the
bound session will reject all new requests with `401 dpop-invalid`. Use `tila auth recover` to
re-establish binding:

```bash
tila auth recover
```

What `tila auth recover` does:

1. Generates a new P-256 DPoP key pair.
2. Drops the stale session cache (`.tila/.session`).
3. Runs a fresh GitHub device-flow exchange sending the new `jkt`, yielding a new bound session.

The command requires an interactive terminal — it cannot run in CI or headless mode. If the lost
credential was a D1 API token (not a session), recovery is a manual rotation:

```bash
# Issue a new bound token (the CLI includes your current jkt automatically)
tila token issue --name my-token-v2

# Revoke the old token
tila token revoke my-old-token
```

Update any CI secrets or scripts to use the new token after rotation.

