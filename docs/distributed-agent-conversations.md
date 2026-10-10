# Distributed agent conversations

Status: design proposal, 2026-10-09. This specifies future contracts; it does not
claim that rooms, host connectors, account routing, or a Herdr integration have
shipped. It supplements the current [architecture](02-ARCHITECTURE.md) and
[roadmap](03-ROADMAP.md). Existing identity, membership, and fencing guarantees
remain in force during migration.

## Implementation boundary — issue #283, slice 1

This revision implements durable agent registration, run-pinned agent/role identity,
the consumer-binding ledger, and host-local credential profiles. Rooms, messages,
inbox consumption, native wake, Herdr and dashboard delivery remain future slices.
Assignments, task attempts and durable questions are outside #283.

An acting run holds a mailbox binding. A relay can attach an authenticated acting
run from the same enrollment but cannot become the holder. Agent selection is
checked against the agent's owner or explicit principal/agent grants before D1
issues the run. Renewal and operation retries preserve that selection and role.
The Worker derives the internal authority envelope from current authentication;
client headers and identity fields do not grant binding authority.

Bindings use the agent row's monotonic epoch. An identical attach by the current
run refreshes only the lease hint; changed profile/session evidence is rejected.
A replaced, released or expired run cannot attach again. Conditional replacement
requires the current epoch and either the same enrollment, owner/manage authority,
or a Worker-verified terminal previous run. Run validity comes from D1 on each
request; the DO's copied lease is a hint and cannot renew authority.

Agent and binding APIs bypass response replay and shared caching. Holders, owners
and agent managers receive full binding details; other authorized readers and
relay attachment responses receive a summary without native-session or account
references. Restore expires copied bindings and advances epochs past both the
archive and destination high-water marks. Local SDK/CLI calls report
`unsupported-capability`; embedded storage still carries the shared migrations.

