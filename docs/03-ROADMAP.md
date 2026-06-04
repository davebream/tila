# tila — v0.1 Scope and Roadmap

> What ships in v0.1, what's deliberately deferred, the success criteria that mean "v0.1 is done," and the triggers for graduating to v0.2. Written to resist scope creep and to give an AI agent or future-you a clear stopping point.

---

## 1. The shape of v0.1

**One repo. tila ships both Cloudflare and local deployment paths, with CLI, HTTP, SDK, and MCP server access surfaces. The Cloudflare path uses Worker plus per-project Durable Object SQLite plus global D1 plus R2. The local path uses bun:sqlite plus filesystem artifacts.**

That is the v0.1 brief in one paragraph. Everything below either elaborates on or constrains that brief.

---

## 2. What v0.1 ships

### 2.1 Repository structure

Single repo. Full structure detailed in Architecture Section 12. Summary:

```
tila/                              # github.com/davebream/tila
└── packages/
    ├── schemas/                   # @tila/schemas — Zod schemas, canonical JSON helpers, no runtime deps
    ├── core/                      # @tila/core — backend interfaces, fence logic, schema evolution
    ├── ops-sqlite/                # @tila/ops-sqlite — shared SQLite ops (entity, coord, artifact, journal, gate, signal, sweep)
    ├── backend-d1/                # @tila/backend-d1
    ├── backend-do/                # @tila/backend-do (Cloudflare path)
    ├── backend-local/             # @tila/backend-local (local path: bun:sqlite + filesystem)
    ├── backend-r2/                # @tila/backend-r2
    ├── worker/                    # @tila/worker — the Cloudflare Worker
    ├── ui/                        # @tila/ui — read-only bundle served by Worker
    ├── cli/                       # tila-cli — `tila` binary (Bun-compiled)
    ├── sdk/                       # tila-sdk — typed TypeScript client for framework consumers
    ├── mcp-server/                # tila-mcp-server — MCP tools and opt-in resources
    └── integration-tests/
```

### 2.2 The CLI surface for v0.1

**tila commands that ship:**

```
tila infra provision
tila project create
tila project create --local
tila init
tila login

tila task new <title> [--parent=<id>]
tila task list [--status=<s>] [--parent=<id>]
tila task show <id>
tila task update <id> --field=value
tila task close <id> --outcome=<o>
tila task archive <id>

tila task claim <id> [--ttl=<s>]
tila task renew <id> --fence=<n>
tila task release <id> --fence=<n>

tila artifact put <file> --task=<id> --fence=<n> --kind=<k>
tila artifact get <key>
tila artifact list --task=<id>
tila artifact search <query> [--kind=<k>] [--resource=<id>] [--limit=<n>] [--json]

tila record set <type> <key> <file> [--fence=<n>] [--tag=<tag>]... [--message=<msg>] [--json]
tila record get <type> <key> [--format=json|yaml] [--json]
tila record list <type> [--tag=<tag>] [--filter=<k=v>] [--include-archived] [--json]
tila record patch <type> <key> <file|--json <json>> --fence=<n>
tila record archive <type> <key> --fence=<n>
tila record unarchive <type> <key> --fence=<n>
tila record history <type> <key> [--values] [--limit=<n>] [--json]
tila record export <type> --output-dir=<dir> [--format=json|yaml]
tila record export --all --output-dir=<dir>
tila record types [--in-use] [--json]

tila gate ...        # approval and quality gates for work-unit transitions
tila signal ...      # lightweight pub/sub notifications
tila template ...    # entity templates for common work-unit shapes
tila summary ...     # project-level state summaries

tila state <resource>
tila presence
tila journal tail

tila schema show
tila schema apply [--strategy=<s>]

tila doctor
tila reset

tila config get <key>
tila config set <key> <value>

tila token issue --name=<name> [--note=<note>]
tila token list
tila token revoke <name>
```

**Issue and epic commands** ship as exact same shapes as `task` but with `issue` and `epic` subcommands. No special semantics in the CLI; differences are in the schema (default TTL, claim mode).

