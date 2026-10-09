# tila — Active Roadmap

Updated 2026-09-20 against `a294fee1` and the 19 open issues listed below.
This replaces the earlier version-number roadmap; its history remains in git.
Issue dispositions and replacement bodies here are **drafts, not posted changes**.

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
evaluation/plugin; dashboard and distributed acceptance. All five slices have
stacked PRs, with the dashboard and standalone connector implemented. Herdr
registration/open and authenticated native restoration remain unfinished;
authentication-boundary changes remain held for explicit review. Only the final
change may close #283 after live Mac/Linux acceptance with the two independent
Claude accounts and plain Codex coordinator selected on 2026-10-09. Fixture results
do not satisfy those live gates. Task assignments, attempts and durable questions
retain separate roadmap ownership.

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

## 4. Existing issue dispositions

The membership implementation in #184 was merged by #218. Keep it closed and keep
its schema, role model, audit and last-owner protections. Existing projects migrated
to hybrid mode; new projects default to explicit. Native key principals are still
missing, and full bootstrap tokens still carry owner access.

### Workflow foundation

| Issue | Draft disposition |
|---|---|
| #190 | Rewrite as the first orchestrator/worker umbrella; remove the blanket exclusion of execution |
| #180 | Keep priority: durable cursors and handoffs tied to pending-work recovery; drop local parity requirement |
| #195 | Keep priority: direct participant addressing/acknowledgement first; defer group/broadcast complexity |
| #181 | Adapt to runtime/provider session lifecycle behind one host boundary; evaluate Herdr first |
| #189 | Narrow MCP tools to the first complete workflow; defer broad surface polish |

### Auth simplification

| Issue | Draft disposition |
|---|---|
| #191 | Complete the existing access-decoupling contract: separate Actions identity, enforce live credential ceilings, preserve bootstrap authority, and unify browser/bearer membership. Keep auth retirement separate. |
| #185 | Scoped service identities, capability credentials, namespace restrictions, rotation, revocation and workload exchange |
| #187 | Completed fail-closed permission revalidation; preserve these checks while current auth remains supported |
| #186 | Refreshable SDK token providers, scoped OIDC workload exchange, and compatible token-bound DPoP verification |
| #102 | Completed owner membership/credential panel; preserve access for explicit owners without App installations |

### Artifact and distribution work

| Issue | Draft disposition |
|---|---|
| #173 | All four implementation slices merged; parent epic tracking still awaits closure |
| #174 | Implemented: journal enrichment ([#221](https://github.com/davebream/tila/pull/221)) and explicit lineages, numbered immutable revisions, and commit-record recovery ([#228](https://github.com/davebream/tila/pull/228)) |
| #175 | Implemented: history/meta/restore across HTTP, SDK, CLI, and embedded backends, plus read-only MCP history ([#230](https://github.com/davebream/tila/pull/230)) |
| #176 | Implemented: version-aware retention, protected live heads, durable deletion recovery, and exemption from the legacy R2 backstop ([#231](https://github.com/davebream/tila/pull/231)); the prerequisite for public version API documentation is satisfied |
| #177 | Implemented: read-only, paginated version history and revision navigation in the artifact drawer ([#237](https://github.com/davebream/tila/pull/237)) |
| #188 | Implement immutable producer provenance, explicit writer reviews, and opt-in trusted-reference task transitions; preserve the read-only UI |
| #178 | Split useful CLI JSON contract from binary packaging/signing polish; defer the latter |

### Evidence and positioning

| Issue | Draft disposition |
|---|---|
| #194 | Replace public case-study prerequisite with first-project migration and acceptance evidence |
| #193 | Implemented: `packages/bench` harness with in-process CI smoke, local and deployed http tiers, soak mode; baselines in `docs/benchmarks/` |

## 5. Copyable issue drafts

These are bounded replacement/new-issue drafts. Check duplicates and current branch
ownership before publication. The acceptance criteria here do not close an issue.

### Replace #190 — first orchestrator and workers

Build one complete flow: assignment, worker question, orchestrator answer or owner
escalation, explicit result, restart recovery. Reuse core identities, journal,
signals and memberships. Tasks, attempts and provider sessions must be distinct.
Start with one topology; allow future policies without inventing a generic topology
language now. Depends on the runtime evaluation, #185, #180, #195 and #181.
Acceptance is the five-condition matrix in §3, including Mac/VPS execution.

### #191 — complete the current authorization contract

