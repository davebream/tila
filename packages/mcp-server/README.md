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

One participant UUID is generated per MCP server process and reused by every tool call. Set `TILA_PARTICIPANT_ID` to preserve that identity across server restarts. Hostname and Git context are sent only as untrusted environment metadata.

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

## Tools (61)

The default catalog contains **six workflow tools**. Existing primitive tools are opt-in with
`TILA_MCP_TOOLS=all`, existing named groups, or `core`. Combine groups with commas, for example
`workflow,artifacts`. Empty/unset selects `workflow`; compatibility aliases remain opt-in.

### Default workflow

| Tool | Purpose |
|------|---------|
| `tila_session` | Open/resume, heartbeat, or acknowledge processed journal events |
| `tila_inspect` | Read work, state, artifacts, handoffs, participants, or changes |
| `tila_claim` | Acquire, renew, or release a fenced resource claim |
| `tila_publish` | Create/update tasks, create/set records, or write text artifacts |
| `tila_signal` | Send directly to a participant, read inbox, or acknowledge delivery |
| `tila_close` | Save a handoff and release explicitly listed claims |

Each workflow tool accepts `{ "request": { ... } }`; all except close select an `action`.
For example, `tila_session({request:{action:"open"}})`,
`tila_inspect({request:{action:"ready"}})`, then
`tila_claim({request:{action:"acquire",resource:"task:T-1"}})`.
Carry that fence into `tila_publish` with `action:"task_update"`, `id:"T-1"`, `data`, and `fence`.
Records use the fence from `tila_inspect` with `action:"record"`; `record_create` never replaces.

Every tool advertises an output schema and four risk annotations. Structured results contain
`result` on success or `error` on failure; primitive success text retains its previous format.
Errors include `code`, `message`, `recovery_action`, and `retry_safety` (`safe`, `after_recovery`,
`unsafe`, or `unknown`). A transport failure on a mutation is not permission to repeat it blindly.
Historical journal entries may have null attribution; output contracts preserve it without
inventing a participant identity. Grouped tools have conservative annotations for their most consequential action: inspection is
read-only; other groups mutate state. Sending signals interacts with other participants.

Open preserves the bound participant identity and reads re-entry state after a heartbeat. It does
not acknowledge events/signals or renew claims. Replay uses `next_after_seq` and the original
`through_seq`; acknowledge only the contiguous prefix actually processed. Changing participants
requires an explicit handoff ID or resource selector for continuity.

Close accepts `{request:{handoff:{id,summary,based_on_seq,...},release:[{resource,fence}]}}`.
The handoff UUID and body must remain identical on retries. Cleanup runs only after the handoff is
saved, skips successor claims, and reports per-resource results. Retry failed cleanup with the
same handoff. Closing does not stop MCP, a coding client, or its lifecycle heartbeat helper.
Artifact results expose provenance and review state; a matching hash does not establish trust.

### Advanced primitive catalog

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
| `tila_claim_acquire` | Acquire an exclusive or owner claim, returns fencing token and participant ID |
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
| `tila_artifact_history` | Read artifact revision history |
| `tila_artifact_reviews` | Read paginated artifact review history |
| `tila_artifact_review` | Trust, reject, supersede, or revoke a review using the current review revision |
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
| `tila_signal_send` | Send a signal to a participant, principal, group, or broadcast audience |
| `tila_signal_list` | List this participant's unacknowledged signal deliveries |
| `tila_signal_ack` | Acknowledge this participant's signal delivery |
| `tila_signal_history` | List delivery and acknowledgement history (admin) |
| `tila_signal_group_list` | List principal-based signal groups |
| `tila_signal_group_get` | Get a signal group |
| `tila_signal_group_set` | Create or replace a signal group (admin) |
| `tila_signal_group_delete` | Delete a signal group (admin) |

### Journal, Schema & Templates

| Tool | Description |
|------|-------------|
| `tila_journal_list` | Query the project event journal |
| `tila_reentry` | Recover summary, journal changes, live claims, pending signals, and a relevant handoff |
| `tila_journal_replay` | Replay oldest-first journal pages, including archived history |
| `tila_journal_cursor_get` | Read the current participant's durable acknowledged cursor |
| `tila_journal_acknowledge` | Advance the current participant's acknowledged cursor |
| `tila_handoff_create` | Save an immutable, attributable handoff; reuse its UUID for retries |
| `tila_handoff_get` | Read a handoff by ID |
| `tila_handoff_list` | List this participant's handoffs or handoffs referencing a resource |
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
| `tila://project/summary` | Entity counts, status breakdown, active claims, ready count, online participants |
| `tila://project/ready` | Entities ready for work (no blockers, no pending gates) |
| `tila://project/presence` | Participants with recorded heartbeats |
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
| `TILA_PARTICIPANT_ID` | No | Stable participant identity for this MCP server process; defaults to a generated UUID |


