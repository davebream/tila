# tila — Technical Architecture

> The technical specification. Detailed enough that an autopilot can implement against it without inventing things. Reads top to bottom; subsections reference each other but each section is meaningful on its own.

---

## Section 0: Implementation stack

The languages, frameworks, and libraries this is built with. Decisions are made; deviations require justification.

### 0.1 Core stack

- **Language:** TypeScript throughout. CLI, Worker, shared schemas, UI bundle. One language eliminates client-server type drift and maximizes Claude Code's effectiveness during AI-assisted implementation.
- **CLI runtime:** Bun (>=1.2). Source is TypeScript; distribution is a static binary per platform via `bun build --compile`. Cold start ~20-30ms vs Node's 200-500ms. Bun's test runner is acceptable for v0.1; Vitest is the fallback for tests that need `@cloudflare/vitest-pool-workers` (the Worker tests specifically).
- **Worker runtime:** Cloudflare Workers (workerd). Same TypeScript source as the CLI; bundled via Wrangler.
- **Package manager:** Bun for the monorepo (`bun install`, workspaces). pnpm is the fallback if Bun's workspace handling surfaces gaps.
- **Monorepo tooling:** Turborepo for task orchestration across packages (matching the maintainer's existing setup).
- **ORM / DB access:** Drizzle for SQL access. In the Worker, `drizzle-orm/durable-sqlite` for the per-project DO (the primary persistence layer) and `drizzle-orm/d1` for the global D1 instance (auth tokens, idempotency). The EntityBackend interface preserves the option for v0.2+ alternatives (GitHub Issues, Linear, Upstash, self-hosted Postgres).
- **HTTP framework in the Worker:** Hono. Route handlers, middleware, error handling.
- **CLI framework:** Citty. Bun-native, declarative, lightweight. Commander.js is the fallback if Citty surfaces gaps in v0.1.
- **Terminal UI library:** Ink (React in the terminal) is bundled-supportable for any interactive CLI components needed. The same library Claude Code uses, well-supported under Bun. v0.1 tila is mostly non-interactive; Ink is available but not heavily used.
- **R2 / S3 client:** `aws4fetch` in the Worker for minimal bundle size. The CLI does not talk to R2 directly; all artifact ops go through the Worker.
- **Validation:** Zod schemas for every API boundary (Worker endpoints, CLI inputs, schema.toml parsing). Zod is the source of truth; types are derived via `z.infer`. Shared schemas live in a dedicated `packages/schemas` workspace consumed by both the Worker and the CLI.
- **Build:** `bun build --compile` for CLI binaries; Wrangler for the Worker. tsdown is the fallback if Bun's compile gains friction for any specific output target.
- **Local development:** `bun run dev` runs the CLI against a local `wrangler dev` instance of the Worker. Iteration loop under 1 second.
- **2026 Cloudflare platform features used by tila:**
  - **Smart Placement** — enabled by default in `wrangler.toml` (`placement = { mode = "smart" }`). Auto-places the Worker close to the DO. Single biggest free latency win.
  - **DO SQLite storage** — GA, 10GB per DO, point-in-time recovery. The primary persistence layer for per-project state (entities, journal, claims, schema history). Replaces the 2024 D1-heavy design.
  - **Workers Analytics Engine** — used for low-cost write-heavy telemetry. Free up to 25M writes/day. Not load-bearing for correctness; degrades gracefully if unavailable.
  - **Tail Workers** — `wrangler tail` for real-time log debugging. Documented in the operational guide.
  - **Cron Triggers** — drives the daily artifact cleanup sweep (`/_internal/sweep`).

### 0.2 Distribution

The CLI ships as multiple artifacts to match how engineers actually install developer tools in 2026. This follows the pattern Claude Code itself uses (which is no accident — it's now the dominant pattern for AI-coding-adjacent CLIs):

- **Pre-built binaries per platform:** GitHub Releases publishes `tila-darwin-arm64`, `tila-darwin-x64`, `tila-linux-x64`, `tila-linux-arm64`, `tila-linux-x64-musl`, `tila-linux-arm64-musl`, `tila-windows-x64.exe`, `tila-windows-arm64.exe`. The musl variants matter for Alpine and other musl-libc distros used in containers.
- **curl-bash install script** (recommended primary path): `curl -fsSL https://tila.dev/install.sh | bash` detects platform, downloads the right binary, places it in `~/.tila/bin/`, updates PATH instructions in the shell rc file. Mirrors Claude Code's `claude.ai/install.sh` approach.
- **PowerShell install script** for Windows: `irm https://tila.dev/install.ps1 | iex`. Same approach as Claude Code's Windows installation.
- **Homebrew tap:** `brew install tila/tap/tila`. Updates manually via `brew upgrade`; opt-in auto-update via `TILA_PACKAGE_MANAGER_AUTO_UPDATE=1` env var.
- **npm with platform-specific optional dependencies:** `npm install -g tila-cli` or `bun add -g tila-cli`. The npm package uses optional per-platform deps (`tila-cli-darwin-arm64`, `tila-cli-linux-x64`, etc.) that resolve to the actual native binary. The installed binary does not invoke Node; this is the same architecture Claude Code uses. Useful for CI environments where adding curl-bash is friction.
- **Linux package managers** (v0.2): `apt`, `dnf`, `apk` repositories with signed packages.

The binary is ~50-60MB (Bun runtime is included). Acceptable for a developer tool installed once.

**Code signing.** Binaries should be signed on platforms that support it: macOS (via Apple Developer certificate, with notarization), Windows (via code-signing certificate). Linux binaries are not individually signed; the manifest is signed and verifiable via the install script. Worth deferring to v0.2 if v0.1 ships without — note in install instructions that v0.1 binaries are unsigned and Gatekeeper / SmartScreen may flag them.

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

```
┌─────────────────────────────────────────────────────────────────┐
│              Framework consumer (out of scope for tila)          │
│   (any workflow tool, agentic system, or orchestrator that       │
│    needs coordination + artifact storage + audit trail)          │
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

**Why the layering looks like this:** the Worker is a thin facade that routes to the right backend. Per-project state (entities, journal, claims) lives in one DO per project; this is the 2026-native consolidation that replaces the 2024 D1+DO split. Auth tokens and idempotency keys live in global D1 because they need cross-project scope and lightweight access patterns. Artifacts live in R2 because they're large blobs that benefit from content-addressing and per-prefix lifecycle. The DO can only be reached through a Worker; the Worker is the only writer to R2 (no signed-URL writes in v0.1).

**Local path (single machine -- `tila init --local`):**

```
┌─────────────────────────────────────────────────────────────────┐
│              Framework consumer (out of scope for tila)          │
└────────────────────────────────┬────────────────────────────────┘
                                 │ uses
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                          tila CLI                                │
│  (same commands as Cloudflare path; backend resolved at init)    │
└────────────────────────────────┬────────────────────────────────┘
                                 │ direct call (no HTTP)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                   @tila/backend-local                            │
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

### 1.2a Coordination primitives

Beyond the four data shapes, tila ships five coordination primitives that operate across them:

- **Claims.** First-writer-wins coordination with fencing tokens against any resource name. Used for work-unit claims (`task:T-142`), file-edit locks (`file:src/auth.rb`), record mutations (`record:service/api`), and any other resource the consumer wants to serialize.
- **Gates.** Approval and quality gates that govern work-unit transitions. A work unit cannot leave a state without all required gates being satisfied. Gates emit journal events on satisfaction.
- **Signals.** Lightweight notifications distinct from journal events. Used for cross-machine coordination of non-state-changing events ("agent A finished its review, agent B may proceed"). Signals do not modify durable state beyond their own emission record.
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
| Signals (lightweight notifications) | DO SQLite | Append-only signal emission record |
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

On the local path (`tila init --local`), all per-project DO SQLite state and the global D1 idempotency table collapse into a single local bun:sqlite database at `~/.tila/<org>/<project>.db`; artifact blobs live on the local filesystem at `~/.tila/artifacts/<org>/<project>/<sha256>.<ext>`. Schema and operations are identical to the Cloudflare path; only the connection and transaction layer differs.

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

Total Worker → response latency: ~5-15ms when DO is warm (Smart Placement co-locates them). Cold DO adds ~50ms one-time startup.

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

`@tila/ops-sqlite` extracts the business-logic operations from `@tila/backend-do` into a platform-agnostic package with zero Cloudflare Workers types. Both `@tila/backend-do` (DO path) and `@tila/backend-local` (local path) import from `@tila/ops-sqlite` for all entity, coordination, artifact, journal, and sweep logic.

The ops package uses `BaseSQLiteDatabase` generic (from `drizzle-orm/sqlite-core`) instead of the DO-specific `DrizzleSqliteDODatabase`, making it runtime-agnostic. The Drizzle schema, migrations (0001-0004), and all query modules live in `@tila/ops-sqlite`. Backend packages provide only the connection layer (DO's `blockConcurrencyWhile` + `this.ctx.storage.sql` vs. bun:sqlite's `new Database()` + `PRAGMA` initialization) and transaction semantics (DO implicit single-threading vs. `BEGIN IMMEDIATE` explicit locking).

Package dependency flow:

```
schemas -> core -> ops-sqlite -> backend-do   (Cloudflare path)
                              -> backend-local (local path)
```

Zero business-logic duplication between the two backends. Differences are confined to the connection, transaction, and migration-runner layers.

### 1.6 SQLite correctness model (local path)

The Cloudflare path serializes writes via the Durable Object's single-threaded execution model: only one request runs at a time within a DO. The local path cannot rely on this -- multiple CLI processes may access the same SQLite database concurrently. Instead, the local path uses SQLite's built-in locking mechanisms to achieve equivalent serialization.

**Three non-negotiable PRAGMAs** applied atomically at connection open (single `db.exec()` call):

1. `PRAGMA journal_mode=WAL` -- enables concurrent readers while a writer holds the write lock. Without WAL, readers block writers and vice versa. WAL separates read and write paths so agents reading state do not block agents writing claims.

2. `PRAGMA busy_timeout=5000` -- SQLite waits up to 5 seconds for a write lock before returning `SQLITE_BUSY`. Eliminates the need for application-layer polling in most contention scenarios. The 5-second window covers typical tila write transactions (sub-millisecond).

3. `PRAGMA foreign_keys=ON` -- enforces referential integrity. Disabled by default in SQLite; must be set per connection.

**`BEGIN IMMEDIATE` for all write transactions.** Every write path in `LocalProject` calls `db.transaction(fn, { behavior: 'immediate' })`. This acquires the write lock at transaction start, not at first write statement -- equivalent to the DO's single-thread serialization. Two concurrent processes cannot both read the `fences` table and both believe they hold a valid claim. The write lock is released on `COMMIT` or `ROLLBACK`.

**Application-layer retry.** After `busy_timeout` expires, `SQLITE_BUSY` propagates to the application. `withBusyRetry` (max 5 attempts, exponential backoff with jitter: `2^attempt * 50ms + random(0..50ms)`) handles the residual contention window. This is a belt-and-suspenders layer -- `busy_timeout` handles the common case; `withBusyRetry` handles the pathological case (a writer monopolizing the DB longer than 5 seconds).

**Fencing tokens** are monotonically incrementing integers, same as the DO path. First-writer-wins is preserved: stale fence -> `FenceError` from `@tila/core`'s `assertFence`.

### 1.6a Embedded local persistence (CLI + Node SDK/MCP)

Local mode is implemented by `@tila/backend-embedded` — a **runtime-agnostic** embedded SQLite core (`EmbeddedProject` + `EmbeddedArtifactBackend` + a `BlobStore` seam) that contains no `bun:*` / `node:*` runtime imports. Two host wrappers inject the concrete driver and primitives:

- `@tila/backend-local` — the **Bun** host (`bun:sqlite`), used by the `tila` CLI.
- `tila-sdk/local` — the **plain-Node** host (`better-sqlite3` + `node:fs`), used by the TypeScript SDK (`createTila({ backend: "local" })` / `createTilaLocal`) and by the `tila-mcp-server` when `backend = "local"`.

Local mode therefore now runs under **plain Node**, not just Bun. There is no ADR file for this seam in the repo; this section is the canonical description.

**Cross-runtime schema identity.** Both hosts run the *same* `EMBEDDED_MIGRATIONS` from `@tila/backend-embedded`, which reuse the canonical `MIGRATIONS` SQL / run-functions from `@tila/ops-sqlite` *verbatim* (not a copy that can drift). Both apply the same ordered `EMBEDDED_PRAGMAS` (`busy_timeout=5000`, then `journal_mode=WAL`, then `foreign_keys=ON`) and the same network-filesystem matcher. The result: a Bun (CLI)-created DB file and a Node (SDK/MCP)-created DB file are byte-for-byte schema-identical, so **a DB file is portable between the CLI and a Node SDK/MCP consumer** (proven by a cross-runtime interop test: bun writes, node reads). Applied versions are tracked in the **`_migrations` table**, not `PRAGMA user_version`.

**Schema versioning & cross-version compatibility.** The embedded migration set is the canonical versions **1–18 minus v15** (`_journal_archive_watermark`; journal archival to R2 is a DO-only feature with no embedded equivalent — skipping it touches no shared table), **plus an embedded-only idempotency table at version `1000`**. In Cloudflare mode idempotency lives in D1; in embedded mode it lives in the same project SQLite file (one fewer store to coordinate), as a standalone `INSERT OR IGNORE`. Version `1000` is deliberately *outside* the canonical 1–18 range so it is purely additive and never hijacks canonical **v5** (the `idx_er_to_id_type` index) — every canonical version, including v5, applies exactly as upstream. Because both hosts share one migration set keyed by version in `_migrations`, a CLI and an SDK/MCP of *different* releases interoperate on one file as long as they share that set: each applies only the versions it doesn't yet have, in ascending order.

**Idempotency is accepted but not honored locally — a known divergence.** The embedded `_idempotency` table (v`1000`) and `EmbeddedProject.checkIdempotency` / `storeIdempotency` exist, but no local resource adapter currently calls them: in local mode an `idempotency_key` (e.g. on `claims.acquire`) is **accepted but not honored**. Remote dedups retries via D1; local relies on **primary-key-level dedup** instead — a retried create of an existing id fails rather than duplicating. Full idempotency wiring is single-machine-low-risk and remains **remote-only**; the table + methods are kept available-but-unwired so a future wiring has the storage already in place. (Mirrored in the SDK README local-divergence list.)

**Pre-feature local DB upgrade — a known limitation.** Local DBs created by the **old / pre-feature** CLI (which used the legacy `ALL_LOCAL_MIGRATIONS` with a *divergent* v1 and v5) do **not** fully upgrade to the canonical embedded schema. Because v1 and v5 are already recorded in that file's `_migrations`, the runner treats them as applied and skips them — so the `artifact_relationships.target` column and the canonical v5 `idx_er_to_id_type` index stay absent. (v14 *does* apply retroactively, since it was never recorded.) A partial in-place heal is intentionally **not** attempted: it cannot reproduce the canonical NOT-NULL primary-key `target` column, so it would yield a subtly non-identical schema — worse than a clean recreate. **Remedy:** recreate the local DB via `tila init --local`. Local mode is single-machine, disposable dev/edge state, so recreating is cheap and safe.

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
  holder          TEXT NOT NULL,                -- 'alice@machine-A:pid-9821'
  mode            TEXT NOT NULL,                -- 'exclusive' | 'owner' | 'presence'
  fence           INTEGER NOT NULL,             -- value of fences.current_fence at time of acquire
  acquired_at     INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  metadata        JSON
);

CREATE INDEX claims_expires_at ON claims(expires_at);
CREATE INDEX claims_holder ON claims(holder);

-- Monotonic fence counter per resource. Incremented on every acquire (even after release).
-- Never decrements. Persists across DO evictions.
CREATE TABLE fences (
  resource        TEXT PRIMARY KEY,
  current_fence   INTEGER NOT NULL DEFAULT 0
);

-- Presence: TTL'd machine activity. Refreshed by heartbeat; reaped by the sweeper.
CREATE TABLE presence (
  machine         TEXT PRIMARY KEY,             -- 'alice@machine-A'
  last_seen       INTEGER NOT NULL,
  info            JSON                           -- current resource, status, etc.
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
  actor           TEXT NOT NULL,                -- 'alice@machine-A' or any actor string
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
  scopes          TEXT NOT NULL DEFAULT 'full', -- 'full' in v0.1; v0.2 adds 'read-only', 'write-artifacts', etc.
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
  schema_version  INTEGER NOT NULL DEFAULT 1,   -- cached from DO; updated when schema applies
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

Entity-level schema changes (adding `task`, removing `bug`, adding required field `priority`) use `tila schema apply` with `_schema_history` as the audit log. The DDL is unaffected — these changes only modify `data` interpretation rules.

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

**DO eviction is safe.** DO instances evict when idle (typical: minutes). SQLite storage persists. In-memory state (cached schema, prepared statements) rebuilds on next fetch via `blockConcurrencyWhile`. No state loss; just a cold start of ~50ms on the next request.

**`blockConcurrencyWhile` for migrations.** On DO startup, the init function runs DDL migrations idempotently (compare current schema version against the bundled migration set, apply missing). All requests block until migrations complete. This is how new tila Worker versions safely evolve the DO schema.

---

## Section 3a: Worker HTTP API contract

The external API surface that the CLI calls. All requests are JSON over HTTPS. All require `Authorization: Bearer <api-token>` header except `/health`.

### 3a.1 Authentication

- **API token format:** opaque random 32+ byte string, base64url-encoded. Generated by Worker on `tila init` via Web Crypto and stored hashed (Argon2id or scrypt) in a `_tokens` table in D1.
- **Bearer header:** `Authorization: Bearer <token>`. Worker rejects with 401 if missing or invalid.
- **Token rotation:** `tila token rotate` issues a new token, invalidates the old one. The new token is written to local `.env`. Team members must rotate their `.env` from a shared secret store.
- **Multiple tokens per project supported.** Each token has a name and `created_at`. Listing and revocation via `tila token list` / `tila token revoke <name>`. Useful for issuing per-machine or per-CI tokens with audit.
- **No granular scopes in v0.1.** Every token has full read+write on the project. Scoped tokens (read-only, artifact-only, etc.) are v0.2.

### 3a.2 Endpoint catalog

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ ok: true, version, project_id }` |
| GET | `/whoami` | — | `{ token_name, scopes }` |
| GET | `/schema` | — | `{ version, schema_toml }` |
| POST | `/schema/apply` | `{ schema_toml, strategy?, dry_run? }` | `{ ok, new_version, changes, warnings }` |
| GET | `/entities` | query: `type`, `status`, `parent`, `limit`, `cursor` | `{ entities: [], cursor? }` |
| POST | `/entities` | `{ type, data, parent?, idempotency_key }` | `{ entity }` |
| GET | `/entities/:id` | — | `{ entity, claim?, recent_journal }` |
| PATCH | `/entities/:id` | `{ patch, idempotency_key }` | `{ entity }` |
| POST | `/entities/:id/archive` | `{ idempotency_key }` | `{ ok }` |
| POST | `/entities/:id/relationships` | `{ to, type, idempotency_key }` | `{ ok }` |
| DELETE | `/entities/:id/relationships/:to/:type` | — | `{ ok }` |
| POST | `/acquire` | `{ resource, holder, mode, ttl_ms, metadata?, idempotency_key }` | `{ ok: true, fence, expires_at }` or `{ ok: false, reason, holder, expires_in_ms }` (409) |
| POST | `/renew` | `{ resource, holder, fence }` | `{ ok: true, expires_at }` or 409 |
| POST | `/release` | `{ resource, holder, fence }` | `{ ok: true }` |
| GET | `/state` | query: `resource` | `{ claim?, owners: [], presence: [] }` |
| GET | `/presence` | — | `{ machines: [] }` |
| POST | `/presence` | `{ machine, current_resource?, metadata? }` | `{ ok }` |
| PUT | `/artifacts/:key` | binary body, metadata in headers | `{ ok, key, deduplicated? }` |
| GET | `/artifacts/:key` | — | binary body with metadata headers |
| GET | `/artifacts` | query: `resource`, `kind`, `limit`, `cursor` | `{ artifacts: [], cursor? }` |
| DELETE | `/artifacts/:key` | `{ force? }` | `{ ok }` |
| GET | `/journal` | query: `since_seq`, `resource`, `kind`, `limit` | `{ events: [], cursor? }` |
| GET | `/journal/stream` | query: `since_seq` | SSE event stream (v0.2; v0.1 uses polling) |
| GET | `/doctor` | — | `{ ok, checks: [{ name, status, detail }] }` |
| POST | `/reset` | `{ confirm: "PROJECT_ID", keep_artifacts?, keep_entity_types? }` | `{ ok, dropped }` |
| GET | `/` (and static paths) | — | UI HTML/JS bundle |

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

### 3a.4 Error envelope

All error responses use the shape:

```json
{
  "ok": false,
  "error": {
    "code": "stale-fence",          // machine-readable
    "message": "Fence 42 is stale; current is 43",  // human-readable
    "retryable": false,
    "details": { "current_fence": 43, "holder": "bob@..." }
  }
}
```

Standard codes: `unauthorized`, `not-found`, `stale-fence`, `already-held`, `rate-limited`, `schema-mismatch`, `idempotency-conflict`, `internal`.

### 3a.5 Rate limiting and backpressure

- Worker enforces 100 req/sec per token (token-bucket). Excess returns 429.
- D1 / DO / R2 rate-limit responses propagate as 429 with `Retry-After` header.
- CLI implements exponential backoff (100ms, 200ms, 400ms, …) up to 5 retries on 429.

### 3a.6 Cross-backend operation ordering

Most operations are single-DO transactions and have no cross-backend concerns. But artifact uploads (R2 + DO) and provisioning (D1 + DO + R2) span backends. The discipline for these:

**Rule 1 — DO transaction is always last.** When an operation spans backends, the DO write commits last. This is because the DO transaction includes the journal append; if the journal records "the artifact was produced," the artifact must already exist. Reverse the order and you get journal events for artifacts that don't exist.

**Rule 2 — Idempotency keys span the full operation.** A cross-backend operation carries an idempotency key the entire way. If the operation is retried, the idempotency key short-circuits at the Worker before re-doing any backend work. See §3a.3.

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

- Provisioning operations (`tila init --cloudflare`)
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
tila_version = "0.1.0"
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
  - Read .tila/.env for TILA_API_TOKEN.
    - If missing: error "no API token found; run `tila init --inherit` to join this project, or set TILA_API_TOKEN in your environment"
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
| `tila init --cloudflare` | yes | no (generates one) |
| `tila init --inherit` | no | yes (prompts for it) |
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

> **CLI local/remote backend-swap contract.** The interfaces in `packages/core/src/interfaces/` (see that directory's `README.md`) form the swap boundary used by the CLI to select between remote (Worker over HTTP) and local (`@tila/backend-local`, bun:sqlite) execution. These interfaces are **not** the Durable Object contract — the `ProjectDO` calls `@tila/ops-sqlite` directly. There is intentionally no `RecordBackend` interface because typed mutable records have no offline CLI path yet.

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

v0.1 implementations:
- `do-sqlite` — full capabilities, ~1ms reads (DO-local SQLite), co-located with coordination state in the same DO
- `local-sqlite` -- full capabilities (same as do-sqlite), <1ms reads (bun:sqlite, process-local), same SQLite storage as coordination state in the same DB file. Requires single-machine deployment; not suitable for multi-machine teams.

Test fixtures (not shipped as backends):
- An in-memory fake EntityBackend lives in `packages/core/test/fixtures/` for unit-testing tila-core logic without spinning up the DO.

Stubs for v0.2+:
- `github-issues` — limited capabilities (no typed dependencies, custom types via labels, ~400ms reads)
- `linear` — limited capabilities (custom types via labels, ~200ms reads, requires paid plan past 250 issues)
- `d1` — if a future use case wants entity storage decoupled from a per-project DO (e.g., shared-tenancy hosted offering)

### 5.2 CoordinationBackend

```typescript
interface CoordinationBackend {
  acquire(
    resource: string,
    holder: string,
    mode: 'exclusive' | 'owner',
    ttlMs: number,
    metadata?: object
  ): Promise<AcquireResult>;

  renew(resource: string, holder: string, fence: number): Promise<RenewResult>;
  release(resource: string, holder: string, fence: number): Promise<void>;

  getState(resource: string): Promise<ResourceState>;
  presence(): Promise<MachineActivity[]>;
  updatePresence(machine: string, info: PresenceInfo): Promise<void>;

  capabilities: CoordinationBackendCapabilities;
}

type AcquireResult =
  | { ok: true; fence: number; expiresAt: number }
  | { ok: false; reason: 'already-held'; holder: string; expiresInMs: number };
```

v0.1 implementations:
- `do-sqlite` — strong consistency via DO single-thread serialization, ~1ms p50 from same DO, same SQLite storage as entities (one transaction can claim and update an entity atomically)
- `local-sqlite` -- strong consistency via SQLite `BEGIN IMMEDIATE` serialization, <1ms p50 (bun:sqlite, process-local), same SQLite storage as entities (one transaction can claim and update an entity atomically)

Test fixtures: a Map-backed in-memory fake CoordinationBackend in `packages/core/test/fixtures/` for unit testing.

Stubs for v0.2+:
- `upstash-redis` — for users who want a separate coordination backend (split EntityBackend and CoordinationBackend implementations are explicitly supported even though v0.1 unifies them)

### 5.3 ArtifactBackend

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

v0.1 implementations:
- `r2` — content-addressed, conditional writes via S3 API path, native lifecycle
- `local-filesystem` -- content-addressed blobs on local filesystem at `~/.tila/artifacts/<org>/<project>/<sha256>.<ext>`, pointer rows in same SQLite DB, <1ms reads (filesystem), no lifecycle rules API in v0.1 (returns empty array)

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
# v0.1 searchability defaults: memory-like text kinds opt into FTS5 indexing
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

> **Searchability configuration:** Artifact kinds can opt in to lexical full-text search (FTS5) by setting `searchable = true` and `search_mode = "full_text"` in `tila.schema.toml`. See [docs/06-SEARCH.md](06-SEARCH.md) for the full guide: configuration, CLI usage, and v0.1 limitations.

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

### 6.3 Adding a new work-unit type

1. Edit `tila.schema.toml`, add `[work_units.initiative]` block.
2. Run `tila schema apply`.
3. Engine compares to previous schema in `_schema_history`. Sees `initiative` is new.
4. No existing entity has `type = 'initiative'`, so no data migration needed.
5. Bumps `schema_version`, records change in `_schema_history`.

### 6.4 Adding a required parent to an existing work-unit type

User edits schema to make `initiative` a required parent of `epic`. Engine:

1. Detects 47 existing epics lack an initiative parent.
2. Refuses to apply without a strategy:
   ```
   ✗ Schema change rejected: 47 existing epics lack required parent 'initiative'.
     --strategy=default-parent ID    Link all existing epics to ID
     --strategy=relax                Allow legacy epics; require for new ones
     --strategy=migrate              Open interactive migration
     --force                         Apply anyway; existing epics become invalid
   ```
3. User picks a strategy; engine applies atomically.

### 6.5 Adding a new artifact kind

1. Edit `tila.schema.toml`, add `[artifacts.retro]` block.
2. Run `tila schema apply`. Auto-applies (no existing artifacts of this kind, by definition).
3. Lifecycle rules in R2 may need updating: `tila lifecycle apply` updates the bucket rules to match the new schema.

### 6.6 Removing a work-unit type or artifact kind

User edits schema to remove `bug`. Engine:

1. Checks for entities/artifacts of this type. Finds matching rows.
2. Refuses without confirmation:
   ```
   ✗ Cannot remove work-unit type 'bug': 12 entities exist with this type.
     --archive   Mark all bug entities as archived (recoverable)
     --delete    Delete all bug entities (irreversible)
     Or migrate them first: tila task convert --from=bug --to=issue
   ```

### 6.7 Tolerant reads

When an entity or artifact pointer is read, the engine:
1. Looks up the row's `schema_version`.
2. Fetches the corresponding schema from `_schema_history`.
3. Validates declared fields against that schema.
4. Passes through any unknown fields verbatim (passthrough preservation, §2.2).
5. Applies field-level `default_for_legacy` for fields added in later versions.

Old data continues to be readable indefinitely, even after schema changes.

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
x-amz-meta-tila-machine:     alice@machine-A
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
  const { resource, fence, holder, body, kind, mime, idempotencyKey } = input;

  // 1. Idempotency check (global D1 lookup, cached for 60s in Worker memory)
  const cached = await checkIdempotency(env.GLOBAL, idempotencyKey);
  if (cached) return cached;

  // 2. Validate fence (one DO round-trip, no transaction needed for read)
  const projectDO = env.PROJECT.get(env.PROJECT.idFromName(env.PROJECT_ID));
  const state = await projectDO.fetch('https://do/coord/state?resource=' + encodeURIComponent(resource));
  const { claim } = await state.json();
  if (!claim || claim.holder !== holder || claim.fence < fence) {
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
        'tila-machine': holder,
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
      produced_by: holder,
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
        Body: { resource: "task:T-142", holder: "alice@machine-A:pid-9821",
                mode: "exclusive", ttl_ms: 600000 }
        → Worker routes to DO
        → DO single SQLite transaction:
            SELECT * FROM claims WHERE resource = 'task:T-142'
            → null (or expired)
            SELECT current_fence FROM fences WHERE resource = 'task:T-142'
            → 41 (or NULL if first time, defaults to 0)
            UPDATE fences SET current_fence = 42 WHERE resource = 'task:T-142'
            INSERT INTO claims (resource, holder, mode, fence, ...) VALUES (..., 42, ...)
            INSERT INTO journal (kind, resource, actor, fence, data, ...) VALUES ('task.claimed', 'task:T-142', 'alice@machine-A:pid-9821', 42, ...)
            COMMIT
        → DO returns { ok: true, fence: 42, expiresAt: ... }
        → Worker returns to CLI

T+0:03  CLI begins agent work.
        → Background renew loop: POST /renew every 60s with { resource, holder, fence: 42 }

T+0:14  Agent produces 3 artifacts.
        → CLI uploads each via PUT /artifacts/<key>
        → Each upload includes fence=42 in metadata
        → Worker validates fence against current claim (one DO read), PUTs to R2 with If-None-Match: *
        → Worker calls DO /artifact/record; DO transaction inserts pointer row, required-reference edges, and 'artifact.produced' journal event

T+0:15  Work complete. CLI: POST /release
        Body: { resource: "task:T-142", holder: "alice@machine-A:pid-9821", fence: 42 }
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

### 8.3 Issue ownership (soft, non-exclusive)

Alice takes ownership of issue I-23:

```
CLI: POST /acquire
Body: { resource: "issue:I-23", holder: "alice", mode: "owner", ttl_ms: 86400000 }

DO transaction:
  INSERT INTO owner_claims (resource, holder, is_primary, fence, ...) VALUES (...)
  → If no other owner: is_primary = 1.
  → If other owners exist: is_primary = 0 (Alice is non-primary owner).
  → Fence increments regardless.

Returns { ok: true, fence: 7, is_primary: true }.
```

Bob can still claim individual tasks within I-23 via exclusive mode. Owner claims and exclusive claims are independent.

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
1. CLI calls /health, gets a 5xx or empty state.
2. CLI calls `tila doctor` which reports the DO is uninitialized/inaccessible.
3. Recovery options:
   a. If R2 still has artifacts and the user has external journal backups (v0.2 feature):
      `tila restore --from-r2-and-backup` rebuilds entities and journal from the backup,
      and reconciles artifact_pointers from R2 object metadata.
   b. If only R2 survives: `tila doctor --reconcile` walks R2, synthesizes artifact_pointers
      from R2 object metadata, and emits `artifact.reconciled` journal events. Entities and
      claims are lost; the user must recreate them.
   c. Otherwise: `tila reset --force` and start fresh.

In practice (a) and (c) are the expected outcomes; (b) is partial recovery for catastrophic
loss with no backup. v0.1 does not implement (a) — backups are v0.2. v0.1's recovery story
is: trust DO SQLite durability (PIT recovery is built in) and have R2 as the long-tail backstop.
```

**The journal is the source of truth for "what happened."** Any reconstruction starts from the journal. If a DO is restored from a SQLite snapshot taken at time T, replaying journal events after T (if available externally) brings state forward. v0.1 relies on Cloudflare's built-in DO SQLite PIT recovery; explicit external backups are v0.2.

---

## Section 9: CLI surfaces

### 9.1 tila commands

```
# Setup
tila init --cloudflare           # provision a new tila project on Cloudflare
tila init --inherit              # join existing cloud project (team member onboarding)
tila login                       # Cloudflare OAuth (delegates to wrangler)

# Work-unit CRUD (same shape for any declared work-unit type)
tila task new "<title>" [--parent <id>] [--type <type>]
tila task list [--status=...] [--parent=...] [--ready] [--leaf-only]
tila task show <id>
tila task update <id> --field=value
tila task close <id> --outcome=success|failed|cancelled
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
tila schema diff
tila schema apply [--strategy=<strategy>]

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
  workerUrl: "https://tila-myproj.example.workers.dev",
  apiToken: process.env.TILA_API_TOKEN!,
});

const task = await client.entities.create({ type: "task", data: { title: "Refactor auth" } });
const claim = await client.claims.acquire({ resource: `task:${task.id}`, holder: "agent-a", mode: "exclusive", ttlMs: 600_000 });
await client.artifacts.put({ resource: `task:${task.id}`, fence: claim.fence, kind: "plan", body: planMarkdown });
await client.claims.release({ resource: `task:${task.id}`, holder: "agent-a", fence: claim.fence });

const service = await client.records.get({ type: "service", key: "api" });
```

Surface modules: `client.entities`, `client.records`, `client.artifacts`, `client.claims`, `client.gates`, `client.signals`, `client.journal`, `client.presence`, `client.schema`, `client.summary`, `client.templates`, and `client.tokens`. Request and response types come from `@tila/schemas` so contracts are type-checked end to end. The SDK handles retry with exponential backoff for transient 429 and 5xx responses; idempotency keys are generated automatically for mutating requests.

### 9.4 The MCP server

`tila-mcp-server` exposes tila as a Model Context Protocol server that agents can connect to directly without going through the CLI or the SDK. The MCP server runs as a separate process; agents configure it as an MCP endpoint and gain access to tila tools.

The server exposes MCP tools for the same operations the SDK and CLI surface:

- `tila_entity_*` (and `tila_work_unit_*` aliases when the public rename ships) for work-unit operations.
- `tila_record_get`, `tila_record_set`, `tila_record_patch`, `tila_record_list`, `tila_record_archive`, `tila_record_unarchive`, `tila_record_history`.
- `tila_artifact_*` for artifact upload, download, list, and search.
- `tila_claim_*` for resource claim acquire, renew, release.
- `tila_gate_*` for gate satisfaction queries and transitions.
- `tila_signal_*` for signal emission and subscription.
- `tila_summary_*` for project-level state summaries.

In addition to tools, the MCP server exposes select content as MCP **resources**. Record types declared with `mcp_resource = true` in `tila.schema.toml` are exposed under URI template `tila://records/{type}/{key}`. The default is tools only; resource exposure is opt-in per record type. Rationale: automatically injecting all records into agent context would flood it. Critical record types such as agent policies or pipeline configs can opt in; everything else is pulled on demand via the `tila_record_get` tool.

Keys containing slashes are percent-encoded in resource URIs. The MCP server decodes the final URI segment with `decodeURIComponent` before lookup.

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
All schema changes happen in a D1 transaction. If any step fails (validation error, network drop, application of strategy fails), the whole change is rolled back. `_schema_history` is not updated unless the change is fully applied.

### 10.6 User downgrades tila to an older version
On startup, tila checks `_schema_history` for the latest applied schema_version. If it's higher than what this version knows about, refuse to operate: "Database is at schema version 5 but this version of tila supports up to 4. Upgrade tila or restore from backup."

### 10.7 User runs concurrent `tila schema apply` from two machines
Schema apply takes an exclusive claim on `system:schema` via the same DO mechanism. Second one waits or fails fast.

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
CLI calls return 404 / DNS failure. `tila doctor` reports "Worker not reachable." User must `tila init --cloudflare` again to create a new project; old data is unrecoverable unless they had exports.

### 10.16 `wrangler deploy` collides with an existing Worker of the same name
Init prompts: "A Worker named `tila-<slug>` already exists in your Cloudflare account. Reuse it? [y/N]" — if yes, attempts to bind to existing resources; if no, suggests a new project slug.

### 10.17 No project context (`.tila/config.toml` missing)
CLI commands that need project context (everything except `--version`, `--help`, `tila account list`) print: "no tila project found in current directory or any parent. Run `tila init --cloudflare` to create one, or `tila init --inherit` to join an existing project." Exit code 1.

### 10.18 Multiple tila projects on one Cloudflare account
Fully supported. Each project has its own Worker, D1, R2 bucket, and DO namespace. Naming convention: `tila-<slug>` for everything. No cross-project isolation issues at the Cloudflare level.

### 10.19 Worker unreachable due to network issues
Every tila command makes at least one Worker call. On network failure: CLI prints "could not reach Worker at <url>; check connection. Use `tila doctor --offline` for diagnostics that don't require network." Exit code 2. No offline fallback; the tool requires network access to operate (consistent with the agentic-coding-needs-network premise).

### 10.20 D1 daily write quota approaching
Worker tracks daily write count in a `_quota` table (cheap: one row updated per write, with day rollover). When usage exceeds 80% of free-tier (80K writes/day), `/health` includes a warning. CLI surfaces the warning on `tila status`. At 100%, Cloudflare returns 429; CLI prints a clear "free tier write limit hit; consider upgrading or waiting until UTC midnight" message.

### 10.21 Framework consumer uses the same Claude API token as the user's interactive sessions
Acceptable. The framework's autopilot pulls `ANTHROPIC_API_KEY` from env at session start. Sub-agent invocations are independent API calls. No coordination with the user's interactive Claude Code session is needed; both call the same API with separate contexts. tila has no opinion or involvement here — LLM credentials never reach the Worker.

### 10.23 Editing the schema at runtime via CLI without editing toml
v0.1 supports `tila schema add-work-unit <type>`, `tila schema add-field <type> <field>`, `tila schema add-artifact <kind>`, `tila schema add-reference-slot <type> <name>` as conveniences. Under the hood, they edit `tila.schema.toml` and call `tila schema apply`. The toml file remains the source of truth.

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
Acme Corp may enforce: R2 jurisdiction (EU only), custom Worker subdomain (`tila.acme.com`), retention policy overrides, restricted Worker permissions. These are configured at the Cloudflare account level and at `wrangler.toml`. tila's `.tila/config.toml` supports `[cloudflare] worker_subdomain`, `jurisdiction`, and `custom_domain` flags; init reads these from the org's tila template if one is provided via `--template=<url>`. Org admins publish a tila template in their org's onboarding docs; engineers run `tila init --cloudflare --template=https://acme.internal/tila-template.toml` to inherit org defaults.

### 10.32 Service account / CI token usage
For automation (CI, scheduled jobs, server-side autopilots): runtime operations use a dedicated project API token issued via `tila token issue --name=ci-prod`. The token is stored in CI secrets as `TILA_API_TOKEN`. Provisioning from CI (rare) uses a Cloudflare API token (not OAuth) scoped to the specific account, stored as `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. tila and wrangler both honor these env vars; no interactive login is required.

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
Smart Placement is enabled by default in the bundled `wrangler.toml`. If a user disables it or runs on a Cloudflare region where it's unavailable, latency degrades but correctness is unaffected. Worker → DO RTT can rise from ~5ms to ~50ms cross-region. `tila doctor` reports the placement mode and Worker→DO latency from a `/health` probe.

### 10.47 D1 token validation cache hit/miss
The Worker caches token validation results in a per-isolate Map for 60 seconds after first validation. Cache miss = D1 lookup; cache hit = ~1ms. When `DELETE /api/tokens/:name` is called, D1 is updated immediately and the calling Worker isolate's in-memory cache entry is invalidated synchronously via `invalidate(tokenHash)`. Other isolates that have the token positively cached will continue accepting it until their cache entry expires (max 60 seconds TTL). The `tila token revoke` CLI output notes this propagation delay. Cross-isolate immediate invalidation (via a revocation marker or broadcast mechanism) is deferred to v0.2.

### 10.48 Journal table growth over time
The `journal` table grows with every operation. For a busy autopilot project, expect ~1-5MB/day. DO SQLite's 10GB limit means roughly 5-10 years of journal at typical rates before pressure. Long before that becomes a concern, v0.2+ adds journal archival: events older than N days are cold-stored to R2 under `journal/<year>/<month>.jsonl.gz` and pruned from DO SQLite. v0.1 does not implement this; the assumption is that a project's actual lifetime is shorter than the practical limit. `tila doctor` reports journal size and projected fill date as part of `tila status`.

### 10.49 Observability: tail Workers and metrics
v0.1 provides three observability surfaces:
1. **`wrangler tail`** streams Worker logs in real time. Documented in the operational guide.
2. **`tila journal tail`** streams journal events from the DO as they're written. The user-facing real-time view of what's happening.
3. **Workers Analytics Engine** writes telemetry datapoints on every Worker request (latency, route, status code, project) and on every DO transaction (table, op, rows affected). Free up to 25M datapoints/day. Aggregations available via Cloudflare's GraphQL Analytics API or the dashboard.

A `/metrics` endpoint returning Prometheus-format counters is v0.2.

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

`tila init --cloudflare` does these things, in order:

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

`tila init --inherit` for joining teammates:

```
1. Read .tila/config.toml (committed by the original setup)
2. Prompt user for the project's shared API token (or read from CI/secrets manager)
3. Write .tila/.env locally
4. Append .tila/.env to .gitignore (if not already)
5. Test connection: GET <worker>/health
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
│   ├── backend-do/                    # @tila/backend-do — ProjectDO with all per-project state (entities, claims, journal, etc.)
│   │   ├── src/
│   │   │   ├── index.ts               # ProjectDO class export
│   │   │   ├── schema.ts              # Drizzle schema for DO SQLite (entities, relationships, claims, fences, journal, _schema_history, etc.)
│   │   │   ├── queries/               # query modules per concern (entity, coord, artifact, journal, schema)
│   │   │   └── migrations/            # DO SQLite migrations, applied via blockConcurrencyWhile
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── backend-d1/                    # @tila/backend-d1 — global D1 for auth tokens, idempotency, project registry
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── schema.ts              # Drizzle schema for _tokens, _idempotency, _projects
│   │   │   └── queries.ts
│   │   ├── migrations/                # Wrangler-managed D1 migrations
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── backend-r2/                    # @tila/backend-r2 — R2 ArtifactBackend
│   │
│   ├── ops-sqlite/                    # @tila/ops-sqlite — shared SQLite ops (entity, coord, artifact, journal, sweep); platform-agnostic BaseSQLiteDatabase generic; used by both backend-do and backend-local
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
│   ├── backend-local/                 # @tila/backend-local — LocalProject (EntityBackend + CoordinationBackend) and LocalArtifactBackend; bun:sqlite + WAL; no Cloudflare Workers types
│   │   ├── src/
│   │   │   ├── connection.ts          # PRAGMA init, NFS detection, migration runner
│   │   │   ├── migrations-local.ts    # MIGRATION_0005 (_idempotency table, local-only)
│   │   │   ├── local-project.ts       # LocalProject class (BEGIN IMMEDIATE writes)
│   │   │   ├── local-artifact-backend.ts  # LocalArtifactBackend class (filesystem blobs)
│   │   │   ├── retry.ts               # withBusyRetry (SQLITE_BUSY, exponential backoff)
│   │   │   └── index.ts
│   │   ├── test/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── worker/                        # @tila/worker — the Cloudflare Worker
│   │   ├── src/
│   │   │   ├── index.ts               # Hono app entry; routes through to ProjectDO
│   │   │   ├── routes/                # public API routes (entities, claims, artifacts, journal, schema, health)
│   │   │   ├── middleware/            # auth (D1 lookup with in-memory cache), idempotency, rate-limit, analytics-emit
│   │   │   ├── do/                    # re-exports ProjectDO from backend-do
│   │   │   ├── sweep.ts               # cron handler for artifact cleanup
│   │   │   └── env.ts                 # typed bindings (PROJECT, GLOBAL, ARTIFACTS, ANALYTICS)
│   │   │   └── env.ts
│   │   ├── test/                      # vitest with @cloudflare/vitest-pool-workers
│   │   ├── wrangler.toml              # the Worker's own wrangler.toml (for `wrangler dev`)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── ui/                            # @tila/ui — read-only HTML/JS bundle
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
│   │   │   └── provision.ts           # wrangler shell-out logic
│   │   ├── templates/                 # bundled: wrangler.toml.tmpl, tila.schema.toml.tmpl, etc.
│   │   ├── test/
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

**Backends as separate packages** is not required for v0.1 functionally — they could be inlined in `core` — but separating them upfront makes the adapter pattern *real* rather than aspirational. Adding `backend-github-issues` or `backend-linear` in v0.2 is "create a new package," not "refactor existing code." `@tila/ops-sqlite` sits between `core` and `backend-{do,local}` in the dependency graph -- it extracts the shared business logic so both backends share identical entity, coordination, artifact, journal, and sweep operations without duplication.

**`packages/worker/wrangler.toml`** is the Worker's own wrangler.toml — used for `wrangler dev` during local development of the Worker package itself. This is different from the *templates* in `packages/cli/templates/wrangler.toml.tmpl`, which are what tila generates when a user runs `tila init --cloudflare` for their own project. Don't conflate them.

**`packages/integration-tests`** is its own workspace, not inside any other package. It depends on all the others. This keeps the integration test machinery out of the application packages and makes it easy to skip with `bun test --filter='!integration'` during inner-loop development.

**No `apps/` directory.** Everything is a package (the CLI is a package, the Worker is a package, the UI is a package). The `apps/` vs `packages/` split would be artificial here.

**Workspace dependencies use `workspace:*`.** In `packages/worker/package.json`:

```json
{
  "dependencies": {
    "@tila/schemas": "workspace:*",
    "@tila/core": "workspace:*",
    "@tila/backend-d1": "workspace:*"
  }
}
```

Bun resolves these to local paths; in publishing, they get rewritten to actual version numbers.

---

## Section 13: Versioning and release

- **Semantic versioning** for tila packages and the `tila` CLI.
- **Schema version is independent of tila version.** A given tila version supports a range of schema versions; mismatches refuse to operate (see edge case 10.6).
- **Wrangler-managed Worker versions** allow rollback via `wrangler rollback`. Schema migrations are NOT auto-rolled back; the Worker version you roll back to must be compatible with the current D1 schema, or `tila doctor` will flag the mismatch.
- **DO class migrations** declared in `wrangler.toml`; never destructive to live data in the v1 architecture (DO data is ephemeral).
- **All tila workspace packages version together.** A given tila release tag (e.g. `v0.1.0`) corresponds to consistent versions of `@tila/schemas`, `@tila/core`, `tila-cli`, etc. Independent versioning would create matrix-testing burden for negligible benefit.

---

This is the technical spine. It's not exhaustive — implementation will surface details not captured here — but it's complete enough that an AI agent or engineer working from it can build the v1 without inventing the architecture.
