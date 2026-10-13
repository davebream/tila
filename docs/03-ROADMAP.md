# tila — Active Roadmap

Issue dispositions reconciled with GitHub on 2026-10-12 for #293; the product
direction dates from 2026-09-20. This replaces the earlier version-number roadmap;
its history remains in git. Proposed wording for #194 below is **not a posted
issue change**. Closed foundations are reused, not reopened.

## 1. Product direction

One self-hosted development-management product, with a reusable coordination core
and shared service contracts. First support one orchestrator assigning work,
answering worker questions and escalating owner decisions. Native Mac/iPhone apps,
other orchestration topologies and sandbox scheduling follow demonstrated needs.

| Boundary | Decision |
|---|---|
| Shared state | Cloudflare Worker + per-project DO SQLite + global D1 + R2 |
| Identity | Project keys bound to native principals and explicit memberships; preserve #184 |
| Execution | Mac/Linux hosts; evaluate existing runtimes before implementing a supervisor |
| Interfaces | CLI/MCP/web first; all use the same task, run and decision semantics |
| Development | Run this checkout's source; retain immutable deployed builds and package checks |

GitHub auth and standalone local persistence are still implemented. Their retirement
requires separate migrations and verification. Local execution, tests and caches
remain supported concepts. A local sandbox is an execution option, not another
source of shared project state.

Existing schema guarantees remain: `default_for_legacy` values are materialized
lazily on read rather than eagerly rewriting stored rows. Claims/fences, validated
writes and transactional entity/claim changes remain requirements during the reset.

### Distributed conversations — #283

Delivery is split into five dependent changes: identity/bindings/profiles;
durable conversations and CLI/MCP; standalone connector/native wake; narrow Herdr
evaluation/plugin; dashboard and distributed acceptance. All five slices merged
in PRs #285–#289 on 2026-10-10, including the dashboard and standalone connector.
Herdr registration/open and full authenticated native restoration acceptance remain
unfinished. #283 stays open until live Mac/Linux acceptance passes with the two
independent Claude accounts and plain Codex coordinator selected on 2026-10-09.
Fixture results do not satisfy those live gates. #303/#304 own durable attempts
and correlated decisions; they do not reopen the completed coordination epics.

## 2. Herdr research: reuse the runtime before building one

**Assessment: strong candidate for execution and terminal supervision; not yet a
verified replacement for durable workflow state.** This is a documentation/repository
review, not a local or VPS acceptance run. No installation or migration was performed.

### Availability and maintenance

