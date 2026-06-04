# tila-mcp-server Changelog

## 0.2.0 — Context-audit hardening (2026-05-29)

### Breaking changes

#### Claim tools renamed to `tila_claim_*`

The claim tools have been renamed to use a consistent `tila_claim_` prefix:

| Old name | New canonical name |
|----------|--------------------|
| `tila_task_claim` | `tila_claim_acquire` |
| `tila_task_release` | `tila_claim_release` |
| `tila_claim_list` | `tila_claim_list` (unchanged) |

**Migration:** update agent calls from `tila_task_claim` → `tila_claim_acquire` and
`tila_task_release` → `tila_claim_release`.

**Transition period:** set `TILA_MCP_COMPAT_ALIASES=1` (or `true`) to also register the
old names as deprecated aliases. The old names are hidden by default to keep the default
tool surface at 38 and avoid context bloat.

```bash
# In your MCP server config (Claude Code, Cursor, VS Code)
TILA_MCP_COMPAT_ALIASES=1  # enables tila_task_claim / tila_task_release aliases
```

### New features

#### `TILA_MCP_TOOLS` group selector (opt-in)

Register only the tool groups your agent needs to reduce context window usage.
Unset or empty (the default) registers all 38 tools.

```bash
# Coordination-only agent (~11 tools)
TILA_MCP_TOOLS=tasks,claims

# Full coordination set (~20 tools via core alias)
TILA_MCP_TOOLS=core
```

**Available groups:**

| Group | Tools | Count |
|-------|-------|-------|
| `tasks` | tila_task_* CRUD | 8 |
| `claims` | tila_claim_acquire/release/list | 3 |
| `gates` | tila_gate_create/resolve/cancel | 3 |
| `signals` | tila_signal_send/list/ack | 3 |
| `artifacts` | artifact tools + tila_search | 8 |
| `records` | tila_record_* | 7 |
| `presence` | tila_presence_heartbeat | 1 |
| `journal` | tila_journal_list | 1 |
| `schema` | tila_schema_update | 1 |
| `templates` | tila_template_list/instantiate | 2 |
| `summary` | tila_summary | 1 |
| `core` (alias) | tasks + claims + gates + signals + summary + presence + journal | 20 |

Unknown group names cause a fail-fast startup error listing valid groups.

#### New `max_chars` parameter — `tila_artifact_read_text`

Large artifacts are now truncated client-side to avoid flooding the agent context.

- Default: `max_chars=10000` (10 000 characters)
- Over-limit responses include a trailing marker:
  `...[truncated: returned N chars of M bytes total]`
- Pass a higher value to read more: `{ key: "...", max_chars: 50000 }`

#### New `limit` parameter — `tila_task_ready` and `tila_task_relationships_list`

Both tools now cap their returned arrays at `limit` (default 50, max 500).
When capped, the response includes `{ truncated: true, total: N }`.
Under-limit responses are returned unchanged (no `truncated` key added).

#### Server `instructions` field

The MCP server now advertises a concise `instructions` string at the initialize
handshake, covering: claim→fence→write coordination, search routing
(`tila_search` vs `tila_artifact_search`), tasks vs records distinction, and
the artifact edit workflow.

#### Presence resource shows all machines with `active` flag

The `project-presence` resource (`tila://project/presence`) now returns **all**
known machines (including recently inactive ones), each with a server-computed
`active: boolean` flag. Previously it returned only active machines with no
`active` field. Filter on `active: true` for currently-online agents.

#### McpServer version sourced from `package.json`

The MCP initialize handshake now advertises the actual `package.json` version
(`0.2.0`) instead of the previous hardcoded `"0.1.0"`. Breaking tool renames
are now visible to clients at the protocol level.

### Description improvements

- `tila_search`: clarified as the preferred entry point for cross-type discovery
  (tasks and artifacts); results are tagged by type — `entity` (a task) or `artifact`.
- `tila_artifact_search`: clarified as artifact-only; prefer `tila_search` for
  general discovery.
- `tila_artifact_write_text`: removed the 4-step edit workflow prose (now in
  `SERVER_INSTRUCTIONS`).