The linked implementations (#182–#187, #95 and #102) are closed. The remaining
composition fixes separate GitHub Actions from its triggering human, enforce
repository policy on issued workload credentials, reserve root operations to
bootstrap/infra credentials, and share canonical membership admission across
browser and bearer access. Migration 0029 and the authorization-version cutover
are documented in the GitHub auth guide. Close the epic only after regression
and runtime validation, security review, and confirmed integration into main.

### Future follow-up — project keys and GitHub auth retirement

Key-only provisioning/onboarding and removal of GitHub/OIDC routes, secrets and
UI are separate future work. Migrate existing ownership first, preserve a
recoverable owner, and fail closed on revoked access. The current compatibility
fixes do not retire any authentication method or delete canonical memberships.

### #185 — scoped service accounts and capability credentials

Deliver the broader integration contract: stable project service principals with
canonical memberships; explicit capability and role ceilings; task-type and record
namespace restrictions; expiring, rotatable and revocable credential versions;
short-lived GitHub Actions and generic OIDC workload exchange; and preserved DPoP
binding. Revalidate current D1 authority on every request, before cached responses
or retry replay. Keep process participants separate from authentication identities.

Maintain existing GitHub authentication, human-session compatibility and legacy
`full` keys. Deprecate new legacy issuance without scheduling removal. Provide SDK,
CLI and owner token-management APIs for #102; its token panel stays separate. Apply
the backward-compatible D1 migration before deploying the Worker or clients and
leave authentication-boundary changes for explicit merge/deployment review.

### Adapt #181 — runtime and provider lifecycle boundary

Record host, runtime occupant and native provider session separately from the Tila
participant and attempt. Use the Herdr pilot to choose the smallest adapter that
supports launch, observation, reconnect and replacement. Do not derive completed
work solely from screen state. Test stale occupants and both Mac↔VPS directions;
retain a terminal-independent service contract. One provider/runtime combination
first, with unsupported combinations reported explicitly.

### Replace #194 — first-project migration evidence

Move one active project's orchestrator/worker exchange to the chosen runtime and
Tila contracts incrementally. Record what existing tooling is retired, what remains,
and its rollback path. Prove unresolved questions survive cold start, owner replies
reach the correct attempt, and the VPS continues without the Mac. Use an isolated
Telegram bot/group for integration tests before changing a live routing owner.
Public promotion and broad performance comparisons are not acceptance requirements.

### New — evaluate Herdr and its Telegram extension

Compare a pinned Herdr build and pinned Telegram plugin with the first milestone.
Use isolated state and fixture workspaces; no live bot takeover. Test Mac cmux/tmux
as outer terminals, VPS tmux, disconnect, process replacement, restart, duplicate
prompts and mixed client/server capabilities. Check stale question buttons and two
same-directory sessions. Separate direct owner control from orchestrator escalation.
Record exact versions, pass/fail evidence and the smallest remaining adapter. Stop
short of a fork, native client or custom supervisor implementation.

### New — durable attempts and assignments

Add an attempt identity independent of task and provider session. Persist assignment,
acceptance, cancellation and explicit result with idempotency keys. Require current
participant/fence before accepting a result. Test retries, ambiguous delivery and
replacement sessions; a second attempt must not inherit the first one's authority.
Runtime status may inform the UI but cannot declare domain completion.

### New — durable worker questions and decisions

Persist question text, question ID, task/attempt, requesting participant and answer
correlation. Support several questions after acceptance and orchestrator-first
routing, with owner escalation explicit. Durable pending queries plus cursor replay
must recover offline answers. Reject stale/mismatched replies and make duplicate
submission harmless. CLI, MCP and later native clients share the same lifecycle.

### New — retire standalone local persistence safely

Inventory public local entry points, data export/restore and compatibility consumers.
Provide a verified migration to Cloudflare before removing supported local commands,
SDK/MCP entry points and packaging. Keep `ops-sqlite`, local fixtures/probes and
execution caches where still used. Remove redundant parity/distribution checks only
with their retired surface, not before. No silent deletion of local data.

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

## #283 delivery ownership and remaining gates (2026-10-09)

| Slice | Implementation owner | Current boundary |
|---|---|---|
| Identity / profiles | schemas, D1, SQLite bindings, SDK/CLI | PR #285; authentication review hold |
| Durable conversations | SQLite/DO, Worker, SDK/CLI/MCP | PR #286; stacked behind identity |
| Standalone connector | connector, client lifecycle, CLI | PR #287; native request fixtures pass on macOS/Linux |
| Herdr 0.9.3 | connector observation adapter and plugin | PR #288; status available, registration/open deliberately unsupported |
| Dashboard / acceptance | UI plus shared history API; repository maintainer owns live acceptance | Dashboard implemented on the stack; live multi-account gates remain open |

The required two Claude accounts and plain Codex coordinator, both cross-host
directions, Mac outage, busy drafts, occupant replacement/reconnect and unattended
native transcript restoration have **not** passed. The selected macOS profiles
now verify against native account metadata, including distinct Claude accounts.
A usable Linux test-host login remains outstanding. Herdr
activation and #283 closure remain blocked on those gates; no process-supervisor
work is implied. Versioned evidence distinguishes fixtures, isolated runtime probes
and actual live results. Do not add `Closes #283` until every live gate passes.
