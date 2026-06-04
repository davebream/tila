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
- A GitHub user with repository admin permission registers the repo through an existing admin session.

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

