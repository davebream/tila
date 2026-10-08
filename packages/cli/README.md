# tila-cli

Command-line interface for [tila](https://github.com/davebream/tila) — a state-and-coordination engine for multi-machine agentic work.

## Installation

```bash
npm install -g tila-cli
# or
brew install tila/tap/tila
# or
curl -fsSL https://tila.dev/install.sh | bash
```

See the [latest release](https://github.com/davebream/tila/releases/latest) for platform-specific binaries.

## Commands

| Command | Description |
|---------|-------------|
| `task` | Manage tasks (create, list, show, update, claim, release) |
| `update` | Update this CLI installation, or check with `--check` |
| `work-unit` | *(deprecated — use `task`)* Alias for `task` |
| `entity` | *(deprecated — use `task`)* Alias for `task` |
| `record` | Manage typed records (get, set, patch, list, history, archive) |
| `artifact` | Manage artifacts (put, search, list) |
| `init` | Initialize a tila project |
| `deploy` | Deploy the Worker to Cloudflare |
| `doctor` | Check project health |
| `open` | Open the tila dashboard in your browser |
| `mcp` | MCP server configuration |
| `gate` | Manage coordination gates |
| `signal` | Send a signal to a target |
| `presence` | Show all participants (active and inactive) |
| `journal` | Query the project journal |
| `schema` | Manage project schema |
| `search` | Unified full-text search across tasks and artifacts |
| `summary` | Show project summary |
| `state` | List all active claims |
| `token` | Manage project API tokens |
| `repos` | Manage the GitHub repo allowlist (`repos register` to register the configured repo) |
| `template` | Manage task templates |
| `index` | Manage index artifacts |
| `config` | View project configuration |
| `reset` | Reset all project data |

## Initializing a project

```bash
tila init --cloudflare     # Provision Worker + DO + D1 + R2 on Cloudflare
tila init --inherit        # Join an existing project (teammate onboarding)
tila init --local          # Local SQLite backend, no Cloudflare account needed
tila init --github-app     # Register a GitHub App for repo-scoped auth
tila init --skip-github    # Skip GitHub App setup (use tila-token auth)
```

GitHub auth is configured automatically during `tila init --cloudflare`. See [GitHub-scoped Auth](../../docs/07-GITHUB-SCOPED-AUTH.md) for details.

## Common workflows

```bash
# Create and claim a task
tila task new "Migrate auth to sessions"
tila task claim T-abc123

# Upload an artifact against a claimed task
tila artifact put plan.md --kind=plan --resource=T-abc123 --fence=1

# Search across all artifacts
tila artifact search "auth migration"

# Manage typed records
tila record set service api ./api.yaml
tila record get service api
tila record patch service api --json '{"owner":"infra"}' --fence=1

# Check project health
tila doctor
tila summary
tila presence
```

## Updating the CLI

```bash
tila update                 # Install the latest stable version for this channel
tila update --check         # Check availability; do not install
tila update --check --json  # Structured result for automation
```

Updates require no project configuration, credentials, or confirmation prompt.
There are no background checks or automatic updates. The command updates only
the invoked CLI installation, not a deployed Worker, SDK, or MCP server.

| Installation | Behavior |
|---|---|
| Homebrew | Refresh metadata, respect pins, and upgrade the owning formula |
| Global npm/pnpm/Bun | Verify ownership and ask the same manager to install its latest stable version |
| Official shell/PowerShell installer | Verify GitHub release checksums and replace the binary in the installer's user bin directory |
| Source checkout, project dependency, temporary runner, unknown manager/path | Stop with instructions; no installation changes |

`--check` can refresh package-manager metadata caches. Homebrew may lag behind
GitHub; the result reports this separately and never switches installation
methods. Versions newer than the channel are kept. Release candidates, explicit
versions, reinstalls, and downgrades are not supported by this command.

Global package ownership must be provable from manager-reported locations.
If it cannot be established (including Yarn or a missing manager), use the
original manager directly. For temporary runners, request `tila-cli@latest`.
The updater never requests sudo or installs another copy elsewhere.

JSON uses the normal `{ "ok": true, "result": ... }` envelope. Results include
`status` (`current`, `available`, `updated`, or `pinned`), `currentVersion`,
`availableVersion`, `installedVersion`, `latestVersion`, `installationMethod`,
`executablePath`, `releaseNotes`, and `channelBehind`. Diagnostics go to stderr.
Completed checks and successful/no-op updates exit 0, actionable failures exit 1,
and transient network failures exit 2. A check finding an update still exits 0.

Standalone downloads must match both the release checksum file and any GitHub
asset digests provided. The candidate must report the expected version before
replacement; the installed binary is then checked again. Failed installation
or verification restores the previous binary when possible. An unrecoverable
failure prints the exact backup and destination paths for manual restoration.
Windows may retain a backup while an older tila process still has it open;
existing processes are never stopped. An interrupted update may leave an
installation lock: confirm that updater has exited before removing the lock
directory named in the error and retrying.

**First upgrade:** releases predating `tila update` need one normal package-manager
upgrade or a rerun of the official installer. Later releases can use this command.

## Participant identity

Every CLI process has one participant ID. Resolution order is `--participant-id`, then `TILA_PARTICIPANT_ID`, then a generated UUID. `tila task claim` prints the participant ID it used. Standalone renew/release require the same ID explicitly so a new process cannot silently act as another participant:

```bash
tila --participant-id session-7 task claim T-abc123
tila --participant-id session-7 task renew T-abc123 --fence 1
tila shell --instance work # injects one TILA_PARTICIPANT_ID for the subshell
```

Hostname and Git repository/worktree/branch/commit details are collected best-effort as environment metadata only; they never establish ownership.

## MCP server setup

```bash
tila mcp init              # Auto-detect editor and write MCP config
```

See [`packages/mcp-server/README.md`](../mcp-server/README.md) for manual configuration and the full tool list.
