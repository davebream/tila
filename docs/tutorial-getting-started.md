# Getting Started with tila

This tutorial walks you through the full tila lifecycle: initializing a project, creating and claiming a task, producing an artifact, querying state, and viewing the dashboard.

**Prerequisites:**
- Node.js 18+ and pnpm (for source install) or a tila binary
- A [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) (`export CLOUDFLARE_API_TOKEN=...`)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed (used for Worker deployment and D1 migrations)

> **Unsigned binaries (v0.1.0):** macOS: `xattr -d com.apple.quarantine ./tila-darwin-*`. Windows: click "Run anyway" in SmartScreen.

---

## Section 1 — Initialize a tila project

### New project owner: `tila init --cloudflare`

Run this once to provision your project on Cloudflare. It requires `wrangler` to be installed and logged in.

```
$ tila init --cloudflare
Checking prerequisites...
  Cloudflare account: My Account (abc123def456)
  Project slug: my-project-a1b2
Generating wrangler.toml...
Setting up D1 database...
  D1 database ID: 11111111-2222-3333-4444-555555555555
Deploying Worker...
  Worker deployed: https://tila-my-project-a1b2.myaccount.workers.dev
Setting up R2 artifact bucket...
Starting GitHub App manifest flow...
  GitHub App created (app_id: 12345)
Setting Worker secrets...
Discovering App installation...
  Installation: my-org (67890)
Registering repo my-org/my-project...
Generating API token...
Writing config files...
Writing default tila.schema.toml...
  tila.schema.toml written with v0.1 searchable artifact defaults.

tila project provisioned.

  Worker:   https://tila-my-project-a1b2.myaccount.workers.dev
  Project:  my-project-a1b2
  Token:    written to .tila/.env

Next steps:
  1. Teammates join with: tila init --inherit (uses GitHub auth — no token sharing needed)
  2. Open the dashboard in your browser
  3. Start working: tila task new --title "First task"
```

**Three output files are written:**

| File | Status | Contains |
|------|--------|----------|
| `.tila/config.toml` | Committed to git (safe) | `project_id`, `worker_url`, schema version |
| `.tila/.env` | Gitignored (secret) | Raw API token — never commit this |
| `tila.schema.toml` | Committed to git | Default entity types and searchable artifact kinds |

**If wrangler is not installed or not logged in**, the command exits immediately:

```
Checking prerequisites...
Error: wrangler not found. Install it with: npm install -g wrangler
```

or

```
Checking prerequisites...
Error: CLOUDFLARE_API_TOKEN is required for Cloudflare provisioning.
```

### Teammate joining an existing project: `tila init --inherit`

Once the project owner has committed `.tila/config.toml`, teammates authenticate via GitHub — no shared API token needed. The CLI reads the GitHub token from the environment (e.g., `gh auth token`) and exchanges it for a tila session.

```
$ tila init --inherit
Looking for .tila/config.toml...
  Project: my-project-a1b2
  Worker:  https://tila-my-project-a1b2.myaccount.workers.dev
  Auth mode: github-repo
Verifying Worker reachability...
  Worker is reachable.
Exchanging GitHub token for tila session...
  Session cached to .tila/.session (expires in 1h).

Joined project successfully.

  Project:  my-project-a1b2
  Worker:   https://tila-my-project-a1b2.myaccount.workers.dev

You're ready to go. Try: tila doctor
```

The GitHub token is resolved from the environment (`GITHUB_TOKEN` or `gh auth token`). No token sharing or manual secret distribution required.

---

## Section 2 — Create your first task entity

### Create a task

```
$ tila task new "Build the auth module"
Created task T-abc123: Build the auth module
```

The ID (`T-abc123`) is a stable reference you'll use in every subsequent command.

### Claim the task

Before making any writes to a task, claim it to get a fencing token:

```
$ tila task claim T-abc123
Claimed task T-abc123  fence=1  expires=2026-05-16T10:35:00.000Z
```

**Fence semantics:** The fencing token (`fence=1`) is a monotonic integer. It must accompany every subsequent destructive write (artifact uploads, field updates) on this resource. A stale fence — from an expired or superseded claim — is rejected by the Worker with HTTP 409. This enforces first-writer-wins coordination across multiple machines or agents.

The claim expires at the time shown (default TTL: 5 minutes). If your claim expires before you've finished, re-claim:

```
$ tila task claim T-abc123
Claimed task T-abc123  fence=2  expires=2026-05-16T10:40:00.000Z
```

Each re-claim increments the fence.

### Browse tasks

