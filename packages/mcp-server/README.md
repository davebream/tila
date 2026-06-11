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

> **`better-sqlite3` peer dep:** local mode lazily loads the optional peer dependency
> `better-sqlite3`. Install it (`npm i better-sqlite3`) for local mode; remote mode
> never touches it.

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

## Tools (43)

### Entities & Tasks

| Tool | Description |
|------|-------------|
| `tila_task_create` | Create a new entity (task, epic, etc.) |
| `tila_task_list` | List entities (compact format) |
| `tila_task_show` | Get entity details with relationships |
| `tila_task_update` | Update entity data (requires fence) |
| `tila_ready` | List entities ready for work |

### Work Units

| Tool | Description |
|------|-------------|
| `tila_work_unit_create` | Create a new work unit |
| `tila_work_unit_list` | List work units (compact format) |
| `tila_work_unit_show` | Get work unit details with relationships |
| `tila_work_unit_update` | Update work unit data (requires fence) |
| `tila_work_unit_ready` | List work units ready for work |
| `tila_work_unit_archive` | Archive a work unit (requires fence) |
| `tila_work_unit_relationships_add` | Add a relationship between work units |
| `tila_work_unit_relationships_list` | List relationships for a work unit |

### Entity Management

| Tool | Description |
|------|-------------|
| `tila_entity_archive` | Archive an entity (requires fence) |
| `tila_entity_relationships_add` | Add a relationship between entities |
| `tila_entity_relationships_list` | List relationships for an entity |

### Claims

| Tool | Description |
|------|-------------|
| `tila_task_claim` | Acquire exclusive or shared claim, returns fencing token |
| `tila_task_release` | Release a claim (requires fence) |
| `tila_claim_list` | List all active claims |

### Records

| Tool | Description |
|------|-------------|
| `tila_record_get` | Get a record by type and key |
| `tila_record_set` | Set (full replace) a record's value (requires fence) |
| `tila_record_patch` | Apply JSON Merge Patch to a record (requires fence) |
| `tila_record_list` | List records of a given type (metadata only) |
| `tila_record_history` | Get revision history for a record |
| `tila_record_archive` | Archive a record (requires fence) |
| `tila_record_unarchive` | Unarchive a record (requires fence) |

### Artifacts

| Tool | Description |
|------|-------------|
| `tila_artifact_put` | Upload an artifact (base64 content) |
| `tila_artifact_search` | Full-text search across artifacts |
| `tila_search` | Unified search across entities and artifacts |
| `tila_artifact_relationships_add` | Add a relationship between artifacts |
| `tila_artifact_relationships_list` | List relationships for an artifact |

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

### Other

| Tool | Description |
|------|-------------|
| `tila_journal_list` | Query the project event journal |
| `tila_schema_update` | Apply a new TOML schema definition |
| `tila_template_list` | List available entity templates |
| `tila_template_instantiate` | Create entities from a template |
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
