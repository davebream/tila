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

The parent supplies a run-specific socket capability. Remote MCP never reads personal sessions, owner tokens or the ambient keychain. `TILA_API_TOKEN` and `TILA_TOKEN` are rejected.

Explicit local mode uses `TILA_MODE=local`, `TILA_PROJECT_ID`, and absolute `TILA_DB_PATH` and `TILA_ARTIFACTS_PATH` paths. Set a stable `TILA_PARTICIPANT_ID` to reconnect after restart. It cannot be combined with remote credentials, `TILA_API_URL` or run bindings. Independent local databases do not share a queue; processes sharing one local database use the same SQLite coordination rules.

## Authentication and lifetime

An enrollment has one canonical service membership; every run gets a different participant and credential. Personal enrollments remain capped by their sponsor’s current project authority. Shared installations require an owner invitation and retain their own project authorization if the authorizing owner leaves.

Run credentials last at most 15 minutes and renew two minutes before expiry with jitter. A heartbeat runs every minute; missing heartbeats expire the lease after five minutes. Revocation, closure, expiry, or loss of authority stops access, including cached/retried operations. Temporary failures retry only while authorization remains valid. No stronger credential fallback exists.

MCP authenticates tools, resources, prompts, and discovery on every request. Reconnects reuse an active run. Native shared clients must provide an unambiguous session mapping; Codex uses request metadata `sessionId` or `threadId`, and Claude Code uses a verified native process mapping. Unsupported or missing metadata fails closed. Use one MCP process per run where reliable mapping is unavailable.

The `worker` preset covers the default work operations. Queue administration still requires maintainer authority. It excludes deletion, governance, credentials, infrastructure, and gate resolution. Selecting extra tool groups changes visibility, never authority; denied operations return permission errors.

Session shutdown saves a handoff, acknowledges observed events, and releases exact captured claims before closing authentication. Cleanup has a five-minute limit and reports incomplete work. Claims still obey their original lease/fence rules. `tila_close` only performs coordination cleanup; it does not terminate authentication. A replacement session gets a new run and participant and recovers through a handoff.

This helper is not an OS sandbox. An unrestricted process under the same OS account may reach that account’s secrets. Hostile-process isolation is the responsibility of the host runtime.