### Session continuity

The `continuity` tool group is included in `core` and `all`; the default workflow uses the same continuity APIs.
`tila_reentry` is read-only: it never acknowledges journal events or signals,
renews claims, or sends a heartbeat. Continue journal pages with `next_after_seq`
and the original `through_seq`, then use `tila_journal_acknowledge` after processing.
A saved cursor belongs to the authenticated principal and participant, not the machine.

Use `handoff_id` or `resource` to consume another participant's handoff. Without
those selectors, re-entry selects your participant's latest handoff. Resource
selectors use `task:<id>`, `record:<type>:<key>`, `artifact:<key>`, or the exact
claim resource. They select the handoff, not a filtered journal. Keep a stable UUID
when retrying `tila_handoff_create`; the same ID and content returns the original
snapshot, while changed content fails with `handoff-conflict`. Record facts and
unresolved questions, never private reasoning. Historical claim snapshots do not
confer permission to write or transfer a lease.


Artifact reviews are explicit writer decisions; matching SHA-256 hashes do not
establish content safety. Any project writer may trust, reject, supersede, or revoke
a review, including their own artifacts. Supply `expected_review_revision` (0 for
an artifact with no review history); stale decisions fail instead of overwriting
newer reviews. Revocation returns the artifact to unreviewed state. Text reads
return a metadata block followed by artifact content, including when truncated.
Participant and environment metadata are client-supplied. Local reviews use the
configured local identity and do not imply remote authentication.

## Workflow evaluation

Reproduce the paired smoke comparison from the repository root after building:

```sh
pnpm exec turbo build --filter=tila-mcp-server...
python3 packages/mcp-server/evaluation/run.py
node packages/mcp-server/evaluation/score.mjs
```

The runner requires installed, authenticated `claude` and `codex` clients. It runs
five scenarios for each client and each profile (`workflow` and `all`): task
completion, stale-lease recovery, context-loss re-entry, contention with another
participant, and an artifact handoff. Each run uses a separate local database and
artifact directory. The other participant is a fixture, not a second model run.
The clients retain their CLI-default model choice throughout the paired run.
Only the fixture MCP server is configured; writes to it are explicitly enabled
for the unattended comparison. Client lifecycle hooks are disabled in these runs;
lifecycle request isolation is tested separately. No production credentials or project are used.

Outputs go under `.context/mcp-evaluation`: prompts, protocol transcripts, client
usage, fixture state, and `results.json`. Run directories are unique; the scorer
selects the latest completed run of each client/profile/scenario, evaluating lease
expiry at the recorded end of that run so delayed rescoring is stable. Re-entry starts
a fresh client with a saved handoff: this simulates context loss and does not
certify a client's native compaction behavior.

The scorer checks final database state, claim ownership, handoff references,
participant-targeted delivery, artifact attribution, and that acknowledged
sequences were actually returned as a contiguous journal prefix. Selection
accuracy is the fraction of calls with no unsupported-operation or unexpected
error; expected claim contention counts as a correct selection. Transcript review
checks that selected operations fit the requested task. These are smoke metrics,
not a statistical claim about model reliability.

Measured on 2026-10-07, Apple Silicon/macOS, one run per scenario/profile/client:

| Client | Profile | Tasks completed | Tool calls | Selection accuracy | Processed tokens |
|--------|---------|-----------------|------------|--------------------|------------------|
| Claude Code 2.1.293 (`claude-opus-4-8`) | workflow | 5/5 | 19 | 100% | 275,236 |
| Claude Code 2.1.293 (`claude-opus-4-8`) | all | 5/5 | 23 | 100% | 472,645 |
| Codex CLI 0.160.1 (CLI default) | workflow | 5/5 | 26 | 100% | 912,888 |
| Codex CLI 0.160.1 (CLI default) | all | 5/5 | 30 | 96.7% | 1,644,858 |

The six-tool profile used 41.8% fewer tokens for Claude Code and 44.5% fewer for
Codex in this suite. Both profiles completed every task. The primitive Codex run
selected the remote-only binary upload once, received an actionable local-backend
error, and recovered with text publication. No protected task or successor claim
was overwritten.

Processed tokens include cached input: Claude's input + cache creation + cache
reads + output, and Codex's input + output (its input already includes cache
reads). These are actual client-reported usage totals, not dollar costs or tool
schema byte estimates. Codex's JSONL did not report a resolved model identifier;
no model override was used. Absolute counts also include client instructions and
conversation history, so compare profiles within each client rather than clients
against each other. Cloudflare correctness is covered separately by backend,
HTTP-facade and Worker tests; this model-backed comparison uses the local backend.
