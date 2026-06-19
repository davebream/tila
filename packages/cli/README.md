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
| `presence` | Show all machines (active and inactive) |
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

## MCP server setup

```bash
tila mcp init              # Auto-detect editor and write MCP config
```

See [`packages/mcp-server/README.md`](../mcp-server/README.md) for manual configuration and the full tool list.