```
$ tila task list
T-abc123  open  Build the auth module

$ tila task show T-abc123
{
  "ok": true,
  "entity": {
    "id": "T-abc123",
    "type": "task",
    "data": { "title": "Build the auth module", "status": "open" },
    ...
  }
}
```

---

## Section 3 — Produce your first artifact

Create a file and upload it:

```
$ echo "# Plan\nStep 1: do the thing." > plan.md

$ tila artifact put plan.md --kind=plan --resource=T-abc123 --fence=1
Uploaded artifact: produced/T-abc123/a7f3b2c1d4e5.md (238 bytes)
```

**R2 key format:** `produced/<resource>/<sha256_prefix>.<ext>`

The key encodes the resource it belongs to and the content's SHA-256 fingerprint, making every artifact content-addressed. Re-uploading the same file produces a deduplicated key:

```
$ tila artifact put plan.md --kind=plan --resource=T-abc123 --fence=1
Uploaded artifact: produced/T-abc123/a7f3b2c1d4e5.md (238 bytes) (deduplicated)
```

### List and retrieve artifacts

```
$ tila artifact list --resource=T-abc123
produced/T-abc123/a7f3b2c1d4e5.md  plan  T-abc123  238B  a7f3b2c1d4e5...

$ tila artifact get produced/T-abc123/a7f3b2c1d4e5.md
# Plan
Step 1: do the thing.
```

### Fence rejection

If your fence is wrong or your claim has expired, the Worker returns HTTP 409. The CLI surfaces this as an error. Re-claim the task to get a fresh fence and retry:

```
$ tila task claim T-abc123
Claimed task T-abc123  fence=2  expires=2026-05-16T10:45:00.000Z

$ tila artifact put plan.md --kind=plan --resource=T-abc123 --fence=2
Uploaded artifact: produced/T-abc123/a7f3b2c1d4e5.md (238 bytes) (deduplicated)
```

---

## Section 4 — Query state and presence

### Active claims

```
$ tila state list
task:T-abc123  holder=cli  mode=exclusive  fence=1  ttl=294s
```

### Per-resource claim detail

```
$ tila state task:T-abc123
task:T-abc123:
  holder:  cli
  mode:    exclusive
  fence:   1
  ttl:     294s
  expires: 2026-05-16T10:35:00.000Z
```

### Machine presence

```
$ tila presence
[active] my-laptop  last_seen=2026-05-16T10:34:12.000Z  info={}
```

**Fields:**
- `[active]` / `[inactive]` — determined by TTL. A machine is active while it sends heartbeats and for a grace period after the last heartbeat.
- `my-laptop` — machine identity from `os.hostname()`, or overridden with `--machine=<name>`.
- `info={}` — framework-extensible metadata (e.g., current task, agent version). Empty by default; frameworks can populate this via `tila presence heartbeat`.

To send a heartbeat explicitly:

```
$ tila presence heartbeat
Heartbeat sent for my-laptop
```

### Journal audit log

Every claim, artifact upload, and state transition is recorded in the journal:

```
$ tila journal tail --resource=task:T-abc123
[1] 2026-05-16T10:30:00.000Z  claim.acquired  task:T-abc123  actor=cli  fence=1
[2] 2026-05-16T10:31:00.000Z  artifact.produced  task:T-abc123  actor=cli  fence=1
```

**Format:** `[seq] <ISO timestamp>  <event kind>  <resource>  actor=<actor>  fence=<n>`

The journal is append-only and immutable. Use it to audit who did what and when, or to debug coordination failures.

---

## Section 5 — View the UI dashboard

Navigate to `<worker_url>/index.html` in your browser. The `worker_url` is shown at the end of `tila init --cloudflare` and is also stored in `.tila/config.toml` under the `worker_url` key.

Example: `https://tila-my-project-a1b2.myaccount.workers.dev/index.html`

The dashboard is read-only and shows four panels:

| Panel | Contents |
|-------|----------|
| **Entities** | Task list with status |
| **Claims** | Active claims with fence and TTL |
| **Journal** | Recent events (latest 20 by default) |
| **Presence** | Active machines and their last-seen timestamps |

> All mutations go through the CLI — the dashboard is an observer, not a controller.

### Local development

For local development with `wrangler dev`, the Worker runs at `http://localhost:8787`. The dashboard is available at `http://localhost:8787/index.html`.

```
$ pnpm dev
# => wrangler dev starts at http://localhost:8787
```

---

## Next steps

- Read the [Operational Guide](05-OPERATIONS.md) for deployment, monitoring, and maintenance.
- Explore `tila task --help`, `tila artifact --help`, and `tila journal --help` for the full command surface.
- Configure searchable artifact kinds in `tila.schema.toml` to enable `tila artifact search`.
