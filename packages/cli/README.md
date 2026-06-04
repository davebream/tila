# tila-cli

Command-line interface for [tila](https://github.com/davebream/tila) — a state-and-coordination engine for multi-machine agentic work.

## Installation

`tila-cli` is not published to npm yet. Run from source:

```bash
git clone https://github.com/davebream/tila.git
cd tila
pnpm install
pnpm --filter tila-cli dev -- --help
```

Use `pnpm --filter tila-cli dev -- <command>` in place of `tila <command>` until packaged binaries are published.

## Commands

| Command | Description |
|---------|-------------|
| `task` | Manage tasks (create, list, show, update, claim, release) |
| `work-unit` | Manage work units — canonical public alias for entities |
| `entity` | *(deprecated — use `work-unit`)* Manage entities |
| `record` | Manage typed records (get, set, patch, list, history, archive) |
| `artifact` | Manage artifacts (put, search, list) |
| `init` | Initialize a tila project |
| `deploy` | Deploy the Worker to Cloudflare |
| `destroy` | Tear down all project resources |
| `doctor` | Check project health |
| `open` | Open the tila dashboard in your browser |
| `mcp` | MCP server configuration |
| `gate` | Manage coordination gates |
| `signal` | Send a signal to a target |
| `presence` | Show all machines (active and inactive) |
| `journal` | Query the project journal |
| `schema` | Manage project schema |
| `search` | Unified full-text search across entities and artifacts |
| `summary` | Show project summary |
| `state` | List all active claims |
| `token` | Manage project API tokens |
| `template` | Manage entity templates |
| `index` | Manage index artifacts |
| `config` | View project configuration |
| `migrate` | Migrate data from another system into tila |
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
