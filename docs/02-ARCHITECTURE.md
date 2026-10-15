# tila — Technical Architecture

> The technical specification. Detailed enough that an autopilot can implement against it without inventing things. Reads top to bottom; subsections reference each other but each section is meaningful on its own.

## Direction and implementation status — v0.10.0 (2026-10-14)

tila is one self-hosted development-management product with a reusable
state-and-coordination core. The existing sections include implemented contracts
and historical design rationale. [Decisions §0](01-DECISIONS.md#0-name-and-scope--amended-2026-09-20) and
[the active roadmap](03-ROADMAP.md) and the [settings/lifecycle contract](#section-14-editable-settings-and-entity-lifecycle-contract-293) take precedence for new work.

The current release includes schema-defined tasks and records, artifacts,
claims/fences, journal cursors and handoffs, conversations, and a managed work queue.
The queue records durable assignments, attempts, questions/decisions, and explicit
results. Tasks, work attempts, authenticated runs, and replaceable provider sessions
are distinct. See the [release and upgrade notes](../CHANGELOG.md#0100---2026-10-14)
and the assignment/attempt/question contracts later in this document.

The first live workflow targets one orchestrator coordinating workers across
Mac/Linux hosts. Cloudflare is the shared project-state authority. Host runtimes
own processes, terminals, and model retries; tila owns durable assignment and
decision semantics, work retry policy, and supported host-adapter contracts.
The standalone connector and SDK execution-adapter contracts are implemented;
live cross-host recovery remains unverified. Herdr is under evaluation, with
registration and cold opening still unsupported. A new supervisor, generic
sandbox scheduler, later orchestration topologies, and native Mac/iPhone clients
are not delivered features. Runtime evaluation and remaining acceptance are tracked
in [#283](https://github.com/davebream/tila/issues/283) and
[#308](https://github.com/davebream/tila/issues/308); measured product dogfooding
remains [#194](https://github.com/davebream/tila/issues/194).

Keys bound to native principals and explicit memberships are the target auth path.
The membership foundation from #184 / #218 is implemented. GitHub App/session auth
and standalone local persistence remain implemented compatibility; key-only
onboarding and auth/local-mode retirement have not shipped. Local mode supports a
subset of the service. Remote MCP requires a managed project run or supported
session mapping. Explicit local MCP uses embedded SQLite with `TILA_MODE=local`,
`TILA_PROJECT_ID`, and absolute `TILA_DB_PATH` and `TILA_ARTIFACTS_PATH` paths; it
supports the local subset and cannot be combined with remote credentials or run
bindings. Preserve current compatibility until migration/export and access tests
cover each removal.

Earlier v0.1/v0.2 sketches are historical design context, not release promises.
Shipped behavior below is reconciled with v0.10.0; alternatives without an
implementation remain unscheduled ideas. The active roadmap and Decisions §0
govern future scope rather than the old version-number sequence. Neither local
fixtures nor the existence of an API establishes live multi-host acceptance or
the comparative study results required by #194.

For development, Wrangler, Bun and tsx use the root source path mappings; Vite reads
schemas from source. Production package exports, declaration builds and packaging
tests remain separate. Deployed hosts must use identifiable immutable revisions.
Client/server API compatibility must be negotiated independently of release versions.

The [distributed agent conversations proposal](distributed-agent-conversations.md)
documents multi-account, cross-host communication and standalone CLI/Herdr
adapter boundaries. PRs #285–#289 are merged; #283 retains unfinished live
acceptance gates. The proposal distinguishes implemented services, isolated probes
and unsupported host operations; it is not proof of live deployment readiness.

---

### Agent identity foundation (#283, slice 1)

D1 runtime rows now optionally pin an agent ID and acting/relay role. A Worker-only
DO request authorizes selection before issuance. The per-project DO owns `agents`
and `agent_bindings`, including binding-epoch high-water marks and immutable
session/profile evidence. Authenticated run context travels separately from
client-shaped identity metadata. Agent routes pass membership, capability and
transfer guards before reaching the DO, and bypass D1 response replay/shared cache.

The shared client-lifecycle package owns local profile resolution and account
checks. CLI and SDK expose registration, binding and inspection; embedded clients
reject these operations explicitly. Rooms, deliveries and the standalone connector
were added by subsequent merged slices (#286/#287); live acceptance remains separate. See the
[conversation specification](distributed-agent-conversations.md#implementation-boundary--issue-283-slice-1).

## Section 0: Implementation stack

The languages, frameworks, and libraries this is built with. Decisions are made; deviations require justification.

### 0.1 Core stack

- **Language:** TypeScript throughout. CLI, Worker, shared schemas, UI bundle. One language eliminates client-server type drift and maximizes Claude Code's effectiveness during AI-assisted implementation.
- **CLI runtime:** Bun (>=1.2). Source is TypeScript; distribution is a static binary per platform via `bun build --compile`. The CLI test script runs Vitest and Bun's local-backend suite. Required Cloudflare runtime tests use `@cloudflare/vitest-plugin` separately.
- **Worker runtime:** Cloudflare Workers (workerd). Same TypeScript source as the CLI; bundled via Wrangler.
- **Package manager:** pnpm for the monorepo (`pnpm install`, workspaces via `pnpm-workspace.yaml`; `packageManager: pnpm@9.15.9`). Bun runs the source CLI and compiles its release binary (`bun build --compile`); pnpm owns workspace management.
- **Monorepo tooling:** Turborepo for task orchestration across packages (matching the maintainer's existing setup).
- **ORM / DB access:** Drizzle for SQL access. In the Worker, `drizzle-orm/durable-sqlite` for the per-project DO (the primary persistence layer) and `drizzle-orm/d1` for the global D1 instance (auth tokens, idempotency). Backend interfaces preserve reuse of the core; the earlier GitHub Issues, Linear, Upstash, and Postgres alternatives are not shipped backends or scheduled milestones. Cloudflare remains the target shared authority under [Decisions §0](01-DECISIONS.md#0-name-and-scope--amended-2026-09-20).
- **HTTP framework in the Worker:** Hono. Route handlers, middleware, error handling.
- **CLI framework:** Citty. The earlier Commander.js fallback and Ink terminal-UI suggestion were design alternatives, not delivered dependencies. Process and terminal supervision belong to host runtimes.
- **R2 / S3 client:** `aws4fetch` in the Worker for minimal bundle size. The CLI does not talk to R2 directly; all artifact ops go through the Worker.
- **Validation:** Zod schemas for every API boundary (Worker endpoints, CLI inputs, schema.toml parsing). Zod is the source of truth; types are derived via `z.infer`. Shared schemas live in a dedicated `packages/schemas` workspace consumed by both the Worker and the CLI.
- **Build:** `bun build --compile` for CLI binaries; Wrangler for the Worker. tsdown is the fallback if Bun's compile gains friction for any specific output target.
- **Local development:** `pnpm dev` runs the Worker via a local `wrangler dev` instance. Iteration loop under 1 second.
- **2026 Cloudflare platform features used by tila:**
  - **Smart Placement** — enabled by default in `wrangler.toml` (`placement = { mode = "smart" }`). Auto-places the Worker close to the DO. Single biggest free latency win.
  - **DO SQLite storage** — GA, 10GB per DO, point-in-time recovery. The primary persistence layer for per-project state (entities, journal, claims, schema history). Replaces the 2024 D1-heavy design.
  - **Workers Analytics Engine** — used for low-cost write-heavy telemetry. Free up to 25M writes/day. Not load-bearing for correctness; degrades gracefully if unavailable.
  - **Tail Workers** — `wrangler tail` for real-time log debugging. Documented in the operational guide.
  - **Cron Triggers** — drives the daily artifact cleanup sweep (`/_internal/sweep`).

### 0.2 Distribution

The CLI ships as multiple artifacts to match how engineers actually install developer tools in 2026. This follows the pattern Claude Code itself uses (which is no accident — it's now the dominant pattern for AI-coding-adjacent CLIs):

- **Pre-built binaries per platform:** GitHub Releases publishes `tila-darwin-arm64`, `tila-darwin-x64`, `tila-linux-x64`, `tila-linux-arm64`, `tila-linux-x64-musl`, `tila-linux-arm64-musl`, `tila-windows-x64.exe`, `tila-windows-arm64.exe`. The musl variants matter for Alpine and other musl-libc distros used in containers.
- **Shell install script:** `curl -fsSL https://github.com/davebream/tila/releases/latest/download/install.sh | sh` detects the platform, verifies SHA-256 checksums, and installs the binary in `~/.tila/bin/` with PATH instructions.
- **PowerShell install script** for Windows: `irm https://github.com/davebream/tila/releases/latest/download/install.ps1 | iex`.
- **Homebrew tap:** `brew install davebream/tap/tila`. Tap updates are published separately.
- **npm with platform-specific optional dependencies:** `npm install -g tila-cli` or `bun add -g tila-cli`. The npm package uses optional per-platform deps (`tila-cli-darwin-arm64`, `tila-cli-linux-x64`, etc.) that resolve to the actual native binary. The installed binary does not invoke Node; this is the same architecture Claude Code uses. Useful for CI environments where adding curl-bash is friction.
- **Linux package repositories:** the earlier `apt`, `dnf`, and `apk` proposal is not delivered or tied to a release milestone. Use the binary or npm channels above.

The binary includes the Bun runtime; exact sizes and checksums are available in
the [published release assets](https://github.com/davebream/tila/releases/tag/v0.10.0).

**Code signing.** Installers verify release-asset SHA-256 checksums; that is distinct
from OS code signing. The earlier macOS notarization and Windows code-signing
proposal is not delivered. macOS binaries remain unsigned and may trigger
Gatekeeper. See [distribution verification](12-INSTALL-DISTRIBUTION.md#compressed-assets-sboms-and-attestations-178)
for current platform limits; no v0.2 signing milestone is implied.

### 0.3 Why Bun + TypeScript

Considered alternatives and the reasoning for each, given the May 2026 landscape:

**Bun + TypeScript (chosen).** The case has gotten stronger over the last six months:

1. **Anthropic acquired Bun in December 2025.** Bun is now the runtime Anthropic is investing in for Claude Code, the Claude Agent SDK, and future AI coding products. The path is paved.
2. **Claude Code itself ships as a Bun-compiled binary.** The patterns that Anthropic optimizes for — single-binary distribution, fast cold starts, cross-platform compilation, signed binaries, installer scripts — are exactly the patterns tila needs. Walking the same path means inheriting that work.
3. **Claude Code is at its absolute best in TypeScript.** The model was effectively trained on this distribution. The Anthropic team has stated this explicitly: TypeScript is the "on-distribution" language for Claude. Other AI-coding CLIs (FactoryAI, OpenCode) made the same choice for the same reason.
4. **Schema sharing is preserved.** Zod schemas live in one workspace, consumed by both the Worker (TypeScript) and the CLI (TypeScript). No codegen layer, no protobuf-style discipline tax, no drift bugs Claude Code will introduce while looking like it's making things work.
5. **Real production data on Bun-compiled CLIs.** A production CLI compiled with Bun came out only ~17% slower than GitHub's Go-compiled `gh` for equivalent operations. For an I/O-bound tool like tila, that gap is invisible (network round trips to the Worker dominate every command).

**Node + TypeScript.** The safe choice. Loses on cold start (200-500ms vs Bun's 20-30ms — and tila commands are typed dozens of times per session) and on distribution (Node version skew is a real support burden; `nvm` is friction for new users; Node's SEA — Single Executable Applications — is still constrained as of mid-2026, CommonJS only, larger binaries). Strong fallback if Bun ever falls over for tila specifically. Source code stays universal TypeScript so the switch is mechanical.

**Rust.** Best raw performance. Best startup. Loses on schema sharing with the Worker (Zod can't be the source of truth across languages; codegen introduces drift), and Claude Code in Rust is meaningfully less productive than in TypeScript in mid-2026 — the model handles Rust well but generates lower-quality idiomatic code and gets ownership semantics wrong more often. OpenAI's path is instructive: they started with TypeScript for rapid development, then migrated to Rust for production performance *later*. That's the right approach for tila too — don't pay the Rust tax upfront for performance you can't reach (the workload is I/O-bound, not CPU-bound).

**Go.** Strong on distribution and compile speed (a Cobra CLI builds in 3-10 seconds clean, sub-second incremental). The pragmatic-compromise candidate. Loses on schema sharing for the same reasons as Rust. Loses on Claude Code productivity — TypeScript still wins, though the gap is smaller than for Rust. Bun gives you Go-shaped distribution without paying the schema-sharing cost.

**Deno.** Nearly interchangeable with Bun in raw capability. Bun's npm ecosystem fluency is slightly ahead, which matters because tila consumes Node-ecosystem libraries (Drizzle, AWS SDK, wrangler shell-outs, validators). Anthropic's investment is in Bun specifically, not Deno. Path-dependency favors Bun.

The selection criteria that decided it: schema sharing with the Worker (preserved by TypeScript), AI assistance quality (maximized by TypeScript on Bun), distribution as static binary (Bun's compile is production-mature in 2026), startup latency (Bun's startup is 5-10x faster than Node's).

### 0.4 Known Bun caveats to manage

Picking Bun is not free. Specific things to watch:

- **Source-map leaks in published packages.** A known Bun bug (open as of April 2026) generates source maps even when `development: false` is set. Anthropic accidentally leaked Claude Code's entire source via this path. Mitigation for tila: CI step that fails the build if `.map` files appear in the output package; explicit `*.map` entry in `.npmignore`. Treat this as a release-engineering invariant, not as something Bun will fix in time.
- **Binary size.** ~50-60MB per platform binary because the Bun runtime is embedded. Acceptable for a developer tool installed once; not acceptable for tools where binary size is a hard constraint.
- **Some npm packages with native deps have edge cases.** Bun's Node compatibility is excellent but not 100%. Avoid native-dep-heavy libraries when alternatives exist. Pin known-good dep versions.
- **Bun's bundler is still evolving.** Use stable APIs only. Keep an eye on the release notes for breaking changes to the `--compile` workflow.
- **Cross-compilation works but watch musl.** Linux glibc and musl (Alpine) are separate targets; both need to be built and tested if you support container deployments.

The fallback strategy: if any of these caveats become blocking, switch the CLI to Node + tsx (or compile to SEA when SEA matures). Source code stays universal TypeScript. The compile pipeline is the only thing that changes.

### 0.5 Stack alignment with the maintainer

This stack uses a Turborepo monorepo, Drizzle ORM, a Hono backend, and Promptfoo testing. The CLI adds Bun as the runtime/build target, Citty as the CLI framework, and Ink for interactive flows.

---

## Section 1: System overview

### 1.1 The layers and their boundaries

These simplified diagrams show CLI persistence paths, not the full product scope.
tila's management workflows and external consumers reuse the coordination core;
the service/host boundary and implementation status are described above.

```
┌─────────────────────────────────────────────────────────────────┐
│          tila workflows and coordination-core consumers         │
│       (humans and agents using tasks, records, and artifacts)     │
└────────────────────────────────┬────────────────────────────────┘
                                 │ uses
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                          tila CLI                                │
│  (primitives: task new/claim/release, artifact put/get, doctor)  │
└────────────────────────────────┬────────────────────────────────┘
                                 │ HTTPS
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│         Cloudflare Worker (tila-<project>, Smart Placement)      │
│                                                                  │
│  ┌──────────────────────────────────────────┐  ┌──────────────┐│
│  │ Project routes (entities, journal,        │  │ Auth & idem  ││
│  │ claims, artifacts) — all routed to DO     │  │ (D1 binding) ││
│  └──────────────────┬───────────────────────┘  └──────┬───────┘│
│                     │                                  │        │
│                     ▼                                  │        │
│  ┌──────────────────────────────────────────┐         │        │
│  │ Artifact upload/download (R2 via aws4fetch)│        │        │
│  └──────────────────┬───────────────────────┘         │        │
└─────────────────────┼───────────────────────────────────┼───────┘
                      │                                   │
                      ▼                                   ▼
        ┌────────────────────────────────┐    ┌──────────────────┐
        │ Durable Object (per-project)    │    │ D1 (global)      │
        │ DO SQLite storage:              │    │ _tokens          │
        │  • entities + relationships     │    │ _idempotency     │
        │  • journal (append-only)        │    │ _projects (meta) │
        │  • _schema_history              │    └──────────────────┘
        │  • claims + fences + presence   │
        └────────────┬────────────────────┘
                     │
                     ▼
              ┌──────────┐
              │    R2    │
              │artifacts │
              │ produced │
              │ sources/ │
              │ indexes/ │
              └──────────┘
```

**Why the layering looks like this:** the Worker is a thin facade that routes to the right backend. Per-project state (entities, journal, claims) lives in one DO per project; this is the 2026-native consolidation that replaces the 2024 D1+DO split. Auth tokens and idempotency keys live in global D1 because they need cross-project scope and lightweight access patterns. Artifacts live in R2 because they're large blobs that benefit from content-addressing and per-prefix lifecycle. The DO can only be reached through a Worker; the Worker is the only writer to R2 (no signed-URL writes in v0.10.0).

**Local path (single machine -- `tila project create --local`):**

Local mode shares CLI commands for supported operations, not full Cloudflare
service coverage. Local facades reject durable conversations, inbox, and dispatch
with `unsupported-capability`; see [local SDK limitations](../packages/sdk/README.md#durable-conversations).

```
┌─────────────────────────────────────────────────────────────────┐
│         Local compatibility workflows and core consumers        │
└────────────────────────────────┬────────────────────────────────┘
                                 │ uses
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                          tila CLI                                │
│       (supported CLI subset; backend resolved at startup)        │
└────────────────────────────────┬────────────────────────────────┘
                                 │ direct call (no HTTP)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                tila-cli: src/local (Bun host)                    │
│                                                                  │
│  ┌──────────────────────────────────────────┐  ┌──────────────┐│
│  │ LocalProject                              │  │LocalArtifact ││
│  │ EntityBackend + CoordinationBackend       │  │Backend       ││
│  │ (bun:sqlite, BEGIN IMMEDIATE, WAL mode)   │  │(filesystem)  ││
│  └──────────────────┬───────────────────────┘  └──────┬───────┘│
│                     │                                  │        │
│                     ▼                                  ▼        │
│  ┌───────────────────────────────┐   ┌─────────────────────────┐│
│  │ @tila/ops-sqlite               │   │ ~/.tila/artifacts/       ││
│  │ (shared ops: entity, coord,    │   │ <org>/<project>/        ││
│  │  artifact, journal, sweep)     │   │ <sha256>.<ext>          ││
│  └───────────────────────────────┘   └─────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │ ~/.tila/<org>/<project>.db            │
              │ (bun:sqlite, WAL mode)                │
              │  • entities + relationships           │
              │  • journal (append-only)              │
              │  • claims + fences + presence         │
              │  • _schema_history                    │
              │  • _idempotency                       │
              └──────────────────────────────────────┘
```

`config.backend` in `.tila/config.toml` is `"cloudflare"` or `"local"`. The CLI resolves the backend at startup in `resolveContext()` -- `"cloudflare"` wires `TilaClient` (HTTP to the Worker), `"local"` wires `LocalProject` + `LocalArtifactBackend` (direct bun:sqlite calls, no network).

### 1.2 The three primitive concepts

tila's data model has exactly three first-class concepts. Conflating them is the most common source of confusion when extending the engine or building a framework on top.

**1. Work units.** Entities that represent units of work — tasks, issues, epics, or whatever a consumer names them. Work units participate in a hierarchy (parent/child relationships declared in `tila.schema.toml`), have claims, status, dependencies between them, gate transitions, and accumulate artifacts and journal events as work progresses. Work units are persisted in the DO SQLite `entities` table (per-project). The public vocabulary is "work unit"; the internal table name remains `entities` for compatibility.

**2. Records.** Typed mutable JSON state addressed by `(type, key)`. Records are schema-validated, fence-protected, revision-tracked, with optional R2 snapshot artifacts. They are not work units: they do not participate in hierarchy, readiness, blockers, or claims (except through fence resource names of the form `record:<type>/<key>`). Records exist for shared coordinated project state such as pipeline configs, service catalogs, agent policies, build matrices, deploy target maps, and framework-specific coordination manifests. The normative specification lives in [`docs/08-RECORDS.md`](08-RECORDS.md); detailed persistence schema, API contract, and CLI surface are documented there.

**3. Artifacts.** Content-addressed blobs stored in R2 with pointer rows in DO SQLite (per-project `artifact_pointers` table). Two flavors with structurally different relationships to work units:
- **Produced artifacts** are emitted by a work unit during work. Plans, designs, reviews, patches, transcripts, lessons. Owned by exactly one producing work unit. Lifecycle determined by retention policy per artifact kind.
- **Source artifacts** are uploaded as project-level inputs. Research documents, external specs, customer transcripts, prior-art references. No producing work unit. Referenced by work units that consult them. Lifecycle is keep-indefinitely by default.

Artifacts of either flavor can reference other artifacts via typed edges (a review references the design it reviews; a plan supersedes an earlier plan; an index points to its entries).

**4. Journal events.** Append-only audit log of meaningful state transitions. Every claim, release, artifact write, record mutation, schema apply, gate transition, signal emission, archive — anything that changes durable state — produces a journal event. Persisted in the per-project DO SQLite `journal` table; immutable after write.

**Client identity.** Every client instance binds `{ principal_id, participant_id, environment }`. The Worker derives the principal from authentication (`token:<uuid>`, `github:<host>:<numeric-user-id>`, or `oidc:<issuer>:<subject>`) and ignores client-supplied principal values. `X-Tila-Participant-Id` is required on authenticated state-changing project requests. Optional `X-Tila-Machine`, repository/worktree/branch/commit, and client headers populate untrusted environment metadata; they never authorize a write or own a claim.

### 1.2a Coordination primitives

Beyond the four data shapes, tila ships five coordination primitives that operate across them:

- **Claims.** First-writer-wins coordination with fencing tokens against any resource name. Used for work-unit claims (`task:T-142`), file-edit locks (`file:src/auth.rb`), record mutations (`record:service/api`), and any other resource the consumer wants to serialize.
- **Gates.** Approval and quality gates that govern work-unit transitions. A work unit cannot leave a state without all required gates being satisfied. Gates emit journal events on satisfaction.
- **Signals.** Lightweight notifications distinct from journal events. Targets are canonical participants, principals, principal-based groups, or the active broadcast audience. Each send snapshots immutable participant deliveries; inboxes and acknowledgements are authorized by the caller's exact principal/participant pair. Display names and environment fields are retained only as audit metadata. Acknowledged deliveries remain through expiry, when the signal and all deliveries are swept together.
- **Presence.** TTL'd machine activity for "who's online and on what."
- **Search.** Lexical full-text search (FTS5) across indexed artifact content. Searchable kinds are declared in `tila.schema.toml`.

The data shapes are what state lives in. The coordination primitives are how agents and humans serialize access to that state.

Three concepts, three relationship tables:

- `entity_relationships` — work unit to work unit (hierarchy, dependencies)
- `entity_artifact_references` — work unit to artifact (referencing source artifacts or other produced artifacts as inputs)
- `artifact_relationships` — artifact to artifact (citations within outputs)

### 1.3 What lives where

| Data | Backend | Notes |
|---|---|---|
| Work unit entities (task, issue, epic, custom types) | DO SQLite (per-project) | Generic `entities` table, JSON `data` column, `schema_version` per row |
| Work-unit-to-work-unit relationships | DO SQLite | `entity_relationships` table, typed edges |
| Work-unit-to-artifact references (source consultation) | DO SQLite | `entity_artifact_references` table |
| Artifact pointers (R2 keys plus metadata) | DO SQLite | `artifact_pointers` table, `resource` is NULL for source artifacts |
| Artifact-to-artifact relationships | DO SQLite | `artifact_relationships` table |
| Records (typed mutable JSON state) | DO SQLite | `records` table keyed by `(type, key)`, plus `record_tags` and `record_revisions`. See [`docs/08-RECORDS.md`](08-RECORDS.md) for full schema. |
| Gates (approval and quality gates on work-unit transitions) | DO SQLite | Gate definitions and satisfaction state per work unit |
| Signals (lightweight notifications) | DO SQLite | Signal emissions, immutable participant deliveries, and principal-based groups |
| Journal events | DO SQLite | Append-only `journal` table |
| Schema history (every schema definition ever applied) | DO SQLite | `_schema_history` table |
| Live claims and leases | DO SQLite | `claims` table — same transaction scope as entities |
| Per-resource fence counters | DO SQLite | `fences` table; monotonic, never decrements |
| Presence (TTL'd machine activity) | DO in-memory + SQLite snapshot | 60-second TTL by default |
| API tokens | D1 (global) | `_tokens` table; cross-project; tokens stored as hashes only |
| GitHub-scoped sessions | D1 (global) | `_sessions` table for browser UI login state |
| Repo allowlist | D1 (global) | `_project_repos` mapping repos to projects for GitHub-scoped auth |
| Idempotency keys | D1 (global) | `_idempotency` table; 24h retention |
| Project metadata | D1 (global) | `_projects` table; maps project slug to DO ID, schema version, creation date |
| Artifact blobs (markdown, JSONL, patches, plans, transcripts, sources, record snapshots) | R2 | Content-addressed by sha256, lifecycle-managed by Worker-driven sweep |
| Artifact metadata | R2 object metadata + DO pointer rows | Redundant on purpose |
| Worker code | Cloudflare Workers platform | Versioned via `wrangler deploy` |
| Per-project config (worker URL, account id, etc.) | `.tila/config.toml` in project repo | Committed |
| API token | `.tila/.env` in project repo | Gitignored |

On the local path (`tila project create --local`), all per-project DO SQLite state and the global D1 idempotency table collapse into a single local bun:sqlite database at `~/.tila/<org>/<project>.db`; artifact blobs live on the local filesystem at `~/.tila/artifacts/<org>/<project>/<sha256>.<ext>`. Schema and operations are identical to the Cloudflare path; only the connection and transaction layer differs.

### 1.4 What flows where

**Read path** (e.g., `tila task show T-142`):
1. CLI reads `.tila/config.toml` to find the Worker URL.
2. CLI makes HTTPS GET to `<worker>/tasks/T-142` with API token in header.
3. Worker validates the token against D1 `_tokens` (cached in Worker memory after first read; ~1ms hit).
4. Worker forwards to the project's DO via `env.PROJECT.get(id).fetch(req)`.
5. DO reads entity row and any live claim in a single SQLite transaction (~1ms).
6. DO returns merged JSON.
7. Worker returns JSON to CLI.
8. CLI renders.

Total Worker → response latency was estimated at ~5-15ms when the DO is warm (Smart Placement co-locates them), with a cold DO adding ~50ms one-time startup. Measured values for the deployed path (`claims-uncontended`, `cold-start` scenarios) and for the DO-only cost (`inproc` tier) are in [docs/benchmarks/BASELINE.md](benchmarks/BASELINE.md); the step costs above remain the model, not measurements.

**Write path** (e.g., `tila task claim T-142`):
1. CLI makes HTTPS POST to `<worker>/acquire`.
2. Worker validates token, forwards to the project's DO.
3. DO runs a single SQLite transaction:
   - Read current claim for `task:T-142`.
   - If valid (not expired, not held by self), return 409.
   - Increment fence counter (`UPDATE fences SET current_fence = current_fence + 1`).
   - Insert into `claims`.
   - Append `task.claimed` row to `journal`.
4. DO returns `{ ok: true, fence: N }`. Transaction commit guarantees all-or-nothing.
5. Worker returns to CLI.
6. CLI receives and proceeds.

The 2024 design required Worker-coordinated writes across D1 (journal) and DO (claim). The DO-first design collapses both into one transaction.

**Artifact upload path** (e.g., `tila artifact put plan.md --task=T-142 --fence=42`):
1. CLI reads file, computes sha256.
2. CLI makes HTTPS PUT to `<worker>/artifacts/<key>` with body and metadata headers.
3. Worker validates the fence against current claim in DO (one DO round-trip).
4. Worker PUTs to R2 with `If-None-Match: *` (refuses overwrite) and `x-amz-meta-tila-*` headers.
5. On R2 success, Worker makes a second DO call to write `artifact.produced` to the journal and insert the `artifact_pointers` row.
6. CLI receives R2 key reference.

Note: the artifact path *is* a cross-backend operation (Worker → R2, Worker → DO). The DO transaction is journal-and-pointer-together. R2 write is durable independently. If the second DO call fails after R2 succeeded, the blob is orphaned but recoverable via the `tila doctor --reconcile` command, which walks R2 and reconciles missing pointer rows from R2 object metadata. See §3a.7 for the full cross-backend ordering rules.

### 1.5 Shared SQLite operations layer

`@tila/ops-sqlite` extracts the business-logic operations from the Durable Object code into a platform-agnostic package with zero Cloudflare Workers types. Both the Worker's Durable Object (`packages/worker/src/do`, DO path) and `@tila/backend-embedded` (local path) import from `@tila/ops-sqlite` for all entity, coordination, artifact, journal, and sweep logic.

The ops package uses `BaseSQLiteDatabase` generic (from `drizzle-orm/sqlite-core`) instead of the DO-specific `DrizzleSqliteDODatabase`, making it runtime-agnostic. The Drizzle schema, migrations (0001-0004), and all query modules live in `@tila/ops-sqlite`. The hosts provide only the connection layer (DO's `blockConcurrencyWhile` + `this.ctx.storage.sql` vs. bun:sqlite's `new Database()` + `PRAGMA` initialization) and transaction semantics (DO implicit single-threading vs. `BEGIN IMMEDIATE` explicit locking).

Package dependency flow:

```
schemas -> core -> ops-sqlite -> worker/src/do    (Cloudflare path)
                              -> backend-embedded (local path)
```

Zero business-logic duplication between the two backends. Differences are confined to the connection, transaction, and migration-runner layers.

### 1.6 SQLite correctness model (local path)

The Cloudflare path serializes writes via the Durable Object's single-threaded execution model: only one request runs at a time within a DO. The local path cannot rely on this -- multiple CLI processes may access the same SQLite database concurrently. Instead, the local path uses SQLite's built-in locking mechanisms to achieve equivalent serialization.

**Three non-negotiable PRAGMAs** applied atomically at connection open (single `db.exec()` call):

1. `PRAGMA journal_mode=WAL` -- enables concurrent readers while a writer holds the write lock. Without WAL, readers block writers and vice versa. WAL separates read and write paths so agents reading state do not block agents writing claims.

2. `PRAGMA busy_timeout=5000` -- SQLite waits up to 5 seconds for a write lock before returning `SQLITE_BUSY`. Eliminates the need for application-layer polling in most contention scenarios. The 5-second window covers typical tila write transactions, which the `embedded` benchmark tier measures at well under a millisecond per op ([docs/benchmarks/BASELINE.md](benchmarks/BASELINE.md)).

3. `PRAGMA foreign_keys=ON` -- enforces referential integrity. Disabled by default in SQLite; must be set per connection.

**`BEGIN IMMEDIATE` for all write transactions.** Every write path in `LocalProject` calls `db.transaction(fn, { behavior: 'immediate' })`. This acquires the write lock at transaction start, not at first write statement -- equivalent to the DO's single-thread serialization. Two concurrent processes cannot both read the `fences` table and both believe they hold a valid claim. The write lock is released on `COMMIT` or `ROLLBACK`.

**Application-layer retry.** After `busy_timeout` expires, `SQLITE_BUSY` propagates to the application. `withBusyRetry` (max 5 attempts, exponential backoff with jitter: `2^attempt * 50ms + random(0..50ms)`) handles the residual contention window. This is a belt-and-suspenders layer -- `busy_timeout` handles the common case; `withBusyRetry` handles the pathological case (a writer monopolizing the DB longer than 5 seconds).

**Fencing tokens** are monotonically incrementing integers, same as the DO path. First-writer-wins is preserved: stale fence -> `FenceError` from `@tila/core`'s `assertFence`.

### 1.6a Embedded local persistence (CLI + Node SDK)

Local mode is implemented by `@tila/backend-embedded` — a **runtime-agnostic** embedded SQLite core (`EmbeddedProject` + `EmbeddedArtifactBackend` + a `BlobStore` seam) that contains no `bun:*` / `node:*` runtime imports. Two host wrappers inject the concrete driver and primitives:

- `packages/cli/src/local` — the **Bun** host (`bun:sqlite`), built into the `tila` CLI.
- `tila-sdk/local` — the **plain-Node** host (`better-sqlite3` + `node:fs`), used by the TypeScript SDK (`createTila({ backend: "local" })` / `createTilaLocal`).

Local mode therefore now runs under **plain Node**, not just Bun. There is no ADR file for this seam in the repo; this section is the canonical description.

**Cross-runtime schema identity.** Both hosts run the *same* `EMBEDDED_MIGRATIONS` from `@tila/backend-embedded`, which reuse the canonical `MIGRATIONS` SQL / run-functions from `@tila/ops-sqlite` *verbatim* (not a copy that can drift). Both apply the same ordered `EMBEDDED_PRAGMAS` (`busy_timeout=5000`, then `journal_mode=WAL`, then `foreign_keys=ON`) and the same network-filesystem matcher. The result: a Bun (CLI)-created DB file and a Node (SDK)-created DB file are byte-for-byte schema-identical, so **a DB file is portable between the CLI and a Node SDK consumer** (proven by a cross-runtime interop test: bun writes, node reads). Applied versions are tracked in the **`_migrations` table**, not `PRAGMA user_version`.

**Schema versioning & cross-version compatibility.** The embedded migration set reuses every canonical migration except v21 (`_do_idempotency`, which is DO-only), including v15 (journal archive watermark), v23 (canonical identity), and v24 (project transfer lock). It adds the embedded-only idempotency table at version `1000`. Sharing the watermark and transfer state is required for cloud/local backup compatibility and for maintenance triggers to block every SQLite mutation during a snapshot. Because both hosts share one migration set keyed by version in `_migrations`, a CLI and an SDK of different releases apply only missing versions in ascending order.

**Idempotency is accepted but not honored locally — a known divergence.** The embedded `_idempotency` table (v`1000`) and `EmbeddedProject.checkIdempotency` / `storeIdempotency` exist, but no local resource adapter currently calls them: in local mode an `idempotency_key` (e.g. on `claims.acquire`) is **accepted but not honored**. Remote dedups retries via D1; local relies on **primary-key-level dedup** instead — a retried create of an existing id fails rather than duplicating. Full idempotency wiring is single-machine-low-risk and remains **remote-only**; the table + methods are kept available-but-unwired so a future wiring has the storage already in place. (Mirrored in the SDK README local-divergence list.)

**Pre-feature local DB upgrade — a known limitation.** Local DBs created by the **old / pre-feature** CLI (which used the legacy `ALL_LOCAL_MIGRATIONS` with a *divergent* v1 and v5) do **not** fully upgrade to the canonical embedded schema. Because v1 and v5 are already recorded in that file's `_migrations`, the runner treats them as applied and skips them — so the `artifact_relationships.target` column and the canonical v5 `idx_er_to_id_type` index stay absent. (v14 *does* apply retroactively, since it was never recorded.) A partial in-place heal is intentionally **not** attempted: it cannot reproduce the canonical NOT-NULL primary-key `target` column, so it would yield a subtly non-identical schema — worse than a clean recreate. **Remedy:** recreate the local DB via `tila project create --local`. Local mode is single-machine, disposable dev/edge state, so recreating is cheap and safe.

**Concurrency limits.** Local mode is **single-machine** only. Concurrent writers (e.g. two CLI processes, or a CLI plus a Node MCP server on the same file) serialize via WAL + a 5 s `busy_timeout` + the `withBusyRetry` application-layer retry loop (proven by a cross-runtime concurrency test where a Bun and a Node writer contend on one file). A **network filesystem is rejected at connect** by `assertLocalFilesystem`, because SQLite's POSIX advisory locking is unreliable there: on Linux it parses `/proc/self/mounts` (longest-enclosing-mount match against `nfs`/`nfs4`/`cifs`/`smb`/`smbfs`); on macOS it shells out to `stat -f %T` (matching `smbfs`/`nfs`/`afpfs`/`webdavfs` substrings). On **Windows the guard is a no-op** (no `/proc`, no `stat -f`). Detection *failures* (unreadable mount table, missing `stat`, sandboxes) are treated as "can't tell" and skip the check rather than hard-failing.

---

## Section 2: Storage schemas

Per-project state lives in a single Durable Object's SQLite storage. Cross-project metadata (auth tokens, idempotency keys, project registry) lives in a single global D1 instance. Both use SQLite as the underlying engine; both are accessed via Drizzle.

### 2.1 DO SQLite tables (per-project)

These tables live inside one Durable Object per project. All access is via the DO's storage API (`this.storage.sql.exec(...)` or Drizzle's `drizzle-orm/durable-sqlite`). A single SQLite transaction can span any of these tables, which is the property that makes claim-and-entity-update an atomic operation.

```sql
-- WORK UNITS -------------------------------------------------------------

-- Generic work-unit storage. Work-unit types and constraints are config (in tila.schema.toml), not DDL.
-- The `data` column is a JSON blob; unknown fields round-trip safely (passthrough preservation —
-- the schema validator does not strip fields it doesn't recognize, so consumers can add fields
-- ahead of schema updates without losing data on read-modify-write cycles).
CREATE TABLE entities (
  id              TEXT PRIMARY KEY,             -- 'task-a1b2c3', 'issue-d4e5f6', 'epic-g7h8i9'
  type            TEXT NOT NULL,                -- 'task', 'issue', 'epic', or custom — must be declared in [work_units.*]
  schema_version  INTEGER NOT NULL,             -- which schema was active when this was created
  data            JSON NOT NULL,                -- arbitrary consumer-defined fields
  created_at      INTEGER NOT NULL,             -- unix ms
  updated_at      INTEGER NOT NULL,
  created_by      TEXT,                         -- 'alice@machine-A' or any actor string
  archived        INTEGER NOT NULL DEFAULT 0,   -- 0 or 1
  CHECK (id GLOB '*-*' AND id NOT GLOB '*/*')   -- entity IDs use 'type-hash' form; no slashes (those are R2 keys)
);

CREATE INDEX entities_type ON entities(type) WHERE archived = 0;
CREATE INDEX entities_updated_at ON entities(updated_at);

-- Work-unit-to-work-unit relationships: hierarchy (parent-child), dependencies (blocks, soft-blocks),
-- provenance (discovered-from), and any custom edge types declared in schema.
CREATE TABLE entity_relationships (
  from_id         TEXT NOT NULL,
  to_id           TEXT NOT NULL,
  type            TEXT NOT NULL,                -- 'parent-child', 'blocks', 'soft-blocks', 'related', 'discovered-from', or custom
  schema_version  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  created_by      TEXT,
  PRIMARY KEY (from_id, to_id, type),
  CHECK (from_id NOT GLOB '*/*' AND to_id NOT GLOB '*/*')  -- both columns must be entity IDs, not R2 keys
);

CREATE INDEX rel_to_id ON entity_relationships(to_id);
CREATE INDEX rel_from_id ON entity_relationships(from_id);
CREATE INDEX rel_type ON entity_relationships(type);

-- ARTIFACTS --------------------------------------------------------------

-- Pointers to R2 artifacts. Each row represents one artifact; the blob lives in R2 at r2_key.
-- An artifact is either "produced" (by a work unit, resource is set) or "source" (project-level, resource is NULL).
CREATE TABLE artifact_pointers (
  r2_key          TEXT PRIMARY KEY,             -- 'tasks/T-142/sha256.md' or 'sources/sha256.md'
  resource        TEXT,                          -- producing work unit (e.g., 'task:T-142'), or NULL for source artifacts
  kind            TEXT NOT NULL,                -- 'plan', 'design', 'review', 'lesson', 'index', 'research', etc. — must be declared in [artifacts.*]
  sha256          TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  fence           INTEGER,                      -- fence at time of write; NULL for source artifacts (uploaded without a claim)
  produced_at     INTEGER NOT NULL,
  produced_by     TEXT NOT NULL,
  mime_type       TEXT,
  expires_at      INTEGER,                      -- unix ms; NULL means keep-indefinitely; set by Worker-driven sweep
  tombstoned      INTEGER NOT NULL DEFAULT 0,   -- 1 if R2 blob has been deleted but pointer kept for audit
  CHECK (r2_key GLOB '*/*')                     -- must look like an R2 key (contains slash)
);

CREATE INDEX artifact_resource ON artifact_pointers(resource) WHERE resource IS NOT NULL;
CREATE INDEX artifact_source ON artifact_pointers(kind) WHERE resource IS NULL;
CREATE INDEX artifact_kind ON artifact_pointers(kind);
CREATE INDEX artifact_expires_at ON artifact_pointers(expires_at) WHERE expires_at IS NOT NULL AND tombstoned = 0;

-- Work-unit-to-artifact references: a work unit consults a source artifact (or a produced artifact from another unit).
-- Reference slots (e.g., "research_sources", "prior_lessons") are declared per work-unit-type in schema config.
CREATE TABLE entity_artifact_references (
  entity_id       TEXT NOT NULL,                -- the consulting work unit
  artifact_key    TEXT NOT NULL,                -- the referenced artifact (R2 key)
  slot            TEXT NOT NULL,                -- which reference slot, declared in [work_units.<type>.references]
  metadata        JSON,                          -- optional structured context (e.g., "note": "key methodology source")
  created_at      INTEGER NOT NULL,
  created_by      TEXT,
  PRIMARY KEY (entity_id, artifact_key, slot),
  CHECK (entity_id NOT GLOB '*/*' AND artifact_key GLOB '*/*')
);

CREATE INDEX ear_entity ON entity_artifact_references(entity_id);
CREATE INDEX ear_artifact ON entity_artifact_references(artifact_key);
CREATE INDEX ear_slot ON entity_artifact_references(slot);

-- Artifact-to-artifact relationships: citations within and across work-unit outputs.
-- Used by index/entry pattern, supersession chains, derived-from chains, etc.
CREATE TABLE artifact_relationships (
  from_key        TEXT NOT NULL,                -- 'tasks/T-142/abc123.md'
  to_key          TEXT,                          -- 'tasks/T-098/def456.md' (NULL when reference is external)
  to_uri          TEXT,                          -- non-NULL when reference is external (URL, PR, doc, etc.)
  type            TEXT NOT NULL,                 -- 'references', 'supersedes', 'derived-from', 'index-of', 'entry-of', 'extends', 'rebuts', or custom
  metadata        JSON,                          -- optional structured context for the edge
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (from_key, COALESCE(to_key, to_uri), type),
  CHECK (from_key GLOB '*/*')
);

CREATE INDEX artifact_rel_from ON artifact_relationships(from_key);
CREATE INDEX artifact_rel_to ON artifact_relationships(to_key);
CREATE INDEX artifact_rel_type ON artifact_relationships(type);

-- COORDINATION (was previously in DO transient storage; now persisted in DO SQLite) ----

-- Active claims. Lifecycle: insert on acquire, update on renew, delete on release or expire.
-- Lazy expiry: a claim past expires_at is considered released on next read; sweeper deletes it.
CREATE TABLE claims (
  resource        TEXT PRIMARY KEY,             -- 'task:T-142', 'file:src/auth.rb', 'epic:E-5'
  principal_id    TEXT NOT NULL,                -- immutable authenticated subject
  participant_id  TEXT NOT NULL,                -- independent client process/session
  environment     JSON NOT NULL DEFAULT '{}',   -- untrusted machine/repository/Git/client metadata
  mode            TEXT NOT NULL,                -- 'exclusive' | 'owner' | 'presence'
  fence           INTEGER NOT NULL,             -- value of fences.current_fence at time of acquire
  acquired_at     INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  metadata        JSON
);

CREATE INDEX claims_expires_at ON claims(expires_at);

-- Monotonic fence counter per resource. Incremented on every acquire (even after release).
-- Never decrements. Persists across DO evictions.
CREATE TABLE fences (
  resource        TEXT PRIMARY KEY,
  current_fence   INTEGER NOT NULL DEFAULT 0
);

-- Presence: TTL'd participant activity. Refreshed by heartbeat; reaped by the sweeper.
CREATE TABLE presence (
  principal_id    TEXT NOT NULL,
  participant_id  TEXT NOT NULL,
  environment     JSON NOT NULL DEFAULT '{}',
  last_seen       INTEGER NOT NULL,
  info            JSON NOT NULL DEFAULT '{}',   -- current resource, status, etc.
  PRIMARY KEY (principal_id, participant_id)
);

CREATE INDEX presence_last_seen ON presence(last_seen);

-- JOURNAL ----------------------------------------------------------------

-- Append-only event log. Durable source of truth for "what happened."
-- All meaningful state changes (claim, release, artifact write, schema apply, archive) emit a row.
CREATE TABLE journal (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  t               INTEGER NOT NULL,             -- unix ms
  kind            TEXT NOT NULL,                -- 'task.claimed', 'artifact.produced', 'artifact.referenced', 'task.completed', 'schema.applied', etc.
  resource        TEXT,                         -- 'task:T-142', null for global events
  principal_id    TEXT NOT NULL,
  participant_id  TEXT NOT NULL,
  environment     JSON NOT NULL DEFAULT '{}',
  token_id        TEXT,                         -- credential audit data
  fence           INTEGER,                      -- if applicable
  data            JSON NOT NULL                 -- full event payload
);

CREATE INDEX journal_t ON journal(t);
CREATE INDEX journal_resource ON journal(resource);
CREATE INDEX journal_kind ON journal(kind);

-- META -------------------------------------------------------------------

-- Schema definition history. Every schema applied is stored.
-- Used to interpret old entities/artifacts against the schema active when they were created.
CREATE TABLE _schema_history (
  version         INTEGER PRIMARY KEY,
  applied_at      INTEGER NOT NULL,
  applied_by      TEXT NOT NULL,
  schema_toml     TEXT NOT NULL,                -- full tila.schema.toml content
  change_summary  TEXT,                         -- 'Added work-unit type: initiative'
  strategy        TEXT                          -- 'auto' | 'relax' | 'migrate' | 'force' | etc.
);
```

### 2.2 D1 tables (global, cross-project)

A single global D1 instance holds cross-project metadata. The Worker reads it for every request to validate authentication and route to the right DO. It is intentionally small.

```sql
-- API token storage (hashed). Issued via `tila token issue`, validated on every Worker request.
-- Scoped to a single project via project_id. Cross-project tokens are an explicit anti-pattern.
CREATE TABLE _tokens (
  token_hash      TEXT PRIMARY KEY,             -- Argon2id or scrypt hash
  project_id      TEXT NOT NULL,                -- which project this token grants access to
  name            TEXT NOT NULL,                -- 'ci-prod', 'alice-laptop', etc.
  note            TEXT,
  scopes          TEXT NOT NULL DEFAULT 'full', -- legacy column; current scoped policy has separate capability/credential metadata
  created_at      INTEGER NOT NULL,
  created_by      TEXT NOT NULL,
  last_used_at    INTEGER,
  revoked_at      INTEGER,
  UNIQUE (project_id, name)
);

CREATE INDEX tokens_project ON _tokens(project_id) WHERE revoked_at IS NULL;

-- Project registry. Maps the project slug to a DO ID and tracks meta.
CREATE TABLE _projects (
  project_id      TEXT PRIMARY KEY,             -- 'tila-myproj' (also the DO name)
  display_name    TEXT,
  created_at      INTEGER NOT NULL,
  created_by      TEXT NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,   -- registry metadata; not the authoritative DO apply revision
  cloudflare_account_id TEXT NOT NULL,
  archived        INTEGER NOT NULL DEFAULT 0
);

-- Idempotency keys for mutating API requests. See Architecture §3a.3.
-- Lives in D1 because idempotency keys are scoped per-request (not per-project) and benefit
-- from cross-DO global scope.
CREATE TABLE _idempotency (
  key             TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  response_json   TEXT NOT NULL,
  status_code     INTEGER NOT NULL
);
CREATE INDEX idempotency_created_at ON _idempotency(created_at);
```

### 2.3 Passthrough preservation

A consumer may add a field to an entity (e.g., `priority: "high"`) before that field is declared in `tila.schema.toml`. tila's write path must NOT strip unknown fields from the `data` JSON blob. The schema validator's job on write is to ensure declared fields meet declared constraints; unknown fields pass through unchanged. On read, the entity is returned exactly as stored — declared fields validated against the schema active at write time, unknown fields included verbatim.

Without this discipline, every read-modify-write cycle would silently lose fields the consumer added ahead of a schema update.

### 2.4 Why CHECK constraints on relationship columns

The three relationship tables (`entity_relationships`, `entity_artifact_references`, `artifact_relationships`) have CHECK constraints that distinguish entity IDs from R2 keys at the SQL level. Entity IDs have the form `<type>-<hash>` and contain no slashes. R2 keys always contain at least one slash (`tasks/T-142/sha256.md`, `sources/sha256.md`). A column that should be an entity ID can never accidentally store an R2 key, and vice versa. This catches a class of bugs (cross-table confusion) at the database boundary rather than relying on application-level discipline.

### 2.5 Schema management

DDL migrations to either DO SQLite or D1 are explicit, require Cloudflare account credentials, and run via `tila worker upgrade`. They are never auto-applied. The DO's SQLite migrations are bundled with the Worker code and applied on first use of each DO (via the DO's `blockConcurrencyWhile(initFn)`); D1 migrations apply via Wrangler at deploy time.

Entity-level schema changes (adding `task`, removing `bug`, adding required field `priority`) are definition revisions made in Settings › Definitions, `tila schema import` or `tila schema apply`, with `_schema_history` as the audit log. The DDL is unaffected — these changes only modify `data` interpretation rules.

Configuration reads and previews return `revision` (zero before the first apply). This is the applied-definition history version, distinct from the format's `schema_version`. Send `expected_revision` on apply to reject stale edits atomically with HTTP 412 `schema-revision-conflict`. Destructive conditional writes also require `reviewed_definition` from preview and an explicit `relax` or `force` strategy. Tila compares parsed definitions, so whitespace changes are harmless; the review is a precondition, not an authorization credential.

Preview changes are typed (`SchemaPreviewChangeSchema`) and carry impact counts taken from current data: unarchived and archived tasks/records of a removed type, tasks/records still holding a removed field, live artifacts and lineages of a removed artifact kind, and rows that will read a newly added field's `default_for_legacy` lazily. Changing an artifact kind's policy adds `impact`: live artifacts (their assigned expiry is never rewritten), whether search settings changed (no automatic reindex), and for a retention change the legacy revisions still waiting for the retention backfill and whether they will take the new value or an earlier policy snapshot. Counts describe the moment of preview; apply checks the revision, not the counts. Invalid definitions return HTTP 400 `schema-parse-error` with `error.errors[]` (`message`, plus `path` for structural problems or `line`/`column` for TOML syntax).

`@tila/core` also exports the editable definition document used by the dashboard: `parseDefinitionDocument`/`serializeDefinitionDocument` keep the raw TOML table tree, so keys the schema does not model survive an edit, and `rebaseDefinition` merges a draft onto a newer revision one declaration at a time. Serialization keeps values but not comments or layout. Validation remains `parseSchemaToml` and the server preview.

The SDK exposes `schema.preview(definition)`, `schema.apply(definition, strategy, { expected_revision, reviewed_definition, idempotency_key })` and paginated `schema.history({ limit, before })`. CLI users can save `tila schema diff --json` to a review file and pass it with `tila schema apply --review <file> --strategy force --idempotency-key <stable-key>`. MCP exposes `tila_schema_preview` and the same conditional fields on `tila_schema_update`. History is retained remotely and locally. Embedded databases now apply the previously skipped canonical migration 21 to add the transactional receipt table; the legacy local response-cache table remains intact.

Legacy revisionless applies remain compatible outside managed projects, with structured `schema-revision-deprecated` warnings carrying guidance and observed/result revisions. SDK applies use an injectable `warningSink` with a visible `console.warn` default; CLI renders one diagnostic on stderr, including JSON mode, and MCP includes warnings in text and structured results. A successful revisionless mutation appends `schema.revisionless_applied` in the same SQLite transaction as history and its receipt. The event carries canonical identity/environment, actor, idempotency context and revision numbers, without definition contents. Exact retries preserve the warning without another event/revision; no-change warns without a state-change event. Invalid/rejected requests do not claim a successful apply. Pre-warning receipts gain a warning on replay without inventing an observed revision or historical event. Managed `revision_required` is checked before receipt replay. Older clients can ignore the new field, but journal readers still observe new revisionless changes. Conditional applies keep 412 semantics and no warning. Requiring revisions on every project is a future migration, with no enforcement release set.

Every new definition write (preview and apply) passes a guard before it is parsed: a definition or reviewed copy over 256 KiB (`DEFINITION_MAX_BYTES`) returns 413 `payload-too-large`, and credentials, a `[tila_export]` table or a client connection file return 400 `schema-parse-error` with one path per problem. The Worker also caps schema request bodies ahead of the idempotency middleware. Stored definitions are never re-checked on read. `tila schema import` and `tila schema export` move definitions in and out as TOML or YAML through the same preview and conditional apply; §14.6 has the contract.

Apply receipts commit with the configuration and journal in project SQLite. An exact retry returns the recorded result, even after the applied revision advances; a reused key with different input is rejected. Schema commands bypass D1 response replay so current authorization is checked before the receipt is read. Entity create/update validation reads the current definition inside its write transaction; Worker cache freshness is not a correctness boundary.

---

## Section 3: Durable Object internals

### 3.1 One DO per project

The DO is identified by the project ID. `env.PROJECT.idFromName(env.PROJECT_ID)` returns a deterministic ID. All requests for a given project route to the same DO instance globally. (The binding name is `PROJECT` rather than the 2024 `COORD` — it holds all per-project state, not just coordination.)

Smart Placement (enabled in `wrangler.toml`) co-locates the Worker that talks to this DO. Effective Worker→DO RTT for the steady state is 1-5ms.

### 3.2 DO SQLite tables

The DO's persistent state is everything defined in §2.1: `entities`, `entity_relationships`, `artifact_pointers`, `entity_artifact_references`, `artifact_relationships`, `claims`, `fences`, `presence`, `journal`, `_schema_history`. All in one SQLite database. All accessible in one transaction.

### 3.3 DO endpoints

The DO exposes one `fetch(req)` handler that routes internally. The endpoints align 1:1 with the Worker's public API surface (§3a.2) — the DO is the implementation of the surface, the Worker is the front door. The DO does not expose a separate "coordination-only" API anymore; entity reads, claim writes, journal appends are all routed to the same DO and dispatched internally.

Internal routing inside the DO:

| Worker route | DO route | Description |
|---|---|---|
| `/entities/*` | `/entity/*` | Entity CRUD + queries (uses `entities`, `entity_relationships`) |
| `/acquire`, `/renew`, `/release`, `/state`, `/presence` | `/coord/*` | Coordination primitives (uses `claims`, `fences`, `presence`) |
| `/artifacts/:key` (metadata) | `/artifact/*` | Pointer rows, refs, relationships (uses `artifact_pointers`, `entity_artifact_references`, `artifact_relationships`). The blob itself goes to R2; only the pointer round-trips through the DO. |
| `/journal/*` | `/journal/*` | Journal read access. Journal writes happen as part of the transactions above. |
| `/schema/*` | `/schema/*` | Schema management (uses `_schema_history`) |
| `/_internal/sweep` | `/sweep` | Cron-triggered cleanup (expired claims, presence reap, expired artifact tombstoning) |

### 3.4 Critical DO behaviors

**Every write is one SQLite transaction.** Claim-and-journal, entity-update-and-journal, artifact-pointer-and-journal — all happen in one `state.storage.transaction()` block. No cross-call coordination needed.

**Acquire is serializable.** All `/coord/acquire` requests for the same resource serialize through the DO's single-threaded execution. No two acquires for the same resource can race; the first wins, the second sees the first's state.

**Fence counters never decrement.** Even if a claim is released, the fence for that resource increments on the next acquire. This is what makes stale-lease detection at the action site possible.

**Lease expiry is checked on every read.** The claim row may still exist past `expires_at`; reads treat it as released. The sweeper (cron-triggered) physically deletes expired rows. **Do not rely on DO alarms for expiry checks** — alarm timing can drift by seconds after eviction; read-time checks are the source of truth, alarms are a hint.

**Journal is the durability anchor.** Every meaningful state change emits a journal row in the same transaction that produced it. If the DO is ever restored from a backup, replaying the journal from a snapshot point produces consistent state. The journal is also how cross-backend operations (Worker → R2 → DO) are made recoverable: if the R2 write succeeds but the DO write fails, the next `tila doctor --reconcile` walks R2 against journal and emits a synthesizing journal event to recover.

**DO eviction is safe.** DO instances evict when idle (typical: minutes). SQLite storage persists. In-memory state (cached schema, prepared statements) rebuilds on next fetch via `blockConcurrencyWhile`. No state loss; just a cold start on the next request. The `cold-start` benchmark scenario measures it on the deployed Worker (`cold_first_request` vs `warm_after_restart` in [docs/benchmarks/BASELINE.md](benchmarks/BASELINE.md)).

**`blockConcurrencyWhile` for migrations.** On DO startup, the init function runs DDL migrations idempotently (compare current schema version against the bundled migration set, apply missing). All requests block until migrations complete. This is how new tila Worker versions safely evolve the DO schema.

---

## Section 3a: Worker HTTP API contract

The external API surface used by clients. Existing bearer and browser-session
authentication remain supported. The catalog below is historical; mounted routes
and §14 define the current settings/access boundaries.

### 3a.1 Authentication

Current clients use supported bearer credentials or authenticated browser sessions.
Project admission uses canonical memberships, then operation-specific capability,
namespace and protected-operation checks. Scoped service/workload credentials and
legacy full D1 keys coexist; scoped issuance cannot exceed current authority.
Rotation has explicit expected-token/overlap semantics, not a settings rollback.
See [the authorization guide](07-GITHUB-SCOPED-AUTH.md) and §14.3 for the current
permission matrix. Key-only onboarding/auth retirement is not implied here.

### 3a.2 Endpoint catalog

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok: true, version, commit, apiVersion, minCliVersion }` — product release and source commit of the deployed build; `apiVersion`/`minCliVersion` are protocol compatibility |
| GET | `/whoami` | — | `{ token_name, scopes }` |
| GET | `/schema` | — | `{ version, schema_toml }` |
| POST | `/schema/apply` | `{ schema_toml, strategy?, dry_run? }` | `{ ok, new_version, changes, warnings }` |
| GET | `/tasks` (alias `/entities`) | query: `type`, `status`, `parent`, `archived`, `sort` (`created_at`, `updated_at`, `type`, `title`, `status`, `id`), `order`, `limit`, `cursor` or `offset` | `{ entities: [], total, limit, offset, has_more, next_cursor, scope }` — keyset pages (§14.8) |
| GET | `/search` | query: `q`, `kind`, `type`, `syntax`, `limit`, `cursor`, `tag_filter` | `{ results: [], total, next_cursor, scope }` — `total` counts this page (§14.8) |
| GET | `/tasks/~/types` | — | `{ ok, types: [{ type, declaration, count, archived_count, definition? }], scope, incomplete? }` — the work type catalog (§14.7) |
| POST | `/entities` | `{ type, data, parent?, idempotency_key }` | `{ entity }` — `data` is limited to 256 KiB (§14.10) |
| GET | `/entities/:id` | — | `{ entity, claim?, recent_journal }` |
| PATCH | `/entities/:id` | `{ patch, idempotency_key }` | `{ entity }` — the merged `data` is limited to 256 KiB (§14.10) |
| POST | `/entities/:id/archive` | `{ idempotency_key }` | `{ ok }` |
| POST | `/entities/:id/relationships` | `{ to, type, idempotency_key }` | `{ ok }` — both tasks must exist, else 404 `not-found` (§14.10) |
| DELETE | `/entities/:id/relationships/:to/:type` | — | `{ ok }` |
| POST | `/acquire` | `{ resource, mode, ttl_ms, metadata? }` + participant/environment headers | `{ ok: true, fence, expires_at, participant_id }` or 409 |
| POST | `/renew` | `{ resource, fence, ttl_ms }` + participant/environment headers | `{ ok: true, expires_at }` or 409 |
| POST | `/release` | `{ resource, fence }` + participant/environment headers | `{ ok: true }` |
| GET | `/state` | query: `resource` | `{ claim?, owners: [], presence: [] }` |
| GET | `/presence` | — | `{ participants: [] }` |
| POST | `/presence` | `{ info? }` + participant/environment headers | `{ ok }` |
| POST | `/signals/send` | `{ target: participant \| principal \| group \| broadcast, kind, resource?, payload?, ttl_ms? }` + participant/environment headers | `{ ok, id, recipient_count }` |
| GET | `/signals` | participant/environment headers | Current participant's unacknowledged inbox |
| POST | `/signals/:id/ack` | participant/environment headers | `{ ok }` or 403 for an unrelated participant |
| GET | `/signals/history` | query: `limit`, `cursor`; admin only | Paginated signal and delivery audit history |
| GET/PUT/DELETE | `/signals/groups[/:id]` | group reads require project read; mutations require admin | Principal-based signal groups |
| PUT | `/artifacts/:key` | binary body, metadata in headers | `{ ok, key, deduplicated? }` |
| GET | `/artifacts/:key` | — | binary body with metadata headers |
| GET | `/artifacts` | query: `resource`, `kind`, `limit`, `cursor` | `{ artifacts: [], cursor? }` |
| DELETE | `/artifacts/:key` | `{ force? }` | `{ ok }` |
| GET | `/journal` | query: `after_seq`, `resource` (repeatable, up to 10), `kind`, `client_name`, `event_name`, `correlation_id`, `limit` | `{ ok, events: [{ principal_id, participant_id, environment, token_id, ... }], archived, lastArchivedSeq }` — without `after_seq` the newest `limit` events, newest first; with `after_seq` the next `limit` events after it, oldest first, so a client pages forward by passing the last `seq` as `after_seq` until a page is shorter than `limit`. `archived: true` (cursor below `lastArchivedSeq`) returns no events: read archived history with `/journal/replay` |
| GET | `/doctor` | — | `{ ok, checks: [{ name, status, detail }] }` |
| POST | `/reset` | `{ confirm: "PROJECT_ID", keep_artifacts?, keep_entity_types? }` | `{ ok, dropped }` |
| GET | `/` (and static paths) | — | UI HTML/JS bundle |

There is no `/journal/stream` route, and the Worker serves no server-sent-event stream. Follow new events by paging `GET /journal` forward with `after_seq`, and read archived history with `GET /journal/replay`.

### 3a.3 Idempotency keys

Every mutating endpoint accepts an `idempotency_key` (UUID v4, client-generated). Worker maintains a `_idempotency` table in D1:

```sql
CREATE TABLE _idempotency (
  key             TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  response_json   TEXT NOT NULL,
  status_code     INTEGER NOT NULL
);
CREATE INDEX idempotency_created_at ON _idempotency(created_at);
```

Keys are retained for 1 hour. A repeated request with the same key returns the cached response. This makes the CLI safe to retry on network errors.

**DO-side dedup (audit B1).** The D1 `_idempotency` row above is written by the Worker *after* the DO write commits, so a crash between the DO commit and the D1 store would leave no D1 row — a retry would then re-execute and double-apply a fence-mutating write. To close that cross-store gap, fence-mutating DO writes (entity update/archive, claim acquire/renew/release, record set/patch/archive/unarchive) ALSO record a dedup row inside the *same DO SQLite transaction* as the write, in a DO-only `_do_idempotency` table (canonical migration v21). The Worker forwards its composite caller-scoped key (`dp:<projectId>:<caller>:<method>:<path>:<clientKey>`) plus the request-body hash to the DO; on replay the DO returns the stored result without re-running the write (no second fence bump). The D1 row remains a fast-path optimization, NOT the sole guard. `_do_idempotency` is DO-only — embedded mode keeps its own `_idempotency` overlay and does not create it.

### 3a.4 Error envelope

All error responses use the shape:

```json
{
  "ok": false,
  "error": {
    "code": "stale-fence",          // machine-readable
    "message": "Fence 42 is stale; current is 43",  // human-readable
    "retryable": false,
    "details": { "current_fence": 43, "participant_id": "550e8400-e29b-41d4-a716-446655440000" }
  }
}
```

Standard codes: `unauthorized`, `not-found`, `stale-fence`, `already-held`, `rate-limited`, `schema-mismatch`, `idempotency-conflict`, `internal`.

### 3a.5 Rate limiting and backpressure

- The Worker does not enforce a per-token throughput limit. The only limiter is on failed authentication: 20 failures per client IP per 60 seconds (`RATE_LIMIT_MAX_FAILURES` / `RATE_LIMIT_WINDOW_MS` in `packages/worker/src/config.ts`), checked against D1 before authentication.
- D1 / DO / R2 rate-limit responses propagate as 429 with `Retry-After` header.
- The SDK ships an opt-in `withRetry` helper (3 retries, 200 ms base with full jitter, honours `retryable`); `TilaClient` itself never retries except for one credential refresh on 401. The benchmark harness does not use `withRetry`, so its percentiles contain no backoff time.

### 3a.6 Cross-backend operation ordering

Most operations are single-DO transactions and have no cross-backend concerns. But artifact uploads (R2 + DO) and provisioning (D1 + DO + R2) span backends. The discipline for these:

**Rule 1 — DO transaction is always last.** When an operation spans backends, the DO write commits last. This is because the DO transaction includes the journal append; if the journal records "the artifact was produced," the artifact must already exist. Reverse the order and you get journal events for artifacts that don't exist.

**Rule 2 — Idempotency keys span the full operation.** A cross-backend operation carries an idempotency key the entire way. If the operation is retried, the idempotency key short-circuits at the Worker (D1 fast-path) before re-doing any backend work. If the Worker's D1 row was never written (a crash after the DO commit), the DO's own in-transaction `_do_idempotency` guard still short-circuits the fence-mutating write on replay (audit B1), so a retry never double-applies. See §3a.3.

**Rule 3 — Orphaned partial work is recoverable, not catastrophic.** If R2 write succeeds but DO write fails:
- The R2 blob exists with no pointer row.
- `tila doctor --reconcile` walks R2 prefixes, finds blobs without pointer rows, and either synthesizes pointer rows from R2 object metadata (which carries `x-amz-meta-tila-resource`, `x-amz-meta-tila-fence`, etc.) or, if metadata is insufficient, lists them for manual review.
- The journal has no record of the failed write; the reconcile step emits a `artifact.reconciled` journal event when it fixes one.

**Rule 4 — Never lock across backends.** No backend's lock waits on another backend. If a DO holds a transaction open while talking to R2, R2 latency couples to DO throughput. Pattern instead: prepare data in the Worker, commit to R2 outside any DO transaction, then enter the DO transaction for the pointer write.

**Concrete artifact upload flow (corrected from §1.4 with full failure-mode handling):**

```
1. Worker receives PUT /artifacts/:key with body, headers, idempotency_key
2. Worker checks D1 _idempotency. If hit, return cached response.
3. Worker calls DO /coord/validate-fence to check the fence is valid for the resource.
   (One DO call, no transaction, just a read.)
4. Worker PUTs to R2 with If-None-Match: * and x-amz-meta-* metadata.
   (If R2 returns 412, it means a blob with this sha256 already exists — dedup hit;
    skip to step 5 with deduplicated: true.)
5. Worker calls DO /artifact/record with the same idempotency_key.
   DO begins SQLite transaction:
   - INSERT into artifact_pointers (idempotent via PRIMARY KEY r2_key)
   - INSERT into journal (artifact.produced event)
   - If artifacts.<kind>.requires_reference_to is set, INSERT into artifact_relationships
   - COMMIT
6. Worker writes the response to D1 _idempotency.
7. Worker returns response.

Failure handling:
- Step 4 R2 PUT fails: return error to client, no DO call made, no state inconsistent.
- Step 5 DO call fails (transient — throw or 5xx): Worker retries once immediately
  (no delay — DO routing errors resolve within milliseconds). If retry succeeds,
  return success. upsertPointer uses INSERT OR IGNORE, making retries idempotent.
- Step 5 both attempts fail: Worker attempts R2 delete as compensation.
  - R2 delete succeeds: return 502 {code: "upload-failed", retryable: true}.
    No blob in R2, no pointer row — clean state. Client may retry full upload.
  - R2 delete fails: return 500 {code: "pointer-registration-failed", retryable: true, r2Key}.
    Blob exists in R2, no pointer row. r2Key included for client-side recovery.
    Reconcile job picks up the orphan when DRIFT_RECONCILE_THRESHOLD (default: 10)
    orphans accumulate, or via manual POST /reconcile?apply=true.
- Step 5 DO returns 4xx (e.g., 422 undeclared kind, 409 fence mismatch): no retry.
  DO error forwarded to client verbatim. R2 blob exists as orphan (reconcile recovers).
- Worker crashes between steps 4 and 5: R2 blob exists, no pointer row.
  Reconcile job recovers when threshold is met.

Note: DRIFT_RECONCILE_THRESHOLD=10 means a single orphan below the threshold is not
auto-recovered by the daily sweep (03:00 UTC cron). Use POST /reconcile?apply=true
for immediate recovery of individual orphans.
```

---

## Section 3b: Authentication and account context

Two distinct credentials, each with a different role. Distinguishing them is foundational; conflating them is the source of most multi-tenancy bugs.

### 3b.1 The two-credential model

**Credential 1 — Cloudflare account credentials (via wrangler).** The user's identity to Cloudflare. Stored at `~/.wrangler/config/default.toml` after `wrangler login`. Used only for:

- Provisioning operations (`tila project create`)
- Worker code updates (`tila worker upgrade`)
- R2 lifecycle rule changes (`tila lifecycle apply`)
- D1 schema migrations (`tila schema apply` when it triggers a D1 DDL migration; entity-config-level schema changes do not need this)
- Tearing down resources (`tila reset --destroy-resources`)

Most engineers never need this credential. Only the project admin who provisioned the resources, or someone with delegated admin access, uses Cloudflare account credentials with tila.

**Credential 2 — Project API token.** The CLI's identity to the Worker. Generated per project during init. Stored at `.tila/.env` locally. Used for every runtime operation: task management, claims, artifacts, journal, presence, doctor's read-only checks.

This is the credential that team members need to use the project. Sharing it via the org's secret manager (1Password, Vault, AWS Secrets Manager, Doppler, etc.) is the standard pattern.

### 3b.2 Project-to-account binding

Every cloud-mode tila project records which Cloudflare account owns it. From `.tila/config.toml`:

```toml
project_id = "auth-refactor"
worker_url = "https://tila-auth-refactor.acme.workers.dev"
created_at = "2026-05-15T10:00:00Z"
tila_version = "0.10.0"
schema_version = 1

[cloudflare]
account_id = "abc123def456ghi789..."
account_name = "Acme Corp"           # display only; account_id is canonical
worker_subdomain = "tila.acme.com"   # optional; defaults to <account>.workers.dev
jurisdiction = "eu"                   # optional; for R2 EU jurisdiction enforcement
custom_domain = true                  # optional; uses worker_subdomain instead of workers.dev

[backends]
entity = "do-sqlite"
coordination = "do-sqlite"
artifact = "r2"
auth = "d1"
```

This file is committed to the project repo. Team members joining inherit the account binding automatically.

### 3b.3 Startup auth check

Every tila command runs this check before executing:

```
Step 1: Resolve project context.
  - Walk up from cwd looking for .tila/config.toml.
  - If not found:
    - Commands that need a project: error with "no tila project found; run `tila init`"
    - Commands that work without a project (--version, --help): proceed
  - If found: load config.

Step 2: Determine which credentials are needed.
  - Provisioning-class commands: need Cloudflare account credentials AND project API token
  - Runtime commands: need only project API token
  - Diagnostic commands (--version, --help, doctor --offline): need nothing

Step 3 (if Cloudflare credentials needed):
  - Check wrangler is installed.
    - If not: error "wrangler is required for this command. Install: npm install -g wrangler"
  - Check wrangler is logged in. Run `wrangler whoami`.
    - If not: error "run `wrangler login` first"
  - Get active Cloudflare account ID. (Wrangler exposes via `wrangler whoami` JSON output.)
  - Compare to project's cloudflare.account_id.
    - If mismatch: error with both account IDs and suggest options (switch accounts, cancel, use a different project).

Step 4 (if project API token needed):
  - Managed runtimes use their runtime broker; operator credential fallback is denied.
  - Prefer explicit --token, then the first nonempty trimmed TILA_TOKEN or legacy TILA_API_TOKEN environment value.
  - Async startup then tries a human session when worker_url is set, CI is unset and stdin is a TTY.
    - An unavailable keychain (error code `KEYCHAIN_UNAVAILABLE`) counts as no session: one token-free stderr warning, then the steps below. Any other lookup error propagates.
  - In tila-token mode, fall back to .tila/.env using its existing TILA_API_TOKEN key.
    - If missing: error "no API token found; run `tila init` to join this project, set TILA_TOKEN (legacy alias: TILA_API_TOKEN), or add TILA_API_TOKEN to .tila/.env"
  - Async github-repo mode resolves a cached/exchanged GitHub session instead of the legacy file. The synchronous GitHub path only accepts --token or a valid cached .session; otherwise it requires async resolution.
  - Continue. Token is sent as Bearer header to the Worker. 401 from Worker is handled at the request site.

Step 5: Execute the command.
```

### 3b.4 Account switching

Three patterns supported, in order of preference:

**Implicit (recommended default).** The CLI sets `CLOUDFLARE_ACCOUNT_ID` from the project's config before shelling out to wrangler. The user doesn't manually switch — being in a project's directory makes that project's account active.

**Explicit via shell.** `eval $(tila account use <name>)` sets `CLOUDFLARE_ACCOUNT_ID` for the current shell. Useful for ad-hoc operations outside a project directory.

**Per-invocation.** `tila <command> --account=<id>` overrides the project's account binding for a single command. Use carefully; intended for cross-account migration scripts.

### 3b.5 Operations classified by credentials

| Command | Needs Cloudflare auth | Needs project API token |
|---|---|---|
| `tila --version` | no | no |
| `tila --help` | no | no |
| `tila login` | yes (initiates) | no |
| `tila project create` | yes | no (generates one) |
| `tila init` | no | yes (prompts for it) |
| `tila task *`, `tila issue *`, `tila epic *` | no | yes |
| `tila claim/renew/release` | no | yes |
| `tila artifact *` | no | yes |
| `tila journal *` | no | yes |
| `tila state`, `tila presence` | no | yes |
| `tila schema show` | no | yes |
| `tila schema apply` (entity-config only) | no | yes |
| `tila schema apply` (D1 DDL migration) | yes | yes |
| `tila lifecycle apply` | yes | yes |
| `tila worker upgrade` | yes | yes (for verification) |
| `tila reset` (data only) | no | yes |
| `tila reset --destroy-resources` | yes | yes |
| `tila doctor` (online checks) | no | yes |
| `tila doctor --offline` | no | no |
| `tila account list` | no (reads wrangler config locally) | no |
| `tila account use` | no | no |
| `tila token rotate` | no | yes |
| `tila token list` | no | yes |
| `tila token revoke` | no | yes |

### 3b.6 Service accounts and CI

For automation (CI, scheduled jobs, server-side autopilots), use a non-interactive token model:

- **For Worker runtime calls:** create a dedicated CI token via `tila token issue --name=ci-prod --note="GitHub Actions runner"`. Put the token in the CI secret store. The CI workflow sets `TILA_API_TOKEN` from secrets; no wrangler needed.
- **For provisioning from CI:** use a Cloudflare API token (not OAuth) scoped to the specific account, with permissions for Workers Scripts, R2 Storage, D1, and Workers KV. Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in CI secrets. tila and wrangler both honor these env vars.

---

## Section 4: Resource identifiers and naming

### 4.1 Resource string format

All claims operate on opaque resource strings of the form `<type>:<id>`. The engine doesn't parse these beyond splitting on the colon.

Conventional types a software-development consumer would use:
- `task:<id>` — exclusive, short TTL
- `issue:<id>` — owner mode, hours TTL
- `epic:<id>` — owner mode, days TTL
- `file:<path>` — exclusive, short TTL (for "no two agents editing the same file")
- `branch:<name>` — owner mode (for "this branch is owned by this agent's worktree")

Users defining custom entity types in `tila.schema.toml` can use any resource prefix; the engine treats them all generically.

### 4.2 Entity ID format

`<type-prefix>-<hash>` where:
- `type-prefix` is 1–6 lowercase letters matching the entity type (`task`, `issue`, `epic`, `bug`)
- `hash` is 4–8 base32 characters derived from a ULID or random bytes

Examples: `task-a1b2c3`, `issue-d4e5f6g7`, `epic-h8i9j0`.

This format prevents merge conflicts when multiple agents create entities in parallel (no shared counter), keeps IDs short for CLI use, and stays distinct from sequential IDs like `T-142` that imply a single source of truth.

**Display IDs vs storage IDs:** a consuming framework may render `task-a1b2c3` as `T-142` for user-facing display (with a per-project counter mirrored in D1), but the canonical storage ID is the hash-based form. The display ID is a UI convenience; the storage ID is what tila knows about.

### 4.3 Fencing tokens

Per-resource monotonic counter. Starts at 1 for the first acquire of a resource. Increments on every acquire (whether the previous lease expired or was released). Never decrements. Stored in `fences` table in the DO.

Fence is always returned with a successful acquire and must be included in any downstream destructive operation against that resource.

---

## Section 5: The three backend interfaces

The CLI never speaks to D1, the DO, or R2 directly. It speaks to three interfaces, each implementable by multiple backends. In v1, only the Cloudflare-backed implementations exist for each.

> **CLI local/remote backend-swap contract.** The interfaces in `packages/core/src/interfaces/` (see that directory's `README.md`) form the swap boundary used by the CLI to select between remote (Worker over HTTP) and local (the CLI's `src/local`, bun:sqlite) execution. These interfaces are **not** the Durable Object contract — the `ProjectDO` calls `@tila/ops-sqlite` directly. There is intentionally no `RecordBackend` interface because typed mutable records have no offline CLI path yet.

### 5.1 EntityBackend

```typescript
interface EntityBackend {
  // Reads
  get(id: string): Promise<Entity | null>;
  list(filter: EntityFilter): Promise<Entity[]>;
  getReady(type?: string): Promise<Entity[]>;
  getHierarchy(id: string): Promise<{ ancestors: Entity[]; descendants: Entity[] }>;

  // Writes
  create(input: CreateEntityInput): Promise<Entity>;
  update(id: string, patch: Partial<EntityData>): Promise<Entity>;
  archive(id: string): Promise<void>;

  // Relationships
  addRelationship(from: string, to: string, type: string): Promise<void>;
  removeRelationship(from: string, to: string, type: string): Promise<void>;

  // Schema
  getSchema(version?: number): Promise<SchemaDefinition>;
  applySchema(newSchema: SchemaDefinition, strategy: ApplyStrategy): Promise<SchemaApplyResult>;

  // Capabilities (each backend declares what it supports)
  capabilities: EntityBackendCapabilities;
}

interface EntityBackendCapabilities {
  typedDependencies: boolean;
  customFields: boolean;
  customEntityTypes: boolean;
  arbitraryMetadata: boolean;
  fastListByPrefix: boolean;
  averageReadLatencyMs: number;  // for the CLI to adapt polling cadence
}
```

Current implementations:

- `do-sqlite` — entity state co-located with coordination state in the same project DO
- `local-sqlite` — entity and coordination state in the same local SQLite DB, shared through `@tila/ops-sqlite`. Standalone local persistence is single-machine compatibility, not shared multi-host authority.

Test fixtures (not shipped as backends):
- An in-memory fake EntityBackend lives in `packages/core/test/fixtures/` for unit-testing tila-core logic without spinning up the DO.

Historical alternatives (not implemented or scheduled):

- `github-issues`, `linear`, and a separate `d1` entity backend were early design
  options. They are not shipped stubs. New backend scope must follow
  [Decisions §0](01-DECISIONS.md#0-name-and-scope--amended-2026-09-20) and
  [the active roadmap](03-ROADMAP.md).

### 5.2 CoordinationBackend

```typescript
interface CoordinationBackend {
  acquire(
    resource: string,
    mode: 'exclusive' | 'owner',
    ttlMs: number,
    metadata?: object
  ): Promise<AcquireResult>;

  renew(resource: string, fence: number, ttlMs: number): Promise<RenewResult>;
  release(resource: string, fence: number): Promise<void>;

  getState(resource: string): Promise<ResourceState>;
  listPresence(): Promise<ParticipantActivity[]>;
  heartbeat(info: PresenceInfo): Promise<void>;

  capabilities: CoordinationBackendCapabilities;
}

type AcquireResult =
  | { acquired: true; fence: number; expires_at: number; participant_id: string }
  | { acquired: false; fence: number; expires_at: number; participant_id: string };
```

Current implementations:

- `do-sqlite` — strong consistency via DO single-thread serialization, with entity and claim writes in one SQLite transaction
- `local-sqlite` — SQLite transaction serialization, with entity and claim writes in the same DB

Performance evidence is dated and workload-specific. See the
[benchmark baseline](benchmarks/BASELINE.md); it is not v0.10.0 validation or the
comparative product study required by [#194](https://github.com/davebream/tila/issues/194).

Test fixtures: a Map-backed in-memory fake CoordinationBackend in `packages/core/test/fixtures/` for unit testing.

Historical alternative (not implemented or scheduled):

- `upstash-redis` was considered for a separate coordination backend. The interfaces
  remain reusable, while current SQLite implementations co-locate entities and
  claims for transactional writes. This is not a v0.2 delivery commitment; see
  [Decisions §0](01-DECISIONS.md#0-name-and-scope--amended-2026-09-20).

### 5.3 ArtifactBackend

Artifact uploads and resource filters accept either a task's bare ID (for example,
`task.api-routes`) or its matching `<type>:<id>` claim alias
(`task:task.api-routes`). Resolution checks the database, with an exact ID match
taking precedence over alias parsing. Stored and returned artifact resources use
the bare ID; claim resources remain typed. Text, multipart, and versioned uploads
share this behavior, as do list, latest, search, and grep filters.

Generated legacy Worker blob keys and resource metadata use the bare ID, so both
spellings deduplicate to the same artifact. Existing blob keys and caller-supplied
keys are preserved. Missing or mismatched upload resources return non-retryable
`400 validation-error`; unknown read filters retain empty/not-found results.
Idempotency keys still require identical request bodies: changing only the alias
spelling with the same idempotency key remains a conflict.

```typescript
interface ArtifactBackend {
  put(input: ArtifactPutInput): Promise<ArtifactPutResult>;
  get(key: string): Promise<ArtifactGetResult | null>;
  list(filter: ArtifactFilter): Promise<ArtifactPointer[]>;
  delete(key: string, options?: { force?: boolean }): Promise<void>;

  // Lifecycle (configured per backend; this is for inspection)
  getLifecycleRules(): Promise<LifecycleRule[]>;
  setLifecycleRules(rules: LifecycleRule[]): Promise<void>;

  capabilities: ArtifactBackendCapabilities;
}

interface ArtifactPutInput {
  key: string;                          // 'tasks/T-142/<sha256>.md'
  body: Uint8Array | string;
  metadata: ArtifactMetadata;           // task, fence, machine, kind, mime
  ifNoneMatch?: string;                 // CAS for write-once
  ifMatch?: string;                     // CAS for mutable pointers
}
```

Current implementations:

- `r2` — content-addressed blobs with Worker-driven cleanup; see [version-aware retention and deletion](#version-aware-retention-and-deletion) for immutable revision lifecycle. An R2 lifecycle backstop must exclude the `versioned/` prefix.
- `local-filesystem` — content-addressed local blobs with pointers in the same SQLite DB. Standalone local persistence remains compatibility; its lifecycle-rules inspection returns an empty array. It is not a new parity target under [Decisions §0](01-DECISIONS.md#0-name-and-scope--amended-2026-09-20).

Test fixtures: a Map-backed in-memory fake ArtifactBackend in `packages/core/test/fixtures/` for unit testing.

---

## Section 6: tila.schema.toml — the schema format

The schema file declares everything tila needs to know about consumer-defined types: what work-unit types exist and how they nest, what artifact kinds exist and what they require, what reference and relationship edges are legal. The format has four logical sections.

### 6.1 File format

```toml
# tila.schema.toml — schema definitions for this project
schema_version = 1

# ---------------------------------------------------------------------------
# WORK UNITS — entities that participate in the hierarchy
# ---------------------------------------------------------------------------

[work_units.task]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "description", required = false, type = "text" },
  { name = "status", required = true, type = "enum", values = ["open", "in_progress", "blocked", "done", "cancelled"] },
  { name = "spec", required = false, type = "text" },
]
parents = ["issue"]
required_parent = false
references = [
  # Declared slots for entity-to-artifact references. Each slot names the
  # artifact kinds that can be referenced and whether multiple are allowed.
  { name = "research_sources", multiple = true, kinds = ["research", "interview", "spec"] },
  { name = "prior_lessons", multiple = true, kinds = ["lesson"] },
]

[work_units.issue]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "description", required = false, type = "text" },
  { name = "status", required = true, type = "enum", values = ["open", "in_progress", "done"] },
  { name = "labels", required = false, type = "list<string>" },
]
parents = ["epic"]
required_parent = false

[work_units.epic]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "description", required = false, type = "text" },
  { name = "owner", required = false, type = "string" },
  { name = "status", required = true, type = "enum", values = ["proposed", "active", "done", "cancelled"] },
]
parents = []

# ---------------------------------------------------------------------------
# HIERARCHY — declares the canonical work-unit nesting
# ---------------------------------------------------------------------------

[hierarchy]
levels = ["epic", "issue", "task"]     # ordered: epic contains issue contains task
max_depth = 3                          # rejected: creating a child of a task (a leaf)

# When [hierarchy] is declared, the last level (`task`) is implicitly a leaf:
# tila refuses to create parent-child edges that exceed max_depth. When [hierarchy]
# is omitted, no canonical hierarchy is enforced; per-type `parents` arrays
# still work, but depth is not checked.

# ---------------------------------------------------------------------------
# ARTIFACTS — content-addressed blobs produced or uploaded into the project
# Searchability defaults: memory-like text kinds opt into FTS5 indexing
# (searchable=true, search_mode="full_text"). Binary or ephemeral kinds
# opt out (searchable=false). When searchable is omitted, it defaults to false.
# ---------------------------------------------------------------------------

[artifacts.lesson]
mime_types = ["text/markdown"]
retention_days = 0                     # never expire
searchable = true                      # opt-in to FTS5 full-text indexing
search_mode = "full_text"

[artifacts.adr]
mime_types = ["text/markdown"]
retention_days = 0                     # never expire — architectural decisions
searchable = true
search_mode = "full_text"

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 30
searchable = true
search_mode = "full_text"
# A plan can stand alone; no other artifact is required.

[artifacts.design]
mime_types = ["text/markdown"]
retention_days = 90
searchable = true
search_mode = "full_text"

[artifacts.review]
mime_types = ["text/markdown"]
retention_days = 30
requires_reference_to = ["design"]
searchable = true
search_mode = "full_text"
# A review must include an artifact_relationship of type 'references' or
# 'derived-from' pointing at an artifact of kind 'design'. tila rejects
# uploads of a review without such a reference.

[artifacts.research]
mime_types = ["text/markdown", "application/pdf", "text/plain"]
retention_days = 0                     # source artifacts default to keep-indefinitely
searchable = true
search_mode = "full_text"
# Source artifacts (uploaded externally, not produced by a work unit) are
# stored under R2 prefix `sources/<sha256>.<ext>` with resource = NULL in
# artifact_pointers. Lifecycle rules in tila.lifecycle.json exempt the
# `sources/` prefix from automatic expiration regardless of retention_days.

[artifacts.index]
mime_types = ["text/markdown"]
retention_days = 0
searchable = true
search_mode = "full_text"
# Index artifacts gather entries of a given kind under a scope. See §7a.

[artifacts.patch]
mime_types = ["text/x-patch", "application/x-patch"]
retention_days = 7
searchable = false                     # binary-adjacent — not indexed

> **Searchability configuration:** Artifact kinds can opt in to lexical full-text search (FTS5) by setting `searchable = true` and `search_mode = "full_text"` in `tila.schema.toml`. See [docs/06-SEARCH.md](06-SEARCH.md) for configuration, CLI usage, and search limitations.

# ---------------------------------------------------------------------------
# ARTIFACT RELATIONSHIPS — the typed edges artifacts can have to each other
# ---------------------------------------------------------------------------

[artifact_relationships]
types = [
  "references",      # general citation
  "supersedes",      # this artifact replaces the older one
  "derived-from",    # produced by deriving from another artifact (e.g., a plan from a design)
  "extends",         # adds to without superseding
  "rebuts",          # disagrees with
  "index-of",        # this artifact indexes a collection (see §7a)
  "entry-of",        # this artifact is an entry in an index
]

# ---------------------------------------------------------------------------
# OPTIONAL: per-field migration metadata for backward-compat
# ---------------------------------------------------------------------------

[work_units.task.field_meta.priority]
added_in_version = 2
required = true
default_for_legacy = "medium"
```

#### Presentation metadata (#300)

A work unit or record definition may name which declared fields clients show
as its title, summary or description. The keys are optional and display-only:
they never change validation, storage, fencing or coordination.

```toml
[work_units.story]
fields = [
  { name = "headline", type = "string" },
  { name = "body", type = "text" },
]
presentation = { title = "headline", description = "body" }

[records.deploy-config]
fields = [{ name = "service", type = "string" }]
presentation = { title = "service", kind = "configuration" }
```

| Key | Applies to | Meaning |
|---|---|---|
| `title`, `summary` | work units, records | Declared `string`, `text` or `enum` field to show as the title or summary |
| `description` | work units | Declared text field to show as the long description |
| `kind` | records | `configuration` or `content`. Unset means the definition makes no claim |

- **Validation:** a slot must name a declared `string`, `text` or `enum` field,
  or the schema is rejected (the same rule as `lifecycle.field`). A record
  definition that relies on `schema_ref` with no local fields is not checked.
- **Fallback:** with an explicit `title`, an empty value stays empty and clients
  show the id; they never borrow another field. Without presentation metadata
  the title is `data.title`, then `data.name`, then the id. Clients never invent
  a placeholder such as "Untitled". `presentedTitle` in `@tila/schemas` is the
  shared implementation.
- **Classification:** whether a record is configuration or content comes only
  from `kind`. Clients must not infer it from the type name.
- **Evolution:** a presentation-only change is a non-destructive
  `definition-changed` and applies without a strategy.

### 6.2 Structural constraints tila enforces from the schema

tila validates writes against the declared schema. The validation rules are limited and structural — tila does not validate semantic content, only data shape and the structural invariants below.

| Constraint | Source | Enforced at |
|---|---|---|
| Work-unit field types and `required` flags | `[work_units.<type>.fields]` | Entity create/update |
| Allowed parent types for a work unit | `[work_units.<type>.parents]` | `entity_relationships` create with type `parent-child` |
| `required_parent = true` | `[work_units.<type>]` | Entity create |
| Canonical hierarchy depth | `[hierarchy].max_depth` | `entity_relationships` create with type `parent-child` |
| Leaf-type child rejection | last entry in `[hierarchy].levels` | `entity_relationships` create with leaf as parent |
| Artifact kind must be declared | `[artifacts.*]` | `artifact_pointers` insert |
| MIME type must be allowed | `[artifacts.<kind>].mime_types` | `artifact_pointers` insert |
| Required artifact references | `[artifacts.<kind>].requires_reference_to` | `artifact_pointers` insert; rejected if no matching `artifact_relationships` edge exists in same transaction |
| Entity-artifact reference slot | `[work_units.<type>.references]` | `entity_artifact_references` insert |
| Referenced artifact kind matches slot | slot's `kinds = [...]` | `entity_artifact_references` insert |
| Multiple-reference allowed | slot's `multiple = bool` | `entity_artifact_references` insert |
| Artifact relationship type declared | `[artifact_relationships].types` | `artifact_relationships` insert |

These are structural checks — they verify "does this edge make sense in the declared schema." tila does NOT validate that a review *actually reviews* the design it references; only that a reference of the right kind exists. Semantic validation is the consumer's concern.

#### Work lifecycle and readiness

An optional `[work_units.<type>.lifecycle]` declares the business states used for readiness. It does not enroll or launch work. The checked-in task definition, like the one `tila project create` generates, uses `status`, dispatches only from `open`, and treats `done` as successful while `failed`, `cancelled` and `deferred` remain terminal but do not satisfy dependencies.

| Field | Meaning |
|---|---|
| `field` | Declared string/text/enum field carrying the business state |
| `dispatchable` | States from which work may be admitted |
| `terminal` | Finished business states, disjoint from dispatchable states |
| `dependency_satisfied` | Explicitly successful terminal states |
| `on_start`, `outcomes.success/failure/cancelled/abandoned` | Optional execution-to-business-state mappings; absent mappings leave business status unchanged |

Declared states must match the field's allowed values when present. Start mappings cannot be terminal. Outcome mappings may target nonterminal states: an attempt can fail and return a ticket to `open` for a retry, or succeed and leave it awaiting review. Entity writes validate lifecycle field values against the current definition within the project transaction; custom terminal transitions enforce pending gates, including gates addressed by the canonical resource name.

`tila task close <id> --outcome <outcome>` closes work through this declaration, in local and remote mode alike. It reads the task's type and the applied definition, looks up `lifecycle.outcomes.<outcome>`, and writes that state to `lifecycle.field`. It writes no other field: it never stores `status: closed` or an `outcome` value. Accepted outcomes are `success`, `failure`, `cancelled` and `abandoned`, plus the earlier words `completed` (`success`) and `deferred` (`abandoned`). Anything else is rejected before the backend is opened. The command also refuses, before any write, when no definition is applied or the stored one cannot be read, the task's type declares no lifecycle, the outcome has no mapping, or the mapped state is not listed in `lifecycle.terminal`; an attempt may still map an outcome to a nonterminal state, but closing a task may not.

Existing projects are not migrated. The generated and bundled definitions declare all four outcomes on `status` (`done`, `failed`, `cancelled`, `deferred`), but a project created earlier keeps the definition it applied. To use `task close` there, add a `[work_units.<type>.lifecycle]` table and its `[work_units.<type>.lifecycle.outcomes]` mappings (see `tila.schema.toml`), include the mapped states in the lifecycle field's values, and run `tila schema apply`. Tasks closed by earlier CLI versions keep their stored `closed` status and `outcome` data.

Readiness respects hard and soft dependency edges, unresolved gates, archive state, and transitive prerequisites. Cycles remain blocked with a diagnostic path. Archiving an unfinished predecessor never counts as success; an explicitly successful predecessor can subsequently be archived without losing its recorded success. Configured work depending on an unconfigured type is blocked until its predecessor's lifecycle is declared. The shared evaluator returns diagnostic reasons for missing work, missing lifecycle metadata, unsuccessful dependencies, cycles and gates.

Unconfigured types retain legacy readiness (`status != closed`, archived predecessors ignored, soft blockers included by default). Managed admission requires lifecycle metadata explicitly and cannot use this fallback. The dashboard explains the fallback beside blocked-work counts instead of altering it (§14.9). Readiness inspection remains read-only: it ignores expired timer gates without resolving them or appending journal events. Execution ownership and queue capacity are separate admission checks.

### 6.3 Adding a new work-unit type

The applied definition in project DO SQLite is authoritative. The CLI previews
and applies a file (or the composed `*.schema.toml` fragments) with
`tila schema import`, which merges by default (§14.6); `tila schema apply` still
submits the fragments as the whole definition. MCP `tila_schema_update` and the
Worker schema endpoint use the same parser/ops.
Adding a type/kind is a definition revision, not a database migration. The server
increments `_schema_history.version`; the file's `schema_version` is separate.
Revision-checked TOML writes are described in §2.5. Settings › Definitions edits
the same definition in the browser (§14.2); a typed structured input remains #296.

### 6.4 Adding a required parent to an existing work-unit type

The current diff classifies destructive changes and preview reports affected data.
Apply rejects a destructive diff without a strategy. The implemented strategies
are `relax` and `force`; neither is an interactive migration/backfill engine.
`migrate`, `default-parent` and automatic reparenting are not supported strategies.
Conditional destructive applies bind to the reviewed revision and definition as
described in §2.5. Broader affected-data reconciliation remains in #296; the
dashboard review presents the preview impact without claiming automatic data repair.

### 6.5 Adding a new artifact kind

Artifact policies are part of the applied definition. New versioned writes and
restores capture the current policy; later edits do not rewrite assigned expiry.
See [version-aware retention](#version-aware-retention-and-deletion) and §14.4.
The deployment's R2 backstop is separate operational configuration and must never
expire the private `versioned/` prefix.

### 6.6 Removing a work-unit type or artifact kind

Removing a declaration does not delete its stored rows, edges or blobs. Preserve
legacy data visibility and show the affected-data preview. Explicit task/record
archive and artifact deletion are separate authorized operations. Do not advertise
unimplemented `--archive`, `--delete` or `task convert` schema-apply options.
The required editor retirement contract is in §14.2–§14.4.

### 6.7 Tolerant reads

Stored content retains schema history references and unknown data fields. Entity
read enrichment uses its stored applied revision and the supported lazy
`default_for_legacy` behavior; it does not bulk-migrate the database. Writes use
current validation, so readable legacy content may need an explicit correction
before a new write is accepted. A missing/corrupt schema is not evidence of an
empty project. See §14 for revision and compatibility boundaries.

---

## Section 7: Artifact storage details

### 7.1 Two flavors of artifact

Artifacts come in two structurally distinct flavors. The flavor is determined by whether `resource` is set on the pointer row.

**Produced artifacts** are emitted by a work unit during work. They have a producing work unit recorded in `artifact_pointers.resource` and a fencing token captured at write time. They live under R2 prefixes named after the work-unit type:

```
tasks/<task-id>/<sha256>.<ext>
issues/<issue-id>/<sha256>.<ext>
epics/<epic-id>/<sha256>.<ext>
```

Examples:
- `tasks/task-a1b2c3/3f4d5e6f...abc.md`
- `issues/issue-d4e5f6/0011223344...xyz.md`

**Source artifacts** are uploaded as project-level inputs, not produced by any work unit. They have `resource = NULL`, no fence (no claim is held during upload — the schema validates the kind, that's all), and live under a single prefix:

```
sources/<sha256>.<ext>
```

Examples:
- `sources/aabbccdd...ee.pdf` (a research PDF)
- `sources/1122334455...ff.md` (an external spec)

Source artifacts are referenced from work units via `entity_artifact_references` rows. A task that consults research declares the reference via `tila task ref add T-142 sources/aabb...ee.pdf --slot=research_sources`; the slot is validated against the schema's declared reference slots for the work-unit type.

**Mutable pointers** (e.g., "latest plan for T-142") live under a separate prefix and are NOT content-addressed:

```
pointers/<resource-id>/<name>.json
```

These are used for the rare cases where a stable, mutable forwarder is needed (typically by the UI to render "the current plan"). The content-addressed artifact is always the source of truth; mutable pointers are convenience.

### 7.2 Metadata

Every artifact carries:

```
x-amz-meta-tila-resource:    task:task-a1b2c3 | (empty for sources)
x-amz-meta-tila-fence:       42 | (empty for sources)
x-amz-meta-tila-principal:   github:github.com:123456
x-amz-meta-tila-participant: 550e8400-e29b-41d4-a716-446655440000
x-amz-meta-tila-kind:        plan | design | review | patch | transcript | research | lesson | index | ...
x-amz-meta-tila-mime:        text/markdown
x-amz-meta-tila-produced-at: 2026-05-15T10:28:11Z
x-amz-meta-tila-schema-version: 1
```

For markdown artifacts, the same fields are duplicated in YAML frontmatter. If R2 metadata is lost (e.g., during migration), frontmatter preserves the record.

### 7.3 Lifecycle policy: Worker-driven cleanup, not R2 lifecycle

**Primary mechanism: Worker-driven sweep.** A Cron Trigger fires the Worker at `/_internal/sweep` daily at low-traffic time (configurable; default 03:00 UTC). The Worker queries the DO for `artifact_pointers` rows where `expires_at <= now() AND tombstoned = 0`, then:

1. DELETE each blob from R2.
2. UPDATE the pointer row to `tombstoned = 1` (keeps it for audit).
3. APPEND `artifact.expired` journal events.

All three happen inside one DO transaction per artifact. Tombstoned pointer rows remain queryable indefinitely so that the journal stays consistent — "we once had this; it was expired on date X."

Why Worker-driven instead of R2 native lifecycle:
- **Deterministic timing.** R2 lifecycle is eventually-consistent with sloppy timing (hours, sometimes a day, between rule match and actual delete). Worker-driven cleanup runs at known times.
- **Journal-traceable.** Every deletion emits a journal event. R2 native lifecycle leaves no audit trail in tila.
- **Tila-aware exemption.** The Worker reads `artifact_pointers.expires_at` (which the Worker itself sets at write time based on the schema's `retention_days` for the kind, with source artifacts getting NULL). No prefix-matching gotchas; the schema is the truth.
- **No coupling to R2 prefix conventions.** If a future schema change moves artifacts to different prefixes, the sweep code doesn't need to change.

**Backstop: R2 native lifecycle as belt-and-suspenders.** A minimal R2 lifecycle policy is also applied, with very long TTLs (1 year on `tasks/`, `issues/`, `epics/`). If the Worker-driven sweep fails for an extended period (cron triggers stop firing, billing issue, etc.), R2's native lifecycle eventually cleans up. The journal will show no `artifact.expired` event for these — that's the signal that the backstop fired and reconciliation is needed.

```json
// Bundled default R2 lifecycle backstop (only fires if Worker sweep fails for ~1 year)
{
  "Rules": [
    {
      "ID": "backstop-tasks-1y",
      "Filter": { "Prefix": "tasks/" },
      "Expiration": { "Days": 365 },
      "Status": "Enabled"
    },
    {
      "ID": "backstop-issues-1y",
      "Filter": { "Prefix": "issues/" },
      "Expiration": { "Days": 365 },
      "Status": "Enabled"
    },
    {
      "ID": "backstop-epics-1y",
      "Filter": { "Prefix": "epics/" },
      "Expiration": { "Days": 365 },
      "Status": "Enabled"
    },
    {
      "ID": "keep-sources-forever",
      "Filter": { "Prefix": "sources/" },
      "Status": "Disabled"
    },
    {
      "ID": "keep-indexes-forever",
      "Filter": { "Prefix": "indexes/" },
      "Status": "Disabled"
    },
    {
      "ID": "abort-incomplete-uploads-1d",
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 },
      "Status": "Enabled"
    }
  ]
}
```

`sources/`, `indexes/`, and `pointers/` are exempt from the backstop entirely; they should never expire.

**The schema's `retention_days` is the source of truth.** When an artifact is written, the Worker computes `expires_at = produced_at + (retention_days * 86400 * 1000)` and stores it on the pointer row. `retention_days = 0` (the source-artifact default) means `expires_at = NULL` and the artifact is exempt from sweep entirely.

Users override per project by editing `.tila/lifecycle.json` (the backstop) and the schema (the actual per-kind retention).

### 7.3a Search projection semantics

Search documents in `artifact_search_docs` are a recoverable projection of artifact state. Their lifecycle is symmetric with the pointer lifecycle:

- **On artifact upload (T5):** A search doc is inserted atomically with the pointer if the artifact kind is searchable and the MIME type is text-native (`text/markdown`, `text/plain`). The `asd_ai` FTS5 trigger propagates the insert to `artifact_search_docs_fts`.
- **On tombstone (T12):** The search doc is deleted atomically within the same `tombstonePointer` transaction. The `asd_ad` FTS5 trigger fires on the DELETE, removing the FTS entry.
- **On sweep expiry (T12):** The Worker calls `/artifact/tombstone` per expired key after R2 deletion. The tombstone transaction deletes the search doc — same code path as explicit tombstone.
- **`sources/` and `indexes/` exemption:** These artifacts carry `expires_at = null` and are never returned by `listExpiredPointers`. Sweep does not touch their search docs. An explicit tombstone of a `sources/` artifact will delete its search doc if one was indexed.
- **Rebuild (T11):** Search docs are a recoverable projection. The rebuild path can backfill docs for pointers that lack them and delete orphan search docs for tombstoned pointers.

### 7.4 Write protocol

```typescript
// Pseudocode for the Worker's artifact write handler.
// DO-first: pointer row and journal event commit in one DO transaction; R2 write is the
// only cross-backend step. See §3a.6 for the full cross-backend ordering rules.
async function putArtifact(req: Request, env: Env): Promise<Response> {
  const input = await req.json();
  const { resource, fence, body, kind, mime, idempotencyKey } = input;
  const identity = resolveAuthenticatedIdentity(req); // principal is never read from input

  // 1. Idempotency check (global D1 lookup, cached for 60s in Worker memory)
  const cached = await checkIdempotency(env.GLOBAL, idempotencyKey);
  if (cached) return cached;

  // 2. Validate fence (one DO round-trip, no transaction needed for read)
  const projectDO = env.PROJECT.get(env.PROJECT.idFromName(env.PROJECT_ID));
  const state = await projectDO.fetch('https://do/coord/state?resource=' + encodeURIComponent(resource));
  const { claim } = await state.json();
  if (
    !claim ||
    claim.principal_id !== identity.principal_id ||
    claim.participant_id !== identity.participant_id ||
    claim.fence < fence
  ) {
    return Response.json({ ok: false, reason: 'stale-fence' }, { status: 409 });
  }

  // 3. Compute hash and R2 key
  const sha256 = await computeSha256(body);
  const ext = extForKind(kind);
  const key = resource
    ? `${prefixForResource(resource)}/${resource.split(':')[1]}/${sha256}.${ext}`
    : `sources/${sha256}.${ext}`;

  // 4. Conditional PUT to R2 (via aws4fetch, the only cross-backend op)
  try {
    await r2.put(key, body, {
      ifNoneMatch: '*',  // refuse to overwrite
      contentType: mime,
      customMetadata: {
        'tila-resource': resource ?? '',
        'tila-fence': String(fence),
        'tila-principal': identity.principal_id,
        'tila-participant': identity.participant_id,
        'tila-kind': kind,
        'tila-produced-at': new Date().toISOString(),
      },
    });
  } catch (e) {
    if (e.status === 412) {
      // Content already exists at this hash. Same content, same key. Deduplicated.
      return Response.json({ ok: true, key, deduplicated: true });
    }
    throw e;
  }

  // 5. DO transaction: pointer row + journal event together.
  // If this fails after R2 succeeded, the blob is orphaned but recoverable
  // via `tila doctor --reconcile`. See §3a.6 and edge case 10.45.
  await projectDO.fetch('https://do/artifact/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({
      r2_key: key,
      resource,
      kind,
      sha256,
      bytes: body.byteLength,
      fence,
      identity,
      mime_type: mime,
      // Includes any required-reference inserts for [artifacts.<kind>].requires_reference_to
      references: input.references ?? [],
    }),
  });

  // 6. Cache idempotency result in global D1
  await recordIdempotency(env.GLOBAL, idempotencyKey, { ok: true, key });

  return Response.json({ ok: true, key });
}
```

The DO endpoint `/artifact/record` runs a single SQLite transaction that inserts the pointer row, inserts any required-reference edges into `artifact_relationships`, and appends the `artifact.produced` event to the journal. All three commit atomically.

---

## Section 7a: Artifact relationships and the index/entry pattern

Beyond the artifact-to-resource relationship (an artifact belongs to a task), tila supports artifact-to-artifact relationships. This is what lets users build cross-references, lessons-learned cross-links, index/entry structures, and any other composition of artifacts.

### 7a.1 Relationship types

A relationship is a typed edge from one artifact to another (or from an artifact to an external URI). The type is a string; tila ships with a small standard vocabulary, and users can declare additional types in `tila.schema.toml`.

**Standard types:**

- `references` — generic citation. "This artifact mentions or cites that one."
- `supersedes` — "This artifact replaces an earlier one." Implies the earlier one is obsolete but preserved for audit.
- `derived-from` — "This artifact's content was built on that one." Used in chain-of-reasoning, refinement, or extraction workflows.
- `extends` — "This artifact adds to that one without replacing it."
- `index-of` — "This artifact (an index) catalogs that one (an entry)." Bidirectional with `entry-of`.
- `entry-of` — "This artifact (an entry) is cataloged by that one (an index)."
- `rebuts` — "This artifact argues against that one." Useful in decision-log workflows where reversals happen.

**Custom types** declared in schema config:

```toml
[artifact_relationships]
types = ["references", "supersedes", "derived-from", "extends", "index-of", "entry-of", "rebuts", "implements", "tests"]
```

The engine treats unknown types as opaque strings; no validation other than "this type must be declared in the schema."

### 7a.2 Where references are recorded

References are written in three places, deliberately redundant for durability:

1. **DO SQLite `artifact_relationships` table** — canonical (per-project). Indexed for fast queries ("what cites this," "what does this cite," "what's the index of this entry").
2. **YAML frontmatter** in the artifact body, for markdown artifacts:

```yaml
---
tila:
  task: task-a1b2c3
  fence: 42
  machine: alice@machine-A
  kind: lesson
  produced_at: 2026-05-15T10:28:11Z
  schema_version: 1
  references:
    - to: tasks/T-098/def456abc.md
      type: derived-from
      note: "Same root cause as the earlier auth bug"
    - to: epics/E-5/index.md
      type: entry-of
    - uri: https://github.com/myorg/myrepo/pull/4231
      type: references
      note: "PR where the fix landed"
---

# Lesson: token rotation must be atomic
...
```

3. **R2 object metadata** as a JSON-encoded header `x-amz-meta-tila-refs`. S3 metadata has a ~2KB limit, so this is a best-effort copy of up to ~10 most-important references. D1 and frontmatter are canonical for artifacts with many references.

### 7a.3 Reference ingestion

When `tila artifact put` is called with references:

1. Explicit `--ref to=<key> type=<type> [note=...]` flags on the CLI, OR
2. Frontmatter in the file body, OR
3. R2 metadata in the upload headers

These should agree; tila prefers explicit flags > frontmatter > R2 metadata. Disagreements log a warning and the canonical form is written to all three places.

### 7a.4 The index/entry pattern

Index/entry is not a tila primitive — it's a pattern composed from artifact kinds + relationship types.

**An index** is an artifact with `kind = "index"` (or any name the user picks; a framework might use `lesson-index`, `decision-index`, etc.). Its body typically describes what the index covers; the actual entry list is queried, not stored in the body.

**Entries** are artifacts with their own kind (`lesson`, `decision`, `principle`, or task-specific). Each entry has an `entry-of` reference back to its index.

**Listing entries of an index:**

```sql
-- Conceptually what tila does:
SELECT p.* FROM artifact_pointers p
JOIN artifact_relationships r ON r.from_key = p.r2_key
WHERE r.to_key = '<index-key>' AND r.type = 'entry-of'
ORDER BY p.produced_at DESC;
```

**CLI convenience commands:**

```
tila index create --kind=lessons --resource=epic:E-5
  → creates an artifact of kind 'index' under epic E-5

tila index add-entry <index-key> <entry-key>
  → adds an entry-of relationship from entry to index
  → also adds an index-of relationship from index to entry

tila index list-entries <index-key>
  → queries artifact_relationships and returns entry pointers

tila entry find --index=<index-key> [--filter=...]
  → same as list-entries with optional filters on kind, age, etc.
```

### 7a.5 Lifecycle interaction with relationships

Two cases worth handling explicitly:

**An entry expires (lifecycle deletes it) but the index still references it.** The relationship row in D1 persists (it's audit). Queries surface a tombstone:

```json
{
  "key": "tasks/T-098/def456abc.md",
  "exists": false,
  "expired_at": "2026-04-15T...",
  "relationship_type": "entry-of"
}
```

UI renders this as a strikethrough entry with the date it was lifecycle-deleted. Users can `tila artifact ref remove` to prune the relationship if desired.

**An index should not expire even though it lives under a resource that has retention.** Indexes are typically structural and long-lived. Lifecycle rules:

- Put indexes under a dedicated R2 prefix (`indexes/`) with lifecycle rule status disabled.
- OR mark individual artifacts as lifecycle-exempt via `x-amz-meta-tila-lifecycle: keep` (R2 lifecycle rules can be filtered by metadata).

The bundled `tila.lifecycle.json` exempts both `pointers/` and `indexes/` prefixes from expiration by default. Users can customize per project.

### 7a.6 Why lessons-learned is not a tila primitive

A common request: "tila should have a lessons-learned feature." It should not. Reasoning:

- Lessons learned is a *workflow shape*, not a *primitive*. Different domains structure lessons differently — pipeline retros differ from research-agent learnings differ from content-workflow style notes.
- The primitives needed for any lessons-learned workflow already exist in tila as three composable concepts: artifact kinds, artifact-to-artifact relationships, and entity-to-artifact references.
- Any framework on top of tila builds the workflow by composing these primitives.

How a consumer composes a lessons-learned workflow:

1. **Declare a `lesson` artifact kind** in `[artifacts.lesson]` with `retention_days = 0`.
2. **Declare a `prior_lessons` reference slot** in `[work_units.task.references]` so future tasks can cite relevant past lessons via `entity_artifact_references`.
3. **Optionally declare `lesson-index` artifact kind** with `[artifact_relationships].types` including `index-of` and `entry-of` for aggregation under epics or themes.
4. **A retrospective command in the consuming framework** queries the journal, produces lesson artifacts via `tila artifact put --kind=lesson`, attaches them to indexes via `tila artifact rel add --type=entry-of`, and optionally links new tasks to relevant lessons via `tila task ref add --slot=prior_lessons`.

The three relationship tables (`entity_relationships`, `entity_artifact_references`, `artifact_relationships`) cover the full graph: lessons connect to their producing task (via `artifact_pointers.resource`), to past related lessons (via `artifact_relationships`), to consuming future tasks (via `entity_artifact_references`), and to scoped indexes (via `artifact_relationships` of type `entry-of`).

The principle is reusable: any feature that maps to "an artifact of a specific kind with specific cross-references" belongs in the consuming framework, not in tila.

---

## Section 8: End-to-end flows

### 8.1 Task claim and work cycle

Alice's autopilot runs `tila task claim T-142` on machine-A (likely orchestrated by a framework like the hypothetical "sisu" but expressed in tila primitives), with Bob already working on a different task:

```
T+0:00  CLI: tila task claim T-142
        → reads .tila/config.toml, gets Worker URL and token

T+0:01  CLI: GET <worker>/tasks/T-142
        → Worker: D1 lookup, DO state check
        → Returns: { entity: {...}, claim: null }

T+0:02  CLI: POST <worker>/acquire
        Header: X-Tila-Participant-Id: 550e8400-e29b-41d4-a716-446655440000
        Body: { resource: "task:T-142", mode: "exclusive", ttl_ms: 600000 }
        → Worker routes to DO
        → DO single SQLite transaction:
            SELECT * FROM claims WHERE resource = 'task:T-142'
            → null (or expired)
            SELECT current_fence FROM fences WHERE resource = 'task:T-142'
            → 41 (or NULL if first time, defaults to 0)
            UPDATE fences SET current_fence = 42 WHERE resource = 'task:T-142'
            INSERT INTO claims (resource, principal_id, participant_id, mode, fence, ...) VALUES (..., 42, ...)
            INSERT INTO journal (kind, resource, principal_id, participant_id, fence, data, ...) VALUES ('task.claimed', 'task:T-142', ..., 42, ...)
            COMMIT
        → DO returns { ok: true, fence: 42, expires_at: ..., participant_id: "550e..." }
        → Worker returns to CLI

T+0:03  CLI begins agent work.
        → Background renew loop: POST /renew every 60s with { resource, fence: 42 }

T+0:14  Agent produces 3 artifacts.
        → CLI uploads each via PUT /artifacts/<key>
        → Each upload includes fence=42 in metadata
        → Worker validates fence against current claim (one DO read), PUTs to R2 with If-None-Match: *
        → Worker calls DO /artifact/record; DO transaction inserts pointer row, required-reference edges, and 'artifact.produced' journal event

T+0:15  Work complete. CLI: POST /release
        Body: { resource: "task:T-142", fence: 42 }
        → DO single transaction: DELETE FROM claims; INSERT journal('task.released'); INSERT journal('task.completed')

T+0:16  Meanwhile, Bob's machine had stale local state and was about to pick T-142.
        → POST /acquire returns { ok: false, reason: 'completed-at-fence-42-by-alice' }
        → Bob's autopilot picks next task. No work wasted.
```

### 8.2 Stale lease recovery

Alice's machine sleeps mid-work. Lease expires.

```
T+0:00  Alice acquires task:T-142, fence=42, ttl=600s.
T+0:05  Alice's laptop closes. Renew loop stops.
T+10:00 Lease expires. (Lazy — not actively cleared.)
T+10:30 Bob's autopilot scans for ready tasks.
        → POST /acquire for task:T-142
        → DO sees expired claim, treats as released.
        → Increments fence to 43. Returns { ok: true, fence: 43 }.
T+15:00 Alice's laptop wakes up. Agent tries to commit artifact with fence=42.
        → Worker: getResourceState shows current fence is 43.
        → Returns 409 { ok: false, reason: 'stale-fence' }.
        → CLI aborts the artifact write. Logs the lost-lease event.
        → No clobber of Bob's work.
```

### 8.3 Issue ownership (principal-scoped)

Alice takes ownership of issue I-23:

```
CLI: POST /acquire
Header: X-Tila-Participant-Id: 550e8400-e29b-41d4-a716-446655440000
Body: { resource: "issue:I-23", mode: "owner", ttl_ms: 86400000 }

DO transaction:
  INSERT INTO claims (resource, principal_id, participant_id, mode, fence, ...) VALUES (...)
  → A different principal conflicts.
  → The same principal from a different participant transfers ownership and increments the fence.
  → The previous participant can no longer renew or release.

Returns { ok: true, fence: 7, participant_id: "550e..." }.
```

Bob can still claim individual task resources within I-23 via exclusive mode. The issue owner claim and task claims are on different resources.

### 8.4 DO eviction and recovery

A DO instance is evicted (idle eviction, or Cloudflare-initiated migration):

```
1. The next request to the DO triggers cold start: Cloudflare loads SQLite from storage,
   runs blockConcurrencyWhile(initFn) which checks and applies any pending migrations.
2. All durable state (entities, relationships, journal, claims, fences) is preserved
   in DO SQLite. Cold start typically adds 50-100ms to the first request.
3. Expired leases (where expires_at <= now()) are still in the claims table but are
   treated as released on read. The sweeper physically deletes them on its next run.
4. In-memory caches (parsed schema, prepared statements) rebuild lazily on next access.
```

If a DO is wiped (Cloudflare incident, manual reset via `tila reset`, accidental DO deletion):

```
1. CLI calls /api/health, gets a 5xx or empty state.
2. CLI calls `tila doctor` which reports the DO is uninitialized/inaccessible.
3. Recovery options:
   a. Restore the latest verified archive with
      `tila project import /absolute/path/project.tila-backup`. This restores the
      same project ID, exact journal sequence, fences, revisions, ACL metadata,
      artifact metadata, and blobs, then verifies a canonical semantic digest.
   b. If only R2 survives: `tila doctor --reconcile` walks R2, synthesizes artifact_pointers
      from R2 object metadata, and emits `artifact.reconciled` journal events. Entities and
      claims are lost; the user must recreate them.
   c. Otherwise: `tila reset --force` and start fresh.

In practice (a) and (c) are the expected outcomes; (b) is partial recovery for catastrophic
loss with no backup.
```

**The journal is the source of truth for "what happened."** A complete backup carries both confirmed archived ranges and the live tail, validates unique contiguous coverage through the archive watermark, and restores `sqlite_sequence` exactly.

### 8.5 Complete project backup format

Format v1 is an uncompressed tar stream. `header.json` is first and `manifest.json` is last; absence of the final complete manifest makes the archive unusable. Canonical JSONL sections live below `do/` and `d1/`, object metadata is in `objects.jsonl`, and deduplicated bytes are stored as `blobs/<sha256>`. Paths must be relative and traversal-free. Every entry declares bytes, rows where applicable, and SHA-256; the manifest binds them with a sorted content-root digest and a semantic digest of authoritative SQLite state.

V1 readers accept older v1 producers by applying schema defaults, ignore only explicitly declared optional sections, reject unknown required features, and reject DO migration versions newer than they support. Project renaming is unsupported because project IDs participate in Durable Object identity and artifact keys. The separate `tila-sdk/backup` entry exposes `inspectProjectBackup`, `exportProjectBackup`, `importProjectBackup`, and the infra-authenticated operator client; the main SDK and MCP surface remain unchanged.

Cloud export uses a renewable transfer lock: reads continue and all mutations, including sweep work and D1 ACL writes, return `423 project-maintenance`. Existing restore keeps one continuous lock across its verified safety export and promotion to a non-expiring import lock. Blobs are restored idempotently by checksum before pointers; rows follow dependency order; FTS virtual tables are rebuilt; D1 ACL replacement is batched; only then can the semantic digest unlock the project. Local replace stages a migrated database and artifact tree in sibling paths, verifies both, and swaps them into place with rollback on a failed swap.

---

## Section 9: CLI surfaces

### 9.1 tila commands

```
# Setup
tila project create           # provision a new tila project on Cloudflare
tila init              # join existing cloud project (team member onboarding)
tila login                       # Cloudflare OAuth (delegates to wrangler)

# Work-unit CRUD (same shape for any declared work-unit type)
tila task new "<title>" [--parent <id>] [--type <type>]
tila task list [--status=...] [--parent=...] [--ready] [--leaf-only]
tila task show <id>
tila task update <id> --field=value
tila task close <id> --outcome=success|failure|cancelled|abandoned   # also: completed, deferred
tila task archive <id>

tila issue new ...               # same shape as task
tila epic new ...                # same shape as task

# Hierarchy
tila tree show <id>              # render the hierarchy rooted at this work unit
tila tree stats                  # count of work units per level
tila tree ancestors <id>         # walk up to the root
tila tree descendants <id>       # walk down to all leaves

# Coordination
tila task claim <id> [--ttl=<seconds>]
tila task renew <id> --fence=<n>
tila task release <id> --fence=<n>
tila presence
tila state <resource>

# Produced artifacts (require an active claim)
tila artifact put <file> --task=<id> --fence=<n> --kind=<kind>
                  [--references=<key>:<rel-type>,...]   # for artifacts.<kind>.requires_reference_to
tila artifact get <key> [--output=<file>]
tila artifact list --task=<id>
tila artifact list --under=<entity-id>     # hierarchy-aware: walks descendants
tila artifact list --kind=<kind>
tila artifact delete <key>

# Source artifacts (project-level inputs, no claim required)
tila source put <file> --kind=<kind> [--mime=<type>]
tila source list [--kind=<kind>]
tila source get <key> [--output=<file>]
tila source delete <key>

# Work-unit to artifact references
tila task ref add <task-id> <artifact-key> --slot=<slot>
tila task ref list <task-id> [--slot=<slot>]
tila task ref remove <task-id> <artifact-key> --slot=<slot>

# Artifact-to-artifact relationships
tila artifact rel add <from-key> <to-key-or-uri> --type=<type> [--metadata-json=<json>]
tila artifact rel list <key> [--direction=outgoing|incoming]
tila artifact rel remove <from-key> <to-key-or-uri> --type=<type>

# Journal
tila journal tail [--filter=...]
tila journal show <seq>

# Schema
tila schema show
tila schema status                  # local *.schema.toml vs the server, by declaration
tila schema diff
tila schema import [file] [--mode=merge|replace] [--expected-revision=<n>]
tila schema export [--format=toml|yaml] [--output=<file>]
tila schema apply [--strategy=<strategy>]   # legacy whole-definition replace

# Lifecycle
tila lifecycle show
tila lifecycle apply

# Diagnostics
tila doctor
tila reset [--keep-artifacts] [--keep-entities-of-type=<type>]

# Config
tila config get <key>
tila config set <key> <value>

# Account
tila account list
tila account use <name>
```

### 9.2 What a framework consumer would invoke

For reference — a framework on top of tila (the hypothetical "sisu" consumer used throughout this document) would not extend the tila CLI; it would ship its own binary that imports `tila-sdk`, connects to `tila-mcp-server`, or invokes the `tila` CLI as a subprocess. tila does not bundle, declare, or know about framework-level commands. The shape of a framework's CLI is entirely the framework's concern.

An illustrative example of how a framework's commands compose tila primitives (this is consumer-side pseudocode, not part of tila):

```
# in a consuming framework's CLI:

framework work <task-id>
  → tila task claim <task-id>
  → invoke planning agent, write plan via tila artifact put --kind=plan
  → invoke implementation agent, write patches via tila artifact put --kind=patch
  → invoke review agent, write review via tila artifact put --kind=review
  → tila task release <task-id>

framework retro --since=<date>
  → tila journal tail --since=<date>
  → tila artifact list --kind=lesson
  → produce summary using local LLM call
  → tila artifact put --kind=retro-summary
```

The point: every framework operation reduces to tila primitives plus framework-local logic (agent invocation, prompt selection, LLM API calls). Frameworks are not tila's concern beyond ensuring the primitives are general enough to support them.

### 9.3 The TypeScript SDK

`tila-sdk` is a typed client over the Worker HTTP API. Framework authors who want type safety, programmatic control, or to avoid CLI subprocess overhead use the SDK directly:

```typescript
import { TilaClient } from "tila-sdk";

const client = new TilaClient({
  baseUrl: "https://tila-myproj.example.workers.dev",
  token: process.env.TILA_API_TOKEN!,
  participantId: "550e8400-e29b-41d4-a716-446655440000",
  environment: { machine: "build-host", client_name: "my-framework" },
});

const task = await client.entities.create({ type: "task", data: { title: "Refactor auth" } });
const claim = await client.claims.acquire({ resource: `task:${task.id}`, mode: "exclusive", ttlMs: 600_000 });
await client.artifacts.put({ resource: `task:${task.id}`, fence: claim.fence, kind: "plan", body: planMarkdown });
await client.claims.release({ resource: `task:${task.id}`, fence: claim.fence });

const service = await client.records.get({ type: "service", key: "api" });
```

Surface modules: `client.entities`, `client.records`, `client.artifacts`, `client.claims`, `client.gates`, `client.signals`, `client.journal`, `client.presence`, `client.schema`, `client.summary`, `client.templates`, and `client.tokens`. Request and response types come from `@tila/schemas` so contracts are type-checked end to end. The SDK handles retry with exponential backoff for transient 429 and 5xx responses; idempotency keys are generated automatically for mutating requests.

### 9.4 The MCP server

`tila-mcp-server` provides project workflows against the shared service or the explicit local SQLite subset. The CLI remains the comprehensive operator interface, constrained by the caller’s authority. Remote MCP runs under one restricted authentication run, supplied through a local credential broker or resolved from a native host session mapping on each request.

The default tools are `tila_session`, `tila_inspect`, `tila_claim`, `tila_publish`, `tila_signal`, and `tila_close`. Primitive groups remain explicitly opt-in. Tool discovery grants no backend permissions. The worker preset supports those workflows while excluding administration, deletion, infrastructure, credential management, and gate resolution.

An installation enrollment reuses one canonical service membership. Personal enrollments are capped by the enrolling human’s current project authority; shared installations use owner-authorized project membership. Each invocation creates its own run, participant, proof key, lease, and short-lived credential versions. The effective policy intersects the enrollment/workload ceiling, current membership and sponsor authority, initial run ceiling, and current workload restrictions.

D1 stores enrollment authenticators, run metadata, credential versions, one-use invitations, and proof/assertion replay state. Credentials are hashed. The strict `/api/runtime/context` endpoint returns the authenticated deployment, project, purpose, principal, participant, run, policy and expiry. Every request revalidates runtime authority before project reads or idempotency replay. Project restore revokes these authorizations.

The local helper holds enrollment secrets outside child environments and exposes a run-specific socket capability. Credentials expire after at most 15 minutes, renew two minutes before expiry, and overlap for at most 60 seconds. Heartbeats occur every minute; five minutes without one expires the run. Terminal states cannot be renewed. Session shutdown saves a handoff and releases exact captured claims before closing access, with a five-minute cleanup limit. `tila_close` itself does not close authentication.

Remote MCP rejects personal/owner tokens and ambient keychain authentication. Explicit local MCP works with `TILA_MODE=local`, `TILA_PROJECT_ID`, and absolute `TILA_DB_PATH` and `TILA_ARTIFACTS_PATH` paths; it rejects mixed remote credentials, `TILA_API_URL`, or run bindings. In remote mode, tools, resources, prompts and discovery share the authenticated per-request run scope. Missing host session mappings fail closed; clients without reliable mappings use one process per run.

Generic record resources at `tila://records/{type}/{key}` check the current project schema and `mcp_resource = true` at read time; startup does not fetch schema under enrollment authority.

See [runtime operations](05-OPERATIONS.md#runtime-enrollment-and-unattended-runs) for storage, recovery, supported session contracts, OIDC, and the coordinated 0.4.0 cutover. The broker is not an OS sandbox; hostile processes under one account require host-runtime isolation.

---

## Section 10: Edge cases and how they're handled

### 10.1 DO is unreachable on acquire
CLI refuses to start work. Error message: "Could not acquire coordination lock; check network or use `--no-coordinate` for single-machine mode." Fail-safe.

### 10.2 DO is unreachable on renew
Current critical section finishes (artifact in progress completes). No new work starts. On reconnect, reconcile via `tila doctor`. Fail-graceful.

### 10.3 R2 write fails after journal event was recorded
Journal event records the *intent* to produce an artifact. The pointer row in `artifact_pointers` is only created on successful R2 write. Discrepancy is detectable via `tila doctor`: journal says artifact X was produced, but no pointer row exists. Surface as a warning; do not auto-resolve.

### 10.4 Two machines acquire near-simultaneously
DO serialization handles this. The DO's single-threaded execution model means one acquire completes before the second begins to evaluate. The second sees the first's claim and returns 409.

### 10.5 Schema migration fails partway
Applied definitions, operation receipts and their journal event commit in one project SQLite transaction. Failure inside that transaction leaves no partial revision. This is not a D1 transaction or an atomic update across stores. After a lost response, retry with the same idempotency key and input; the receipt distinguishes a committed apply from a stale new write.

### 10.6 User downgrades tila to an older version
Product release, physical database migration, serialized schema-format version and applied definition revision are distinct. A high history revision does not by itself mean an older client cannot parse the format. Preserve existing compatibility checks; #296 owns the explicit settings-client transition, and #307 reports immutable release/protocol identity. Do not restore old definitions as a database downgrade.

### 10.7 User runs concurrent `tila schema apply` from two machines
Both callers send the revision they read as `expected_revision` (`tila schema import --expected-revision <n>` does). The first transaction commits; the second receives `schema-revision-conflict` and must read/preview again. Legacy callers that omit the precondition retain unconditional behavior outside managed projects, with an explicit warning and `schema.revisionless_applied` journal event on change. There is no schema claim or cross-store transaction in this path.

### 10.8 Lease TTL too short, agent loses lease mid-work
Renew loop runs every TTL/3 (default: every 60s for a 180s lease, every 200s for a 600s lease). If three consecutive renews fail, the agent aborts its current critical section and surfaces the issue.

### 10.9 R2 lifecycle deletes an artifact that the journal still references
Acceptable consequence. The journal preserves the *fact* that the artifact existed; the bytes are gone per the user-configured retention policy. `tila artifact get <key>` returns 404 with a journal cross-reference. `tila doctor` flags expired-but-referenced artifacts.

### 10.10 D1 free tier limit hit (5M reads/day, 100K writes/day)
Cloudflare returns 429. Worker propagates to CLI as "rate limit exceeded; check usage in Cloudflare dashboard." `tila doctor` includes current daily usage if available via Cloudflare API.

### 10.11 DO request limit hit (100K/day free)
Same handling. Pre-emptive: `tila status` shows recent rate, warns when approaching 80% of daily limit.

### 10.12 Worker URL changes
Treated as a project migration. `tila migrate --worker-url=<new>` re-keys the config; old Worker can be drained and decommissioned.

### 10.13 Network partition during write
The Worker is on Cloudflare's anycast network; partitions are rare. If a write to D1 succeeds but the response is lost, the CLI may retry and produce a duplicate write. Mitigation: include a client-generated `idempotency_key` (UUID) in every mutating request; D1 has a `request_log` table that rejects duplicate keys within a 1-hour window.

### 10.14 Clock skew between machines
All timestamps are recorded by the Worker (single clock). Client-supplied timestamps are advisory only. TTLs are computed at the DO using the DO's clock.

### 10.15 Project deleted from Cloudflare dashboard
CLI calls return 404 / DNS failure. `tila doctor` reports "Worker not reachable." User must `tila project create` again to create a new project; old data is unrecoverable unless they had exports.

### 10.16 `wrangler deploy` collides with an existing Worker of the same name
Init prompts: "A Worker named `tila-<slug>` already exists in your Cloudflare account. Reuse it? [y/N]" — if yes, attempts to bind to existing resources; if no, suggests a new project slug.

### 10.17 No project context (`.tila/config.toml` missing)
CLI commands that need project context (everything except `--version`, `--help`, `tila account list`) print: "no tila project found in current directory or any parent. Run `tila project create` to create one, or `tila init` to join an existing project." Exit code 1.

### 10.18 Multiple tila projects on one Cloudflare account
Fully supported. Each project has its own Worker, D1, R2 bucket, and DO namespace. Naming convention: `tila-<slug>` for everything. No cross-project isolation issues at the Cloudflare level.

### 10.19 Worker unreachable due to network issues
Every tila command makes at least one Worker call. On network failure: CLI prints "could not reach Worker at <url>; check connection. Use `tila doctor --offline` for diagnostics that don't require network." Exit code 2. No offline fallback; the tool requires network access to operate (consistent with the agentic-coding-needs-network premise).

### 10.20 D1 daily write quota approaching
Worker tracks daily write count in a `_quota` table (cheap: one row updated per write, with day rollover). When usage exceeds 80% of free-tier (80K writes/day), `/api/health` includes a warning. CLI surfaces the warning on `tila status`. At 100%, Cloudflare returns 429; CLI prints a clear "free tier write limit hit; consider upgrading or waiting until UTC midnight" message.

### 10.21 Framework consumer uses the same Claude API token as the user's interactive sessions
Acceptable. The framework's autopilot pulls `ANTHROPIC_API_KEY` from env at session start. Sub-agent invocations are independent API calls. No coordination with the user's interactive Claude Code session is needed; both call the same API with separate contexts. tila has no opinion or involvement here — LLM credentials never reach the Worker.

### 10.23 Editing the schema at runtime via CLI without editing toml
The current schema CLI exposes show/diff/apply/status and submits an explicit TOML definition; the add-work-unit/add-field/add-artifact/add-reference-slot conveniences described in the historical design are not implemented. Applied server state is authoritative. Settings › Definitions provides browser editors (#297), and files move in and out only through explicit import and export (#299, §14.6), so a local file never silently overwrites later server edits.

### 10.24 R2 lifecycle expires an artifact while UI is rendering it
UI fetches artifact metadata from D1 (`artifact_pointers`); fetches the blob from R2. If R2 returns 404 for an artifact the pointer references, the UI shows a "this artifact was deleted by lifecycle policy on <date>" placeholder, with the journal event still visible. The pointer row remains for audit; `tila doctor` can prune orphaned pointers if desired.

### 10.25 LLM API key handling (in framework consumers)
This is the consuming framework's concern, not tila's. A framework reads provider keys from env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) and makes LLM API calls locally in its own process. No LLM key is ever sent to the Worker or stored server-side by tila. The Worker only sees the resulting artifacts and journal events that the framework produces via `tila artifact put` and other primitives.

### 10.26 Worker version mismatch with CLI
CLI sends `X-Tila-CLI-Version` header. Worker returns `X-Tila-Worker-Version` in every response. Major-version mismatch triggers a warning; CLI suggests `tila worker upgrade` or `npm update`. The Worker version corresponds to a tila npm package version; upgrade redeploys via `wrangler deploy`.

### 10.27 User logged into wrong Cloudflare account
Detected at startup for provisioning-class commands by comparing `wrangler whoami` output to project's `cloudflare.account_id`. Error message names both accounts and offers options: `wrangler login` to switch, `--account=<id>` to override for this invocation, or cancel. Refuses to proceed silently on mismatch — destructive operations against the wrong account are unrecoverable.

### 10.28 Wrangler not installed
For provisioning-class commands, tila checks `wrangler --version` resolves. If not, prints install instructions (`npm install -g wrangler` or `bun add -g wrangler`) and exits. Runtime commands (tasks, artifacts, claims) do not require wrangler and proceed normally.

### 10.29 Wrangler not logged in
For provisioning-class commands, tila runs `wrangler whoami` and checks for valid auth. If unauthenticated, prints "run `wrangler login` first" with a hint that the same session works for tila. Optionally launches the login flow if user passes `--auto-login`.

### 10.30 Multiple Cloudflare accounts on one machine
Supported via per-shell `CLOUDFLARE_ACCOUNT_ID` env var that tila sets implicitly based on the project's config before shelling out to wrangler. User does not manually switch accounts; being in a project's directory is what makes that project's account active. `tila account list` enumerates accounts the local wrangler has credentials for; `tila account use <name>` outputs an `export CLOUDFLARE_ACCOUNT_ID=...` line suitable for `eval`.

### 10.31 Organization Cloudflare account policies override tila defaults
Acme Corp may enforce: R2 jurisdiction (EU only), custom Worker subdomain (`tila.acme.com`), retention policy overrides, restricted Worker permissions. These are configured at the Cloudflare account level and at `wrangler.toml`. tila's `.tila/config.toml` supports `[cloudflare] worker_subdomain`, `jurisdiction`, and `custom_domain` flags. Org admins publish these defaults in their org's onboarding docs; engineers run `tila project create` and apply the org's configuration overrides.

### 10.32 Service account / CI token usage
For unattended coding runs, use an enrolled shared runner with `tila run exec`, or supported runtime OIDC exchange. Remote MCP requires these restricted run credentials. Operator automation can still use a dedicated project API token issued via `tila token issue --name=ci-prod`, stored in CI secrets as `TILA_API_TOKEN`. Provisioning from CI (rare) uses a Cloudflare API token (not OAuth) scoped to the specific account, stored as `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. tila and wrangler both honor these env vars; no interactive login is required.

### 10.33 Creating a child of a leaf-type work unit
Schema declares `[hierarchy] levels = ["epic", "issue", "task"]`. User runs `tila task new --parent=<task-id>`. tila rejects: `task` is the last level in the hierarchy and therefore a leaf. Returns `409 hierarchy-leaf-child`: "cannot create a work unit as a child of leaf-type 'task'. Declare a deeper hierarchy level in tila.schema.toml or attach as a non-hierarchical relationship instead."

### 10.34 Parent-child relationship exceeding max_depth
Schema declares `[hierarchy] max_depth = 3`. User has E-5 → I-23 → T-142 already (depth 3). User attempts to create T-142's child. tila rejects: depth would exceed max_depth. Returns `409 hierarchy-max-depth-exceeded` with the same remediation path (raise max_depth in schema or use non-hierarchical relationship type).

### 10.35 Parent-child relationship outside declared hierarchy levels
Schema declares `[hierarchy] levels = ["epic", "issue", "task"]`. User attempts to create a parent-child edge from a `task` to a `bug` (a type not in `levels`). tila rejects: bug is not part of the declared hierarchy. The remediation is either to declare `bug` in `[hierarchy]` or to use a non-hierarchical relationship type (`related`, `discovered-from`, or custom).

### 10.36 Artifact upload missing a required reference
Schema declares `[artifacts.review] requires_reference_to = ["design"]`. User runs `tila artifact put review.md --task=T-142 --fence=42 --kind=review`. tila rejects: review requires a reference to a design artifact. Returns `409 missing-required-reference`. Resolution: include the reference in the put: `tila artifact put review.md --task=T-142 --fence=42 --kind=review --references=tasks/T-142/<design-sha256>.md:references`. tila inserts both the `artifact_pointers` row and the `artifact_relationships` row in a single transaction.

### 10.37 Entity-artifact reference to undeclared slot
Schema declares `[work_units.task.references]` with slots `research_sources` and `prior_lessons`. User runs `tila task ref add T-142 sources/aabb...ee.pdf --slot=external_links`. tila rejects: `external_links` is not a declared slot for type `task`. Returns `409 undeclared-reference-slot`. Resolution: declare the slot in schema and `tila schema apply`, or use an existing slot.

### 10.38 Entity-artifact reference to artifact of wrong kind
Schema declares slot `research_sources` accepts `kinds = ["research", "interview", "spec"]`. User runs `tila task ref add T-142 tasks/T-098/plan.md --slot=research_sources`. The referenced artifact is of kind `plan`, not research/interview/spec. tila rejects: `409 reference-kind-mismatch`. The reference is structurally legal (work unit can reference any produced artifact) but violates the slot's kind constraint. Resolution: pick a slot whose `kinds` includes `plan`, or extend the slot's allowed kinds in schema.

### 10.39 Source artifact lifecycle: keep indefinitely
Source artifacts under `sources/` are exempt from R2 lifecycle expiration by default. A user wanting to remove a source artifact must `tila source delete <key>` explicitly. This deletes the R2 object, the `artifact_pointers` row, and cascade-deletes any `entity_artifact_references` and `artifact_relationships` rows pointing to it. The deletion is recorded as a `source.deleted` journal event. Work units that had referenced the source will fail subsequent `tila task ref list` queries with a tombstone marker rather than disappearing silently.

### 10.40 Owning work unit archived while produced artifacts still exist
A work unit is archived (`archived = 1`). Its produced artifacts remain in R2 and `artifact_pointers`. R2 lifecycle continues to apply per-prefix retention; if a 30-day rule applies to `tasks/`, those artifacts expire as scheduled. `tila artifact list --task=<id>` continues to return them while they exist. `tila tree show <archived-id>` returns the unit and its descendants but flags them as archived. Cross-references from other work units' `entity_artifact_references` rows continue to work — archive does not delete.

### 10.41 Hierarchy-aware artifact query traversal
`tila artifact list --under=epic:E-5` walks the parent-child hierarchy from E-5 down via recursive CTE on `entity_relationships`, collects all descendant work-unit IDs, then queries `artifact_pointers` for rows whose `resource` is in that set. Archived descendants are included by default; pass `--no-archived` to exclude. The query is O(descendants + artifacts) and bounded by `[hierarchy].max_depth`.

### 10.42 DO eviction during a long-running request
A DO can be evicted at any time when idle, and Cloudflare may also migrate a DO between regions for placement optimization. If eviction happens mid-request, the in-flight request fails with a 5xx and Cloudflare typically retries. SQLite state is durable; in-memory caches (parsed schema, prepared statements) rebuild on next fetch via `blockConcurrencyWhile(initFn)`. No state loss; just a 50-100ms cold-start added to the next request. The CLI's exponential-backoff retry policy covers the transient failure.

### 10.43 DO alarm timing drift
DO `state.storage.setAlarm()` fires roughly on time but can drift by seconds after a DO eviction (the alarm is delivered when the DO next wakes, not at the wall-clock target). **tila does not rely on alarms for correctness**. Claim expiry is enforced at read time (every read checks `expires_at <= now()`); alarms are used only for advisory cleanup (the sweeper). If the alarm fires late, reads see the same lazy-expiry behavior and nothing breaks.

### 10.44 R2 blob missing but pointer row exists
The Worker-driven sweep should keep these in sync, but if a manual R2 delete happens or the sweep fails between steps, a pointer row can reference a blob that doesn't exist. `tila artifact get` returns `410 Gone` with `{ tombstoned: true, deleted_at?: ms }`. `tila doctor` flags the inconsistency and offers `--reconcile-orphan-pointers` to update the rows to `tombstoned = 1`.

### 10.45 Cross-backend write: R2 succeeded, DO write failed
The artifact upload sequence guarantees that if R2 succeeds and the DO write fails, the R2 blob is orphaned but recoverable. `tila doctor --reconcile` walks R2 prefixes, finds blobs without pointer rows, synthesizes pointer rows from R2 object metadata (the metadata carries `x-amz-meta-tila-resource`, `-fence`, `-kind`, etc.), and emits `artifact.reconciled` journal events. Worst-case window: ~24h until the next reconcile cron run, configurable. The CLI returns an error to the caller in real time so they know not to assume success.

### 10.46 Worker Smart Placement disabled or unsupported
Smart Placement is enabled by default in the bundled `wrangler.toml`. If a user disables it or runs on a Cloudflare region where it's unavailable, latency degrades but correctness is unaffected. Worker → DO RTT can rise from ~5ms to ~50ms cross-region (Cloudflare's figures; tila does not measure the hop in isolation). `tila doctor` reports the placement mode and Worker→DO latency from a `/api/health` probe; the benchmark harness records the serving colo and `cf-placement` header with every deployed run.

### 10.47 D1 token validation cache hit/miss
The earlier 60-second positive-cache revocation window is superseded. Current
requests revalidate D1 credential/session/binding and membership state against the
primary database; positive authentication caches cannot establish continuing
validity. Lookup failures fail closed. Revocation applies to requests authenticated
after its commit, not mutations already authorized and executing. See
[credential rotation and revocation](05-OPERATIONS.md#expiry-rotation-and-revocation)
and [Decisions](01-DECISIONS.md) for the current authorization boundary.

### 10.48 Journal table growth over time
Journal archival is implemented, superseding the earlier v0.2 proposal. The
Worker sweep archives eligible events to project-scoped R2 objects and confirms
the archive before pruning DO rows. Project backups include confirmed journal
archives. See [backup and recovery](05-OPERATIONS.md#backup-and-recovery) and
[cron sweep health](05-OPERATIONS.md#cron-sweep-health).
The old growth/lifetime estimates are not capacity evidence; use the benchmark
harness's soak mode to measure rows and database bytes for the actual workload
([benchmark guide](benchmarks/README.md)).

### 10.49 Observability: tail Workers and metrics
Current observability surfaces include:

1. **`wrangler tail`** streams Worker logs in real time. Documented in the operational guide.
2. **`tila journal tail`** reads recent journal events; it is not an SSE subscription. Durable cursors support incremental recovery.
3. **Workers Analytics Engine** records request telemetry and sweep summaries when configured. Telemetry is advisory; missing analytics must not break project operations. See [Operations](05-OPERATIONS.md) for queries and deployment settings.

A Prometheus `/metrics` endpoint was an earlier proposal; it is not implemented
or assigned a release milestone. See [Operations](05-OPERATIONS.md) for available
telemetry and [the active roadmap](03-ROADMAP.md) for future scope.

### 10.50 Operational guide: routine maintenance
`tila doctor` is the maintenance command. Run it weekly (or pipe to cron). It checks:
- DO is reachable and serving requests
- D1 is reachable and tokens are valid
- R2 bucket is reachable and lifecycle backstop is in place
- Journal size is below 80% of DO SQLite limit
- No orphaned R2 blobs (would be picked up by next sweep, but `doctor` reports them now)
- No expired claims that haven't been swept
- No schema_version mismatches between Worker and DO

Returns exit code 0 (healthy), 1 (warnings), 2 (errors). Useful in CI.

---

## Section 11: Provisioning sequence in detail

`tila project create` does these things, in order:

```
1. Check wrangler is installed (npm install if needed, version >= 3.73)
2. wrangler login (browser OAuth)
3. Generate .tila/wrangler.toml from template:
   - name = "tila-<project-slug>"
   - main = "node_modules/@tila/worker/dist/worker.js"  (bundled with tila CLI)
   - compatibility_date set to current release
   - placement = { mode = "smart" }                    # Smart Placement on by default
   - [[durable_objects.bindings]] name = "PROJECT", class_name = "ProjectDO"
   - [[migrations]] tag = "v1", new_sqlite_classes = ["ProjectDO"]
   - [[d1_databases]] binding = "GLOBAL", database_name = "tila-global"   # SHARED across all projects
   - [[r2_buckets]] binding = "ARTIFACTS", bucket_name = "tila-<project-slug>-artifacts"
   - [[analytics_engine_datasets]] binding = "ANALYTICS"
   - [triggers] crons = ["0 3 * * *"]                  # daily artifact sweep at 03:00 UTC
   - [vars] PROJECT_ID = "<slug>"
4. Check if global D1 (tila-global) exists in account; if not, create it and run migrations.
   (The global D1 is shared across all tila projects in an account. Stores _tokens, _idempotency,
    _projects. Created once per account; subsequent project inits skip this step.)
5. wrangler deploy (auto-provisions DO, R2, registers as new project in tila-global._projects)
6. The first request to the deployed Worker triggers the ProjectDO's blockConcurrencyWhile init,
   which runs all bundled DO SQLite migrations (entities, artifact_pointers, journal, etc.).
7. wrangler r2 bucket lifecycle set <bucket> --config .tila/lifecycle.json (applies backstop lifecycle)
8. Generate API token via Cloudflare API (scoped to this Worker only); hash it and insert into
   global D1 _tokens with project_id set to this project
9. Write .tila/config.toml:
   project_id = "<slug>"
   worker_url = "https://tila-<slug>.<subdomain>.workers.dev"
   created_at = "<iso>"
10. Write .tila/.env (gitignored):
    TILA_API_TOKEN = "<token>"
11. Append .tila/.env to .gitignore
12. Add .tila/config.toml to git
13. Apply initial tila.schema.toml (the bundled default template — `epic → issue → task` hierarchy; users override as needed)
14. Print success summary with Worker URL and next steps
```

Note: D1 is shared across all tila projects in a Cloudflare account (one `tila-global` instance per account). The DO and R2 bucket are per-project. This is intentional — the global D1 is small (auth tokens, idempotency, project registry) and benefits from being one place. Per-project D1 would create unnecessary fragmentation.

`tila init` for joining teammates:

```
1. Read .tila/config.toml (committed by the original setup)
2. Prompt user for the project's shared API token (or read from CI/secrets manager)
3. Write .tila/.env locally
4. Append .tila/.env to .gitignore (if not already)
5. Test connection: GET <worker>/api/health
6. Print success
```

No Cloudflare account needed for the joining user.

---

## Section 12: Repository structure

Single repo, Bun + Turborepo monorepo. All of tila — schemas, core, backends, Worker, UI, CLI, integration tests — lives in one repository with workspace packages.

```
tila/                                  # github.com/davebream/tila
├── .github/
│   └── workflows/
│       ├── ci.yml                     # lint + test + build on every PR
│       ├── release.yml                # tag-triggered: build binaries per platform, publish to npm, create GitHub release
│       └── publish-tap.yml            # update Homebrew tap on release
├── packages/
│   ├── schemas/                       # @tila/schemas — Zod schemas, no runtime deps
│   │   ├── src/
│   │   │   ├── entity.ts
│   │   │   ├── claim.ts
│   │   │   ├── artifact.ts
│   │   │   ├── journal.ts
│   │   │   ├── relationships.ts
│   │   │   ├── config.ts
│   │   │   ├── tila-schema.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── core/                          # @tila/core — backend interfaces, fence logic, schema evolution, relationships logic
│   │   ├── src/
│   │   │   ├── backends/              # interfaces: EntityBackend, CoordinationBackend, ArtifactBackend
│   │   │   ├── fence.ts
│   │   │   ├── schema/                # schema parse/diff/apply
│   │   │   ├── relationships.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── fixtures/              # in-memory fakes (Map-backed) for unit tests
│   │   │   └── *.test.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── ops-sqlite/                    # @tila/ops-sqlite — shared SQLite ops (entity, coord, artifact, journal, sweep); platform-agnostic BaseSQLiteDatabase generic; used by both worker/src/do and backend-embedded
│   │   ├── src/
│   │   │   ├── schema.ts              # shared Drizzle schema (BaseSQLiteDatabase generic)
│   │   │   ├── migrations.ts          # shared migrations 0001-0004
│   │   │   ├── entity-ops.ts
│   │   │   ├── coord-ops.ts
│   │   │   ├── artifact-ops.ts
│   │   │   ├── journal-ops.ts
│   │   │   ├── sweep-ops.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── worker/                        # @tila/worker — the Cloudflare Worker
│   │   ├── src/
│   │   │   ├── index.ts               # Hono app entry; routes through to ProjectDO
│   │   │   ├── routes/                # public API routes (entities, claims, artifacts, journal, schema, health)
│   │   │   ├── middleware/            # auth (D1 lookup with in-memory cache), idempotency, rate-limit, analytics-emit
│   │   │   ├── do/                    # ProjectDO: per-project DO SQLite (entities, claims, journal, ...); router and migration runner over ops-sqlite
│   │   │   ├── d1/                    # global D1 store: tokens, sessions, idempotency, project registry, human accounts
│   │   │   ├── r2/                    # R2 ArtifactBackend (content-addressed blobs)
│   │   │   ├── sweep.ts               # cron handler for artifact cleanup
│   │   │   └── env.ts                 # typed bindings (PROJECT, GLOBAL, ARTIFACTS, ANALYTICS)
│   │   │   └── env.ts
│   │   ├── test/                      # vitest with @cloudflare/vitest-pool-workers
│   │   ├── wrangler.toml              # the Worker's own wrangler.toml (for `wrangler dev`)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── ui/                            # @tila/ui — project dashboard HTML/JS bundle
│   │   ├── src/
│   │   ├── dist/                      # built; bundled into worker
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── cli/                           # tila-cli — the `tila` binary
│   │   ├── src/
│   │   │   ├── index.ts               # Citty entry
│   │   │   ├── commands/              # init, task, record, gate, signal, template, summary, claim, artifact, schema, doctor, account, token
│   │   │   ├── auth.ts                # startup auth check
│   │   │   ├── config.ts              # .tila/config.toml read/write
│   │   │   ├── client.ts              # HTTP client to the Worker
│   │   │   ├── provision.ts           # wrangler shell-out logic
│   │   │   ├── local/                 # Bun host for local mode: LocalProject + LocalArtifactBackend over bun:sqlite (WAL); delegates to @tila/backend-embedded
│   │   │   └── auth-store/            # client-side auth persistence: instance registry, credential store, keychain seam, providers
│   │   ├── lib/wrangler-config.ts     # generates wrangler.<slug>.toml at deploy time (no bundled templates)
│   │   ├── test/local/                # bun test suite for src/local (Bun-only APIs)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── sdk/                           # tila-sdk — typed TypeScript client for framework consumers
│   │   ├── src/
│   │   │   ├── index.ts               # TilaClient class
│   │   │   ├── client.ts              # HTTP client with retry and idempotency
│   │   │   ├── entities.ts            # client.entities.*
│   │   │   ├── artifacts.ts           # client.artifacts.*
│   │   │   ├── claims.ts              # client.claims.*
│   │   │   ├── gates.ts               # client.gates.*
│   │   │   ├── signals.ts             # client.signals.*
│   │   │   ├── journal.ts             # client.journal.*
│   │   │   ├── presence.ts            # client.presence.*
│   │   │   ├── schema.ts              # client.schema.*
│   │   │   ├── summary.ts             # client.summary.*
│   │   │   ├── templates.ts           # client.templates.*
│   │   │   └── tokens.ts              # client.tokens.*
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── mcp-server/                    # tila-mcp-server — MCP tools and opt-in resources
│   │   ├── src/
│   │   │   ├── index.ts               # MCP server entry
│   │   │   ├── config.ts
│   │   │   ├── errors.ts
│   │   │   ├── tools/                 # MCP tool definitions per concern
│   │   │   ├── resources/             # opt-in MCP resources (records with mcp_resource = true)
│   │   │   └── prompts/
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── integration-tests/             # @tila/integration-tests — end-to-end tests
│       ├── src/
│       │   ├── helpers/               # wrangler-dev spawner, temp-project setup
│       │   └── flows/                 # init, claim cycle, artifact cycle, schema evolution
│       ├── package.json
│       └── tsconfig.json
│
├── biome.json
├── lefthook.yml
├── turbo.json
├── tsconfig.base.json
├── package.json                       # root: workspaces, scripts
├── bun.lockb
├── README.md
├── LICENSE                            # MIT
└── CONTRIBUTING.md
```

### 12.1 Notes on the package boundaries

**`@tila/schemas`** is the keystone — both the Worker and the CLI depend on it. Changes here are the riskiest because they affect everything; protect with rigorous CI checks (semver-aware contract testing).

**Packages only where code has more than one consumer.** `@tila/ops-sqlite` and `@tila/backend-embedded` are packages because two runtimes share them: `ops-sqlite` serves both the Durable Object and the embedded local path, and `backend-embedded` serves both the Bun CLI and the Node SDK. Storage code with a single consumer lives inside that consumer: the Worker holds its Durable Object, D1 and R2 backends under `packages/worker/src/{do,d1,r2}`, and the CLI holds its Bun local backend and auth store under `packages/cli/src/{local,auth-store}`. A backend becomes its own package once a second consumer needs it. `@tila/ops-sqlite` sits between `core` and both storage hosts in the dependency graph, so they share identical entity, coordination, artifact, journal, and sweep operations without duplication.

**`packages/worker/wrangler.toml`** is the Worker's own wrangler.toml — used for `wrangler dev` during local development of the Worker package itself. This is different from the per-deploy config the CLI generates programmatically via `generateWranglerConfig()` in `packages/cli/src/lib/wrangler-config.ts` (written as `wrangler.<slug>.toml`) when a user runs `tila project create` for their own project. Don't conflate them.

**`packages/integration-tests`** is its own workspace, not inside any other package. It depends on all the others. This keeps the integration test machinery out of the application packages and makes it easy to skip with `bun test --filter='!integration'` during inner-loop development.

**No `apps/` directory.** Everything is a package (the CLI is a package, the Worker is a package, the UI is a package). The `apps/` vs `packages/` split would be artificial here.

**Workspace dependencies use `workspace:*`.** In `packages/worker/package.json`:

```json
{
  "dependencies": {
    "@tila/schemas": "workspace:*",
    "@tila/core": "workspace:*",
    "@tila/ops-sqlite": "workspace:*"
  }
}
```

Bun resolves these to local paths; in publishing, they get rewritten to actual version numbers.

---

## Artifact revisions (#174–#177)

The revision core and API shipped in [#228](https://github.com/davebream/tila/pull/228)
and [#230](https://github.com/davebream/tila/pull/230). Version-aware retention and
recovery shipped in [#231](https://github.com/davebream/tila/pull/231), satisfying
the prerequisite for public API documentation. The read-only history drawer
shipped in [#237](https://github.com/davebream/tila/pull/237). These are merged
implementation milestones; deployment status depends on the installation.

Versioning is explicit: clients supply a lineage ID and a live fence for
`artifact:<lineage_id>`. Ordinary artifact uploads retain their existing keys,
deduplication and supersedes behavior. A lineage fixes its kind and resource;
numbered revisions identify events while SHA-256 identifies bytes. Restore always
appends a new revision, including when its bytes equal the current head.

Migration 27 adds nullable pointer fields and the lineage/operation tables to the
shared DO/embedded migration registry. Existing artifacts are not backfilled from
supersedes links. Explicit adoption copies a selected legacy artifact into revision
1 of a new lineage and records its original key; the old artifact stays unchanged.
This replaces #174's originally proposed inferred historical backfill.

The write protocol reserves an ordinal, persists an immutable revision blob,
revalidates the fence, accepts the commit transactionally with its journal event,
and publishes an immutable recovery record before exposing the pointer. Accepted
operations form a durable outbox. DO alarms share scheduling with reindexing;
embedded consumers resume the outbox on subsequent writes. Metadata and history
reads never access the blob store. Replays of an accepted
operation remain valid after lease expiry. New operations require a current live
claim. Pending publication blocks later writes to that lineage but leaves the
previously published head readable.

R2 keys use the project-scoped `versioned/` prefix, outside the legacy `produced/`
backstop. Every revision has separate bytes and a `.commit.json` recovery record.
Recovery accepts records from the private project prefix, validates their identity,
and preserves revision numbers, timestamps, producer identity, tags and restore
provenance. A blob without an accepted recovery record is never a recoverable
revision. Gaps from failed reservations are permitted. Project backup/destroy also
includes lineage and operation state.

History uses a lineage-bound cursor with a fixed initial revision ceiling and an
exclusive next-page boundary. Metadata never includes inline or blob content.
Tags are set on write/restore; omitted restore tags inherit the source and an
empty list clears tags only on the new revision. The MCP addition is read-only
history.

### Version-aware retention and deletion

Migration 28 separates permanent revision metadata (`artifact_revisions`) from
live/disposable `artifact_pointers`. History and metadata use the ledger, including
revision tags and deletion timestamps. Tombstoned pointers still require a
confirmed blob deletion. Migration 29 retains pointer rows as provenance and review audit records after cleanup.
The ledger and immutable recovery records remain until project destruction.

Retention is opt-in per kind (`retention_days = 0` means keep forever). New writes
and restores snapshot the current policy at reservation. Existing revisions are
assigned retention in bounded batches against one persisted project policy
snapshot. Expiry is production time plus the configured days, so enabling this
migration can immediately expire old non-head content. Later schema changes do
not rewrite assigned expiry. A live lineage head is never automatically swept;
deleting it selects the newest remaining live revision without cascading.

Lifecycle operations persist retention assignments, tombstones, deletion
confirmations, and lineage retirement as immutable JSON records beside revision
commit records under the project-scoped `versioned/` prefix. Deletion intent must
be durable before deleting bytes; the confirmation timestamp is persisted before
publishing its record so retries write identical content. A durable SQLite queue
retries failed work with capped exponential backoff. DO alarms and the daily
sweep drain it; embedded consumers expose `drainLifecycle()` and also drain on
subsequent writes. Metadata reads do not touch blob storage.

Individual versioned DELETE requests require a live `artifact:<lineage_id>` fence
via the `fence` query parameter. Ordinary artifact deletion is unchanged.
`POST /artifacts/~/destroy/:lineageId` accepts `{ fence }` plus an idempotency key
and returns 202 after permanent retirement is durable. This operation cascades
blob deletion, preserves history, and rejects all future writes/restores into
that lineage. SDK and embedded clients expose `destroyLineage()`; no destructive
MCP tool is provided. Conflicts with pending revision publication return a
retryable lineage-busy error. Accepted operation retries survive lease expiry.

History/meta remain 200 for deleted revisions; downloads/restores return 410
`artifact-unavailable`. Recovery applies lifecycle records before publishing
recovered pointers, preventing deleted content or retired lineages from becoming
live. Reconciliation also imports standalone retirement records for lineages that
never published a revision. Backup includes the ledger, lifecycle queue, policy
snapshot, and immutable recovery records even after pointer cleanup. Project
destruction removes the entire private versioned prefix as well as SQLite state.

The 365-day R2 backstop remains scoped to `produced/`. No object expiration rule
may cover `versioned/`; multipart-upload abortion remains bucket-wide.

---

## Section 13: Versioning and release

- **Semantic versioning** for tila packages and the `tila` CLI.
- **Schema version is independent of tila version.** A given tila version supports a range of schema versions; mismatches refuse to operate (see edge case 10.6).
- **Wrangler-managed Worker versions** allow rollback via `wrangler rollback`. Schema migrations are NOT auto-rolled back; the Worker version you roll back to must be compatible with the current D1 schema, or `tila doctor` will flag the mismatch.
- **DO class migrations** are declared in `wrangler.toml`. Project DO SQLite data is durable; class/storage migrations must preserve it. Rollback does not undo applied database migrations.
- **One product version for public release artifacts.** v0.10.0 aligns the root release marker, `tila-cli`, all `tila-cli-*` platform packages, `tila-sdk`, `tila-mcp-server`, and the MCP server manifest. Private implementation packages (`@tila/schemas`, `@tila/core`, `@tila/ops-sqlite`, `@tila/backend-embedded`, Worker, UI, and other private modules) do not require product-version bumps. `pnpm version:check` verifies public lockstep; private package versions are not deployed release identity.

---

This is the technical spine. It's not exhaustive — implementation will surface details not captured here — but it's complete enough that an AI agent or engineer working from it can build the v1 without inventing the architecture.


### Artifact provenance and review decisions (#188)

Each artifact key has immutable `provenance` identifying its original producer and
`revision_creation` identifying the actor creating that revision. Both contain
principal, participant, timestamp, client name/version, and environment metadata.
Cloud principals come from authentication. Participant and environment values are
client-supplied; local identities are local assertions. Unknown legacy provenance
is `null`, never inferred from a display name. Missing client versions are `null`.
Deduplicated uploads retain the first accepted attribution. Restores preserve the
original producer, record the restoring actor separately, and start unreviewed.
Private revision commit records preserve provenance during recovery, but never
carry mutable reviews. Old non-deduplicated publication records can recover a
producer; a restore or deduplicated request alone cannot establish that identity.

Any project writer may record a review, including self-review and replacement of
another writer's decision. `trusted`, `rejected`, `superseded`, and `revoked` events
are append-only. The latest event determines state; revocation yields `unreviewed`
and does not reactivate an older approval. New revisions and `supersedes`
relationships never implicitly change a review. A hash verifies byte integrity,
not truth or safety. Reviews are explicit assertions, not automated evaluations.

| Interface | Contract |
|---|---|
| GET `/projects/:projectId/artifacts/~/reviews/:key` | History newest first; `limit` 1–100 (default 50), exclusive `before_revision`; `next_revision` supplies the next cursor |
| POST at the same path | `{decision, expected_review_revision, reason?}`; initial expected revision is 0; supports `Idempotency-Key` |
| SDK | `artifacts.reviews(key, query)` and `artifacts.review(key, request)`; `idempotencyKey` is optional |
| CLI | `tila artifact reviews KEY`; `tila artifact review KEY --decision trusted --expected-review-revision 0 --reason 'Checked source'` |
| MCP | `tila_artifact_reviews`, `tila_artifact_review`; text reads separate structured metadata from artifact content |

A review write atomically appends its event and journal entry. A stale expected
revision returns `409 review-conflict`; reusing an idempotency key with different
input returns `422 idempotency-key-conflict`. Identical retries return the original
decision, while metadata reads always return the current state. Permissions use
existing project membership and `artifacts:read` / `artifacts:write` capabilities;
namespace-restricted credentials retain the existing artifact access restrictions.

Artifact responses expose producer and review metadata by default. Raw downloads
preserve their bytes and add `X-Tila-Artifact-Review-State` and
`X-Tila-Artifact-Review-Revision`; full identity is available from artifact metadata.
The web UI displays current decisions, provenance, and paginated review history,
including for unavailable content. It does not submit review decisions.

A work-unit reference slot can set `require_trusted_for_statuses = ["done"]`.
Entering a selected status requires at least one reference in that slot and all
its artifacts to be trusted, unexpired, and not tombstoned or confirmed deleted.
Checks run within the task transaction, including direct and template creation.
Failure returns `422 artifact-review-required` with failing slots and states.
Absent rules preserve existing behavior. Later review changes do not undo a task
transition; ordinary reads remain available. Backup restoration does not replay
workflow checks. Tila does not execute agents or automatically assess content.

Migration 29 adds immutable identity columns and append-only reviews to both DO
and embedded stores. Backups require `artifact-review-v1`; older backups remain
readable with unknown identity and no reviews where evidence is missing. Lifecycle
cleanup removes blob/inline content but retains metadata, tags, and review history
for audit. Full project destruction and authorized backup replacement remain
explicit exceptions. Review loss during blob-only recovery yields unreviewed
state, never an inferred approval.

## Durable conversations (#283, slices 1–2)

The Worker authenticates each request, applies current project membership and
capability checks, and creates a separate internal conversation authority envelope.
Room/inbox/dispatch routes run before D1 response replay and shared caching. They
return `private, no-store`; publication rejects `Idempotency-Key` and uses the
SQLite author-scoped operation ledger instead.

Shared migration 31 adds `rooms`, `room_members`, `threads`, `messages`,
`message_recipients`, `dispatch_outbox`, `dispatch_attempts`, `conversation_context`
and `_conversation_state`. The DO transaction owns publication, snapshots,
acknowledgement fencing and wake generations. D1 remains the source of current run
validity; relay requests check both the relay and the acting holder. R2 references
are accepted only after their artifact pointers exist. Journal events contain IDs
and dispositions, not message bodies.

The outbox holds two states and a separate expiring lease. Delivery suppression
and stalled retry metadata never replace the pending delivery state. Delivery TTL
(default seven days) affects delivery responsibility, not room history. Restore invalidates
bindings, removes leases/reply contexts and rotates signed cursor generation after
verifying the archive's semantic digest. Embedded backends carry the migrations
and backup data but their public conversation methods remain unsupported.

See [the conversation contract](distributed-agent-conversations.md) and
[operations](05-OPERATIONS.md#durable-conversation-operations) for the API and
recovery boundaries. Connector, gated Herdr observations and conversation UI
slices are merged (#287–#289); fixture coverage does not satisfy #283 distributed
live acceptance. The bounded [Herdr adapter wiring](evidence/issue-283-adapter-v1.md)
adds authenticated read-only reconciliation and a private V2 runtime association
ledger. Public Herdr registration and cold open remain unsupported pending live
evidence; attended standalone restoration remains available.

### Conversation dashboard (#283)

The project SPA includes rooms, room streams, thread drawers, agent binding status
and delivery inspection. Messages render as plain text with visible peer-content
labels; content never becomes approval. Delivery inspection is metadata-only and
uses the existing manager/current-consumer authorization. Its URL includes agent
and delivery IDs; it does not fetch or acknowledge the mailbox.

### Delivery tracing (#302)

Two additive read projections trace a message to its delivery outcomes. Neither
fetches, acknowledges, sweeps or wakes anything.

| Route | Capability | Returns |
|---|---|---|
| `GET /rooms/:room/messages/:message/deliveries` | `conversations:read` plus room access | Readers: `restricted: true` and aggregate counts only. Managers: per-recipient traces (up to 200) |
| `GET /deliveries?agent&room&thread&message&id&state&limit&cursor` | `conversations:manage` | Newest-first traces with a signed cursor bound to caller and filters. `id` matches a delivery or message ID |

Each trace keeps the facts separate: `stored`, `wake` (latest attempt outcome,
attempt count, re-wakes, suppression), `fetched`, `acknowledged` and
`work_result`. `work_result` reads the explicit result of the attempt named by the
message's `attempt_id` (#303); acknowledgement never fills it. It is
`not-reported` when the message names no attempt, `pending` while the attempt is
unfinished, `reported` with the outcome once it finished (and `corrected` when
corrective work was linked), `unlinked` when the attempt is missing or belongs to
a different task than the message names, and `hidden` when the caller cannot read
the attempt's task. `state` is the effective
state, so an unswept pending delivery past its TTL reads `expired` while room
history keeps the message. `recipient.status` reports the targeted binding as
`active`, `offline` (lease lapsed), `replaced`, `released`, `expired` or `none`.
`GET /inbox/:agent/deliveries/:id` additively returns the same `trace` and a
`message` reference (room, thread, seq and correlation fields).

The dashboard uses these projections: a lazily loaded **Deliveries** disclosure on
each room message, a `/deliveries` browse page with filters and cursor pagination,
and a trace drawer at `/deliveries/:agent/:delivery` (the older
`/agents/:agent/deliveries/:delivery` link still works). The manual delivery UUID
form is gone.

History accepts `direction=backward` for newest-first page selection while returning
messages in ascending sequence order. Its signed cursor is direction-scoped. The
additive `tail_cursor` is a forward cursor at that page's newest message, scoped to
the same reader, room and optional thread. Existing forward callers are unchanged.
Both directions preserve the three-day lifetime and restore-generation checks.

The UI keeps backward history queries separate from forward tail polling. It
retains four history pages and 200 recent messages, deduplicates by room sequence,
and renders at most 200 messages per stream. Reading older history or scrolling
away from the tail freezes the visible window; returning to Latest refreshes it.
Announcements are opt-in and never read incoming bodies aloud automatically.

A reply draft is scoped to principal/project/room/thread in tab sessionStorage.
The pending publication freezes its operation ID and payload before the request;
network retries and explicit retry after reauthentication reuse both. New edits
remain separate until that outcome is reconciled. A late response checks the
latest persisted revision, including after unmount/remount, before clearing text.
Server authorization remains authoritative on every retry. Storage failures are
visible and block sign-in navigation that would lose the only copy of the draft.

## Section 14: Editable settings and entity lifecycle contract (#293)

Reviewed 2026-10-12 against the shared schemas, mounted Worker routes, SQLite/D1
operations and SDK/CLI/MCP/UI consumers. This section is the product contract for
[#292](https://github.com/davebream/tila/issues/292). **Current** describes code in
this checkout; **required** describes delivery owned by the linked child issues.
Neither a schema field nor a client method alone proves an operation is supported.
This section supersedes conflicting historical configuration/UI descriptions; it
does not change an API, permission, migration or deployment.

### 14.1 Categories, authority and relationships

| Category | Examples and authority | Interaction and lifetime |
|---|---|---|
| Definitions and policies | Applied work/record definitions, templates, hierarchy and artifact policy in project DO SQLite | Persisted settings; validate changes, preview impact and retain revision history. A file is an input format. |
| Stable identities and access | DO agents, rooms, groups; D1 principals, memberships and credential policy; host-owned profile definitions | Managed identity/access lifecycle. Archive or revoke without erasing referenced work or evidence. |
| Durable work and content | DO tasks, records, messages; artifact metadata in DO and bytes in R2; managed attempts/results and correlated questions | Explicit domain transitions; survive browsers, runtime runs and provider sessions. A record's business definition determines whether it is configuration or content. |
| Runtime observations and commands | D1 runtime runs; DO bindings, claims, presence and delivery leases; host observations | Persisted observations can expire. Show freshness, unknown/redacted/unavailable states; use supported commands to change runtime state. |
| Historical evidence | Schema history, journal/cursor archives, record/artifact revisions, provenance/reviews, message and delivery evidence | Permission-aware history and retention. Restore creates new validated state; an audit reference does not guarantee retained payload bytes. |

Cloudflare is the shared authority. UI, CLI and MCP must call the same validated
operations, including authorization and concurrency checks. Current local/embedded
APIs remain supported where implemented; this contract neither retires them nor
pretends their unsupported conversation/runtime methods work.

Conceptual relationships below are **not new database foreign keys**. Attempts,
assignments and correlated decisions live in the managed queue and question
tables (#303/#304). A conversation message's optional `attempt_id` only lets a
delivery trace read that attempt's explicit result; it never creates or
completes work.

```text
definition revision --validates--> task / record --references--> artifact revision
template revision --instantiates--> tasks + relationships
principal --membership + credential ceiling--> authorized project operations
principal --owns / binding grant--> durable agent --current epoch--> runtime binding
runtime binding --holder--> runtime run --identifies--> participant
runtime binding --observes--> host + native session + profile revision
task --has many--> attempt --assigned to--> durable agent
attempt --correlates--> question / decision --discussed in--> room message
room --contains--> thread / message --snapshots recipients--> delivery / wake attempt
schema / identity / work / runtime operation --records evidence--> history / journal
```

Workflow roles (orchestrator/worker) belong to an assignment or attempt. They do
not replace the existing runtime credential roles `acting` and `relay`; a relay
has metadata-only dispatch authority, not an acting worker's content access.

### 14.2 Setting-to-editor coverage

The tables are field-group inventories, not a list of current UI features. API
paths in this section are relative to `/projects/:projectId` unless prefixed
`/api` or `/_internal`. Permission codes refer to §14.3; lifecycle codes to §14.4.
Every ordinary setting requires a browser path. A missing editor or revision
precondition is a named delivery gap, not permission to leave it file-only.

#### Applied definitions — DO SQLite `_schema_history`

All rows below currently share `GET /schema`, `POST /schema/preview` and
`POST /schema` (full TOML `definition`, optional `relax`/`force` strategy).
CLI `schema show/diff/apply/status`, SDK `schema.get/apply`, MCP
`tila_schema_update` and the schema resource consume this definition. SDK
`schema.history()` reads `GET /schema/history` (`limit`, `before`).

Settings › Definitions (#297) is the browser path for every row below. It keeps
a per-tab draft as TOML text based on the applied revision, edits it with forms
(work types, fields, lifecycle, reference slots, record types, artifact kinds,
templates, hierarchy and vocabularies) or as source, and never requires a local
file. Forms edit the raw TOML tree through `@tila/core` definition documents, so
keys the schema does not model survive; they rewrite comments and layout, and
the source editor keeps them. Validation is the shared core parser plus the
server preview; the review page shows the typed changes and impact counts, and
apply always sends `expected_revision` and `reviewed_definition` with an
idempotency key. Destructive changes need a typed confirmation and are applied
with `relax`. A stale apply (412) keeps the draft and offers a per-declaration
rebase onto the latest revision. Restore loads a historical definition as a
draft on the current revision and applies it as a new revision after the same
review; there is no separate restore endpoint and history is never rewritten.
Retiring a declaration removes it; stored rows stay readable as legacy data.
A change that only touches comments or unknown keys records no revision.
#296 still owns a typed structured input and revision detail endpoints. Import
and export are in §14.6.

| Setting / complete field group | Permission / lifecycle | Required browser editor and removal behavior |
|---|---|---|
| `schema_version` | S / D | Definition format metadata, separate from the server concurrency revision; compatibility validation, not a user-controlled lock counter. |
| `work_units.<type>.fields`: `name`, `type`, `required`, `default`, `default_for_legacy`, `values` | S / D | Work types and field editor, including enums and legacy defaults; preview in-use field/type retirement; preserve readable legacy rows. |
| `work_units.<type>.parents`, `required_parent`; `hierarchy.levels`, `max_depth` | S / D | Hierarchy/parent constraints, with affected-data preview; no implied reparenting or deletion. |
| `work_units.<type>.references`: `name`, `multiple`, `kinds`, `require_trusted_for_statuses` | S / D | Reference slots and trusted-review transition requirements; removing a declaration does not erase references or evidence. |
| `artifacts.<kind>`: `mime_types`, `retention_days`, `requires_reference_to`, `searchable`, `search_mode`, `auto_supersedes` | S / A | Artifact policy editor; explain captured expiry, protected heads and indexing/rebuild effects; deleting a kind is not blob deletion. |
| `artifact_relationships.types`; `entity_artifact_references.slots` | S / D | Relationship/reference vocabulary editor; preview affected edges, retain history and explicitly handle legacy data. Work-unit relationship operations also retain their existing shared-schema constraints. |
| `templates.<name>`: `description`, `entities` (`id_suffix`, `type`, `data`), `relationships` (`from`, `to`, `type`) | S / T | Template editor/duplicate/retire; validation uses current definitions. Retirement prevents new use, not deletion of previously instantiated work. |
| `records.<type>`: `format`, `history`, `key_description`, `writers`, `mcp_resource`, `schema_ref`, `fields` (same complete field group as work units) | S / D | Record definition editor; preserve JSON/YAML format and revision/snapshot history semantics. Presentation of configuration-like record content follows its definition, not the records table or a name heuristic (#300/#305). |

#### Stable identities, access and project policy

These rows are owned by #298 for complete editors and missing shared client
operations; #296 supplies the revision contract where needed, and #299 exports
only authorized non-secret configuration. Existing membership/credential controls
remain available during expansion.

Agents, rooms and signal groups carry their own settings revision (project
migration 42). Revisions come from one project-wide counter, so a deleted and
recreated resource never reuses a revision an old editor still holds; a project
restore re-stamps them. Every write names the `expected_revision` it reviewed and
fails with 412 `revision-conflict` (current `revision` and `resource` in the error)
instead of overwriting a newer change. Publication never changes a room revision;
binding attach and release never change an agent revision. Writes accept an
`Idempotency-Key` whose receipt commits in the same DO transaction after current
authorization, so a retry replays the committed result and a key reused with a
different body fails. Settings events (`agent.*`, `room.*`, `signal_group.*`) carry
revisions and changed field names only, never grants or member identities, because
journal readers may lack management authority.

Settings › Agents, Settings › Rooms and Settings › Signal groups are the browser
paths. Each editor works on a copy opened at a revision; a conflict keeps the
edits and offers either to load the latest revision or to keep only the fields the
user changed on top of it. The agent editor separates read-only identity (ID,
owner, creation), configured policy (name, binding grants, profile selection) and
the observed binding (epoch, holder, host, reported profile, lease), which links to
Runtime and is never editable as JSON. Archive and group deletion use the typed
destructive confirmation, fed by an archive preview.

| Setting / fields | Owner/store and current operations / consumers | Permission / lifecycle | Editor coverage and implementation gap |
|---|---|---|---|
| Agent `id`, `name`, `bind_policy` (`principal_id`, `agent_id`); server-assigned owner; `revision`; `archived` | DO; `GET/POST /agents` (`?include_archived=true` for managers), `GET/PATCH /agents/:id`, `GET /agents/:id/archive-preview`, `POST /agents/:id/archive|unarchive`; SDK agents, CLI `agent register/list/inspect/update/archive-preview/archive/unarchive`, MCP `agents` group (`tila_agent_*`); Runtime view (`GET /runtime-view`, #301) | M / I | Settings → Agents (delivered). Registration stays idempotent and refuses changed settings with a pointer to update. `PATCH` changes name and grants against `expected_revision`; grants must name the agent; the owner is immutable. ID and owner are read-only provenance. |
| Room `id`, `name`, `history_policy`, `delivery_ttl_seconds`, budgets `max_hops`, `pair_exchanges`, `agent_wakes`, `room_wakes`; members (`agent:`/`principal:` reference, `wake`); `revision`; `archived` | DO; `GET/POST /rooms` (`?include_archived=true`), `GET/PATCH /rooms/:id`, member `PUT/DELETE` (optional `expected_revision`), `GET /rooms/:id/archive-preview`, `POST /rooms/:id/archive|unarchive`; SDK conversations, CLI `room create/update/archive/unarchive/join/leave` with TTL and budget flags, MCP `tila_room_get/create/update/member_set/member_remove/archive_preview/archive/unarchive` | C / R | Settings → Rooms (delivered). Membership is room policy, so a member change advances the room revision. Budgets are replaced as a whole. Threads/messages are content, not settings. |
| Signal group ID, `name`, `principal_ids`; `revision` | DO (also embedded/local); GET/PUT/DELETE `/signals/groups/:groupId`; PUT `expected_revision` 0 creates only and a positive value must match; DELETE `?expected_revision=`; SDK, CLI `signal group set --create/--expected-revision`, MCP `tila_signal_group_*` | G / G | Settings → Signal groups (delivered). Omitting `expected_revision` keeps the legacy unconditional replace for older clients; the dashboard always sends it. Deleting an audience never rewrites sent deliveries. |
| Membership mode; principal/provider identity, subject kind, role, display name; grant/revoke | D1; `/membership-policy`, `/memberships`, `/membership-events`, `/membership-repos`; Settings → Access; SDK `memberships`, CLI `member list/grant/role/revoke/policy/events`; MCP `tila_access_members` (read-only); compatibility `/admins` maps into canonical membership | O / X | Settings → Access (delivered). Demoting or revoking the last active owner fails with `last-owner` inside the same D1 write, so concurrent removals cannot leave a project without an owner; the `/admins` route uses the same guard, and only the full bootstrap credential bypasses it. Never a second roster. |
| Repository association (`host`, owner/repo identity, repository ID); read/write permission thresholds, maximum permission, mirrored-membership enablement/role cap; `access_policy_revision` | D1; `GET/POST /api/repos`, `GET/PUT /api/repos/:repoId/access-policy`, `DELETE /api/repos/:repoId`, each with `?host=` (default `github.com`); SDK `repos`, CLI `repos list/policy/remove`; MCP `tila_access_repos` (read-only) | O / X | Settings → Repositories (delivered). Policy writes and link removal take `expected_revision` and apply it in the conditional write (412 `revision-conflict`). Removing a link never removes explicit memberships. |
| Repository OIDC enablement, permission ceiling, subject pattern, allowed events/refs/environments/workflows; `oidc_policy_revision` | D1; `GET/PUT /api/repos/:repoId/oidc-policy?host=`; SDK `repos`, CLI `repos oidc`; MCP read-only through `tila_access_repos` | O / X | Settings → Repositories, Actions OIDC policy (delivered). Revision-checked like the access policy, with its own revision. GitHub.com Actions trust is built in; GHES Actions requires an exact deployment `GITHUB_ACTIONS_TRUSTED_ISSUERS` mapping. Verified issuer and mapped repository host persist in workload context and are revalidated with current host-specific policy on every protected use. Conditions are authorization policy, not runtime observations. |
| Service account name/display name, initial membership role; workload binding name/provider/issuer/subject/policy | D1; `/service-accounts` and `/:principalId/workload-bindings`; SDK and CLI service accounts; MCP `tila_access_service_accounts` (read-only) | O / X | Settings → Service identities (delivered): create, rename, revoke, and workload bindings. The principal is stable; role changes go through canonical membership. Revocation preserves attribution. Display-name and binding-policy edits accept optional `expected_revision` and increment their D1 revision atomically (#439). The dashboard keeps conflict drafts for explicit rebase/reload; legacy callers may omit the revision. Revocation needs no revision. |
| Credential name/note, principal, role/capabilities, task-type/record-key restrictions, expiry, optional DPoP key binding; rotation expected token ID/overlap | D1 hashes and credential versions; `/api/tokens` issue/list/revoke/rotate; SDK/CLI token; MCP `tila_access_credentials` (metadata only) | K / X | Settings → Credentials (delivered): issue, rotate and revoke. The secret is shown once at issuance or rotation and is never stored by the browser, exported or recoverable through history. Issuance is not idempotent; after an unconfirmed failure the user checks the list and revokes or reissues. |
| Runtime enrollment name/installation reference/policy, invitation policy; revocation | D1; `/runtime/enrollments` (list, revoke), `/runtime/invitations` (create, list, revoke), `/runtime/redeem`; SDK runtime and CLI `machine` flows including `machine invitations/revoke-invitation` | E / X | Settings → Runtime access (delivered), linked to Runtime (#301): list and revoke enrollments, create, list and revoke invitations. One invitation enrolls one installation. Creating an enrollment needs a device proof key, so it stays in the CLI. Run tokens, proof keys and invitation bearer values are never listed or editable. |
| Project display name and identity metadata; `settings_revision` | D1 registry; `GET/PATCH /projects/:id/project-settings`; SDK `project`, CLI `project settings/rename` | O (`project:configure`) for rename; root for destructive project operations / I | Settings → General (delivered). Rename is revision-checked and audited, and display only. IDs, creation time/actor and account binding are read-only provenance; archive/destroy remain explicit operational actions. |
| Agent profile selection: `profile_id`, optional `host_ref` (enrollment) and `account_ref` | DO, on the agent (`profile_selection`, covered by the agent revision); `PATCH /agents/:id`; CLI `agent update --profile/--profile-host/--profile-account/--clear-profile`; MCP `tila_agent_update` | M for the selection; runtime attach still B / H | Settings → Agents, configured policy (delivered). A new attach must report the selected profile, account and enrollment, or it fails with `profile-mismatch`; an attached run's renewal is unaffected. A selection does not rewrite binding evidence, verify an account or grant credentials. Changing a host's local profile has no supported command (#283) and is shown as unavailable, never as success. |

#### Record read and write restrictions (#530)

Namespace restrictions gain a split form for records. `records` stays one rule
list that applies to both sides. `records_read` and `records_write` are
independent lists with the same rule shape; the two forms are mutually
exclusive, an absent side denies every record once either field is present, and
an empty list denies every record on its side. `hasNamespaceRestrictions`, the
catalog, the search `restricted` flag and the DO `restricted` scope flag all see
every field, so a policy that sets only one side is still a restricted
credential.

Enforcement uses the side of the operation, enumerated per route rather than
inferred from the verb. `GET` and `HEAD` read, the listed create, replace, put,
patch, archive, unarchive and claim routes write, and any other method or route
is denied.

| Operation | Side | Worker (`capabilityMiddleware`) | DO (`assertCredentialRequest`) |
|---|---|---|---|
| `GET/HEAD /records/:type/:key`, `~/history/:key` | read | key against `records_read` | same |
| `GET /records/:type`, `GET /records/_types`, record search | read | passed through | rows, counts, types and catalog filtered by the read side |
| `POST /records/:type`, `PUT /records/:type/:key`, `POST ~/put/:key` | write | key against `records_write` | same; response is a receipt when the read side does not admit the key |
| `PATCH /records/:type/:key`, `POST ~/archive/:key`, `POST ~/unarchive/:key` | write and read | both sides for the same key | same (these return the stored record) |
| `stamp-artifacts` (follow-up of a snapshot write) | write | not routed | write side |
| claim acquire, renew, release on `record:<type>/<key>` | write | key against `records_write` | same |
| claim state, claim listing on `record:<type>/<key>` | read | state checked, listing passed through | state checked; listing filtered by the read side |

Containment (`policyContains`) and narrowing (`intersectCredentialPolicies`)
work per side. Narrowing emits the legacy single list when both sides end up
equal, so a policy that never used the split fields narrows to exactly what it
always did. List cursors carry only a position; the current credential's read
side is applied to every page, so a cursor cannot widen what another policy
may see.

The write response for `create`, `set` and `put` is a full record for any
credential whose policy is not split (unchanged). For a split policy it is the
full record only when the credential holds `records:read` and its read side
admits the key; otherwise it is the receipt `{ ok, receipt: true, type, key,
fence }`. The receipt is explicit in the API schema (`RecordWriteResponse`), the
SDK (`isRecordWriteReceipt`) and the MCP result schemas, so clients narrow on it
rather than finding fields missing. The stale-fence message and the
undeclared-type message are likewise limited for such a caller.

#### Client, host and deployment boundary — explained exclusions

| Field group / authority | Current surface | Boundary and management path |
|---|---|---|
| `TilaProjectConfig`: `project_id`, `backend`, `worker_url`, `instance.instance_key`; `schema_version`, `tila_version`, `created_at` | Local project connection file; CLI init/link/switch/config get | Client connection/format metadata. Show project/instance context, but do not import these fields as shared definitions or silently retarget a client. `config set` is a stub, not a delivered editor. Definition import rejects this file with a `client-connection-file` error, and definitions name none of these identities (§14.6). |
| `TilaProjectConfig`: `auth.mode`, `github.host/owner/repo/repo_id`; `local.db_path/artifacts_path/org` | Local auth selection and local-backend compatibility | Connection/bootstrap hints and local storage locations, not overrides of server membership/repository policy. Keep current consumers; local/auth retirement is separate work. |
| `TilaProjectConfig`: `cloudflare.account_id`, `custom_domain`, `backends.entity/coordination/artifact/auth`; infrastructure account/name, D1 ID, R2 bucket, Worker URL, Pages name, app/installation IDs, infra slug | Deployment metadata; CLI infra/provision/deploy and project configure | Infrastructure ownership, routing and backend placement. Operational configuration, not ordinary project Settings. Read-only diagnostics may link to the runbook (#307); do not promise live backend switching. |
| `CredentialProfile`: ID/revision, harness, launcher, config directory, credential-store kind, endpoint, environment allowlist, account reference; profile-file format/revision map | Host profile store; CLI profile/client-lifecycle operations | H. Non-secret project selection belongs in #298; host mutation requires a negotiated #283 adapter command and confirmed applied revision. Launcher/config paths remain host-local. Remote profile management is not implemented. |
| Instance registry label/URL/trust/current context, credential-provider kind and OIDC/exec parameters; local credential records | Client instance registry and OS credential store | Local trust/auth acquisition, never shared Settings import. Host/instance owner manages these through CLI/account flows; remote settings must not execute a supplied credential-provider command. |
| Connector registration, process generation, sockets, native session, launch intents, Herdr observations; lifecycle hooks, presence/claim TTLs, runtime protocol/lease constants | Host connector/client lifecycle, runtime service operations and code defaults | Observations, command parameters or implementation limits, not editable project policy. Runtime view/commands #301 and adapter #283; no supported generic stop/reconnect/profile operation may be inferred from a stored field. |
| Provider secrets, passwords/proof keys, token material; infrastructure HMAC/sweep/admin keys and Worker bootstrap secrets; deployment lifecycle backstop | Host/OS credential stores or deployment secret/configuration service | Never ordinary export/history. Account/security and operational procedures own mutation. #307 owns readiness and a separately controlled credential cutover; this issue authorizes none. R2 backstop configuration stays operational and must exclude `versioned/`. |

For inventory completeness, the remaining shared schemas describe content
(`entity`, `record`, relationships/tags, artifacts/reviews/versions, gates,
conversation messages), runtime (`claim`, `fence`, `presence`, signals/deliveries,
binding/run/connector/lifecycle), evidence (`journal`, continuity, schema history,
backup and artifact lifecycle), or transport/authentication (API envelopes,
pagination/search, CLI/MCP results, sessions/cookies, refresh/DPoP, human accounts,
GitHub/workload claims, deployment routes). Their mutable content uses Work,
Conversations, Runtime or Account operations; it is not another hidden settings
file. Instance-level account administration is separate from project membership.

### 14.3 Permission matrix — preserve current thresholds

Role labels alone are insufficient. Current membership, credential capability and
namespace ceilings, protected-operation revalidation, room visibility, and
resource fences all apply. UI affordances never grant authority. `full` bootstrap
credentials keep their existing compatibility/root paths; an owner session is not
automatically an infrastructure credential. Failed authority lookup fails closed.

| Code / category | Read | Mutation and restrictions |
|---|---|---|
| S — definitions/policies | Project read; scoped `schema:read` | The inner route says `write` (participant), but mounted capability middleware requires `schema:write` at maintainer level for apply, including compatibility sessions via `compatibilityPolicy`. Preview uses participant-level `schema:preview`. Scoped credentials additionally need the explicit capability. Document this guard mismatch; #296/#297 must not infer writer apply access from the inner handler or silently change the effective threshold. The dashboard offers drafting and preview with `schema:preview` and Apply only with `schema:write` at maintainer level, independently of membership administration; the server enforces both again. |
| M — agents / profile selections | `agents:read`; binding details, grants and profile selection are manager/current-consumer restricted; archived agents only with `include_archived` and management authority | `agents:manage` with maintainer ceiling (or existing full-token compatibility) for register, update, archive preview, archive and unarchive. Registration ownership/bind policy still applies. |
| C — rooms/membership | `conversations:read` plus room history policy/membership; archived rooms stay readable under the same rules | `conversations:manage` (maintainer) for create, update, member changes, archive preview, archive and unarchive; publishing uses `conversations:publish` plus room admission and current runtime checks when acting as an agent. |
| G — signal groups/history | Groups use read / `signals:read`; delivery history requires admin / `signals:manage` | Group PUT/DELETE requires admin (maintainer), scoped `signals:manage`. Sending and recipient acknowledgement use their distinct writer capabilities and identity checks. |
| O — canonical membership, services, repository policy, project name | Owner checks also protect administrative reads | Owner plus applicable `memberships:*`, `service-accounts:*`, `workload-bindings:*`, `repository-policy:*`, `project:configure`; interactive cookie sessions need recent authentication (step-up) for every write, including repository links and policies and the project name. Preserve last-owner and explicit-owner access independent of GitHub App installation. `/auth/session/status` reports one flag per owner editor (`memberships_manage`, `service_accounts_manage`, `workload_bindings_manage`, `repository_policy_manage`, `project_configure`), each computed from the same rule as its route. |
| K — credential management | Existing credential-management guard; scoped `tokens:read` | Owner/scoped token-management policy and fresh authentication, with issuance ceilings. Legacy full-token issuance retains its D1-token guard. Token rotation uses expected token identity; no editor may manufacture broader policy. Session flags `credentials_read/issue/rotate/revoke` follow `tokens:read/issue/rotate/revoke` (`credentials_manage` remains as an alias of revoke). |
| E — runtime access configuration | Enrollment owner or permitted manager, scoped by runtime service | Personal enrollment currently requires a GitHub/OIDC human principal with participant authority; shared invitations require an owner, and revocation uses owner/sponsor checks. Do not claim native human-account enrollment parity before it is implemented. Enrollment/run authority never exceeds live policy; do not equate machine ownership with project ownership. |
| B — runtime observations/commands | Authorized projection; redact privileged binding/session/profile evidence. `GET /runtime-view` (`agents:read`) is that projection: binding detail follows the agent-view rule, runs and hosts follow `GET runtime/runs` visibility, presence needs `presence:read`. Redacted rows keep run state, lease and enrollment-revoked facts but no identities | Attach/release requires current agent-pinned runtime authority, binding policy and expected epoch; relay/acting checks remain distinct. Claims require current participant/fence. Host commands also require adapter capability. |
| W — durable work/content | Resource read capability, task/record namespace and room restrictions | Applicable task/record/artifact/template/gate capabilities plus current validation, record writer policy and required fences. Gate resolve/cancel retains permission-based authorization, not an invented gate fence. #303/#304 must specify new workflow operation authorization explicitly. |
| V — historical evidence | Underlying resource permissions; management-only delivery/security evidence stays restricted | No general history edit. Restore uses the resource's current write permission/validation; journal archive and project backup/import/destroy retain full-D1/infra root restrictions. |

Revalidation occurs before protected effects and authorized retry replay; snapshots
are evidence, never reusable credentials. Revocation must take effect despite an
open editor, saved workflow revision or old token. The existing authorization
guide describes compatibility/cache details; this contract grants no stale-access
exception. Settings must expose each permitted editor independently of the current
membership-admin shell. Do not impose owner-only access on definition editors;
use effective schema capabilities rather than a generic writer label. Any future
participant-level apply change requires an explicit authorization decision.

### 14.4 Revision, activation, deletion and recovery

| Code / resource | Current behavior and required activation contract |
|---|---|
| D — applied definitions | Apply parses input, then diffs/commits inside a DO SQLite transaction, increments history `version`, and journals. `expected_revision` is checked in the same transaction (412 on mismatch), destructive conditional writes bind to the previewed `reviewed_definition`, and retries replay their receipt. Writes without `expected_revision` warn and journal changes; managed-queue projects reject omission (428), even on receipt replay. No-change warns without another event/revision; rejected writes never record an apply. History is public and restore applies an old definition as a new revision. New writes use current validation; legacy reads retain supported lazy `default_for_legacy` behavior without bulk rewriting stored rows. Retiring a type must not conceal its remaining rows. |
| T — templates | Instantiation validates and creates work/relationships using the active definition. Edits affect later instantiations only; previously created work is independent. Attempts record the definition and queue-policy revisions in force at reservation, authorization and result (#303, migration 39) as audit evidence; template edits are not task mutations. |
| A — artifact policy | New versioned writes/restores capture current retention at reservation. Existing unassigned revisions get one persisted policy snapshot through bounded backfill; already assigned expiry is not rewritten by later schema edits. Expired non-head revisions may be swept; live lineage heads are protected. Explicit deletion/lineage retirement uses durable intent/retry records and preserves metadata/provenance. Restore cannot recover deleted bytes or revive a destroyed lineage. Search policy changes do not promise automatic historical reindexing. |
| I — stable identity / archive | Rename, grants and profile selection are revision-checked updates; IDs and attribution stay stable. Archive, in one DO transaction, checks the revision and the reviewed `expected_epoch` of the active binding (`stale-binding` if the occupant changed), releases that binding and advances the epoch so the running session loses agent authority, supersedes the agent's open questions, stops dispatch, and refuses new runs, attaches, publications and room membership. Pending deliveries remain as evidence until their TTL; unfinished attempts keep their own lifecycle and need an explicit cancel or reassignment in Queue. Unarchive restores the identity only: no binding, lease or expired delivery is revived, and an attach must use the current epoch. Project destruction is a separate root operation, never “archive”. |
| R — rooms | Updates and member changes check the room revision. New TTL, hop and pair budgets apply to later publications and wake budgets to the next dispatch lease; already stored recipient/expiry snapshots remain evidence. Visibility and member removal govern subsequent access immediately. Archive stops publication and thread creation now and wakes at the next lease; authorized history stays readable, pending deliveries can still be fetched and acknowledged until their TTL, and nothing is deleted. Recreating an archived room's ID fails with `room-archived`; unarchive restores publication. |
| G — signal groups | PUT/DELETE change future recipient expansion and check `expected_revision` when given (0 = create only). Existing deliveries retain their snapshotted recipients/acknowledgements until expiry/retention cleanup; group deletion is not cancellation of past signals. |
| X — access/credentials | Repository access and OIDC policies and the project name carry their own D1 revision (migration 0034); service accounts and workload bindings do too (0036). Supplied revisions make writes conditional on the reviewed version; omitted revisions preserve legacy callers. Restore re-stamps settings above both retained destination history (0035/0036) and imported service/binding revisions, so a pre-restore editor cannot become current again. D1 policy/credential versions and current membership own effect timing. Narrowing/revocation governs subsequent authorized requests and cannot be undone by a schema restore. Credential rotation retains its explicit overlap policy; expanding policy requires newly authorized issuance, not widening an old snapshot. Preserve audit identity after revocation; no old secret recovery. New editor preconditions must not disable immediate security revocation. |
| H — host/profile selection | Host profile revisions and binding evidence are distinct. The agent's profile selection is enforced on the next new attach; it cannot switch an active account/session. A supported host command has requested/acknowledged/observed outcomes and an applied revision. Offline is pending/unavailable, never success. #283 owns adapter proof; #298/#301 own management/projection. Settings shows host-local profile changes as unavailable, and the Runtime view exposes binding release (expected epoch) only; reconnect and stop are reported as unsupported until an adapter command exists. |

When identity, room and access changes take effect:

| Change | Takes effect |
|---|---|
| Agent rename | Immediately for reads; bindings and message provenance (by ID) are unchanged |
| Binding grants narrowed / widened | At the holder's next mailbox call / at the next attach |
| Profile selection | At the next new attach; an active binding and its renewal are unaffected |
| Agent archive | Immediately: binding released, epoch advanced, new runs, attaches and publications refused, room fan-out skips the agent; pending deliveries remain until their TTL |
| Agent unarchive | At the next attach with the current epoch; nothing is revived |
| Room membership, `history_policy` | Admission and reads immediately |
| Room TTL, `max_hops`, `pair_exchanges` | Later publications |
| Room `agent_wakes`, `room_wakes` | The next dispatch lease |
| Room archive | Publication now; wakes at the next lease; history stays readable; fetch and acknowledgement work until TTL |
| Signal group edit or delete | The next send; past deliveries keep their recipients |
| Membership revocation or demotion | The next request; existing sessions of a revoked member are deleted |
| Credential revocation | The next request; on rotation the old secret works until the overlap ends |
| Repository access policy | The next request, plus up to 60 seconds of cached GitHub permission checks |
| Repository OIDC policy | The next token exchange |
| Enrollment revocation | Immediately, including expiry of its agent bindings |
| Invitation revocation | The next redemption; installations already enrolled keep their own lifecycle |
| Project rename | Display only |

Required shared-write sequence (#296):

```text
read revision N -> edit draft -> preview against N -> authorized apply(expected N)
  -> current N: revalidate + commit N+1 + audit
  -> current differs: conflict + preserve draft -> reload/review/rebase
restore historical definition -> preview against current data -> new revision
```

History records actor/principal, participant, origin, operation ID and before/after
revision/diff. #296 owns exact wire formats, no-op/retry outcomes, cache coherence
and the staged legacy-client policy. Unrestricted old apply calls cannot remain a
silent concurrency bypass on server-managed projects, but enforcement requires
that explicit client transition; this documentation does not break current callers.

Archive, expiry and recovery are separate operations:

```text
definition active -> retire declaration -> legacy content remains readable
identity active -> archive/revoke -> retain work/history; authorize replacement explicitly
task active -> archived -> retained row/evidence (no new general task-unarchive promise)
record active -> archived -> explicit unarchive under current authority
runtime active -> lease expires -> old authority invalid -> new authorized run/binding/fence
pending delivery -> acked or expired -> message history remains (not task completion)
artifact revision -> deletion accepted -> bytes removed -> metadata/history retained
historical evidence -> permitted inspection -> restore-as-new where supported
```

The recovery query must recover durable pending work/questions and cursor history,
not reconstruct completion from presence or terminal state. A replacement session
attaches to the existing attempt through `replace-session`, or execution starts a
new attempt through force recovery or retry (see "Session replacement, revisions
and recovery queries"). Both paths require fresh authority, and a stale
result/answer is rejected. A later hotfix links a new task/attempt to the
original result instead of rewriting it.
Attempt cancellation supersedes pending questions (#304) transactionally while
retaining discussion and existing answer evidence. Replacement execution requires
a linked question and fresh confirmation; see Durable questions and decisions.

No atomic Settings save spans DO, D1, R2 and a host. A multi-resource UI must report
individual committed revisions and failures; retries use the owning service's
operation identity. Schema restore neither restores access nor rolls back a
deployment, host profile, deleted blob or independently committed setting.

### 14.5 Identities and versions that must remain distinct

| Identifier | Meaning / authority |
|---|---|
| Schema-format version | Compatibility marker inside serialized definitions/config; not a concurrency lock or product release. Existing names are retained. |
| Persisted configuration revision | DO history `version` identifies an applied definition today; #296 makes the expected-revision write contract explicit. Other resources need their own revision, not a project-wide pseudo-transaction. |
| Entity schema version / record revision | Entity `schema_version` references applied history for interpretation; record revision identifies content changes. Neither is the TOML format marker. |
| Access/credential/profile version | D1 membership/policy/credential state and host profile revisions have separate owners; saved values explain provenance, not current permission. |
| Principal / durable agent | Authentication identity versus stable project mailbox/work identity. A principal can operate more than one agent subject to binding policy. |
| Participant / runtime run | Participant identifies a concrete coordination session; D1 run identifies its short-lived runtime credential lifecycle. Neither is a work attempt. |
| Work attempt / native session | Durable execution of an assignment (#303) versus a replaceable provider session on a host. One task can have multiple attempts; an attempt survives session replacement through `replace-session`. |
| Binding epoch / fence | Agent-consumer generation rejects replaced occupants; resource fence rejects stale claimed writes. Neither substitutes for the other or for live membership. |
| Release / protocol / database migration | Product build identity, negotiated wire capability and physical storage schema are independent of all the above (#307). |

### 14.6 Import/export and acceptance traceability

Definition import and export cover applied definitions only (#299). Agents,
rooms and signal groups use the separate `tila-project-settings` v1 envelope
and explicit identity/profile/resource mapping (#448), exposed by `tila settings`,
Settings → Settings transfer and the MCP `settings` group. See the
[settings transfer guide](settings-transfer.md) for coverage, review and exact
receipt recovery. Access settings and credentials remain excluded. Server state stays authoritative:
starting a client, deploying, provisioning or `init` never reads a definitions
file, and Git-managed or automatically synchronized files remain deferred.

An import is planned on the client against the revision it just read
(`planDefinitionImport` in `@tila/core`), then goes through the normal preview
and revision-checked apply, so a change in between returns 412. A unit is one
named declaration in `work_units`, `records`, `artifacts` or `templates`, or any
other whole top-level key (`hierarchy`, `schema_version`, an unmodeled key).

| Mode | Behaviour |
|---|---|
| `merge` (default) | Each unit in the file replaces the same unit; units the file omits are kept. A declaration is replaced whole, so fields it drops are removals the preview reports. An empty section changes nothing. `schema_version` comes from the file, else the project. |
| `replace` | The file becomes the whole definition. Every removed unit is listed and must be confirmed (`--confirm-removals`, the dashboard checkbox, or MCP `confirm_removals: true`), including template removals the server treats as non-destructive. |

The result is validated as a complete definition before preview; any error means
nothing is drafted or written. Destructive changes still need review and a
strategy; the dashboard also requires its typed confirmation. An import that
only changes comments or unmodeled keys records no revision.

TOML and YAML are supported (`.toml`, `.yaml`, `.yml`; pasted text is detected).
YAML is read with the 1.2 core schema and normalizes to the same document as
TOML; several documents, custom tags, aliases, merge keys and nulls are rejected.
The server stores and validates TOML only, so clients convert YAML first. The
adapter is the `@tila/core/definition-yaml` entry, which keeps the `yaml`
library out of the Worker, Durable Object and SDK bundles.

Export (`tila schema export`, Settings › Definitions, MCP `tila_schema_export`) writes the applied
definition with a `[tila_export]` table: `format = "tila-definitions"`,
`format_version`, `project_id`, `revision`, `exported_at`, and optionally
`applied_at` and `exported_with`. Import checks `format` and `format_version`
(a newer version is refused), warns when a same-project export is older than the
applied revision, and removes the table. A comment header says the file holds
definitions only and is not a backup. Values and unmodeled keys survive; comments
and layout do not. Definitions name no project identities, so nothing needs
remapping; `records.*.schema_ref` and template entity `data` are copied verbatim
and listed in the header. A stored definition that contains credentials is
refused rather than redacted. Full recovery remains the separate #192
backup/restore contract and permissions.

Every new definition write (preview and apply, from any client) passes a guard;
stored text is never re-checked on read.

| Rejected input | Response |
|---|---|
| A definition or reviewed copy over 256 KiB (`DEFINITION_MAX_BYTES`); a request body over 1 MiB + 64 KiB, checked before the idempotency middleware reads it | 413 `payload-too-large` |
| Credential-shaped values (tila, GitHub, AWS and Slack tokens, API keys, JWTs, private keys) or credential-named keys holding a value | 400 `schema-parse-error`, one entry per path; the value is never echoed |
| A `[tila_export]` table (import removes it) or a client connection file (`.tila/config.toml`) | 400 `schema-parse-error` |

`tila schema status` compares local `*.schema.toml` files with the server by unit
(`up-to-date`, `differs`, `unknown`) instead of treating the file as pending.
`tila schema apply` without a revision still sends the files as the whole
definition, and warns. MCP `tila_schema_import` accepts file text, TOML/YAML/detect
format and merge/replace mode. It plans by default and returns the shared unit
plan, warnings, server preview and a `reviewed_plan` snapshot (revision,
canonical TOML definition, removed units). Applying requires explicit `apply:
true`, caller-supplied `expected_revision`, and this unchanged snapshot;
destructive changes also require a strategy. First apply checks the snapshot
against the same revision before sending the normal conditional schema write.
Preview races conflict; an import never silently replans onto newer state.
Idempotent retries retain the original definition, revision, key and strategy:
the server can replay its receipt before checking the stale revision, while a
fresh stale request conflicts without writing. No additional server operation
or transport retry system is introduced. The schema tool group exposes both
transfer tools; the nine-tool default workflow catalog is unchanged. Export
from an unapplied project returns an explicit empty result, while a valid import
can bootstrap against revision 0. `tila_schema_preview` and conditional
`tila_schema_update` remain compatible.

| Scenario / child ownership | Contract review and acceptance probes |
|---|---|
| S1 browser setup/evolution: #296–#300, #305/#306 | Every inventory row has an editor or justified boundary; unused/legacy types remain visible. Competing UI/CLI/MCP edits and stale/partial imports conflict or preserve omitted sections; drafts survive failure. Restore cannot recreate deleted data. |
| S2 cross-host coordination: #283, #294/#295, #298, #301–#305 | Durable agent/attempt/run/session identities stay distinct. Expired/replaced occupants cannot ack or complete work; offline recovery uses durable content. Unsupported host operations and redacted/unavailable observations are explicit. |
| S3 hotfix during change: #295/#296, #303–#308 | Current policy beats snapshots; cancellation/result/answer races retain evidence. Read-only reviewers see permitted history, not privileged binding/credential data. Record the original result and linked corrective work separately. |
| Foundation/acceptance: #293, #294/#295, #307/#308, #194 | #293 defines this contract; closed #294/#295 supply observation/query truth. #307 owns readiness and controlled activation; #308 proves the three journeys and feeds measured outcomes to #194. Fixture success does not close #283 live gates. |

Source audit anchors: [shared schema inventory](../packages/schemas/src/index.ts),
[configuration fields](../packages/schemas/src/config.ts),
[mounted routes](../packages/worker/src/index.ts),
[capability routing](../packages/worker/src/middleware/capability.ts),
[capability ceilings](../packages/schemas/src/capability.ts),
[schema transactions](../packages/ops-sqlite/src/schema-ops.ts),
[retention](../packages/ops-sqlite/src/artifact-lifecycle-ops.ts),
[SDK](../packages/sdk/src/index.ts), [CLI](../packages/cli/src/commands/index.ts),
[MCP tools](../packages/mcp-server/src/tools/index.ts) and
[current Settings](../packages/ui/src/pages/settings.tsx). The inventory includes
declared fields even when current enforcement/editor coverage is incomplete;
implementation must verify the shared operation, not infer behavior from a label.

### 14.7 Work catalogs and presentation (#300)

A type catalog lists every task or record type the caller may read without
reading any page of rows. `GET /tasks/~/types` serves tasks, and the `entries`
field of `GET /records/_types` serves records. Each entry carries:

| Field | Meaning |
|---|---|
| `declaration` | `declared` (in the current schema, possibly with no rows), `undeclared` (rows exist but the schema does not declare the type: never declared, renamed or retired) or `unknown` (the schema could not be read) |
| `count`, `archived_count` | Non-archived and archived rows visible to the caller |
| `definition` | Declared fields in declaration order, the lifecycle, and presentation metadata (§6.1). Only for declared types |

- **Retired types stay visible.** A type with stored rows is listed even after
  its declaration is removed, so its content remains readable.
- **Scope is stated.** `scope.restricted` is true when namespace restrictions
  narrowed both the types and the counts. A restricted caller never sees a
  declared type it may not read, and never learns whether the schema could be
  read: it receives no `incomplete`, and an unreadable schema reads as nothing
  declared rather than `unknown`.
- **Partial failure is explicit.** When the schema or the counts cannot be read,
  `incomplete` names the missing half, mirroring the records types response.
- **Display only.** Catalog definitions and presentation metadata guide clients;
  they grant nothing. Authorization stays on the server.

### 14.8 Paging and search scope (#300)

**Task lists use keyset cursors.** `GET /tasks` orders by `sort` (default
`created_at`) and always breaks ties by `id`, so the order is total even when
many rows share a timestamp. With a `limit`, the response carries an opaque
`next_cursor` (null on the last page); pass it back as `cursor`.

- A cursor is bound to the filter and sort it came from. Reusing it with other
  parameters returns `400 invalid-cursor` instead of skipping or repeating rows.
- `cursor` and a non-zero `offset` cannot be combined. Offset paging still works,
  and its responses also carry `next_cursor` so callers can switch.
- `total` counts every row matching the filter and the caller's restrictions.
  `scope.restricted` says restrictions applied; `scope.archived` says whether
  archived rows were excluded (`archived=0`) or included (no `archived` filter).
- Migration 35 adds `(created_at, id)`, `(updated_at, id)` and `(type, id)`
  indexes. `title` and `status` sorts read `data.title` and `data.status`
  directly (not presentation metadata) and are not indexed.
- **Page size.** Without `limit`, every matching task comes back in one response
  (`limit: null`, `next_cursor: null`); send a `limit` to page. A `limit` above
  500 is served as 500 and the response echoes the effective value. The per-page
  tag, blocker and artifact lookups run in slices of 90 ids, so neither an
  omitted `limit` nor one above 100 meets Durable Object SQLite's 100-value
  statement cap (#519).

**Unified search pages with per-kind offsets.** `GET /search` ranks each kind by
FTS5 bm25 with an id tie-break. bm25 scores shift whenever the corpus changes,
so a keyset on the score would not be stable; the cursor instead holds one
offset per kind, bound to the query. Pages are deterministic for an unchanged
corpus and may drift under concurrent writes. Each kind stops at depth 1000.

| Parameter | Meaning |
|---|---|
| `kind` | Comma list of `task`, `record`, `artifact`. Defaults to every kind the caller may read. Task results carry `type: "entity"` |
| `type` | Comma list of task or record types. Requires exactly one `task` or `record` kind |
| `syntax` | `fts` (default): FTS5 query syntax. `literal`: plain words, each quoted, the last prefix-matched |
| `cursor` | `next_cursor` from the previous page |

- **Task ids are searchable.** Migration 35 indexes `entity_id` beside the title,
  weighted below it, so `task-251` or `251` finds the task.
- **Titles follow presentation.** The indexed title is the declared
  `presentation.title` field, else `data.title`, else `data.name`. Applying a
  schema that changes a type's `presentation.title` re-derives the indexed
  titles of that type's tasks in the same transaction.
- **Ids are tokenized.** `task-251` indexes as `task` and `251`, so a common id
  prefix matches many tasks. Title matches still rank first.
- **Scope is explicit.** `scope.kinds` lists the kinds searched and
  `scope.excluded_kinds` the ones left out, with a reason: `capability` (a
  scoped credential lacks `tasks:read`, `records:read` or `artifacts:read`) or
  `restricted` (namespace-restricted credentials never search artifacts).
  Asking for an excluded kind explicitly returns 403. Archived tasks and records
  never match (`scope.archived: "excluded"`).
- **Restricted credentials can search.** Exact `/search` is allowed for
  namespace-restricted credentials; tasks and records are filtered by the same
  restriction conditions as lists. `/search/reindex` stays denied.
- `total` is the number of results in the page, not a match count.

### 14.9 Dashboard navigation and Overview (#306)

The dashboard groups its pages into five sections. Every page keeps its URL, so
deep links and bookmarks still open the same view.

| Section | Pages (path below `/p/:projectId/`) |
|---|---|
| Overview | `overview` (the project's default page) |
| Work | `tasks`, `queue`, `records`, `artifacts`, `journal` |
| Conversations | `rooms`, `deliveries`, `signals` |
| Runtime | `runtime`, `agents`, `presence` |
| Settings | `settings` (access), `settings/definitions` (read-only definitions) |

- **Old links redirect.** Flat URLs from before project-scoped routes
  (`/tasks/:id`, `/rooms/:id?thread=…`, `/entities/:id`) move below the active
  project with their sub-path, query and fragment, replacing the history entry.
  `entities/:id` opens that task.
- **Visibility is a convenience.** Sections and command-palette entries the
  caller's effective policy cannot read are hidden; namespace-restricted
  credentials only see the surfaces the Worker allows them. A deep link to a
  hidden page still renders that page's own forbidden state.

**The Overview separates observed facts from attention rules.** Each rule reads
an exact, caller-scoped count from a server list and states why a non-zero count
needs a person. The count links to the list it was counted from.

| Rule | Severity | Observed fact | Links to |
|---|---|---|---|
| `execution.uncertain` | red | Queue entries whose execution outcome is uncertain | `queue?state=uncertain` |
| `execution.lease-lapsed` | red | Executions starting or running past their lease | `queue?lease=expired` |
| `decisions.waiting` | red | Open questions routed to the caller, including escalations to them | `decisions` (the inbox's "Waiting on me" view) |
| `work.blocked` | amber | Open tasks waiting on prerequisites | `tasks?blocked=1` |
| `work.failed` | amber | Unarchived tasks in their type's failure or abandoned state | `tasks?outcome=failure,abandoned` |
| `execution.suspended` | amber | Queue entries whose execution is suspended | `queue?state=suspended` |
| `delivery.wake-suppressed` | amber | Pending deliveries whose wakes stopped | `deliveries?state=pending&wake=suppressed` |
| `delivery.expired-recent` | amber | Deliveries that expired unacknowledged in the last day | `deliveries?state=expired&expires_after=<cutoff>` |
| `runtime.occupant` | amber | Agents whose current occupant needs a check | `runtime?filter=attention` |

Each count is the `total` of the list its link opens, read with `limit=1` and the
same URL-derived filters the list page applies (`packages/ui/src/lib/list-queries.ts`).
The expired-deliveries cutoff is fixed when the count is read, and the link
carries that exact cutoff. `work.failed` is not applicable, rather than zero,
when no type declares either outcome. Failure states are terminal, so a
failed task keeps counting until it is archived; the rule says so and is amber
rather than a standing red alarm. `decisions.waiting` is red because the worker
that asked stops until someone answers. It is not applicable when the credential
has no principal, since nothing can be routed to it. Escalation reroutes a
question to one named owner, so filtering by responder covers it.

**Blocked counts and legacy readiness (#398).** `work.blocked` and
`GET /tasks?blocked=1` use the same readiness rules as the queue
(`evaluateReadiness`, `isTerminal` and `blockedTaskIds` in
`packages/ops-sqlite/src/ready-ops.ts`). A task type that declares no
`[work_units.<type>.lifecycle]` is judged by the legacy rule: only status
`closed` is finished. A project that marks finished work `done` therefore sees
those tasks counted as open, and a prerequisite in any other status keeps its
dependents waiting. A type that does declare a lifecycle also waits on a
prerequisite of an undeclared type, whatever that prerequisite's status.

The dashboard keeps these semantics and explains the count instead of changing
it:

- **No guessed meanings.** `done`, `completed` and `cancelled` are not treated
  as finished for a type that has not said so, and no type is left out of the
  count in the dashboard only. The count and the list it links to stay equal to
  the queue's own reasons. Declaring a lifecycle for the type is the fix, and it
  needs no data migration. The development seed declares one for `task`
  (`packages/cli/tila.schema.toml`: `done` is terminal and successful);
  `epic` and `milestone` are dependency-free containers with no known finished
  state, so they stay unconfigured on purpose.
- **Where it shows.** A note sits in the `work.blocked` row of the Overview and
  under the filtered Tasks list (`tasks?blocked=1`), including when the count
  is zero: a zero does not show that every type declares a lifecycle. Search
  results do not apply the filter and do not carry the note.
- **Where it comes from.** Only the work type catalog (§14.7): a visible type is
  named when it is `declared` without a `definition.lifecycle`, or `undeclared`.
  The names never come from a page of rows, which can omit a type, and never
  from a prerequisite's reasons.
- **Unknown is stated as unknown.** A failed or stale catalog, an `unknown`
  declaration, or `incomplete` in the catalog reads as "coverage unknown", never
  as every type having a lifecycle. When every visible type declares one and
  the catalog is complete, there is nothing to explain and no note.
- **Restricted credentials.** A `task_types` restriction adds a caveat that
  prerequisites of types the credential cannot see are counted but not named,
  and the note lists only the types in that credential's own catalog. Any
  namespace restriction, including records only, hides the schema's read state,
  so an undeclared type is worded as one the credential "sees no lifecycle
  for" rather than as declared absent. A records-only restriction hides no task
  type and makes no claim that some are hidden.
- **Access-aware link.** The note links to Settings › Definitions only when the
  caller's access includes it; otherwise it says so and names no page.

Workflow-attempt rules wait for a list page that can show them.

**Attention filters.** These list parameters give the Overview exact,
caller-scoped counts for problems that a plain status filter cannot express.
Each list's `total` counts every match across pages, so a count and the list it
links to always agree.

| Request | Matches |
|---|---|
| `GET /tasks?blocked=1` | Open tasks (not archived, not terminal) whose readiness reports an unresolved, missing, cyclic or lifecycle-unconfigured prerequisite. Soft blocks count; pending gates and the task's own state do not. A visible task blocked by a task the caller cannot see counts, without revealing it. |
| `GET /tasks?outcome=failure,abandoned` | Tasks whose declared lifecycle field holds the state their type names for one of those outcomes. `scope.outcome_types` lists the visible types that declare one; an empty list means nothing can match, not that nothing failed. |
| `GET /deliveries?state=pending&wake=suppressed` | Pending deliveries whose wakes stopped (stall, budget, hop or pair limit) until someone resumes them. |
| `GET /deliveries?state=expired&expires_after=<ms>` | Deliveries that expired after that time, including pending rows past their TTL. Expired rows are never deleted, so an unbounded count would only grow. |
| `GET /queue?lease=expired` | Entries whose latest attempt is starting or running past its execution lease: the caller-scoped view of the `expired_execution_leases` diagnostic. |
| `GET /questions?state=open&responder_principal_id=<caller>` | Open questions whose current responder is the caller. `total` applies the same task-type restriction as the rows, so a namespace-restricted credential counts only questions on tasks it can read. `escalated=true\|false` narrows any question list the same way. |
| `GET /runtime-view?filter=attention` | Agents whose current occupant expired, cannot be confirmed, or whose host stopped reporting while attached (`runtimeAttention` in `@tila/core`). A run-store outage is reported in `sources`, not counted. The Worker scans at most 250 agents per request; `scan.complete` is false beyond that and `total` is then a floor. |

`blocked`, `outcome`, `wake` and `expires_after` are bound to list cursors, so a
cursor issued for one filter is rejected under another. The SDK exposes task
`blocked?: boolean` and `outcome?: LifecycleOutcome[]` filters over HTTP and local
Node/Bun backends. `tasks.list` preserves entities plus the exact total, limit,
offset, has_more, next_cursor and scope (including outcome_types). Existing
array-returning `EntityBackend.list` remains compatible; optional `listPage`
supplies metadata without reconstructing totals from a page. CLI `task list`
accepts `--blocked`, `--outcome` and `--cursor`; MCP `tila_task_list` accepts the
same filters and paging options. Local SDK lists still return full entities
when compact is requested. Third-party array-only backends report unsupported
metadata explicitly and cannot silently ignore attention filters or cursors.

The page states are derived in order:

1. **Attention:** a rule found something. The most urgent finding (red before
   amber, then the larger count) is the next action.
2. **Setup:** `GET /schema` returns no applied schema and the catalogs report
   no tasks or records. The page links to Settings › Definitions and access
   management instead of asking for a local schema file.
3. **Pending:** a check is still loading. No count is shown yet.
4. **Unchecked:** the caller's access includes no check.
5. **Unknown:** no check completed.
6. **Partial:** nothing found, but a check failed, is stale, scanned only part
   of its data, or lacks deployment configuration. This is never an all-clear.
7. **Idle:** every check completed and found nothing.

A forbidden check is listed as "not checked with your access", never as zero.

### 14.10 Task write bounds (#519)

Two task writes that used to reach SQLite and answer a retryable 500 are
refused before the write, with a non-retryable error.

**Task data is limited to 256 KiB.** The limit is `MAX_TASK_DATA_BYTES`
(262,144) in `@tila/schemas`, measured as the UTF-8 byte length of the JSON the
task's `data` is stored as, so key order does not change it and multibyte
characters count by bytes. `data` exactly at the limit is accepted; one byte more
is refused with `413 payload-too-large` and `retryable: false`, and nothing is
written (no task, tags, search document or journal event).

| Write | What is measured |
|---|---|
| Create (`POST /tasks`) | The `data` of the new task. The Worker refuses it before the Durable Object hop; the shared ops layer checks every create again, including each task a template creates. |
| Update (`PATCH /tasks/:id`) | The merged `data` (stored data with the patch applied), not the patch. A patch under the limit can still be refused. |

- **Oversized stored tasks can only shrink.** A task whose stored `data` is
  already over the limit (written before the bound existed) may be updated only
  when the result is strictly smaller than what is stored. That lets a client
  trim it; an update that keeps the size or grows it, including a patch that
  changes nothing, is refused with the same `413`. Once the task is within the
  limit the ordinary rule applies.
- **Attempts are not stranded.** An execution attempt's lifecycle transition
  (the start state or an outcome state named by the definition) is not
  refused for size, so work already in flight on such a task can still finish.
  Only that one write is exempt; the same state set by a client update is not.
- **Same rule everywhere.** The check lives in the shared ops layer, so
  embedded and local backends refuse the same way. They raise
  `TaskDataTooLargeError`, which maps to `payload-too-large`.
- Records keep their own 64 KiB bound; task list behavior is unchanged.

**A relationship needs two existing tasks.** `POST /tasks/relationships` checks
`from_id`, then `to_id`, for every relationship type, and answers
`404 not-found` naming the first missing id with `retryable: false`. Nothing is
written. Valid requests (`201`, `created: true`) and duplicates (`200`,
`created: false`) are unchanged, and a `parent-child` request is still refused
with `422` when the parent's type is the hierarchy leaf (checked after both tasks
are known to exist). Archived tasks remain valid endpoints. Embedded and local
backends do not yet make this check; their callers see the database's foreign
key error.

## Managed execution foundations

Managed dispatch is advertised as `managed-queue-v1` and stays disabled until a
maintainer enables a project. Adding lifecycle metadata does not enroll or launch
a task. Shared SQLite migrations hold durable queue entries, attempts,
execution/WIP reservations and command receipts.

An attempt has a separate identity from its task, enrollment, participant and
provider session. A reservation holds capacity before acceptance. Acceptance
commits the optional lifecycle start transition and authorizes launch; the
adapter then binds the provider session. Results commit their optional task
transition, terminal history, reservation release and receipt together. A schema
or gate conflict rolls the result back, leaving the attempt available for
reconciliation. A competing terminal command observes the first committed result.

Execution authority includes principal, participant, fence and an unexpired
claim. Commands use revision preconditions and durable operation keys. Replaying
an acceptance returns the current attempt and current `grant_valid`, never a
cached permission to spawn. A receipt does not extend a lease twice. Receipts
are retained with attempt history and are not removed by the generic seven-day
idempotency sweep.

Expiry before acceptance abandons the unstarted attempt and returns its entry
to the backlog. Expiry after acceptance makes the attempt uncertain and retains
both capacity reservations, even if the ordinary claim has already been swept.
The old fence is invalidated. Expiry runs before attempt mutations and during
sweeps; admission will evaluate it in its own transaction. A missing heartbeat
is not evidence that an external process stopped.

### Queue admission and managed work

The admission backend uses one explicitly enrolled project queue. Enrollment
does not launch work. Selection orders priority descending, enrollment order
ascending, then stable ID; blocked, incompatible and differently targeted work
is skipped. Capabilities describe scheduling compatibility and never replace
resource authorization.

Admission checks the current project policy, lifecycle/dependency/gate snapshot,
claims and reservations in one SQLite transaction. That transaction reserves
execution and WIP, establishes the claim and attempt, journals the grant and
records the command receipt. A replay rechecks current task access and reports
current grant validity. A reserved grant still requires acceptance before launch.

An explicit positive execution limit is required to enable dispatch. WIP is
uncapped unless configured and counts distinct admitted items. Pausing prevents
new grants, while existing grants may be accepted and finished. Lowering a limit
does not evict work. Empty, blocked, paused and exhausted capacity are ordinary
no-grant results, distinct from conflicts and unavailable service.

Unfinished enrollment prevents generic claim acquisition, renewal, release and
task archival. Terminal lifecycle changes must commit with the attempt result;
nonterminal lifecycle changes require the current execution authority. Ordinary
content edits use an explicit zero-fence content path on managed tasks and never
grant execution authority. Supplying a positive fence continues to require a
live matching claim, so stale execution writes are rejected. Unmanaged tasks
retain their existing claim behavior.

Once enabled, managed configuration permanently requires revision-aware writes,
even after dispatch is disabled. Migration 33 preserves that marker. The DO
transport and embedded facades share the same operations.

### Suspension, cancellation and recovery

Suspension is a two-step protocol: a participant requests it, then the owning
adapter confirms quiescent execution and supplies a checkpoint. A request alone
keeps both reservations. Confirmation revokes the execution fence and releases
execution capacity while retaining the task and its WIP reservation. Suspended
attempts need no execution heartbeat. Adapters without safe suspension keep
occupying execution capacity.

Resume requests place the same attempt in `resume_pending`. Its owner must obtain
a fresh execution grant after policy, capacity, capabilities, targeting,
dependencies and gates have been checked. The task may be in its nonterminal
working state; the initial dispatchable state is not required for continuation.
A successful grant moves directly to `starting`, with a fresh fence. An earlier
resume receipt cannot authorize a later grant. Paused projects do not resume new
execution. Finishing or cancelling safely suspended work does not require a new
external execution slot.

Cancellation records intent and retains capacity. Acceptance rejects a reservation
that was cancelled before launch. An explicit stopped result finalizes the
attempt; cancellation and success racing to finish retain the first committed
outcome. Results on expired execution require reconciliation, not an old fence.

Reconciliation records an observed running, stopped or unknown execution. Running
observations must match the recorded session and issue fresh authority without
releasing occupied capacity. Unknown observations retain uncertainty and both
reservations. A confirmed stopped observation can commit an explicit outcome.
Like a finish, it cannot record a result for a reservation that was never
accepted, except a cancellation that was requested before launch. The owner may
reconnect; changing execution ownership requires maintainer authority, a reason
and the same recorded session. Membership and resource access are enforced by
the authenticated transport, outside the project transaction.

Automatic retries are opt-in through `retry_safe`, default to three total
attempts, and use exponential backoff starting at five seconds and capped at
five minutes. A failed, confirmed stopped execution can return its enrollment
to the backlog while retaining WIP. Cancellation intent suppresses automatic
retry. Every replacement receives a distinct attempt ID and predecessor link;
a preaccept expiry of a replacement retains already-admitted WIP. Explicit retry
requires a stopped unsuccessful outcome, current revision, available WIP and no
newer attempt or unfinished enrollment. Attempt ordering uses the task fence,
so same-millisecond completions cannot scramble predecessor history.

Force recovery requires maintainer authority and a reason. It records abandonment
with unresolved external execution, invalidates old authority and schedules a
replacement while retaining WIP. It does not assert that the old process died.
All replacements still require dispatchable lifecycle state: configure a failure
or abandonment mapping when that transition should happen automatically. Absent
mappings leave task status unchanged and can leave replacement work blocked.
Schema or gate conflicts roll back the entire result/recovery transaction.

These operations share the SQLite domain implementation and embedded facade.

### Attempt control authority (#303)

Enrollment records the assigner: the principal and participant that enrolled the
work (`enrolled_by_principal`, `enrolled_by_participant`; migration 38). Requests
to cancel, suspend or resume an attempt, and explicit retry, are accepted from
three callers:

- the attempt's current owner (principal and participant)
- the assigner principal
- a maintainer or owner

Editing or withdrawing an enrollment is limited to the assigner or a maintainer.
A former owner is none of these, so after a rebind, resume or retry it cannot
cancel or otherwise steer the replacement execution. The check runs before the
receipt lookup, so replaying an earlier receipt is also rejected once authority
has moved. Enrollments created before migration 38 have no recorded assigner:
control requests fall back to owner or maintainer, and edit/withdraw keep the
earlier task-writer behavior.

Control requests carry no fence. `expected_revision` covers it, because every
new fence also bumps the attempt revision. Finishing suspended work, which has
no live grant, requires the latest recorded fence.

When a maintainer forces recovery or records a stopped reconciliation, the
journal names the maintainer as the actor and the execution owner in
`owner_principal_id`/`owner_participant_id`. Task transitions still run under
the owner's fence. Retrying an enrollment under a new key while the first is
unfinished returns `queue-conflict` naming the existing entry, in the message and
in `details.entry_id`, so a client can reconcile an ambiguous failure.
`GET /health` advertises `attempt-control-v1` when a Worker enforces these rules.

### Session replacement, revisions and recovery queries (#303)

An attempt can outlive a provider session. When the recorded native session
stops and the same work continues in a new one, for example after a provider
restart, the owner calls `replace-session`:

- **Command:** the recorded fence and revision, a reason, `previous_session`,
  `previous_stopped: true`, the new `session`, and an optional checkpoint.
- **Caller:** only the exact owner (principal and participant). To change owners,
  a maintainer rebinds first; rebind keeps the recorded session.
- **States:** `running`, or `uncertain` after lease expiry. `previous_session`
  must equal the recorded session, and the new session must differ (the same
  session reconnects through `reconcile` with `observation: "running"`). A
  pending cancellation is rejected; record the stopped outcome instead.
- **Effect, in one transaction:** the old claim and fence are revoked, open
  questions are superseded, a fresh fence is issued, and the session, checkpoint
  and `revisions.authorized` are written. `attempt.session_replaced` records
  the previous session and fence. The task lifecycle and outcome are untouched.
- **Retries:** the receipt stores the issued fence. A replay returns current
  state, and `grant_valid` is true only while that fence is still current.

When the old session's state is unknown, or the attempt is already terminal, the
work continues in a new attempt instead: force recovery or retry, then a fresh
claim. That attempt has a new ID, a `predecessor_id` link, its own acceptance and
no inherited checkpoint, questions or fence. Neither path inherits the old
session's authority.

Attempts record governing revisions in `revisions` (migration 39). Each snapshot
holds the project schema history version (`definition_version`), the queue
policy revision and a timestamp:

| Snapshot | Written at |
|---|---|
| `reserved` | Admission |
| `authorized` | Accept, claim-resume, reconnect, rebind and session replacement |
| `finished` | The terminal result, including expiry of an unaccepted reservation |

The same values appear on the matching journal events, and `GET /attempts/:id`
adds `current_revisions` so clients can show drift. Snapshots are audit
evidence only. They never authorize an operation or select older rules:

| Change during an attempt | Effect |
|---|---|
| Queue paused or disabled | Blocks new grants and claim-resume only; accepted work can heartbeat and finish |
| `lease_ms` changed | Applies at the next heartbeat or fresh grant |
| Limits lowered | Never evicts live work |
| Enrollment edited | Affects later resume and retry admission |
| Definition changed | Applies at the next lifecycle transition |
| Membership or credential revoked | The next request is rejected (401/403) before any receipt replay |

When the current definition rejects a transition, such as a result whose
lifecycle mapping or required fields no longer validate, the whole transaction
rolls back and the attempt is unchanged. The error keeps its existing contract
(`422 constraint-violation` for a field rule, `409 queue-conflict` when the
lifecycle was removed), and its message now names the current and captured
definition versions. Repair the definition, then finish or reconcile again.

Attempt lists accept `principal_id`, `participant_id` and `active` filters
(`active=true` selects every nonterminal state), backed by the
`work_attempts_owner` index. A restarted wrapper finds its unfinished work with
these filters instead of paging through the project. `GET /health` advertises
`attempt-session-replacement-v1`.

### Corrections and result projections (#303)

A terminal attempt's result is permanent. Application code never rewrites it,
and migration 40 adds a trigger that rejects changes to `state`, `outcome` or
`finished_at` on a terminal row. When a regression is found after an accepted
result, the follow-up is linked instead:

- `POST /attempts/:id/correct` with `{ idempotency_key, task_id, reason }`
  appends an `attempt_corrections` row. The attempt must be terminal (any
  outcome); the corrective task must exist and not be archived, and may be the
  same task or a new one, queued or not.
- The caller needs task write access to both tasks. A pair can be linked once;
  replays return the same view. Links are append-only (a trigger rejects
  updates) and `attempt.corrected` is journaled on the original attempt.
- `GET /attempts/:id` lists `corrections` oldest first. The original outcome,
  evidence and revisions are unchanged.

Two read projections now show attempt evidence, read from attempt records and
never inferred from runtime or delivery state:

- The runtime view's `work_attempt` lists up to five unfinished attempts held by
  the current binding's principal and participant, with the total. Callers
  without `tasks:read` and `claims:read` get `{ "detail": "redacted" }`; rows
  without unfinished attempts get `null`.
- Delivery traces report `work_result` from the message's `attempt_id`, as
  described in "Delivery tracing".

Backups include `attempt_corrections` and declare `attempt-corrections-v1`.
Restore checks that every correction references a finished attempt and an
existing task. `GET /health` advertises `attempt-corrections-v1`.

### Managed queue public contract

The SDK exposes `queue` and `attempts` alongside the existing task facade. The
conversation `dispatch` namespace remains independent. HTTP uses project-scoped
`/queue` and `/attempts`; CLI uses `tila queue` and `tila attempt`; MCP exposes
`tila_queue` and `tila_attempt` in the default workflow catalog and the optional
`queue` group. All surfaces delegate transitions to the same SQLite operations.
`GET /health` advertises `managed-queue-v1`; project activation remains explicit.

| Surface | Inspection | Mutations |
| --- | --- | --- |
| Queue HTTP | `GET /queue`, `GET /queue/policy` | `POST /queue/configure`, `/enroll`, `/claim`, `/entries/:id/edit`, `/entries/:id/withdraw` |
| Attempt HTTP | `GET /attempts`, `GET /attempts/:id` | `POST /attempts/:id/<action>` |
| SDK queue | `policy`, `inspect` | `configure`, `enroll`, `edit`, `withdraw`, `claimNext` |
| SDK attempts | `get`, `list` | `accept`, `started`, `heartbeat`, `finish`, `requestSuspension`, `confirmSuspension`, `requestResume`, `claimResume`, `requestCancellation`, `reconcile`, `rebind`, `retry`, `forceRecovery`, `replaceSession` |

HTTP attempt actions use kebab case. Mutation bodies carry `idempotency_key` and,
where applicable, `expected_revision` and `fence`. If supplied, the HTTP
`Idempotency-Key` header must match the body. Queue/attempt commands bypass D1
response caching: current authentication, membership and resource permissions are
checked before the permanent project-local receipt. Receipt replay returns
current state and grant validity. An old claim or acceptance fence cannot become
valid again after resume, rebind, expiry or restore. Read responses are not cached.

Queue inspection supports state, type, priority, target and capability filters,
plus `limit` (1–500) and `offset`. Attempt inspection supports task, enrollment,
state, owner (`principal_id`, `participant_id`) and `active` filters with the
same pagination bounds. Resource restrictions apply before
pagination; restricted predecessors are not disclosed in block diagnostics.
Scheduling capabilities are declared compatibility metadata, not authorization.
A valid denial (`no_grant`: disabled, paused, empty, blocked or capacity exhausted)
is distinct from transport failure and conflict errors.

The CLI accepts operation JSON through `--data` or `--file`, including stable
idempotency keys. For example:

```bash
tila queue policy --json
tila queue configure --data '{"idempotency_key":"enable-1","expected_revision":0,"enabled":true,"paused":false,"execution_limit":20}' --json
tila queue enroll --data '{"idempotency_key":"enroll-ticket-1","task_id":"ticket-1"}' --json
tila queue claim --participant-id worker-1 --data '{"idempotency_key":"poll-1","capabilities":["coding"]}' --json
```

Only a successfully accepted, currently valid grant authorizes launch. Keep the
same participant identity for subsequent attempt operations. CLI list output
uses the existing `{ "ok": true, "result": { "items": [...] } }` collection
envelope. SDK methods return typed results directly. MCP wraps results in its
structured `result` envelope. Explicit local MCP mode requires local paths and
rejects mixed remote credentials; separate local databases are never distributed.

Migration 34 adds destination queue fence watermarks to transfer bookkeeping.
Backups now contain policy, enrollment, attempts, reservations and permanent
receipts and declare `managed-queue-v1`. Older compatible archives remain readable.
After digest verification, restore pauses dispatch, raises fences above both
snapshot and destination values, removes copied claims, and marks every saved
nonterminal attempt uncertain. This includes suspended snapshots: the source
process may have resumed after export. Confirmed quiescent reconciliation can
return such an attempt to suspended while retaining WIP. Terminal history and
receipts remain intact. Never interpret restoring a database as stopping a process.

### Durable questions and decisions (#304)

Questions belong to accepted work attempts. Each has an independent UUID, text,
requester principal/participant, attempt ID, captured attempt revision and fence,
initial session/binding provenance, designated responder, question revision,
routing history, optional discussion references, and immutable answer evidence.
An answer is an explicit operation; conversation messages remain peer content.

| Transition | Behavior |
|---|---|
| Ask | Current attempt holder with a valid claim supplies `expected_revision`, `fence`, `attempt_id`, a caller-generated question `id`, and a responder principal. |
| Answer | Current designated responder supplies `question_id`, `expected_revision` (question revision), `attempt_id`, `attempt_revision` (captured at ask), `attempt_fence`, `text`, and `idempotency_key`. |
| Escalate | Designated responder or maintainer names a current project owner and a reason. The question remains open with a new revision and routing entry. |
| Cancel | Current requester, responder, or maintainer closes the question with a reason. |
| Attempt cancellation/result | Open questions become superseded in the same transaction. Existing answers remain historical and lose applicability. |
| Lease expiry | Questions remain answerable as evidence. Execution authority is not restored by an answer. |
| Replacement fence/agent binding | Pending questions become superseded; answered questions retain evidence. Ask a new question with `predecessor_id` for fresh confirmation. |

Initial provider-session attachment and ordinary heartbeats do not invalidate the
saved question context. A new execution fence does. `answer_applicable` is
computed for the requesting caller's live attempt authority on every read and
receipt replay. It is a point-in-time observation, not a transferable execution
grant; subsequent work must still validate its fence. Questions never pause or
resume execution and do not release queue capacity.

All mutations use durable operation receipts scoped to principal, participant,
operation, and key. Identical retries return the saved operation result with
fresh applicability; changed payloads conflict. Read the question again for its
latest revision. Authorization is evaluated before returning a receipt.

The Worker rechecks responder membership and capability at answer time, including
bootstrap credentials. Escalated answers require the named principal's current
owner role. Runtime callers must have a current acting agent binding; relay or
replaced runs cannot read or mutate questions. Task restrictions apply to both
individual reads and list pages. Embedded backends use the existing trusted
local-process authority model, retaining identity, correlation, and fence checks;
they do not reproduce D1 membership administration.

Existing room publication supplies discussion transport. Link references only
when the message is readable and its `task_id`, `attempt_id`, and `correlation_id`
match the question. References never copy message bodies or grant room access.
Local conversation publication remains unsupported; local references must resolve
to rows already present in that database.

Recover open questions with the question list API. Recover changes through the
existing journal replay and acknowledgment cursor. Journal events contain the
question ID and revision; fetch the durable record for content. Process by
question/revision and acknowledge only after processing. A retry may replay an
event; this guarantees one persisted answer, not exactly-once external execution.


## Authenticated project reports (#321)

`POST /projects/:projectId/journal` appends the reserved `custom.reported`
envelope. A report proves an authenticated principal/participant submitted an
observation. It does not verify the observation or change tasks, claims, attempts,
gates, assignments, or capacity. The server stamps `seq`, `t` (recorded Unix ms),
identity, environment headers, credential attribution, and any validated fence.
The producer's contract is stored in the envelope's `data` object:

```json
{
  "event_name": "pipeline.tests_passed",
  "event_version": 1,
  "target": { "kind": "resource", "resource": "task:T-142" },
  "correlation_id": "run-abc",
  "occurred_at": "2026-10-12T12:00:00Z",
  "data": { "suite": "unit", "passed": 87 }
}
```

The request requires `event_name`, `event_version`, `target`, and object `data`.
Names match `[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+`, maximum 128 characters.
Versions are producer format labels (1–2,147,483,647), without registration.
Unknown names and versions remain inspectable. JSON data is limited to 16 KiB
serialized UTF-8 and 16 container levels, counting its root object as level 1.
The HTTP body is limited to 64 KiB. Unknown contract fields are rejected.
`correlation_id` and the required `Idempotency-Key` header each accept 1–128
printable ASCII characters. `occurred_at` must be an RFC 3339 datetime with an
explicit timezone. Producer timestamps never affect sequence ordering.

| Target | Meaning and validation |
| --- | --- |
| `{ "kind": "project" }` | Project observation; server resource is `project:<projectId>` |
| `{ "kind": "resource", "resource": "task:T-142" }` | Observation about an existing task or `record:<type>/<key>`; no ownership assertion |
| `{ "kind": "claim", "resource": "task:T-142", "fence": 7 }` | Requires a live claim held by the authenticated principal and participant, matching the current fence |

Task IDs are canonicalized to their stored `<type>:<id>` resource. Resource
strings are bounded to 1,024 characters and must resolve in this project.
Optional `artifact_refs` contains up to ten existing canonical artifact keys;
expired/tombstoned artifacts and non-project-visible resources are rejected.
Optional `corrects_seq` is a positive safe integer referencing an earlier custom
report. Corrections validate live or archived history and current reference
access, then append another event. Existing history is immutable.

Append requires current project write authority, an explicit participant, and
`journal:append`. Linked references additionally require their read capabilities;
claim-bound reports require `claims:read`, and corrections require `journal:read`.
Namespace-restricted credentials cannot append or read this project-wide journal.
Conversation/private attachments are unsupported. Arbitrary JSON fields do not
establish references, permissions, or ownership. Environment labels are reported
metadata, not authenticated machine identity.

Migration 37 adds `journal_report_receipts`, fixed-minute rate counters, and
partial expression indexes for custom event name and correlation. The event,
receipt, and counters commit in one project SQLite transaction. D1 response replay
is bypassed. Keys are scoped to project, principal, and participant; credential
rotation does not reset them. Canonical JSON hashing ignores object-key order.
Current permissions, reference access, and claim authority are rechecked even on
retry. An authorized identical retry returns the original event and attribution;
a changed request with the same key fails with `idempotency-key-conflict` (422).

The response is `{ "ok": true, "event": {...}, "dedup_expires_at": <Unix ms> }`.
Acceptance and replay return 200; replay also sets `Idempotency-Replayed: true`.
Receipts expire exactly seven days after acceptance, without extension. After
expiration, key reuse is a new submission and can duplicate a historical report.
This guarantee does not provide unbounded exactly-once delivery.

Live inspection supports indexed `event_name`, `correlation_id`, and existing
resource filters. Archived ranges retain the explicit archive-boundary response;
use replay for older history. Unfiltered replay remains complete, including
custom reports. Acknowledging a sequence means processing that journal
position, never acknowledging an external command. Inspection does not advance a
consumer cursor. Handoffs/reentry reuse the same unfiltered replay stream.

`GET /journal/replay` also takes `event_name` and `correlation_id`, which select
`custom.reported` rows by exact value across live and archived history; both
must match when both are given. A row without the field never matches, and the
`custom.reported` kind is part of the match even though stored rows are not
required to carry it. The filters never reach re-entry.

A filtered request examines up to `JOURNAL_REPLAY_SCAN_BUDGET` (1000) sequences,
five maximum-size pages, and `limit` caps the matches returned rather than the
sequences examined. History for the whole examined range is merged and checked
for missing or conflicting sequences before any row is filtered, so lost history
fails with `journal-history-unavailable` (503) or `journal-history-conflict`
(409) even when the filter matches nothing. The archive is read once per request,
however many pages' worth of sequences it covers.

`next_after_seq` reports what was actually examined: the end of the examined
range, or the sequence of the last match when more matches than `limit` were
found. `has_more` is `next_after_seq < through_seq`. A filtered page can be empty
while `has_more` is true, so every client loops on `has_more`, never on page
size, and resumes without skipping or repeating a sequence. Filtered replay is
a lookup, not a consumer stream: acknowledging its `next_after_seq` would mark
events the filter skipped as processed.

Archive objects carry only sequence-range metadata, not names or correlation
IDs, so an archived search streams every overlapping object. The durable index
is a separate change; the request shape does not depend on it.

Complete project backups preserve reports, identity, sequence, and receipt
expiration; compatible older backups restore new tables empty. Local/embedded
backends can inspect imported reports, but append returns
`unsupported-capability` because local identity is not service-authenticated.
Built-in writes remain transactionally coupled to their domain operation.

Public API read schemas tolerate unknown event kinds. Consumers validating the
older closed `JournalEventKindSchema` must upgrade before consuming projects
that contain `custom.reported`. Reports are never disguised or omitted for older
clients. Upgrade readers before enabling producers; deploy the Worker and bundled
UI together. There is no pipeline engine, trigger execution, or attempt-reference
contract introduced by this feature.