**No framework-level commands.** tila ships `tila` and only `tila`. Workflow orchestration (commands like `work`, `plan`, `review`, `retro`) belongs in a framework consumer that imports `tila-sdk`, calls the MCP server, or invokes the `tila` CLI; tila does not bundle, declare, or ship any of these. Validating that the tila primitives are general enough to support such a framework is part of the dogfooding criteria in §5.

### 2.3 The backends that ship

Following the interface design in the architecture spec:

| Interface | v0.1 implementations |
|---|---|
| `EntityBackend` | `do-sqlite` (Cloudflare path, per-project DO), `local-sqlite` (local path, bun:sqlite) |
| `CoordinationBackend` | `do-sqlite` (same DO; entity and claim writes share a transaction), `local-sqlite` (same SQLite database; serialization via `BEGIN IMMEDIATE`) |
| `ArtifactBackend` | `r2` (Cloudflare path; content-addressed; Worker-driven sweep for lifecycle), `local-filesystem` (local path; content-addressed blobs in `~/.tila/artifacts/`) |
| Auth backend (not a public interface) | `d1` (global; cross-project token storage; GitHub session and repo allowlist tables) |

Both Cloudflare and local entity, coordination, artifact, journal, gate, and signal operations are implemented once in `@tila/ops-sqlite` and reused by `@tila/backend-do` and `@tila/backend-local`. The differences between paths are confined to the connection layer (DO's `blockConcurrencyWhile` plus `this.ctx.storage.sql` versus bun:sqlite plus PRAGMA initialization) and the transaction semantics (DO implicit single-threading versus `BEGIN IMMEDIATE` explicit locking).

Test fixtures (Map-backed in-memory fakes implementing the interfaces) live in `packages/core/test/fixtures/` but are not shipped as backends.

No GitHub, Linear, Upstash, Beads, or other adapters in v0.1. The interfaces exist as architectural seams; implementations come in v0.2+. The interfaces deliberately allow split implementations (different EntityBackend and CoordinationBackend) even though v0.1's two implementations unify them.

### 2.3a SDK and MCP server

**`tila-sdk`** is a typed TypeScript client over the Worker HTTP API. Framework authors and applications import `tila-sdk` instead of shelling out to the CLI. The SDK exposes `client.entities.*`, `client.records.*`, `client.artifacts.*`, `client.claims.*`, `client.gates.*`, `client.signals.*`, `client.journal.*`, `client.presence.*`, `client.schema.*`, `client.summary.*`, `client.templates.*`, and `client.tokens.*`. Schema types come from `@tila/schemas` so request and response shapes are type-checked end to end.

**`tila-mcp-server`** exposes tila as an MCP server that agents can connect to directly. It provides MCP tools for the same operations the SDK and CLI surface (entities, records, artifacts, claims, gates, signals, summary). Record types declared with `mcp_resource = true` in `tila.schema.toml` are additionally exposed as MCP resources under URI template `tila://records/{type}/{key}`. The default is tools only; resources are opt-in per record type to avoid flooding agent context.

### 2.4 The UI that ships

A single-page HTML+JS bundle served by the Worker at the root path. **Read-only.** Capabilities:

- List entities filtered by type, status, parent
- Show one entity with its hierarchy, claim state, artifacts, journal events
- Tail the journal in real time (polling, not websockets in v0.1)
- View presence: who's online and what they're working on
- View an artifact (download or inline render for markdown)
- View a project's overall status

**Not in v0.1:** creating, editing, claiming, releasing from the UI. The UI is for reviewing what the autopilots and CLI users have done; mutations are CLI-driven.

The UI uses the same API token as the CLI (via a one-time login flow that stores the token in the browser's localStorage).

### 2.5 Schema management in v0.1

- Bundled `tila.schema.toml.template` with a reasonable default schema (epic → issue → task, with standard dependency types) — a starting point for software-development consumers; users override for other domains.
- `tila schema show` displays current schema.
- `tila schema apply` reads `tila.schema.toml`, diffs against the latest applied schema, and applies non-destructive changes automatically.
- Destructive changes require `--strategy=...`. Supported strategies in v0.1: `relax`, `force`. (`migrate` and `default-parent` are v0.2.)

### 2.6 What's bundled vs. what users provide

**Bundled in the binary (or platform npm package):**
- Worker code (gets deployed via `wrangler deploy` during init)
- `wrangler.toml` template with all binding configuration, including `placement = { mode = "smart" }`, Analytics Engine binding, and the daily-sweep cron trigger
- Default `tila.schema.toml` template (`epic → issue → task` hierarchy with standard dependency types — a reasonable starting point for software-development consumers; users override for other domains)
- Default `tila.lifecycle.json` (R2 lifecycle backstop with 365-day expiry on produced-artifact prefixes; `sources/` and `indexes/` exempt). The primary cleanup is Worker-driven via the cron sweep — see Architecture §7.3.
- DO SQLite migration SQL bundled with the Worker (`migrations/do/0001_initial.sql`, etc.) — applied on first DO use via `blockConcurrencyWhile`
- D1 migration SQL for the shared global DB (`migrations/global/0001_initial.sql`)
- The static UI bundle served by the Worker
- `aws4fetch` for R2 conditional writes from inside the Worker

**Required peer dependency:**
- `wrangler` (>=3.73). Detected at startup for any cloud-provisioning command. If not installed, tila prints clear installation instructions (`npm install -g wrangler` or `bun add -g wrangler`) and exits. Runtime commands that only talk to the Worker do not require wrangler.

**Startup checks performed by every tila command:**
1. Resolve project context (walk up from cwd for `.tila/config.toml`)
2. If command needs Cloudflare auth: verify wrangler is installed, logged in, and active account matches the project's `cloudflare.account_id`
3. If command needs project API token: verify `TILA_API_TOKEN` is present in `.tila/.env` or environment
4. Surface clear, actionable errors at each failure point

**User provides:**
- A Cloudflare account (one team member, for provisioning)
- Their own customizations to `tila.schema.toml` and `tila.lifecycle.json` if non-defaults are wanted
- The project API token, shared via the team's secret manager (1Password, Vault, etc.) for engineers joining via `tila init`

---

## 3. What v0.1 explicitly does NOT ship

Documented so the scope stays sharp. Not "we forgot" — "we deliberately deferred."

- **No GitHub adapter** (v0.2)
- **No Linear adapter** (v0.3)
- **No Upstash Redis adapter** (v0.3)
- **No Beads compatibility layer** (no version yet — depends on demand)
- **No websocket / real-time event streaming** (v0.3)
- **No write-capable UI** (v0.2 at earliest)
- **No hosted SaaS / Pro tier** (no version yet)
- **No multi-project aggregation view** (no version yet)
- **No bundled workflow framework** (out of scope — tila is the engine; consumers build their own framework or use a third-party one on top)
- **No Slack/Discord webhooks** (v0.2 if a user asks)
- **No Docker image** (v0.2)
- **No `tila export` / `tila import` for data portability** (v0.2)
- **No interactive `tila schema migrate` for complex schema changes** (v0.2)
- **No external telemetry to Anthropic or anyone else.** tila collects no anonymous usage data, never. Workers Analytics Engine writes datapoints to the user's *own* Cloudflare account for their own observability — never leaves the user's account.
- **No `/metrics` Prometheus endpoint** (v0.2). v0.1 observability is `wrangler tail`, `tila journal tail`, and Workers Analytics Engine queries via Cloudflare's dashboard.
- **No DO sharding for projects exceeding single-DO capacity** (v0.3). v0.1 assumes one DO per project, comfortable for 40+ active machines and ~10 years of journal at typical rates.
- **No token scopes beyond "full"** (v0.2 adds read-only, write-artifacts-only, etc.)
- **No automatic token rotation with overlap windows** (v0.2; v0.1 has revoke + reissue)
- **No formal API documentation site** (v0.2)
- **No code-signed binaries** (v0.2; v0.1 binaries are unsigned, README documents the Gatekeeper/SmartScreen override)

---

## 4. The success criteria for v0.1

v0.1 is done when all of the following are true. Not negotiable.

### 4.1 Functional success criteria

1. **`tila infra provision` + `tila project create` succeeds on a fresh Cloudflare account in under 5 minutes.** From binary install to a working Worker URL. Smart Placement is enabled by default in the generated `wrangler.toml`.
2. **`tila init` succeeds in under 60 seconds** when given a valid config and token.
3. **Two machines can successfully coordinate on the same project without races.** Run by spinning up two terminals against the same Worker, having both try to claim the same task; one wins, one gets 409.
4. **A full task lifecycle succeeds end-to-end.** A simulated framework consumer runs against tila: claims a task, produces three artifacts (plan, patch, review) with cross-references, releases. Journal contains all events. Artifacts are retrievable from R2 with correct sha256-derived keys. All claim-and-journal writes commit in single DO SQLite transactions (verified by integration test).
5. **The UI loads and renders state for a project with at least 50 tasks, 5 issues, and 100 artifacts** in under 2 seconds.
6. **Schema changes work for the four common cases:**
   - Adding a new entity type (auto-applied)
   - Adding a new optional field (auto-applied)
   - Adding a required field with `default_for_legacy` (auto-applied with default backfill)
   - Making a parent required (rejected without `--strategy=relax|force`)
7. **`tila doctor` correctly identifies common inconsistencies** when manually induced (orphaned R2 blobs without pointer rows, tombstoned pointers, expired claims awaiting sweep, journal-to-pointer mismatches). Returns exit code 1 (warnings) or 2 (errors) appropriately.
8. **`tila reset` cleanly drops all project data** and re-initializes.
9. **Account context check refuses cross-account mistakes.** A `tila` command run in a project whose `cloudflare.account_id` does not match `wrangler whoami` fails with a clear error before attempting any destructive operation.
10. **The dogfooding consumer works.** A minimal framework script (Bun TypeScript file in the integration test suite) successfully drives a full task cycle through tila primitives, validating that the primitives are general enough to support workflow orchestration.
11. **Worker-driven artifact cleanup works.** Set a low `retention_days` on a test artifact kind, advance time, verify the daily sweep cron deletes the R2 blob, tombstones the pointer row, and emits an `artifact.expired` journal event.
12. **DO eviction is recoverable.** Force a DO restart mid-test (via `wrangler` or manual DO ID rotation in a test fixture), verify that all entity, journal, and claim state survives via DO SQLite persistence and the next request succeeds with <100ms cold-start latency.
13. **Cross-backend orphan recovery works.** Simulate a R2-write-succeeded / DO-write-failed scenario in integration tests, run `tila doctor --reconcile`, verify the orphaned blob is rematerialized as a pointer row with an `artifact.reconciled` journal event.
14. **Records work end-to-end.** Declare two record types in `tila.schema.toml` (one `history = "revision"`, one `history = "snapshot"`). Run the full record lifecycle: create, set, patch, archive, unarchive, history, export. Verify fence-based concurrency control, schema validation, canonical JSON storage, revision tracking, and (for snapshot mode) R2 artifact snapshots. Verify MCP tools expose record operations and that opt-in record types appear as MCP resources.
15. **Local backend reaches parity with Cloudflare backend.** A full task lifecycle, artifact upload, claim cycle, gate transition, signal emission, and record mutation all succeed against `tila project create --local`. Concurrent writes from two CLI processes against the same local SQLite database serialize correctly via `BEGIN IMMEDIATE`.
16. **SDK and MCP server are usable from a real consumer.** A test consumer imports `tila-sdk` and drives a full task lifecycle. A separate test agent connects to `tila-mcp-server` and performs the same lifecycle via MCP tools. Both paths produce identical journal output to the CLI path.

### 4.2 Non-functional success criteria

1. **The free Cloudflare tier handles the test workload comfortably.** A realistic test (3 machines, 8 hours of light autopilot work) uses less than 30% of any free-tier quota. DO SQLite storage stays below 1% of the 10GB per-DO limit.
2. **CLI commands return in under 500ms for any single operation.** Outliers under 2s. With Smart Placement enabled and DO warm, typical operations land at <50ms end-to-end.
3. **Worker p95 latency under 100ms** for entity/journal/state operations (down from the 200ms target in the 2024 design — DO SQLite makes this achievable); under 500ms for artifact uploads.
4. **The codebase has at least one integration test per CLI command.** Unit tests are nice to have; integration tests are mandatory.
5. **README and one tutorial doc exist.** README explains what tila is and how to install. Tutorial walks through `init → first task → first artifact → first state query`.
6. **An operational guide exists** documenting `wrangler tail` for log debugging, `tila journal tail` for state debugging, and Workers Analytics Engine queries for telemetry.
7. **One real project (the maintainer's) runs on v0.1 for at least two weeks before tagging v0.1.0.** Dogfooding is the final gate.

---

## 5. Build order

The order in which to actually build tila v0.1. Roughly 6–8 weeks of focused work for one person with AI assistance.

**Phase 1: foundations (week 1–2)**
1. Scaffold the tila monorepo: Bun + Turborepo + Biome + lefthook + tsconfig.base
2. `@tila/schemas` package with all Zod schemas (entities, claims, artifacts, journal, relationships, config)
3. `@tila/core` package with backend interfaces (EntityBackend, CoordinationBackend, ArtifactBackend) and in-memory test fixtures
4. `@tila/backend-do` package: DO SQLite Drizzle schema, initial migrations, ProjectDO class skeleton
5. `@tila/backend-r2` package: R2 ArtifactBackend with aws4fetch, sha256-keyed put/get/list
6. `@tila/worker` with Hono routing skeleton, Smart Placement configured in `wrangler.toml`, deployed via `wrangler dev` locally
7. `tila-cli` with basic command parsing (Citty), config loading, HTTP client to Worker
8. CI pipeline (lint, test, build) on every PR; integration tests via `@cloudflare/vitest-pool-workers`

**Phase 2: provisioning and auth (week 2–3)**
9. Global D1 setup (one-time per Cloudflare account): `tila-global` database with `_tokens`, `_idempotency`, `_projects` tables and migrations
10. `tila infra provision` + `tila project create` flow end-to-end (wrangler shell-out, ProjectDO + R2 bucket creation, global D1 registration, token issuance, config write)
11. `tila init` for joiners
12. Startup auth check sequence (wrangler installed, logged in, account match, API token present, project context resolved)
13. Project API token issuance, revocation, listing
14. Worker token validation with 60s in-memory cache

**Phase 3: tila primitives (week 3–5)**
15. ProjectDO with all DO SQLite tables (entities, relationships, artifact_pointers, references, journal, claims, fences, presence, _schema_history) and `blockConcurrencyWhile` migration runner
16. Entity CRUD in DO + Worker + CLI (`tila task new`, `tila task list`, `tila task update`, etc.)
17. Coordination primitives: acquire / renew / release in DO with single-transaction claim+journal writes
18. Fencing token discipline implemented end-to-end with action-site validation
19. Three relationship tables wired up; CHECK constraints distinguishing entity IDs from R2 keys verified by integration tests
20. R2 artifact put/get/list with conditional writes; sha256-keyed; produced + source flavors with correct R2 prefixes
21. Artifact relationships, entity-artifact references with declared-slot validation
22. Index/entry pattern for aggregate artifacts (lessons-index, etc.)
23. `tila state` and `tila presence` commands
24. Cross-backend orphan recovery: `tila doctor --reconcile` walks R2, synthesizes missing pointer rows from R2 object metadata

**Phase 4: schema management (week 5)**
25. `tila.schema.toml` parser and validator (work_units, hierarchy, artifacts, artifact_relationships sections)
26. `_schema_history` table and apply logic
27. Tolerant reads with `default_for_legacy`
28. The four common schema-change cases work as documented in Architecture §6.3–6.6
29. Structural constraints enforced at write time: hierarchy depth, leaf-child rejection, required artifact references, reference slot validation

**Phase 5: cleanup, observability, UI (week 6)**
30. Worker-driven artifact cleanup: daily cron sweep at `/_internal/sweep`. Identifies expired pointer rows, deletes R2 blobs, tombstones rows, emits journal events
31. R2 lifecycle backstop policy applied (365-day expiry on produced-artifact prefixes; `sources/`, `indexes/` exempt)
32. Workers Analytics Engine integration: emit datapoints for Worker requests (route, latency, status) and DO operations (table, op, rows affected)
33. `tila doctor` full check suite: DO reachable, D1 reachable, R2 reachable, no orphaned R2 blobs, no overdue expired claims, journal size projection, Worker↔DO latency probe
34. `@tila/ui` single-page bundle (TypeScript, no framework)
35. Worker serves static assets via Hono
36. Read-only views: entity list, entity detail, journal tail, presence, artifact view, hierarchy tree
37. Polling-based updates

**Phase 6: dogfooding consumer (week 6–7)**
38. Build a minimal framework-shaped consumer script (Bun TypeScript) in the integration test suite. It drives a full task lifecycle through tila primitives — claim, produce three cross-referenced artifacts, release. This is not shipped as a product; it exists to validate that tila's primitives are general enough.
39. Run for 2 weeks, file and fix issues. Pay special attention to: DO eviction recovery, Smart Placement effectiveness (measure Worker↔DO RTT), cron sweep correctness, journal growth rate

**Phase 7: records (week 8)**

Records implementation follows the eleven-issue plan in [`docs/09-RECORDS-EPIC-DRAFT.md`](09-RECORDS-EPIC-DRAFT.md), which is normative against [`docs/08-RECORDS.md`](08-RECORDS.md). The phase exists because records were designed after the original build order was written; their normative spec is the source of truth, and this phase reference points there rather than restating it.

40. Record schema primitives in `@tila/schemas` (type/key/tag validation, canonical JSON serializer, SHA-256 helper, API request/response schemas).
41. Schema parser and evolution support for `[records.<type>]` in `@tila/core`.
42. DO SQLite tables (`records`, `record_tags`, `record_revisions`) and corresponding `@tila/backend-local` tables.
43. Core record ops (create, set, get) with fences and revisions in `@tila/ops-sqlite`.
44. Patch, archive, unarchive, list, history, tags, types-in-use.
45. Worker API routes under `/projects/:projectId/records`.
46. Snapshot artifact flows for `history = "snapshot"` record types.
47. `tila record` CLI command group with JSON and YAML input.
48. `client.records.*` in `tila-sdk`.
49. MCP record tools, plus opt-in MCP resources for record types declared with `mcp_resource = true`.
50. Public work-unit aliases (`tila work-unit`, `/work-units` routes, `client.workUnits.*`, `tila_work_unit_*` MCP tools) without renaming the internal `entities` table.

**Phase 8: release (week 9–10)**
51. README, tutorial, install scripts (curl-bash, PowerShell, Homebrew tap)
52. Operational guide documenting `wrangler tail`, `tila journal tail`, Workers Analytics Engine queries
53. `bun build --compile` for 8 platform targets via GitHub Actions
54. Publish to npm with platform-specific optional dependencies
57. Tag v0.1.0

This is roughly 8–10 weeks of focused work. Adjust to reality; ship when the success criteria are met.

---

## 6. Graduation criteria: when to start v0.2

Triggers for moving past v0.1, in order of priority. Hit any of these and start v0.2 planning:

1. **A second user asks for a feature that v0.1 doesn't have, and it's something v0.2's roadmap already includes.** Real demand, not speculative.
2. **You personally hit a friction point in your own use that's not on the deferred list.** Real pain, not theoretical pain.
3. **Two weeks of dogfooding reveals a structural problem with the v0.1 architecture.** Honest reassessment, not feature creep.
4. **External users ask for an adapter** (GitHub Issues, Linear) and they're willing to pilot it.

Do NOT graduate to v0.2 just because v0.1 is done. v0.1 should run in production for at least a month before adding new scope. The whole point is to resist the "we shipped, now what?" trap.

---

## 7. v0.2 scope sketch

When graduation criteria hit, v0.2 will plausibly include:

- **GitHub adapter** (one-way mirror of entity state to Issues for human visibility)
- **Write-capable UI** (create entities, claim tasks, release, from the browser)
- **`tila migrate --to-account`** for moving a project between Cloudflare accounts (personal → org migration)
- **`tila export` / `tila import`** for data portability
- **Interactive `tila schema migrate`** for the `--strategy=migrate` case
- **Webhooks** firing on meaningful state changes
- **Docker image** for users who prefer running tila in a container
- **Code signing** for binaries (macOS Developer ID + notarization, Windows code-signing cert) — v0.1 ships unsigned
- **`tila account list` / `tila account use`** convenience commands for users with multiple Cloudflare accounts on one machine
- **Custom subdomain / R2 jurisdiction** support fully wired through `tila init` flags (v0.1 supports it via direct `wrangler.toml` editing)
- **Service account / CI token** documentation and helper commands (`tila token issue --name=ci-prod --note=...`)
- **API documentation site** generated from Zod schemas
- **Cache API integration** on the Worker for entity reads (read-through cache with invalidation on write — pushes typical reads to sub-millisecond)
- **Token scopes** (read-only, write-artifacts-only, write-state-only) and rotation with overlap windows (issue new, both valid for 24h, old revoked)
- **`tila metrics` endpoint** returning Prometheus-format counters for users who run their own observability stack
- **Journal archival** — events older than N days cold-stored to R2 under `journal/<year>/<month>.jsonl.gz` and pruned from DO SQLite

Not a commitment. The actual v0.2 scope will be set when v0.1 is in production and real signal exists.

---

## 8. v0.3 scope sketch

If v0.2 succeeds, v0.3 plausibly includes:

- **Linear adapter** (a commonly requested third-party integration)
- **Upstash Redis CoordinationBackend** for users who want to split coordination from entity storage
- **Websocket-based real-time event streaming** in the UI (replaces polling)
- **GitHub Actions templates** that drive tila from CI
- **DO sharding** for projects that have outgrown a single DO (rare; 40+ active machines or 10GB+ journal)
- **R2 event notifications** (R2 → Queue → Worker) replacing polling-based artifact discovery

Again, not a commitment. The trajectory matters more than the specifics.

---

## 9. Risks and how they're handled

### 9.1 Risk: Cloudflare changes the free tier
**Mitigation:** the backend interface allows swapping in alternatives. Upstash and self-hosted etcd are reasonable fallbacks. If Cloudflare's free tier becomes hostile, the adapter pattern absorbs it.

### 9.2 Risk: Wrangler's auto-provisioning changes
**Mitigation:** the init flow can fall back to explicit `wrangler r2 bucket create`, `wrangler d1 create`, etc. More verbose but stable.

### 9.3 Risk: Durable Objects pricing or SQLite limits change
**Mitigation:** acknowledged. DOs are now the primary persistence layer, not just coordination — so their pricing and limits matter more than in the 2024 design. The mitigation has two arms. First, the v0.1 architecture stays well within DO SQLite's 10GB-per-DO limit for realistic projects (years of typical usage). Second, the EntityBackend and CoordinationBackend interfaces preserve the option to split entities back out to D1 or to a different backend entirely. If Cloudflare changes DO pricing materially, tila's adapter pattern absorbs it — a future `d1+upstash` backend split would be a v0.2+ project, not a v0.1 blocker.

### 9.4 Risk: Schema evolution code has bugs
**Mitigation:** integration tests for each of the four common cases. `_schema_history` provides forensic data. `tila doctor` flags inconsistencies.

### 9.5 Risk: Scope creep during v0.1
**Mitigation:** this document. Any feature request during v0.1 that's not in section 2 goes on the v0.2 sketch list and stays there.

### 9.6 Risk: The engine/consumer boundary is wrong
**Mitigation:** v0.1 validates the boundary by including a minimal framework-shaped consumer in the integration tests (Phase 6 of build order). If the consumer can't be expressed in tila primitives without reaching into internals, the boundary is wrong and needs revisiting before v0.1.0. The dogfooding consumer is cheap to write and reveals problems fast.

### 9.7 Risk: Limited external adoption
**Acceptable.** tila is built first to serve its maintainer's real projects; external adoption is a bonus, not a success requirement. The tool is justified by its own use.

### 9.8 Risk: Beads or another tool ships something equivalent
**Acceptable.** The target niche (pre-MVP autopilot work, multi-machine, no ceremony, artifact lifecycle outside repo) is genuinely underserved. If Beads pivots to cover it, that's good for the ecosystem — use whichever tool serves you best.

### 9.9 Risk: The "tila" name doesn't land culturally
**Mitigation:** the name reads as neutral for non-Finnish speakers and acceptable to Finnish ears. Renaming before v0.1.0 is acceptable if early feedback strongly warrants it; after v0.1.0 it carries a real cost and shouldn't happen without strong reason.

### 9.10 Risk: Bun has a blocking bug or regression
**Mitigation:** Bun is Anthropic-owned and well-supported in 2026, but it's younger than Node. Specific known issues to watch: source-map leakage in published packages (CI guards against it), occasional npm-compat edge cases (pin known-good dep versions). If Bun becomes blocking for tila specifically, fall back to Node + tsx with SEA for distribution. Source stays universal TypeScript; only the build pipeline changes.

### 9.11 Risk: Wrangler's auth model changes
**Mitigation:** wrangler is bundled-by-shell-out, not vendored as a library. If wrangler's OAuth or account selection model changes meaningfully, the auth code in tila is concentrated in the startup-check sequence and a few provisioning helpers. Tested via integration tests against `wrangler whoami` output shape; breakage surfaces immediately.

### 9.12 Risk: Source-map leak via Bun's bundler bug
**Mitigation:** known Bun bug where source maps get generated even when explicitly disabled. CI step fails the npm publish if any `.map` files appear in the package. `.npmignore` includes `*.map`. Treat as a release-engineering invariant, not as something Bun will fix in time for v0.1.

### 9.13 Risk: Single-DO bottleneck or failure isolation
**Mitigation:** acknowledged in decisions §11. A single DO is the per-project consistency point and therefore a single point of failure for that project. Throughput ceiling is ~1000 req/s sustained — fine for 40+ active machines at 500ms claim cadence. Failure isolation is the real concern: if the DO has a problem, the project is briefly unavailable. The tradeoff is taken deliberately for v0.1; DO sharding lives in v0.3 if a real user needs it. The architecture supports the migration path without v0.1 lock-in.

### 9.14 Risk: DO SQLite migrations introduce data corruption
**Mitigation:** migrations run via `blockConcurrencyWhile(initFn)` on DO startup, so they cannot be interrupted mid-flight. Every migration is tested against a populated DO in integration tests before release. A failed migration (e.g., constraint violation on existing data) prevents the DO from serving requests until manually fixed — a deliberate "fail loud" behavior. `tila doctor` reports schema_version mismatches between expected and actual.

### 9.15 Risk: Worker-driven cleanup falls behind or fails silently
**Mitigation:** the daily cron sweep emits journal events for every expiration. `tila doctor` checks whether any pointer rows have `expires_at < now() - 2 days AND tombstoned = 0` — if yes, the sweep hasn't run successfully recently. R2 lifecycle backstop (365 days) ensures eventual cleanup even if the sweep is broken for months. Workers Analytics Engine records sweep run latency and rows-affected per run.

### 9.13 Risk: Unsigned binaries trigger Gatekeeper / SmartScreen warnings
**Mitigation:** v0.1 binaries are unsigned. README documents the override steps for macOS (right-click → Open, or `xattr -d com.apple.quarantine`) and Windows (More info → Run anyway). Code signing is a v0.2 deliverable. For users who want signed binaries immediately, recommend the npm-install path (which still gets the unsigned native binary but bypasses Gatekeeper since it comes from npm not direct download).

---

## 10. A note on AI-assisted development

Most of v0.1 will be built with AI coding agents (Claude Code primarily). A few principles:

- **The two governance documents** (`01-DECISIONS.md` and `02-ARCHITECTURE.md`) are inputs to every coding session. Reference them when delegating.
- **Each phase in section 5** maps to a discrete delegation: "implement phase 2 against the architecture spec, success criteria in section 4."
- **Integration tests are non-negotiable.** AI-generated code is best validated by running it, not by reading it. The success criteria in section 4 are integration-test shaped.
- **Resist letting AI agents widen scope.** Every "should we also..." in an AI session goes on the v0.2 list, not into v0.1.
- **Dogfood obsessively.** The maintainer is the canary. If something feels wrong in real use, fix it before shipping; don't ship hoping users won't notice.

---

This is the plan. It is a real plan. It assumes you ship in 8–10 weeks of focused work and then live with what you shipped for at least a month before deciding what's next.