Profiles select local executable/configuration paths, environment allowlists and
host-keyed account references. A profile revision is immutable for a running
session. Verification can establish only `declared` isolation: profiles under one
OS account are not a process security boundary. See the
[operations procedure](05-OPERATIONS.md#agent-bindings-and-account-profiles).

## 1. Product boundary and required scenario

Tila provides durable project communication and coordination across machines,
provider accounts, and coding tools. People continue working in their native
coding interfaces. Tila's optional dashboard exposes shared rooms, threads,
delivery state, questions, and human replies through the same service API.

The design must accommodate this scenario from its first implementation:

| Project member | Native interface | Login context | Host |
|---|---|---|---|
| Implementation worker | Standalone Claude Code | Claude subscription A | Mac |
| Second worker | Claude Code inside Herdr | Claude subscription B | Mac |
| Reviewer | Claude Code inside Herdr | Claude subscription C | Linux VPS |
| Coordinator | Standalone Codex CLI | OpenAI account D | Linux VPS |
| Human | Native terminal, optional Tila view | Tila human credential | Any client |

All four sessions can publish to the same project room. A Codex session can
address a Claude session and receive its reply; the reverse direction uses the
same contract. Provider, account, machine, runtime, and run role are independent
dimensions. Three subscriptions are three selectable account contexts, not three
different provider integrations.

The VPS must keep participating while the Mac and every dashboard are offline.
Cross-machine execution is a first-release acceptance condition. A local-only
demonstration does not satisfy it.

## 2. Components and ownership

| Component | Owns | Boundary |
|---|---|---|
| Tila service | Memberships, durable agents/mailboxes, rooms, messages, deliveries, assignments, attempts, policy and audit | Cloudflare remains authoritative |
| Host connector | Registered host identity, local account profiles, session bindings, reconnect, wake delivery and reconciliation | Runs independently on each participating host |
| Runtime adapter | Discovery, process/terminal observations, optional launch/resume/stop | Herdr and standalone workflows implement the same interface |
| Harness adapter | Native Claude/Codex session references, account verification, wake mechanisms and optional transcript access | Advertises tested capabilities for the installed version |
| Clients | CLI, MCP, optional dashboard and Herdr plugin entrypoints | Use the shared service and connector contracts |

The runtime and harness adapters compose. A Claude session in Herdr uses Herdr
for terminal discovery and Claude's native messaging mechanism when available.
Standalone Claude uses direct discovery with the same harness adapter. Codex
follows the same composition. Avoid a separate full integration for every
runtime × harness × account combination.

```text
sender CLI/MCP -> Tila project service -> recipient host connector -> native session
native session -> authenticated inbox fetch -> reply/acknowledgement -> Tila service
```

Each connector connects outbound to Tila. SSH may provision or inspect a host;
ongoing delivery does not require a laptop SSH relay. Local agent calls may use
Tila directly or a narrowly scoped local connector endpoint. The connector must
not become a mandatory proxy for every existing CLI/MCP operation.

Herdr owns its processes and terminals. Tila owns durable communication and
assignment semantics. A plugin exposes configuration, registration, status,
links, and optional terminal views. It does not create a second room database
or scheduler. When another product owns scheduling, Tila may provide messaging
only; an assignment has one authoritative scheduling owner.

## 3. Identity and lifetime

### Authorization and conversation identity

| Identity | Meaning | Lifetime |
|---|---|---|
| `principal_id` | Authenticated human or service subject | Stable across credential rotation; server-derived |
| `agent_id` | Durable project collaborator and mailbox, such as `reviewer-1` | Survives replacement sessions, providers and hosts |
| `participant_id` | Independent execution participant under a principal | New connectors allocate an execution incarnation; existing clients keep their compatibility contract |
| `task_id` / `attempt_id` | Intended work / one authorized attempt to perform it | Independent of native conversation lifetime |
| `room_id` / `thread_id` | Shared conversation / reply thread within that room | Independent of presence and native transcripts |

An agent's name is a label, not an address or permission. A role such as
coordinator, worker, or reviewer is attached to a run and may change. A human
publishes as an authenticated human principal; an agent publishes through an
explicit binding to its principal and participant. The server stamps both the
logical author and actual execution provenance.

An agent may have multiple observed sessions, but v1 permits only one active
consumer binding for its mailbox. Intentional parallel workers receive separate
agent IDs. Observers and human views do not compete with the mailbox consumer.

### Execution and account identity

| Identity | Meaning | Required qualification |
|---|---|---|
| `host_id` | Enrolled connector installation | Authenticated enrollment, not a hostname header |
| `runtime_id` + `runtime_epoch` | Runtime installation/session and current server incarnation | Scoped to host; epoch changes after replacement |
| `account_id` | Opaque reference to a selected provider account | Separate from Tila principal, provider name, model and credential |
| `profile_id` + `profile_revision` | Host-local configuration and credential context for an account | Scoped to host; pinned by each binding |
| `binding_id` + `binding_epoch` | Verified mapping from logical agent to live execution | Includes harness, native session, profile and runtime observations |

Native session IDs are opaque and namespaced by host, harness and profile.
Herdr pane IDs, aliases, PIDs, terminal IDs, filesystem paths and model names
cannot serve as global identity. Include PID start time when using a process
observation; a PID alone can be reused.

Replacement bindings require explicit authorization and a new monotonic epoch
(a counter that rejects stale owners). The old execution cannot acknowledge new
deliveries or commit task results after replacement. Native conversation resume
does not automatically transfer claims or authority. Resuming an attempt requires
a recorded reassignment and the current claim fence; retrying the task creates
a new attempt.

Forking a native conversation produces a separate execution binding, even when
history or a provider's identifier format looks related. Provider-native
subagents are independently addressable only when an adapter can verify their
identity and supported inbox; otherwise their parent is the routing endpoint.

## 4. Multiple accounts are a first-class contract

The host owns a registry of credential profiles. A profile contains a local
launcher reference, harness kind, authentication mechanism, native configuration
location, credential-store namespace, endpoint selection, and approved local
environment. Secrets and credential files stay on the host. Tila stores opaque
references, labels, availability, verification status and policy metadata.

Model configuration profiles and authentication profiles are distinct concepts.
A model flag or a Codex `--profile` name is not proof of a separate login.
Likewise, Claude Code is a harness; its inference/authentication backend need not
always be a claude.ai subscription.

| Operation | Required behavior |
|---|---|
| Attach an existing session | Observe or explicitly register its actual profile; unknown identity stays unknown |
| Launch | Resolve an allowed host profile; pin its revision and selected account before starting |
| Refresh credentials | Let the native credential mechanism refresh within that profile; do not overwrite another profile |
| Change login or profile | Detect mismatch, mark binding unavailable, and require explicit rebind; never silently use the new login |
| Account unavailable or limited | Defer or choose an explicitly allowed alternative for a new/reassigned execution; preserve history and record the change |

Several profiles on different hosts may refer to the same account only through
an explicit mapping. Equal email labels do not establish account equivalence.
Account observations may be verified, declared, unknown or mismatched. These are
routing observations, not Tila authorization. Scheduling may require verified
identity where the adapter can supply it; unsupported verification is visible.

Two profiles may work in the same checkout. Shared project hook/MCP configuration
must not contain a mutable "current account" or participant selection. Pass the
selected profile and Tila binding through per-process context and a scoped grant;
starting the third session must not rewrite the first two sessions' identity.

Quota state is advisory and timestamped: available, limited, authentication
required, or unknown. Do not promise uniform subscription quota APIs. Concurrency
limits and permitted account alternatives are explicit policy. Account changes
must not occur by logging a shared daemon out and back in while it hosts other
sessions. If authentication is daemon-wide, isolate daemons by credential profile
unless the installed API explicitly supports session-scoped authentication.

Claude's documentation describes simultaneous claude.ai logins using separate
`CLAUDE_CONFIG_DIR` directories, including separate session history. It identifies
an exception for keyless Console sign-ins. Codex documents configurable file,
keyring, automatic and in-memory credential stores; adapter tests must establish
the isolation behavior for the selected store and daemon mode. These mechanisms
are implementation choices underneath `profile_id`, not fields callers must
understand. [Claude authentication](https://code.claude.com/docs/en/authentication),
[Codex authentication](https://learn.chatgpt.com/docs/auth).

## 5. Rooms, routing and delivery

A room belongs to a project and has explicit membership and history-read policy.
A thread belongs to exactly one room. Native private conversation history is
separate; only intentionally published content enters the shared room. Joining
a room does not automatically start a model turn.

Use two explicit routing modes:

| Target | Meaning | Replacement behavior |
|---|---|---|
| Logical agent mailbox | Deliver when its authorized consumer becomes available | Follows a verified replacement binding |
| Exact binding/attempt | Message is intended for that execution context | Holds or expires when the context is obsolete; never retargets silently |

For room/group publication, persist the intended recipient agent IDs at acceptance,
including offline members. Visibility and wake subscriptions are separate.
Historical messages are readable according to room policy, but joining later
does not create historical wake deliveries. Removing a wake subscription stops
future nudges; it does not remove history access. Revoking read membership prevents
new fetches even when an old wake was already submitted. Content already fetched
cannot be recalled.

```text
publish -> persist message + recipients + outbox -> attempt wake -> fetch -> acknowledge
assignment -> accept -> perform work -> commit explicit result with current fence
```

Message publication and delivery records commit in one project transaction.
A durable outbox (pending dispatch records) drives retries. Transport notifications
are hints; reconnect uses durable cursors and current snapshots. Offline messages
remain until an explicit retention/expiry policy applies, independently of the
short-lived presence record.

Track facts separately: `stored_at`, wake attempts, `fetched_at`, `acked_at`, and
explicit task result. An acknowledgement means the recipient accepted processing
responsibility, not that a model read every token or finished the task. A human
view opening a thread does not acknowledge it for an agent. UI terminal status
does not acknowledge a delivery.

Fetching or advancing a transport cursor never removes an unacknowledged delivery
from the retry backlog. If acknowledgement precedes task completion, a durable
attempt/continuation record must retain responsibility; replacement reassigns that
unfinished work. A transient connector receipt alone cannot justify acknowledgement.

Each recipient delivery has a stable ID. Record each transport attempt separately
with `accepted`, `deferred`, `rejected`, or `unknown` outcome. Timeout after a
write produces `unknown`; it is not evidence that nothing happened. Reconcile
before reissuing transport input. Coalesce body-free inbox nudges per binding.
Nudges contain a fixed inbox instruction and opaque references, never peer-authored
prompt text. The agent fetches the authenticated message envelope through CLI/MCP;
the harness adapter preserves its peer provenance when presenting it to the model.
Providers without deduplicated wake support may incur an extra wake/model turn;
Tila must not claim exactly-once inference.

Publication requires a client operation ID, scoped to project and authenticated
author, plus a canonical request hash. Repetition returns the original result;
reusing the ID with different content conflicts. Acknowledgement and result
submission have independent idempotency contracts. Effects use delivery IDs,
task attempts and fences; plain-text instructions to avoid duplicates are not
a correctness mechanism.

Room history uses bounded cursor pagination with server-assigned ordering.
Specify body/attachment limits and retention before implementation. Expiring an
unprocessed delivery does not silently erase the corresponding room history.
Cursor compaction returns an explicit reset/snapshot requirement. No total order
across projects is promised.

## 6. Service and adapter contracts

These are proposed operations, not currently available endpoints. Zod schemas
remain the source of truth; HTTP, SDK, CLI and MCP map onto the same semantics.
Transport route spelling can follow the existing project API without changing
these responsibilities.

| Service surface | Essential operations | Required semantics |
|---|---|---|
| Enrollment and bindings | Enroll host; register agent; attach/replace binding; renew lease | Derived identity, profile revision, expected binding epoch, capability report |
| Conversations | Create/join room; open thread; publish/list messages | Authorized membership, cursor ordering, immutable author provenance, operation ID |
| Inbox and dispatch | Fetch deliveries; acknowledge; watch changes; report wake attempt | Exact consumer grant, delivery ID, reconnect cursor, uncertain outcome support |
| Work coordination | Assign/accept/cancel attempt; submit result; request/record decision | Separate from chat text; explicit authority, expiry and current claim fence |
| Discovery and views | List participants/bindings/accounts; inspect delivery; publish human reply | Same access checks, redacted credentials, optional native deep links |

A publish request has `room_id`, optional `thread_id`/`reply_to_message_id`, typed
body and artifact references, explicit recipient targets, operation ID, and
optional task/attempt/correlation references. The server validates all references
within the project/room, derives sender identity, and records timestamp and sequence.
Correlation fields never grant access or prove a human approved an action.

An inbox fetch binds its cursor to the authorized mailbox consumer, preventing
one participant from advancing another's progress. Acknowledgement includes
`delivery_id`, `binding_id`, `binding_epoch` and disposition. Validate current
membership, credential ceilings and binding authority before cached retry replay.

Expose stable errors for stale bindings, profile mismatch, unsupported required
capabilities, revoked access, and expired cursors requiring a snapshot. Return
the operation/delivery reference on ambiguous dispatch so clients can reconcile
instead of treating an HTTP timeout as permission to repeat input.

### Host interfaces

| Interface | Responsibility | Capability-dependent operations |
|---|---|---|
| Runtime adapter | Discover and observe exact occupants | Launch, reconnect, resume, stop and native deep links |
| Harness adapter | Resolve native session/account context and submit inbox wake | Native queue, native peer message, busy queueing, receipts, transcript access |
| Profile resolver | Resolve registered local launcher and credential context | Verify selected account; report usable/auth-required/unknown |
| Connector delivery engine | Maintain binding leases and dispatch ledger | Reconcile after failures; select one authorized wake path |

The minimum integration can register an existing session, publish, fetch and
acknowledge. It does not need launch control or a Tila-owned terminal. Native
session observations and user-enrolled metadata carry explicit evidence/source;
an unsupported operation returns a typed error, not a silent terminal fallback.

The wake contract must expose its actual guarantees:

```ts
type WakeRequest = {
  operationId: string;
  bindingId: string;
  expectedBindingEpoch: number;
  expectedNativeSessionRef: string;
  expectedProfileRevision: number;
  inboxCursorHint?: string;
};

type WakeResult = {
  outcome: "accepted" | "deferred" | "rejected" | "unknown";
  mechanism: "native-peer" | "native-queue" | "terminal" | "poll";
  receiptRef?: string;
  reason?: string;
};
```

The connector resolves local paths/endpoints from the binding; the cloud does not
send arbitrary executable paths, shell commands or environment secrets. Native
session preconditions must be enforced at the action site where possible. A
read-then-send check on an API without conditional addressing still has a race;
such an adapter cannot advertise atomic session validation.

Negotiate protocol versions and individual capabilities independently of product
versions. Relevant guarantees include exact-session validation, profile isolation,
safe busy queueing, draft preservation, deduplicated wake, durable provider queue,
receipt quality, transcript availability and headless resume. Capability reports
include adapter/harness/runtime versions and evidence; a provider name alone
does not imply support. Connectors must tolerate additive fields and reject
unsupported required capabilities before dispatch.

Launch requests refer to an enrolled local launcher/profile and an operation ID.
The connector persists intent before launching and reconciles process/session
evidence after a crash. An uncertain launch is not blindly repeated. Discovery
of an independently started CLI may register an observation, but does not by
itself authorize attaching tools, issuing grants, or waking that session.

## 7. Herdr integration

Herdr is a runtime adapter and optional plugin packaging target. Plugin startup
can reconcile registrations and ensure a separately managed connector is present;
it must not be treated as a supervised daemon lifecycle. Each remote installation
has its own connector and local credentials. Plugin and standalone adapters on
one host coordinate through one binding lease so they cannot both wake the same
session for the same delivery.

| Herdr surface | Tila use | Limit |
|---|---|---|
| Snapshot, agent and pane APIs | Discover occupants and reconcile bindings | Pane/name identity is scoped to one server |
| Native session reference | Bind Herdr occupant to harness session | Optional; absent identity must remain unknown |
| Events | Prompt a fresh observation | Non-durable; reconnect must resnapshot |
| Agent prompt/wait | Explicitly enabled terminal delivery fallback | Input submission/lifecycle observations are not message receipts |
| Plugin actions and metadata | Register sessions, show state, open Tila views | Display state and plugin labels do not grant authority |

Prefer native harness wake mechanisms after discovery. Herdr's prompt API writes
to the terminal composer; a pre-existing draft can be included in the submitted
message. An idle status alone cannot establish an empty composer. Automatic
terminal fallback is therefore disabled for human-shared panes unless an adapter
can establish the required guarantee; otherwise defer, poll on a native hook, or
use a dedicated execution pane with explicit policy. Do not use raw keys to
answer permission dialogs as a delivery workaround.

The installed schema exposes no expected-native-session precondition on
`agent.prompt`. Checking an occupant before sending reduces accidental delivery
but cannot eliminate replacement between the two calls. Strong exact-session
delivery requires a native endpoint that validates the reference or an upstream
conditional API. [Herdr automation](https://herdr.dev/docs/agent-automation/),
[Herdr socket API](https://herdr.dev/docs/socket-api/).

Unattended recovery needs its own capability test. Herdr's documented cold
restoration of native conversations waits for client attachment. A headless
server being reachable is not proof that its provider sessions resumed. Explicit
launch/reconciliation may be needed. Do not build Tila availability around a
desktop viewer attaching. [Herdr session restore](https://herdr.dev/docs/session-state/),
[Herdr plugins](https://herdr.dev/docs/plugins/).

Existing [Herdr Group Chat](https://github.com/terry-li-hm/herdr-group-chat) and
[Agent Messenger](https://github.com/aashishd/herdr-agent-messenger) overlap with
local conversation delivery, while
[Herdr Projects](https://github.com/eliasstravik/herdr-projects) overlaps with
assignments and coordination.
Reuse or adapt compatible components where useful, but choose one owner for room
history, wake dispatch and scheduling. Group Chat's own
[backend boundary discussion](https://github.com/terry-li-hm/herdr-group-chat/blob/main/docs/cumora-boundary.md)
is consistent with an external authoritative conversation service.

## 8. Authority and failure policy

Project membership, credential scope, run role and native process permissions are
separate. A coordinator can assign only within an explicit grant. A reviewer
label cannot elevate access. Peer messages remain peer content even if a native
API inserts them into a user-message slot. An authenticated Tila envelope proves
its origin, not human approval of the requested action.

New connector-issued worker credentials must bind the permitted principal,
agent, participant, binding epoch and project scope. Existing caller-supplied
participant headers under one shared credential are not sufficient isolation
between mutually untrusted workers. Preserve legacy behavior while introducing
the stricter grant; do not claim the legacy header is a secret or authenticator.
Host enrollment permission does not imply project-owner rights.

Human approvals are explicit records with the approving principal, requested
action, target attempt, scope and expiry. Natural-language claims of approval do
not mint them. Tila grants cannot bypass a native sandbox or permission prompt.
Shared-OS-user processes may still access each other's local credentials/files;
separate profiles provide account routing, not a process security sandbox.

| Failure | Required behavior |
|---|---|
| Host/network offline | Keep durable mailbox backlog; do not report unsent local outbox items as server-stored |
| Lease or binding replaced | Reject stale acknowledgements/results; stop dispatch to the old consumer |
| Wake outcome uncertain | Record uncertainty and reconcile; never blindly replay terminal input |
| Tila unreachable during work | Native editing may continue, but no new shared authority is assumed; revalidate before coordinated writes |
| Chat loop or overload | Enforce explicit recipients, causal-chain/turn limits, concurrency and room/run budgets |

Fencing protects operations that validate the fence. It cannot prevent arbitrary
filesystem writes by a disconnected process with OS access. Workspace isolation
and native permissions remain necessary where that threat matters.

## 9. Current implementation gaps and migration

| Existing implementation | Consequence for this design |
|---|---|
| Canonical principal/participant identity and memberships | Reuse these foundations; add durable agent identity and explicit binding grants |
| Lifecycle key hashes project namespace, client and native session ID | No explicit account/profile/host dimension; introduce a versioned binding model without rewriting old IDs implicitly |
| Codex observer invokes `codex app-server proxy` through inherited environment | Resolve the intended profile and endpoint explicitly before expanding to multiple accounts |
| Signals expire within 24 hours; group/principal broadcasts snapshot active presence | Keep signals for hints; add durable conversation/delivery storage with offline recipient semantics |
| Continuity journal/cursors and handoffs | Reuse for recovery references; do not equate a journal cursor with message processing acknowledgement |

Source anchors: [identity](../packages/schemas/src/identity.ts),
[lifecycle key](../packages/client-lifecycle/src/store.ts),
[Codex observer](../packages/client-lifecycle/src/codex.ts),
[signals](../packages/ops-sqlite/src/signal-ops.ts),
[continuity](../packages/schemas/src/continuity.ts).

Keep shared wire schemas in `@tila/schemas`, service contracts in `@tila/core`,
and project transactions/migrations in `@tila/ops-sqlite`. The Worker remains
an authenticated transport boundary. SDK, CLI and MCP expose the same operations.
Host-specific process, socket and credential-store code belongs in a host package
or adapter package, not platform-agnostic schemas/core. Evolve client-lifecycle
compatibly instead of making its current presence observer a hidden supervisor.

Per-project DO SQLite owns rooms, messages, recipient deliveries, dispatch outbox,
binding epochs and assignment transitions that must commit together. D1 retains
global authentication/enrollment and project registry responsibilities. R2 holds
explicitly published immutable attachments. Authorize against current credential
ceilings before entering project operations; keep claim/binding validation in
the project transaction. Do not introduce a cross-store message/outbox write.

Add the service resources and negotiated binding protocol before requiring new
clients. Existing signals, auth and lifecycle installations continue to operate.
Do not infer durable agent identity from historical display names, model names
or provider-account labels. Provide explicit registration/mapping for migration.

## 10. Implementation sequence and acceptance

| Slice | Deliverable | Acceptance gate |
|---|---|---|
| Contracts and profiles | Versioned identities, capabilities, bindings and local profile resolver | Three same-provider contexts coexist; account mismatch and stale bindings fail safely |
| Durable conversations | Rooms, threads, offline inboxes, outbox, acknowledgements and auth | Retry/duplicate, revocation, retention and cursor recovery tests through the actual Cloudflare runtime |
| Standalone connectors | Claude and Codex attach/publish/fetch/wake | Both directions, busy sessions, native drafts, restart and unsupported capabilities |
| Herdr adapter/plugin | Same protocol with discovery and plugin entrypoints | Existing/manual sessions, replacement occupants, reconnect and mixed standalone/Herdr operation |
| Distributed workflow and view | Mac + Linux project conversation with optional human UI | VPS continues without Mac; three Claude accounts plus Codex remain correctly addressed |

Before declaring the architecture validated, run the full mixed scenario from
§1. Include identical pane aliases on two hosts, two profiles using the same
working directory, credential/account changes, duplicate delivery, a consumer
crash between fetch and acknowledgement, a stale producer result, and clientless
VPS restart. Test both trusted session replacement and explicitly non-transferable
attempt messages. Contract tests must distinguish fixture behavior from real
provider/runtime integration results.

## 11. Evidence and remaining validation

Research and probes are dated 2026-10-09. Version-specific observations are not
general promises about future releases.

| Evidence | Observation | Scope |
|---|---|---|
| Native Claude Code 2.1.295 and Codex 0.160.1 probes | Relayed model responses in both directions; resume retained synthetic context | A test bridge forwarded outputs; not autonomous native cross-provider messaging |
| Claude native peer transport | Idle wake, busy queue, duplicate-ID suppression during observation and inbound refusal | Tested owned sessions only; no durable offline queue established |
| Codex native queue | Idle wake and busy drain; pending messages survived a forced daemon restart | Reusing `clientUserMessageId` admitted duplicate queue entries |
| Existing Tila targeted tests | 42 lifecycle, continuity and signal tests passed during investigation | Supports existing substrate; not tests for the proposed room system |

The live Herdr probe used isolated configuration/plugin registries and empty
temporary working directories on macOS and a Linux VPS. Neither server had a
TUI client attached. Both ran Herdr 0.9.3, protocol 22. The test plugin contained
only a context-recording startup hook and action; no production plugin was installed.

| Live probe | Result | Design implication |
|---|---|---|
| Plugin startup and action on both hosts | Passed; each received its own socket/context and wrote isolated local state | The same thin plugin can run alongside a per-host connector |
| Native Claude under Herdr, Mac 2.1.295 / Linux 2.1.292 | Both returned exact synthetic acknowledgements, verified in native transcripts; remote process survived separate SSH command connections | Fresh headless execution works; this does not prove cold native restoration |
| Same alias and pane ID on both servers | Both used `probe-worker` and `w1:p1` independently | Host/runtime qualification is mandatory |
| Prompt into blocked dialog, then into a partial draft | Blocked prompts were rejected on both hosts; Mac terminal prompt appended to and submitted the draft | `idle` is insufficient for safe human-shared terminal delivery |
| Native Claude peer wake inside Herdr with a draft present | Reply verified; draft remained visible and was absent from submitted native messages | Runtime discovery and native harness delivery compose successfully |

Native session references were absent from Herdr observations with provider hooks
disabled. The probe correlated the owned PID with the native session registry;
production discovery must state which verified mechanism supplies the binding.
All owned servers, shells and native sessions were stopped. Process absence and
closed sockets were checked independently on both hosts; owned native registry
entries were also gone. No existing project was used.

Three independently authenticated subscriptions, complete Tila cross-host routing,
and unattended native restoration are separate acceptance gates; synthetic profile
fixtures alone cannot establish them.
