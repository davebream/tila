# tila-mcp-server

Tila MCP provides project workflows using short-lived run credentials. Tila CLI remains the operator interface for projects, memberships, credentials, and administration. Version 0.4.0 requires runtime protocol 1 on the shared backend.

## Setup

Authorize each installation once using an existing human login, then generate client configuration:

```sh
tila --instance https://tila.example.com --project my-project machine enroll
tila --instance https://tila.example.com --project my-project mcp init
```

For native Claude Code/Codex hooks, run setup in a directory configured for the same remote project. Other supported editors get one MCP process per run. Setup validates configuration before provisioning, preserves unrelated settings, and pins the MCP package to the installed CLI release. Noninteractive setup requires an existing enrollment and sufficient instance/project inputs.

Enrollment secrets and signing keys remain in the installation helper. The default store is the OS secret store. Headless Linux must explicitly select a private directory with `machine enroll --file-store /absolute/private/directory`; unavailable keychain storage never silently falls back to files. Repository configuration contains no enrollment secrets.

To launch a single process manually after enrollment:

```sh
tila --instance https://tila.example.com --project my-project run exec -- npx -y tila-mcp-server@0.4.0
```

The parent supplies a run-specific socket capability. MCP never reads personal sessions, owner tokens, the ambient keychain, or a private SQLite database. `TILA_API_TOKEN`, `TILA_TOKEN`, `TILA_BACKEND=local`, `TILA_DB_PATH`, and `TILA_ARTIFACTS_PATH` are rejected. There is no compatibility switch. CLI/SDK local functionality and operator authentication are retained.

## Authentication and lifetime

An enrollment has one canonical service membership; every run gets a different participant and credential. Personal enrollments remain capped by their sponsor’s current project authority. Shared installations require an owner invitation and retain their own project authorization if the authorizing owner leaves.

Run credentials last at most 15 minutes and renew two minutes before expiry with jitter. A heartbeat runs every minute; missing heartbeats expire the lease after five minutes. Revocation, closure, expiry, or loss of authority stops access, including cached/retried operations. Temporary failures retry only while authorization remains valid. No stronger credential fallback exists.

MCP authenticates tools, resources, prompts, and discovery on every request. Reconnects reuse an active run. Native shared clients must provide an unambiguous session mapping; Codex uses request metadata `sessionId` or `threadId`, and Claude Code uses a verified native process mapping. Unsupported or missing metadata fails closed. Use one MCP process per run where reliable mapping is unavailable.

The `worker` preset covers the six default workflows. It excludes deletion, governance, credentials, infrastructure, and gate resolution. Selecting extra tool groups changes visibility, never authority; denied operations return permission errors.

Session shutdown saves a handoff, acknowledges observed events, and releases exact captured claims before closing authentication. Cleanup has a five-minute limit and reports incomplete work. Claims still obey their original lease/fence rules. `tila_close` only performs coordination cleanup; it does not terminate authentication. A replacement session gets a new run and participant and recovers through a handoff.

This helper is not an OS sandbox. An unrestricted process under the same OS account may reach that account’s secrets. Hostile-process isolation is the responsibility of the host runtime.

See [runtime operations](../../docs/05-OPERATIONS.md#runtime-enrollment-and-unattended-runs) for shared runners, OIDC, recovery, revocation, and the backend-first upgrade.

## Tools (61)

The default catalog contains **six workflow tools**. Primitive tools are opt-in with
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

Record types with `mcp_resource = true` in the project schema are exposed as MCP resources at `tila://records/{type}/{key}`. The generic resource template is registered without reading project data. Each read authenticates its run, fetches that project’s current schema, and checks that the record type is exposed.

## Runtime configuration

| Variable | Meaning |
| --- | --- |
| `TILA_RUN_SOCKET`, `TILA_RUN_CAPABILITY` | Ephemeral run access supplied by the parent helper; never persist in repository configuration |
| `TILA_LIFECYCLE_CLIENT` | Native session integration selected by setup |
| `TILA_API_URL`, `TILA_PROJECT_ID` | Non-secret native integration binding; must match the run |
| `TILA_MCP_TOOLS` | Default `workflow`; optional primitive groups or `all` |

Participant identity is assigned by the server. Environment metadata is descriptive. Conflicting participant/project/credential overrides are rejected.

## Verification

```sh
pnpm --filter tila-mcp-server test
pnpm --filter @tila/worker test -- --run runtime-auth.integration runtime-subprocess
pnpm test:runtime
```

Protocol tests interleave tools, resources, prompts, and discovery from separate sessions. CLI subprocess tests use isolated homes and real protected file storage. Required Cloudflare runtime tests exercise D1, DO SQLite, R2, proof binding, renewal, and revocation. The previous private-SQLite MCP evaluation harness was removed at the 0.4.0 cutover.
