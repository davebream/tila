# tila-mcp-server

MCP (Model Context Protocol) server for [tila](https://github.com/davebream/tila). Exposes tila's coordination API as MCP tools, resources, and prompts for AI coding agents.

## Prerequisites

A tila project (Cloudflare or local). Auth is configured automatically if your project uses GitHub auth (`[auth] mode = "github-repo"` in `.tila/config.toml`). For token-based auth, set `TILA_API_TOKEN`.

## Setup

### Recommended: one command

```sh
tila mcp init
```

Auto-detects your editor (Claude Code, Cursor, VS Code) and writes the config file.

### Manual config

> If your project uses GitHub auth, omit the `TILA_API_TOKEN` env var — the server reads credentials from `.tila/config.toml` automatically.

**Claude Code** — add to `.mcp.json`:

```json
{
  "mcpServers": {
    "tila": {
      "command": "npx",
      "args": ["-y", "tila-mcp-server"],
      "env": {
        "TILA_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

**Cursor** — add to `.cursor/mcp.json` (same shape as above).

**VS Code Copilot** — add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "tila": {
      "command": "npx",
      "args": ["-y", "tila-mcp-server"],
      "env": {
        "TILA_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

If your project has a `.tila/config.toml`, the server reads `worker_url` and `project_id` from it automatically. Otherwise, set them via environment variables (`TILA_API_URL`, `TILA_PROJECT_ID`).

## Local mode (embedded SQLite, no network)

The server runs against an embedded SQLite database + on-disk artifacts instead of a
Cloudflare Worker when the backend is `local`. It runs under **plain Node** (no Bun
required) via `tila-sdk/local`. No token and no `worker_url` are needed.

Set the backend in `.tila/config.toml`:

```toml
backend = "local"
project_id = "my-project"

[local]
db_path = ".tila/project.db"
artifacts_path = ".tila/artifacts"
org = "my-org"            # optional; defaults to the OS username
```

Or configure it entirely via environment variables (see below). Then point your MCP
client at the server:

```json
{
  "mcpServers": {
    "tila": {
      "command": "npx",
      "args": ["-y", "tila-mcp-server"],
      "env": {
        "TILA_BACKEND": "local",
        "TILA_PROJECT_ID": "my-project",
        "TILA_DB_PATH": ".tila/project.db",
        "TILA_ARTIFACTS_PATH": ".tila/artifacts"
      }
    }
  }
}
```

> **`better-sqlite3` driver:** local mode lazily loads `better-sqlite3`, declared as an
> `optionalDependency`. `npx -y tila-mcp-server` (and a normal `npm i`) pulls it
> automatically, so local mode works out of the box. If the native build is skipped or
> fails on your platform, install it manually (`npm i better-sqlite3`) for local mode;
> remote mode never touches it.

### Local-mode environment variables

For each value, precedence is **config value > environment variable > default**.
`db_path` and `artifacts_path` are required in local mode (config or env); `org`
defaults to the OS username.

| Variable | Config key | Required | Default |
|----------|-----------|----------|---------|
| `TILA_PROJECT_ID` | `project_id` | Yes | — |
| `TILA_DB_PATH` | `local.db_path` | Yes | — |
| `TILA_ARTIFACTS_PATH` | `local.artifacts_path` | Yes | — |
| `TILA_ORG` | `local.org` | No | OS username |

### Remote-only tools in local mode

Some tools have no local equivalent and require a remote (cloudflare) backend. In
local mode they are still registered (so clients can discover them) but reject at
invocation time with a clear error:

| Tool | Local alternative |
|------|-------------------|
| `tila_artifact_put` (binary/base64 multipart upload to R2) | `tila_artifact_write_text` (content-addressed text artifacts) |

## Tools (40)

> Tool names are derived from source registration. `work-unit` and `entity` are deprecated aliases for `task`; use `tila_task_*` tools.

### Tasks

| Tool | Description |
|------|-------------|
| `tila_task_create` | Create a new task (task, epic, etc.) |
| `tila_task_list` | List tasks (compact format) |
| `tila_task_show` | Get task details with relationships |
| `tila_task_update` | Update task data (requires fence) |
| `tila_task_archive` | Archive a task (requires fence) |
| `tila_task_ready` | List tasks ready for work |
| `tila_task_relationships_add` | Add a relationship between tasks |
| `tila_task_relationships_list` | List relationships for a task |

### Claims

| Tool | Description |
|------|-------------|
| `tila_claim_acquire` | Acquire exclusive or shared claim, returns fencing token |
| `tila_claim_release` | Release a claim (requires fence) |
| `tila_claim_list` | List all active claims |

### Records

| Tool | Description |
|------|-------------|
| `tila_record_get` | Get a record by type and key |
| `tila_record_set` | Set (full replace) a record's value (requires fence) |
| `tila_record_put` | Put (upsert) a record's value (requires fence) |
| `tila_record_patch` | Apply JSON Merge Patch to a record (requires fence) |
| `tila_record_list` | List records of a given type (metadata only) |
| `tila_record_history` | Get revision history for a record |
| `tila_record_archive` | Archive a record (requires fence) |
| `tila_record_unarchive` | Unarchive a record (requires fence) |

### Artifacts

| Tool | Description |
|------|-------------|
| `tila_artifact_put` | Upload an artifact (base64 content) |
| `tila_artifact_write_text` | Write a text artifact (content-addressed) |
| `tila_artifact_read_text` | Read a text artifact by key |
| `tila_artifact_get_latest` | Get the latest artifact for a prefix |
| `tila_artifact_grep` | Search artifact content with grep |
| `tila_artifact_search` | Full-text search across artifacts |
| `tila_artifact_relationships_add` | Add a relationship between artifacts |
| `tila_artifact_relationships_list` | List relationships for an artifact |
| `tila_search` | Unified search across tasks and artifacts |

### Gates

| Tool | Description |
|------|-------------|
| `tila_gate_create` | Create a coordination gate (requires fence) |
| `tila_gate_resolve` | Resolve a pending gate |
| `tila_gate_cancel` | Cancel a pending gate |

### Signals

| Tool | Description |
|------|-------------|
| `tila_signal_send` | Send a signal to another agent or broadcast |
| `tila_signal_list` | List unacknowledged signals in inbox |
| `tila_signal_ack` | Acknowledge a signal |

### Journal, Schema & Templates

| Tool | Description |
|------|-------------|
| `tila_journal_list` | Query the project event journal |
| `tila_schema_update` | Apply a new TOML schema definition |
| `tila_template_list` | List available task templates |
| `tila_template_instantiate` | Create tasks from a template |

### Presence & Summary

| Tool | Description |
|------|-------------|
| `tila_presence_heartbeat` | Record a heartbeat to mark agent as online |
| `tila_summary` | Get compact project summary |

## Resources

### Static resources

| URI | Description |
|-----|-------------|
| `tila://project/summary` | Entity counts, status breakdown, active claims, ready count, online machines |
| `tila://project/ready` | Entities ready for work (no blockers, no pending gates) |
| `tila://project/presence` | Machines with recorded heartbeats |
| `tila://project/schema` | Current schema version and definition |

### Dynamic record resources

Record types with `mcp_resource = true` in the project schema are exposed as MCP resources at `tila://records/{type}/{key}`. These are registered at server startup by fetching the project schema.

## Auth Modes

The server supports two auth modes, configured via `.tila/config.toml`:

| Mode | Config | How it works |
|------|--------|-------------|
| `tila-token` (default) | `TILA_API_TOKEN` env var or `.tila/.env` | Static API token |
| `github-repo` | `[auth] mode = "github-repo"` in config.toml | Session cache with OIDC token exchange via GitHub App |

For `github-repo` mode, the `[github]` section (owner, repo) and `worker_url` must be set in `.tila/config.toml`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TILA_BACKEND` | No | Backend mode: `"local"` or `"cloudflare"`. Overrides config.toml `backend`; default `cloudflare`. Lets local mode be selected with no `.tila/config.toml` present. Invalid values error. |
| `TILA_API_TOKEN` | Only for `tila-token` mode | API token for authentication (remote) |
| `TILA_API_URL` | No | Worker URL (overrides config.toml `worker_url`) (remote) |
| `TILA_PROJECT_ID` | No | Project ID (overrides config.toml `project_id`) |
| `TILA_DB_PATH` | Local mode only | SQLite DB path (config `local.db_path` wins) |
| `TILA_ARTIFACTS_PATH` | Local mode only | Artifacts dir (config `local.artifacts_path` wins) |
| `TILA_ORG` | No | Org slug for local mode (config `local.org` wins; defaults to OS username) |