See [runtime operations](../../docs/05-OPERATIONS.md#runtime-enrollment-and-unattended-runs) for shared runners, OIDC, recovery, revocation, and the backend-first upgrade.

## Tools (98)

The default catalog contains **nine workflow tools**. Primitive tools are opt-in with
`TILA_MCP_TOOLS=all`, existing named groups, or `core`. Combine groups with commas, for example
`workflow,artifacts`. Empty/unset selects `workflow`; compatibility aliases remain opt-in.

### Managed queue

| Tool | Purpose |
| --- | --- |
| `tila_queue` | Inspect, configure, enroll, edit, withdraw and claim managed work. |
| `tila_question` | Ask, inspect, answer, escalate, cancel and link discussion for attempt questions; decisions never resume execution. |
| `tila_attempt` | Accept, start, heartbeat, finish, suspend, resume, cancel, reconcile, retry, replace a stopped native session on the same attempt and link corrective work to a finished result; list filters recover one owner's unfinished work. |

Both are included in `workflow` and can be selected with `TILA_MCP_TOOLS=queue`. Each accepts a typed `request` with an `action`. Mutations require an idempotency key and current revision where applicable. A grant reserves capacity; acceptance must commit before launch. Cancellation requests do not stop processes. Replayed grants must have `grant_valid=true`.

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
| `tila_signal_group_set` | Create or replace a signal group (admin); `expected_revision` 0 creates only, a positive value must match |
| `tila_signal_group_delete` | Delete a signal group (admin) against an optional `expected_revision`; past deliveries are unchanged |

### Journal, Schema & Templates

| Tool | Description |
|------|-------------|
| `tila_journal_list` | Query the project event journal |
| `tila_journal_append` | Append a project-visible authenticated report; requires a stable idempotency key and never changes work state. Cloudflare only. |
| `tila_reentry` | Recover summary, journal changes, live claims, pending signals, and a relevant handoff |
| `tila_journal_replay` | Replay oldest-first journal pages, including archived history |
| `tila_journal_cursor_get` | Read the current participant's durable acknowledged cursor |
| `tila_journal_acknowledge` | Advance the current participant's acknowledged cursor |
| `tila_handoff_create` | Save an immutable, attributable handoff; reuse its UUID for retries |
| `tila_handoff_get` | Read a handoff by ID |
| `tila_handoff_list` | List this participant's handoffs or handoffs referencing a resource |
| `tila_schema_update` | Apply a new TOML schema definition |
| `tila_schema_preview` | Preview configuration changes and return the revision and reviewed definition for conditional apply |
| `tila_schema_import` | Plan or conditionally apply a TOML/YAML definition file, merging named declarations by default |
| `tila_schema_export` | Export the applied definition as TOML/YAML with provenance metadata |
| `tila_settings_export` | Export allowlisted agents, rooms and signal groups with caller-scoped coverage |
| `tila_settings_import` | Review explicit identity/profile/resource mappings and return a frozen non-secret receipt |
| `tila_settings_resume` | Inspect or explicitly apply a retained receipt; confirm removals and retain partial outcomes |
| `tila_template_list` | List available task templates |
| `tila_template_instantiate` | Create tasks from a template |

The settings tools are in the `settings` group, selected with
`TILA_MCP_TOOLS=workflow,settings` or `all`. They require the Cloudflare backend.
`tila_settings_import` never writes. Without `mappings`, it lists required
identity/profile/resource choices. With mappings it returns `result.receipt`,
including exact action payloads, destination revisions, warnings and removals.
Retain that receipt before calling `tila_settings_resume({ receipt, apply: true })`.
Inspecting with `apply: false` is the default. Confirm listed removals with
`confirm_removals: true`; keep the returned receipt after every attempt, including
`partial` or `blocked` outcomes. Resume skips committed actions and retains the
original IDs and revisions. Changed permissions and revision conflicts block
replay; they never silently refresh the plan. See [the settings transfer guide](../../docs/settings-transfer.md)
for mapping shapes, pending profile selections and recovery.

### Presence & Summary

| Tool | Description |
|------|-------------|
| `tila_presence_heartbeat` | Record a heartbeat to mark agent as online |
| `tila_summary` | Get compact project summary |

### Definition apply warnings

`tila_schema_update` accepts a full TOML definition. Preview with
`tila_schema_preview` and pass the returned `revision` as `expected_revision`,
plus `reviewed_definition` for destructive conditional writes. Stale writes
retain 412 behavior; retain the original payload/revision/idempotency key when
retrying a lost response.

Omitting the revision on a non-managed project remains compatible and returns
`warnings` with code `schema-revision-deprecated`, guidance and observed/result
revisions in both text and structured results. SDK diagnostics use stderr,
preserving the stdio protocol on stdout. Successful revisionless state changes
record `schema.revisionless_applied` in the durable journal; retries do not
duplicate it and no-change warns without another event. Managed projects still
require a revision, including cached legacy retries. No enforcement release is
set for other projects. `tila_schema_import` already requires a reviewed revision
on apply.

### Definition import and export

Select `TILA_MCP_TOOLS=workflow,schema` (or `all`) to expose these tools.
`tila_schema_import` takes `text`, `format` (`toml`, `yaml`, or `detect`, the
default), and `mode` (`merge`, the default, or `replace`). It plans without
writing, even if `expected_revision` is supplied. The `result` contains units
added, changed, unchanged, preserved and removed, warnings, the server preview,
and `reviewed_plan`: the revision, resulting canonical TOML in `definition`, and
removed units. Merge replaces each declaration the file mentions whole and
keeps omitted declarations. Replace makes the file the whole definition.

Retain and review the plan before applying:

```js
const { result: plan } = await tila_schema_import({ text, format: "detect" });
await tila_schema_import({
  text,
  apply: true,
  expected_revision: plan.reviewed_plan.revision,
  reviewed_plan: plan.reviewed_plan,
  idempotency_key: "unique-key-for-this-reviewed-import",
});
```

Apply requires `apply: true`, `expected_revision`, and the unchanged
`reviewed_plan`; revision 0 bootstraps an unapplied project. Keep the same file,
format and mode. Replace removals also require `confirm_removals: true`, including
template removals that the server considers non-destructive. If
`preview.autoApplicable` is false, review its changes and provide `strategy:
"relax"` or `"force"`. Missing confirmation, strategy or revision, changed
review/file contents, malformed or oversized definitions, and credential-shaped
values are rejected without writing. Diagnostics do not quote definition text.
Preview races conflict; apply never merges onto a newer revision automatically.

Use a stable idempotency key for an apply. If its response is lost, retry the
same request with the original reviewed TOML, revision, key, strategy and
confirmation. The existing server receipt can replay even after another
revision lands. A fresh stale request conflicts, and a reused key with different
apply contents is rejected. The applied result contains the original review and
`application` response; a replay's application revision can be older than the
project's current revision. A no-change apply records no new revision.

`tila_schema_export({ format: "toml" })` returns `result.text` and
`verbatim_paths`; `yaml` is also supported. The file includes `tila_export`
provenance, which import validates and strips. Export renders the applied
definition, including unknown keys, through the same helpers as CLI and UI;
comments and layout are not retained. A project without an applied definition
returns `status: "empty"`, revision 0 and `text: null`. Definition exports exclude
agents, rooms, access settings, credentials and stored data; they are not project
backups. A stored definition containing credentials is refused.

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

### Durable conversations (`TILA_MCP_TOOLS=workflow,conversations`)

Conversation access requires explicit enrollment capabilities. The default worker
preset remains unchanged. Acting runs must be pinned to an agent and attached to
its current binding; relay credentials cannot read bodies or acknowledge deliveries.
Conversation protocol 1 is independent of runtime protocol 1. SDK requests send
`X-Tila-Conversation-Protocol: 1`; a missing header is accepted for this release.

| Tool | Purpose |
|------|---------|
| `tila_room_list` | List accessible rooms |
| `tila_room_history` | Page through peer-content history with signed cursors |
| `tila_room_publish` | Publish with an author-scoped stable operation ID |
| `tila_inbox_fetch` | Fetch pending deliveries without acknowledging them |
| `tila_inbox_ack` | Accept processing or decline using the current binding epoch |
| `tila_inbox_watch` | Wait up to 25 seconds for publication, then re-poll with jitter |
| `tila_inbox_explain` | Inspect delivery metadata and wake attempts |
| `tila_agent_bind` | Attach the current run at the observed binding epoch |
| `tila_room_get` | Read room settings, revision and members (archived rooms stay readable) |
| `tila_room_create` | Create a room (managers) |
| `tila_room_update` | Change settings against `expected_revision` |
| `tila_room_member_set` | Add a member or change its wake setting; advances the room revision |
| `tila_room_member_remove` | Remove a member |
| `tila_room_archive_preview` | Show members, pending deliveries and messages an archive affects |
| `tila_room_archive` | Stop publication and wakes; history stays readable |
| `tila_room_unarchive` | Restore publication |

Room settings writes name the revision you read. A stale revision fails with
`revision-conflict` and the current revision instead of overwriting another change;
reuse an `idempotency_key` only to retry the same request.

### Access inspection (`TILA_MCP_TOOLS=access`)

Read-only views for project owners. Memberships, repository policy, service
identities and credentials change only through the dashboard, CLI or SDK.

| Tool | Purpose |
|------|---------|
| `tila_access_members` | List canonical memberships and roles |
| `tila_access_repos` | List linked repositories with access and OIDC policies and revisions |
| `tila_access_service_accounts` | List service identities |
| `tila_access_credentials` | List credential metadata; never secret values |

### Agent management (`TILA_MCP_TOOLS=agents`)

Opt-in identity management for agent managers. Configured identity and policy are
separate from the observed binding: an update never replaces the active binding, and
a profile selection applies to the next new attach. Archiving releases the reviewed
binding (`expected_epoch` from the preview) in the same step; pending deliveries stay
until they expire and attempts keep their own lifecycle. Host-local profile changes
are not available through MCP.

| Tool | Purpose |
|------|---------|
| `tila_agent_list` | List agents with observed bindings; managers may include archived agents |
| `tila_agent_get` | Read configured identity, policy, revision and observed binding |
| `tila_agent_register` | Register an agent mailbox |
| `tila_agent_update` | Change name, binding grants or profile selection against `expected_revision` |
| `tila_agent_archive_preview` | Show the binding, deliveries, rooms, questions and attempts an archive affects |
| `tila_agent_archive` | Archive and release the reviewed binding |
| `tila_agent_unarchive` | Restore the identity; nothing is revived |

Fetched content is always labelled `peer-content`, never human approval. Acknowledge
accepted processing before acting; declining is also an acknowledgement. Neither
means task completion. Do not send “received” messages. A reply reuses the supplied
`reply_op_id` so a retried turn cannot publish a duplicate reply.

History cursors expire after three days. Restart history on `cursor-expired`;
fetching the inbox without a cursor independently recovers pending work. Inline
bodies are limited to 64 KB in UTF-8; publish existing artifact references for larger
content. Local backends report `unsupported-capability`.