[Herdr](https://github.com/herdrdev/herdr) is Apache-2.0, with Mac/Linux/Windows
binaries. Its [changelog](https://github.com/herdrdev/herdr/blob/master/CHANGELOG.md)
records 0.9.1 on September 16 and 0.9.0 on September 7, 2026. The repository shows
roughly 40k stars, but recent releases are the useful maintenance evidence.
The self-hosted runtime does not require a hosted subscription; compute and agent
providers remain separate costs. The [website](https://herdr.dev/) lists Herdr Cloud
as coming soon, so do not make it a dependency or assume its eventual price.

### What it could replace

| Need | Documented support | Remaining work to prove |
|---|---|---|
| Mac/VPS sessions | Per-host background servers, SSH machine profiles, remote CLI control | Cross-host assignment recovery and operation with Mac offline |
| Orchestrator driving workers | Agent start/prompt/read/wait and occupant-bound waits | Task-specific completion, retries and durable results |
| See blocked workers | Agent state from hooks or screen manifests | Unusual prompts; screen detection is fallible |
| Phone questions/chat | Third-party Telegram plugin with agent topics and answer buttons | Steward-first routing, safe retries, multiple hosts and recovery |
| Client upgrades | Capability negotiation permits compatible mixed versions | Pin and test the exact runtime/adapter combination |

Sources: [machine connections](https://herdr.dev/docs/connecting-machines/),
[automation](https://herdr.dev/docs/agent-automation/),
[agent detection](https://herdr.dev/docs/agents/).

### Limits that matter for this product

- **State is not task completion.** Herdr explicitly does not track individual turns
  in `agent prompt --wait`; an already-running turn can satisfy a wait. Tila must
  correlate completion to an assignment/attempt, not infer it from `idle` or `done`.
  [Automation semantics](https://herdr.dev/docs/agent-automation/)
- **Live events are not a durable journal.** Subscriptions do not replay earlier
  lifecycle events. Snapshot plus subscription supports rebuilding a runtime view;
  it does not prove recovery of all unanswered decisions. Keep durable work records
  outside terminal state. [Socket API](https://herdr.dev/docs/socket-api/)
- **A server restart stops processes.** Layout restoration, native conversation
  resume and experimental live handoff have different guarantees. A disconnected
  viewer is not a restarted worker. [Restore model](https://herdr.dev/docs/session-state/)
- **Herdr owns its terminals.** It can run inside an outer tmux, but does not detect
  agents hidden inside tmux started in a Herdr pane. It does not document adopting
  arbitrary existing cmux/tmux workers. Preserve Mac cmux/tmux and VPS tmux workflows
  while testing this alternative. [Detection boundary](https://herdr.dev/docs/agents/)
- **It is not an isolation boundary.** Plugins run with the user's permissions;
  VM/container wrappers are separate. Sandbox selection remains independent.
  [Plugin trust model](https://herdr.dev/docs/plugins/)

### Telegram and mobile extensions

[permgps/herdr-telegram-agents](https://github.com/permgps/herdr-telegram-agents)
is MIT-licensed and documents per-agent topics, two-way messages, question buttons,
file delivery and persistent topic mappings. Its README reports Mac/Linux end-to-end
verification, but this review did not reproduce it. It is a separate, much smaller
project than Herdr; do not transfer Herdr's maturity claim to the plugin.

The plugin primarily connects the owner directly to an agent. That differs from
workers first asking an orchestrator, which escalates only owner decisions.
Its [behavior documentation](https://github.com/permgps/herdr-telegram-agents/blob/main/docs/behaviour.md)
also records in-memory turn tracking and ambiguous transcript selection when two
agents share a directory. Topic recovery is useful, but not proof of durable
question/answer delivery. Check current code before relying on these limitations.
Do not run competing pollers against the existing Telegram bot during a pilot.

[Moshi documents Herdr phone integration](https://getmoshi.app/docs/herdr), including
workspace selection and agent-event navigation. It is a separate client with
[free and paid tiers](https://getmoshi.app/pricing), not a free native Tila app.
Phone terminal access can reduce urgency for a custom terminal renderer; structured
ideas, decisions and project management still need their own acceptance criteria.

### Resulting architecture choice

Pilot a pinned Herdr release behind a small execution adapter. Keep workflow state
independent of Herdr pane IDs. If it passes, reuse its process supervision and SSH
transport rather than building equivalent daemon internals. A lightweight connector
may still be needed for outbound HTTPS delivery to Cloudflare. Iroh/Mosh and a
custom native terminal are deferred until a measured transport gap requires them.
Do not fork Herdr or commit to its Cloud service as part of this evaluation.

## 3. First milestone and order

```text
source development + runtime pilot
  -> native project credentials
  -> durable assignments, questions and cursor recovery
  -> one orchestrator / workers in a live project
  -> native clients and additional topologies
```

The first live workflow must meet all five conditions:

1. An orchestrator assigns work to a worker on Mac or VPS with a stable attempt ID.
2. A worker asks after accepting; the orchestrator gets the actual question and
   answers it or escalates to the owner without reading a terminal picker.
3. Restart/reconnect presents unresolved work, with duplicate-safe delivery and
   stale-session rejection. An observed notification never marks work completed.
4. Workers continue when a viewer disconnects; Mac cmux/tmux and VPS tmux entry
   points work. Record any runtime migration instead of claiming existing adoption.
5. Host, server, protocol and adapter revisions are recorded. No source change
   silently alters an already-deployed host; no runtime update silently kills work.

## 4. Existing issue dispositions — GitHub review 2026-10-12

Status below is GitHub issue state, not a claim of production activation. Links
provide the source of each disposition. The old replacement drafts for closed
issues have been retired; remaining product work has explicit ownership.

### Completed foundations

| Issue(s) / observed state | Reuse and remaining boundary |
|---|---|
| [#184](https://github.com/davebream/tila/issues/184), [#218](https://github.com/davebream/tila/pull/218) — closed / merged | Canonical memberships, roles, audit and last-owner protection remain authoritative. Existing projects migrated to hybrid; new projects default to explicit. No second UI roster. |
| [#179](https://github.com/davebream/tila/issues/179), [#180](https://github.com/davebream/tila/issues/180), [#181](https://github.com/davebream/tila/issues/181), [#190](https://github.com/davebream/tila/issues/190), [#195](https://github.com/davebream/tila/issues/195) — closed | Participant identity, durable cursors/handoffs, client lifecycle and addressed signals are foundations. #283 owns native conversation delivery; #303/#304 add assignment/attempt/question semantics. Do not rewrite #190 as a new umbrella or reimplement #181. |
| [#182](https://github.com/davebream/tila/issues/182), [#183](https://github.com/davebream/tila/issues/183), [#185](https://github.com/davebream/tila/issues/185), [#186](https://github.com/davebream/tila/issues/186), [#187](https://github.com/davebream/tila/issues/187), [#191](https://github.com/davebream/tila/issues/191) — closed | OIDC policy, role ceilings, service/capability credentials, token providers, live authorization and access decoupling are delivered foundations. Native key-only onboarding and auth retirement remain separate future migrations. |
| [#102](https://github.com/davebream/tila/issues/102), [#173](https://github.com/davebream/tila/issues/173), [#174](https://github.com/davebream/tila/issues/174), [#175](https://github.com/davebream/tila/issues/175), [#176](https://github.com/davebream/tila/issues/176), [#177](https://github.com/davebream/tila/issues/177), [#188](https://github.com/davebream/tila/issues/188) — closed | Preserve membership/credential UI, immutable artifact revisions, lifecycle/recovery, history and provenance/reviews. #173 no longer awaits closure. Individual history views remain read-only; the whole dashboard is not. |
| [#178](https://github.com/davebream/tila/issues/178), [#189](https://github.com/davebream/tila/issues/189), [#192](https://github.com/davebream/tila/issues/192), [#193](https://github.com/davebream/tila/issues/193) — closed | Reuse CLI contracts, compact MCP workflow tools, full backup/recovery and benchmark harness. Configuration export (#299) does not replace #192; #194 measures product use rather than restating benchmark claims. |

### Current product delivery

The [settings/lifecycle contract](02-ARCHITECTURE.md#section-14-editable-settings-and-entity-lifecycle-contract-293)
is the reference for editor coverage, current permissions and future API gaps.

| Issue(s) / observed state | Ownership and dependency boundary |
|---|---|
| [#292](https://github.com/davebream/tila/issues/292), [#293](https://github.com/davebream/tila/issues/293) — open | Product epic and this documentation contract. Definitions, stable identity, durable work, runtime observations and evidence are distinct; server state is authoritative. |
| [#294](https://github.com/davebream/tila/issues/294), [#295](https://github.com/davebream/tila/issues/295) — closed | Lease/presence display and query-failure truth are completed prerequisites. Preserve their regression coverage; unavailable must not become empty/offline. |
| [#300](https://github.com/davebream/tila/issues/300) — delivered | Type catalogs independent of result rows (declared, undeclared, unknown, with scoped counts), optional `presentation` schema keys, keyset cursors for tasks and records, scoped paged unified search, and schema-aware task and record views. See architecture §14.7–§14.8. |
| [#297](https://github.com/davebream/tila/issues/297) — delivered | Settings › Definitions drafts, reviews (typed preview with impact counts), applies against the reviewed revision, rebases after a conflict and restores history for every definition section, without a local file. See architecture §14.2. |
| [#298](https://github.com/davebream/tila/issues/298) — delivered | Every project setting outside the definition editor has a browser path with the same rules as CLI and MCP: agents, rooms and signal groups (revision-checked edits, archive with binding release, profile selection at the next attach) and access settings (repository and OIDC policy, service identities, credential issue and rotate, runtime access, project name), with revision preconditions and a write-time last-owner rule (architecture §14.2–§14.4). MCP access tools are read-only. Host-local profile changes wait for #283. |
| [#296](https://github.com/davebream/tila/issues/296), [#299](https://github.com/davebream/tila/issues/299) — open | Typed structured definition input and explicit imports. All ordinary settings need browser paths. |
| [#302](https://github.com/davebream/tila/issues/302) — delivered | Delivery trace read projections and dashboard tracing (message → recipients → trace; signal payload/resource/expiry). Work result reads the linked attempt's explicit result since #303. |
| [#301](https://github.com/davebream/tila/issues/301), [#303](https://github.com/davebream/tila/issues/303), [#304](https://github.com/davebream/tila/issues/304) — delivered | #303 adds attempt control authority, replacement native sessions, captured definition/policy revisions, owner-filtered recovery, corrective-work links and attempt/result projections (architecture "Attempt control authority", "Session replacement, revisions and recovery queries", "Corrections and result projections"). #304 correlates questions/decisions with attempts. #301's runtime projection (`GET /runtime-view`) joins DO bindings with D1 runs, enrollments and presence, and now lists the current participant's unfinished attempts. |
| [#305](https://github.com/davebream/tila/issues/305) — open | Browser work actions over the shared attempt and decision APIs. |
| [#306](https://github.com/davebream/tila/issues/306), [#307](https://github.com/davebream/tila/issues/307), [#308](https://github.com/davebream/tila/issues/308), [#283](https://github.com/davebream/tila/issues/283), [#194](https://github.com/davebream/tila/issues/194) — open | Navigation/attention, operational readiness, three-scenario validation, live native transport and measured dogfooding retain distinct owners. #307 does not authorize silent production credential rotation; #308 cannot substitute fixtures for #283 live proof. |

## 5. Remaining boundaries and proposed #194 alignment

These are ownership notes and one proposed issue amendment, not new implementation
claims or requests to reopen closed issues.

| Work | Owner / boundary |
|---|---|
| Runtime evaluation and native restoration | #283, including pinned Herdr adapter proof and isolated account/host tests; no custom supervisor or live bot takeover implied. |
| Durable assignments, attempts, results, questions and decisions | Delivered by #303/#304 on the managed queue; generic task/runtime APIs are preserved. Live multi-host proof stays with #283 and #308. |
| Key-only auth and standalone local persistence retirement | Separate future migration work; inventory clients/data/ownership and prove export/recovery before any removal. No retirement is part of #292/#293. |
| Configuration editors/import/export | #296–#299; one server authority, explicit revisions, per-resource permission checks and non-secret references. No Git/file synchronization. |
| Product evidence | #308 executes S1–S3 and feeds #194; record failures, setup/diagnosis/recovery cost and exact evidence provenance. |

### Proposed replacement positioning for #194 — not applied to GitHub

#194 currently requires documentation to say Tila does not launch agents, assign
work or schedule execution. That blanket exclusion conflicts with amended
Decisions §0 and #292's first orchestrator/worker workflow. Preserve #194's measured
case-study ownership and evidence requirements; replace that exclusion with:

> Tila is one self-hosted development-management product with a reusable shared
> state and coordination core. Its first workflow assigns durable work to an
> orchestrator and workers, correlates questions and explicit results, and uses
> supported host adapters for execution. Runtime/process supervision and provider
> retries remain behind the host boundary; Tila does not infer completion from
> terminal state or promise unsupported adapter operations. Generic scheduling,
> additional topologies and native clients are later work.

Keep the predeclared scenario/evaluation rubric, non-secret reproducible evidence,
failures and limitations, and measured operator effort for setup, diagnosis and
recovery. Feed the three #292 journeys and #283 live evidence into that case study.
Public promotion is not a gate on shipping the settings contract. This proposal
does not silently change #194's published scope or mark its evidence complete.

## 6. Development, pinning and repository policy

| Context | Rule |
|---|---|
| Editing in this repo | Source CLI/MCP/Worker/UI; no npm release between edits |
| CI and releases | Preserve production builds, typechecks, public version lockstep and bundle tests |
| Installed host/server | Pin immutable SHA/release, record build identity, update explicitly |
| Native clients later | Negotiate protocol capabilities; durable cursors and idempotent outboxes |
| Git workflow | Existing `pr` policy remains; public visibility and branch policy are separate decisions |

Do not infer a branch-policy change from repository stars or a request to reduce
ceremony. Release/distribution polish can wait while correctness checks continue.
This reset changes direction and development entry points; it does not implement
or deploy the future auth, host, orchestration or persistence migrations.

## #283 delivery ownership and remaining gates (reviewed 2026-10-12)

| Slice | Implementation owner | Current boundary |
|---|---|---|
| Identity / profiles | schemas, D1, SQLite bindings, SDK/CLI | [PR #285 merged](https://github.com/davebream/tila/pull/285); current authority checks remain required |
| Durable conversations | SQLite/DO, Worker, SDK/CLI/MCP | [PR #286 merged](https://github.com/davebream/tila/pull/286); durable rooms/mailboxes |
| Standalone connector | connector, client lifecycle, CLI | [PR #287 merged](https://github.com/davebream/tila/pull/287); native request fixtures pass on macOS/Linux |
| Herdr 0.9.3 | connector observation adapter and plugin | [PR #288 merged](https://github.com/davebream/tila/pull/288); status available, registration/open deliberately unsupported |
| Dashboard / acceptance | UI plus shared history API; repository maintainer owns live acceptance | [PR #289 merged](https://github.com/davebream/tila/pull/289); live multi-account gates remain open |

The required two Claude accounts and plain Codex coordinator, both cross-host
directions, Mac outage, busy drafts, occupant replacement/reconnect and unattended
native transcript restoration have **not** passed. The selected macOS profiles
now verify against native account metadata, including distinct Claude accounts.
Linux SSH access, account readiness and read-only native transport probes now pass.
Full cross-host routing and native session acceptance remain outstanding. Herdr
activation and #283 closure remain blocked on those gates; no process-supervisor
work is implied. Versioned evidence distinguishes fixtures, isolated runtime probes
and actual live results. Do not add `Closes #283` until every live gate passes.
