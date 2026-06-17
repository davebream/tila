# tila — Foundational Decisions

> The constitution. Every decision here is settled. If a future commit, design doc, or AI agent appears to re-open one of these, push back and reference this file. Re-litigating settled questions is the most common way good projects rot.

---

## 0. Name and scope

**`tila`** — Finnish for "state, space, condition, mode." A state-and-coordination engine for multi-machine agentic work. Generic, unopinionated, reusable. Includes the Cloudflare Worker, all backends (D1, DO, R2), and the `tila` CLI.

**What tila is:** the primitives a higher-level framework needs to coordinate work across machines. CRUD on entities (tasks, issues, epics, or any user-defined type), first-writer-wins claims with fencing tokens, append-only journal, content-addressed artifact storage with lifecycle, schema-as-config.

**What tila is not:** a workflow orchestrator, an opinion about how AI agents should plan or review work, a bundled set of agent prompts, or a pipeline runner. Those things belong in a framework that consumes tila — and a framework is exactly the kind of thing tila is designed to support, but it is not itself part of tila.

**The test for any feature:** would this make sense for non-software-development agentic work — content moderation, research, automation pipelines, anything where multiple workers coordinate over a shared state? If yes, it belongs in tila. If no, it belongs in a framework on top.

**CLI surface:** `tila` is the only binary. Short verbs, single-purpose, fast. `tila task claim T-142`, `tila artifact put plan.md`, `tila presence`, `tila state`. No workflow commands.

**The hypothetical framework consumer.** Throughout this document, an imagined framework named "sisu" is sometimes mentioned to clarify *what tila must support*. Sisu is not a thing tila ships. It's a thought-experiment consumer — a stand-in for any future framework that will run on top of tila — used to validate that tila's primitives are generic enough to support workflow orchestration without being workflow-specific.

---

## 1. The three-layer architecture

The settled persistence model. Each layer exists because it has a distinct write profile, audience, and consistency requirement. Collapsing any two destroys a property we need; but importantly, what counted as separate layers in the 2024 design (entities and coordination) belong together in 2026.

| Layer | Backend (v0.1) | Role | Write freq | Consistency |
|---|---|---|---|---|
| Project state | Durable Object SQLite | Entities, relationships, journal, schema history, claims, fences, presence | seconds | Strong, serializable (single-thread serialized) |
| Auth + idempotency | D1 (Cloudflare SQLite) | API tokens, idempotency keys, project metadata | minutes-hours | Eventual, cross-DO scope |
| Artifacts | R2 with Worker-driven cleanup | Content-addressed blobs (outputs of work + uploaded sources) | per artifact write | Strong, immutable, content-addressed |

**Why DO SQLite for project state, not D1.** When this design started in 2024, D1 was the obvious choice for entity storage and the DO held only ephemeral coordination state. In 2026 — with DO SQLite GA, 10GB per DO, point-in-time recovery, and sub-millisecond reads — the cleaner architecture is to put *all* per-project state inside a single DO. Three reasons:

1. **Coordination and entity writes commit in one transaction.** Claiming a task and updating its status used to require touching two backends (D1 for the entity, DO for the claim); writes had to be journal-first-then-DO to be recoverable. In the DO-centric model, both happen in one SQLite transaction. The two-write problem dissolves.
2. **Hot-path latency drops 5-10x.** D1 reads from a Worker are ~30ms; DO SQLite reads from inside the DO are <1ms. The latency budget for a `tila task show` collapses from "Worker → D1 → reply" (~40ms) to "Worker → DO → reply" (~10ms).
3. **The single-DO serialization is the actual correctness mechanism.** The DO already serializes all writes for coordination. Co-locating entities means the same serialization protects entity invariants for free. No additional locking, no cross-backend transactions.

**Why D1 still exists.** Two narrow uses: API token storage (must be readable before the DO is contacted, to authenticate the request) and idempotency keys (cross-project scope by design). Both are tiny tables with light access patterns. D1's free tier handles these comfortably.

**Why no git in the cloud path:** the journal lives in DO SQLite, not in a sidecar git repo. The autopilot's exhaust never touches git at all; the project repo stays clean automatically.

The backend interfaces (EntityBackend, CoordinationBackend, ArtifactBackend) allow alternative implementations to be added in future versions (Upstash Redis, GitHub Issues, Linear, self-hosted Postgres). v0.1 ships only the Cloudflare-backed implementations. The DO-first model does *not* preclude alternative backends — it means the v0.1 reference implementation puts entities and claims together, while the interfaces leave room for split implementations elsewhere.

---

## 2. Correctness model: first-writer-wins with fencing tokens

The non-negotiable correctness property. Two machines must not silently both believe they hold the same claim.

- **Every claim returns a monotonic `fence` token.** Per-resource counter, incremented on each acquire.
- **Entity coordination keys canonicalize at the boundary.** Entity claims, renewals, releases, and state reads normalize to the canonical `<type>:<id>` resource before touching claim or fence rows. Bare ids are a caller convenience, not a second storage form.
- **Every destructive operation downstream of the claim carries the fence.** Artifact writes, status updates, completion markers — all include the fence.
- **The action site validates the fence.** If a write arrives with a fence lower than the current fence for that resource, it is rejected. This catches stale leases that expired during work.
- **Missing fence rows fail closed.** Required-fence write paths reject when the canonical fence row is absent; there is no silent "best effort" fallback for entity resources.
- **Lock acquisition is single-threaded inside the DO.** The DO itself is the serialization primitive — no Redlock-style multi-instance correctness needed at this scale. DO serialization is the *primary* correctness mechanism; fencing tokens are the secondary defense.
- **Why fencing tokens exist when the DO already serializes.** Three scenarios where DO serialization alone is insufficient:
  1. Long-running agent operations where the claim TTL expires between read-claim and write-result (the autopilot scenario). The DO doesn't know the in-flight work; fence-on-write catches it.
  2. Out-of-band writes that bypass the DO (direct R2 uploads via signed URLs in v0.2+). The DO can't serialize what it doesn't see.
  3. Defense-in-depth for code paths added later that might forget to go through the DO. The fencing-token discipline turns a class of latent bugs into hard errors.
- **Why not optimistic concurrency control (OCC).** OCC (version counters / ETags) was evaluated and rejected. A fencing token validates that the writer *holds the resource*, not merely that the entity hasn't changed — this prevents zombie writes where an expired claimant's late-arriving write succeeds because the entity version hasn't advanced. OCC also cannot extend to out-of-band R2 writes, where fencing tokens can be embedded in signed URLs.
- **TTL leases, not perpetual locks.** Every claim has an expiration. Renewals extend; failures release. Crashed clients self-recover within the TTL window.

This applies uniformly: tasks, issues, epics, artifacts, file reservations. The semantics differ (exclusive vs. owner mode, short vs. long TTL), but the fencing-token discipline is the same everywhere.

**Cadence target.** The coordination layer must support claim/renew/release operations at ~500ms cadence across 3–6 machines without rate-limit pain or correctness loss. This is the design target that selected Cloudflare DOs over Workers KV, GitHub Issues, IPNS, and DNS-as-KV. v0.1 must meet this in real use.

**File reservations are first-class.** `file:src/auth.rb` is as legitimate a resource as `task:T-142`. Two autopilots editing the same file simultaneously is a real failure mode the engine prevents via the same claim/fence mechanism. Framework consumers take file reservations before destructive edits.

---

## 3. Three coordination modes

A resource can be claimed in one of two ways, plus an implicit third:

- **`exclusive` mode** — one holder at a time, short TTL (minutes), fence-validated. Used for tasks. Two agents cannot both claim the same task.
- **`owner` mode** — multiple holders allowed; one designated primary. Long TTL (hours to days). Used for issues and epics. Alice owning issue I-23 doesn't prevent Bob from claiming individual tasks within it; it just signals "Alice is driving this."
- **`presence`** — implicit, ephemeral, no claim semantics. TTL'd machine activity. Used for the "who's online and on what" view.

---

## 4. Entity schema is config, not code

Entity types (`task`, `issue`, `epic`, or any custom hierarchy users define) live in `tila.schema.toml`. They are NOT hardcoded in tila's data model.

**Storage layout:** one generic `entities` table with `type TEXT`, `data JSON`, `schema_version INTEGER`. Adding/removing entity types is a config change, never a DDL migration.

**tila ships a default schema template** — `epic → issue → task` with dependency types (`blocks`, `related`, `parent-child`, `discovered-from`). This is what most software-development consumers will start from. Users with different domains (content workflows, research, automation) define whatever entity hierarchy fits — the schema is config, not code, so the default is just a starting point, not a structural commitment.

**Schema evolution:** field-level `default_for_legacy` for backward-compatible additions; explicit user strategy (`--strategy=relax|migrate|default-parent|...`) for destructive changes. Tolerant reads (each entity validated against the schema active when it was created); validated writes (against current schema).

---

## 5. Artifact model: write-once, content-addressed, lifecycle-managed

- **Content-addressed by sha256.** Key format: `<prefix>/<task-id>/<sha256>.<ext>`. The same content produces the same key — deduplication falls out for free.
- **Write-once, never edited.** "Updating" means writing a new artifact with a new hash; pointer files (if any) reference the current one via conditional PUT.
- **Self-describing via metadata.** Every artifact carries `x-amz-meta-tila-task`, `x-amz-meta-tila-fence`, `x-amz-meta-tila-machine`, `x-amz-meta-tila-kind`. Markdown artifacts additionally have YAML frontmatter with the same fields. Redundancy is deliberate: if one record is lost, the other can rebuild it.
- **R2 lifecycle rules encode retention by prefix.** Tasks 30 days, designs 90 days, transcripts 14 days, completed-state markers retained longer. Configurable per project in `tila.config.toml`.
- **Pointer files for "current best."** When mutable pointers are needed (e.g., `pointers/T-142/latest.json`), use full PUT with `If-Match: <etag>` for CAS. Fencing-token check at the application layer.

---

## 6. The pre-MVP velocity problem is the niche

Stated explicitly because it shapes everything that follows. The unfilled gap in the current tool landscape:

> There is no tool today optimized for high-velocity autopilot work on pre-MVP projects, where multiple machines need real coordination but you cannot afford the ceremony tax of human-grade tooling (PR/CI/merge cycles, Linear workspaces, full JIRA flows).

**Existing tools and their gaps:**
- **Beads** — git-native, excellent for solo memory-across-sessions. No real-time multi-machine coordination. No artifact lifecycle outside the project repo. Conflicts surface at git push time, after work is done.
- **Linear** — great UI, good API, Agent framework. 250-issue free tier kills it for autopilots filing follow-ups. No CAS/locking semantics. Ceremony tax for high-velocity programmatic use.
- **GitHub Issues** — universal, but the PR/CI/merge cycle adds minutes to operations that should take seconds.
- **In-repo markdown plans** — pollutes the codebase, bloats agent context, no multi-machine sync.

**tila fits exactly here.** Sub-second coordination, no PR ceremony, artifacts live outside the project repo with lifecycle, schemas are flexible, runs on free Cloudflare tiers.

---

## 7. Two failure modes to permanently kill

These two failure modes from earlier approaches are retired, not iterated forward:

**Mode 1 (everything in the project repo)** is replaced by tila running on Cloudflare. D1 holds entities and the journal; DO holds live coordination; R2 holds artifacts. The project repo only contains `.tila/config.toml` (committed) and `.tila/.env` (gitignored). No autopilot exhaust touches git.

Do NOT add a "local-only" or "git-synced" mode as a feature. Multi-machine sync via local files is exactly the failure mode being escaped from.

**Amendment (v0.2 era) — DELIVERED.** A single-machine local SQLite backend is distinct from this prohibition and is now a **shipped feature** across CLI, SDK, and MCP. It targets co-located agents on one machine (laptop, VPS) using a runtime-agnostic embedded SQLite core (`@tila/backend-embedded`) with WAL mode + `busy_timeout` + application-layer busy-retry -- the same first-writer-wins correctness model as the DO, serialized via SQLite locking instead of DO single-threading. Two host wrappers consume the embedded core: `@tila/backend-local` (Bun, `bun:sqlite`) for the CLI, and `tila-sdk/local` (plain Node, `better-sqlite3` + `node:fs`) for the SDK (`createTila({ backend: "local" })`) and the MCP server — so local mode now runs under plain Node, not just Bun. No multi-machine sync; no files in the project repo; no git coordination. The backend interfaces explicitly anticipate this (see Decision 1: "allow alternative implementations to be added in future versions"). `tila project create` remains the default for multi-machine teams; `tila init --local` is the zero-setup path for solo agents on a single machine. See `docs/02-ARCHITECTURE.md` §1.6a (Embedded local persistence) for the full description, including the documented divergences (idempotency accepted-but-not-honored locally, pre-feature DB upgrade limitation).

**Mode 2 (GitHub Issues + milestones)** is replaced by tila on Cloudflare as the primary coordination layer. A GitHub adapter (v0.2) optionally mirrors entity state to Issues for human visibility. One-way mirror, D1 is the source of truth. The autopilot does not wait on PR merges for state changes.

---

## 8. Provisioning: three-layer CLI model

Setup is split into three layers: `tila infra provision` (one-time account setup), `tila project create` (per-project), and `tila init` (teammate onboarding). Under the hood of `tila infra provision` + `tila project create`:

1. Set `CLOUDFLARE_API_TOKEN` (account-level token with Workers, D1, R2 permissions).
2. Generate `wrangler.toml` from a bundled template declaring the Worker, DO binding, D1 binding, R2 bucket.
3. Create D1 database and R2 bucket via the Cloudflare SDK.
4. `wrangler deploy` — deploys the Worker with all bindings.
5. `wrangler d1 migrations apply` — creates entity, journal, schema_history tables.
6. Apply R2 lifecycle rules and set Worker secrets via the SDK.
6. Write `.tila/config.toml` (Worker URL, project ID, Cloudflare account ID) and `.env` (API token). Commit `.tila/config.toml`; gitignore `.env`.

**Total user-visible steps:** one OAuth, two commands (`tila infra provision` once per account, then `tila project create` per project). Team members joining via `tila init` use the same Worker without their own Cloudflare account.

### 8.1 Two-credential model

Two distinct credentials, each with a different role. Conflating them is the source of most multi-tenancy bugs.

- **Cloudflare account credentials (via wrangler):** the user's identity to Cloudflare. Used only for provisioning operations (`tila infra provision`, `tila project create`), Worker upgrades, R2 lifecycle changes, and resource destruction. Most engineers never need this credential — only the project admin who provisioned the resources uses it.
- **Project API token:** the CLI's identity to the Worker. Generated per project during init. Stored at `.tila/.env` locally. Used for every runtime operation (task management, claims, artifacts, journal, presence). This is the credential team members need to use the project; shared via the team's secret manager.

This separation means engineers can join an existing project (`tila init`) and use it fully without ever logging into the project's Cloudflare account. Cloudflare account access is reserved for admin operations.

## 9. Multi-tenancy and organization use

A real workflow: Alice has personal tila projects on her personal Cloudflare account. She joins Acme Corp, which runs tila on Acme's Cloudflare Workers Paid account. Both must work simultaneously without credential confusion.

**The pattern: account context is per-project, not per-user.** Each `.tila/config.toml` records `cloudflare.account_id` for the project. When Alice runs a tila command inside an Acme project, the CLI uses Acme's account context; in a personal project, her personal account context. Same machine, same tila install, different accounts based on directory. This is the same pattern `gh`, `aws`, `kubectl`, and `gcloud` use for multi-account management.

**Why this works cleanly:**
- Runtime operations (the 95% case) only need the project API token. No Cloudflare account access required.
- Provisioning operations (`tila infra provision`, `tila project create`, schema migrations that touch D1 DDL, lifecycle changes) check that the active wrangler account matches the project's `cloudflare.account_id`; mismatches are rejected with clear guidance.
- Engineers joining an org get the project API token via the org's secret manager (1Password, Vault, Doppler, etc.). They never need access to the org's Cloudflare account.

**Org admin workflow:** one admin runs `tila infra provision` once per Cloudflare account, then `tila project create` for each project. They configure optional org-level concerns: custom subdomain (`tila.acme.com` instead of `*.workers.dev`), R2 jurisdiction for data residency (`eu` for GDPR-locked workloads), retention policy overrides. The resulting `.tila/config.toml` is committed; everyone else joins via `tila init`.

**Cost model implication:** Cloudflare bills per account, not per project. An org with 5 active tila projects shares one free-tier allowance across all of them; Workers Paid ($5/mo per account) is the realistic minimum once activity is real. tila does not aggregate billing across projects in v0.1; Cloudflare Analytics + project ID metadata is how an org attributes usage internally if needed.

---

## 10. Things we explicitly decided NOT to do

These were considered and rejected. If they come back up, point to this section.

- **No sidecar git repo for the journal.** D1 holds the journal in the cloud path. Sidecar was a hedge against polluting the project repo with autopilot exhaust, but in the cloud path the autopilot exhaust never touches git at all. The project repo stays clean automatically.
- **No Pro/free tier split as an architectural commitment.** The UI is part of the OSS Worker package. Hosted SaaS aggregation may exist someday as a separate decision, but it does not shape architecture choices made now.
- **No defensive code for "user manually edited D1 / R2."** Engineers who reach past the engine know they're stepping out of safety. Ship `tila doctor` (diagnostic) and `tila reset` (clean slate); do not pay complexity tax across the engine for this case.
- **No Workers KV.** Last-writer-wins with ~60-second propagation. Fundamentally wrong for first-writer-wins coordination.
- **No IPNS, DNS TXT, DHT, Discord/Slack/Matrix pins, chat-as-DB.** Each fails either correctness (no CAS) or latency (propagation in seconds-to-minutes).
- **No GitHub Contents API as primary entity backend.** Rate limits at 5K req/hr per user kill it for 6 active machines. Available as an *adapter* for users who want it; not the default.
- **No Linear or GitHub Issues as primary entity backend.** Both available as adapters; neither shapes the default.
- **No competitor comparisons in the README or docs.** Describe what tila does and why. Comparisons invite users to make decisions on the wrong axes.
- **No competing with Beads.** Beads owns the "agent memory via git-native task graph" position. tila addresses an adjacent problem (real-time multi-machine coordination with artifact lifecycle), not a directly competing one.
- **No bundling of Dolt.** Beads' Dolt dependency is correct for its use case; tila's D1 + JSON-data column achieves the schema flexibility we need with less infrastructure.
- **No defensive coordination against multi-version installs.** Version mismatch is detected at startup and refuses to proceed; we do not try to make incompatible versions interop.
- **No automatic migrations across destructive schema changes.** User must supply a strategy. Silent invalidation of existing data is unacceptable.
- **No built-in lessons-learned feature in tila.** Lessons learned is a workflow shape, not a primitive. tila provides artifact kinds, cross-references, indexes, and journal events; any framework on top of tila composes them into a retrospective workflow. Same principle for retro, post-mortem, knowledge-base, decision-log features: they belong in the framework, not the engine.

---

## 11. Things explicitly accepted as tradeoffs

These are not problems; they are deliberate consequences of decisions made above.

- **Cloudflare dependency in v0.1.** tila runs on Cloudflare. The backend interfaces preserve the option to add other implementations later, but day-1 reality is Cloudflare-shaped and that's intentional — it's the right stack for the use case and matches the maintainer's existing infrastructure.
- **One person per project pays the Cloudflare setup friction.** Team members join via `tila init` with no Cloudflare account of their own.
- **R2 has no native object versioning.** Acceptable because artifacts are content-addressed and write-once; "rollback" is "link to a different artifact" at the pointer level.
- **Workers binding API for conditional puts has reported bugs.** Use the S3 API path via `aws4fetch` from the Worker, not the Workers binding. Documented.
- **Single DO is a throughput ceiling and single point of project failure.** A single DO handles ~1000 req/s sustained, ~10K burst. At 500ms claim cadence per machine, that's room for 40+ active machines per project before saturation. The throughput ceiling isn't the practical concern; failure isolation is — if the DO has a problem, the project is briefly unavailable. The tradeoff is taken deliberately: single-DO simplicity beats sharded complexity for tila's audience (small teams). Projects that need sharding can migrate in v0.2+ via a documented path.
- **DO SQLite limits.** 10GB per DO, sufficient for hundreds of thousands of entities and millions of journal events. When approaching the limit, the migration path is journal archival (cold-store older events to R2) before sharding the DO itself.
- **No real-time event stream in v1.** Webhooks fire on meaningful state changes; websocket presence/event streaming is a v0.3+ feature.
- **Free tier has real limits.** 100K DO requests/day, 5M D1 reads/day, 1M R2 Class A ops/month. At realistic team sizes these are not hit, but billing alerts should be set. The DO-first architecture is *more* friendly to free tier than the previous D1-heavy design because entity reads no longer hit D1.
- **No offline mode.** If you can't reach the Worker, you can't run tila. This is acceptable because agentic coding requires network access for LLM calls; if you're offline, the autopilot can't run anyway.
- **R2 lifecycle is supplementary, not primary.** Worker-driven cleanup (a scheduled Worker that runs cleanup against R2 based on the journal) is the primary mechanism for artifact expiry. R2 lifecycle rules are a backstop. This costs a small amount of Worker CPU time daily in exchange for deterministic, journal-traceable deletion.

---

## 12. The cultural posture

A few principles to apply when decisions get ambiguous in the future:

**"Would a human reviewer benefit from seeing this change in a PR?"** Yes → it belongs in the project repo (e.g., `tila.schema.toml`). No → it belongs in the D1 journal, presence updates, or artifact metadata. Don't ceremoniously gate things that don't need review.

**"Does this serve me on a real project today?"** Build for the actual current use case, not the hypothetical future audience. The version of tila that works perfectly for one real user (the maintainer) is more likely to find its audience than the version optimized for hypothetical other users.

**"Is this the engine's responsibility or the framework's?"** When in doubt about which layer something belongs in: primitives → tila; opinions and workflows → out of scope, belongs in a consuming framework. If the answer would be the same for a content-moderation use case as for software development, it belongs in tila.

**Opinionated by default; configurable for power users.** Most users should get a working setup without configuration. Power users should be able to customize. Avoid the trap of making everything configurable and shipping no defaults.

**Errors fail loud and fail clean.** No silent state corruption. No "I'll patch around this." If invariants break, surface the break and let the user decide. `tila doctor` diagnoses; `tila reset` recovers.

**Spec-first TDD ("Ralph Wiggum" approach) is the build methodology.** Following the maintainer's established pattern: humans define Zod schemas as contracts and write failing tests; AI agents implement to make them pass with explicit pass/fail conditions. The artifacts in this repo (decisions, architecture, roadmap) are the human-authored spec; integration tests are the executable spec; AI agents fill in the implementation against both.

## 13. Ideas worth borrowing from neighboring tools

Not "we copy them"; "these are good ideas in the space that fit the design."

**From Beads:**
- **Hash-based IDs** over auto-increments to prevent merge conflicts when parallel agents create entities. Already adopted (see Architecture §4.2).
- **Typed dependencies** (blocks, related, parent-child, discovered-from) richer than parent-child only. Already adopted (see Architecture §6.1).
- **Memory decay** — old closed tasks summarized into compressed entries to reduce context bloat for agents. Adopt as a v0.2 feature: `tila task summarize --older-than=30d` or automatic at archive time. The journal preserves full history; the entity body gets compressed.

**From Linear's Agents framework:**
- **Activity-feed-shaped journal events.** Each event is structured well enough to render as a UI feed entry without postprocessing. The journal `data` JSON column carries enough context that the v0.1 UI can show "alice's autopilot started planning T-142," "produced plan.md (2KB)," "tests passing," etc. Design events with this rendering in mind.
- **Webhooks as the integration surface.** Any state change worth subscribing to should fire a webhook. v0.2 feature.

---

## 14. 2026 Cloudflare features tila uses

Specific platform capabilities the architecture depends on or benefits from. Naming them so the implementation doesn't miss them.

**Required (in v0.1):**
- **DO SQLite storage.** GA. 10GB per DO, transactional, point-in-time recovery. The primary persistence layer.
- **Smart Placement.** Enabled in `wrangler.toml` (`placement = { mode = "smart" }`). Auto-places the Worker close to its DO. Single biggest free latency win; drops Worker→DO RTT from cross-region (~50ms) to co-located (~5ms).
- **`@cloudflare/vitest-pool-workers`.** The supported test harness for Workers and DOs. v0.1 integration tests run here.
- **`wrangler` CLI for provisioning.** Single source of truth for resource creation; tila shells out rather than re-implementing the Cloudflare API.

**Used opportunistically (in v0.1, not load-bearing):**
- **Workers Analytics Engine.** Free up to 25M writes/day. Used for low-cost write-heavy telemetry: claim acquisitions/sec, artifact uploads/sec, fence increments. Not load-bearing — if AE is unavailable, telemetry degrades but operations continue.
- **Tail Workers.** `wrangler tail` for real-time log debugging. Documented in the operational guide.
- **Cron Triggers.** Drives the Worker-driven artifact cleanup job (`/_internal/sweep`). Runs daily at low-traffic time.

**Adopted in v0.2+:**
- **Cache API on the Worker.** Read-through cache for entity reads with cache invalidation on write. Drops repeated `tila task show` to sub-millisecond.
- **Workers KV.** As a secondary cache layer for schema definitions and lifecycle rules (cross-Worker-region read scope).
- **R2 event notifications.** R2 → Queue → Worker for triggering downstream work on artifact upload. Replaces polling patterns.
- **Token scopes.** Currently every token has full read-write; v0.2 adds scoped tokens (`read-only`, `write-artifacts-only`, etc.).

---

## 15. Audience

**Primary audience A (solo with multiple machines or multiple autopilots):** A single engineer running AI coding agents (Claude Code primarily) across two or more machines — laptop + desktop, or one machine running multiple parallel autopilots that fan out across files. The pain: machines don't see each other's state; in-repo artifacts pollute the codebase; switching machines means losing in-flight context. This audience hits the contention failure mode any time two autopilots independently pick the same task or edit the same file.

**Primary audience B (small team, 3–6 engineers, 1–2 machines each):** A team running autopilots in shared projects. Contention is the default, not the exception. The team pays Cloudflare setup once; everyone joins via `tila init`. Audit trail across agents becomes load-bearing; presence becomes useful.

**Secondary (non-software-development consumers):** Engineers building non-software-development agentic systems (content workflows, research agents, automation) who need first-writer-wins coordination and lifecycle-managed artifact storage. tila's primitives are general enough to serve them without modification.

**Tertiary (framework authors):** Anyone building an opinionated workflow framework on top of tila — pipeline orchestrators, retro/lessons-learned tools, expert-roster invocation systems. tila's job is to be a stable foundation for these consumers; their job is to provide the workflow opinions tila deliberately doesn't.

**Explicitly not the audience:** large engineering organizations needing JIRA-grade compliance, audit, or enterprise features. Mature post-MVP products with established ticket workflows. Solo developers doing single-machine one-shot experiments where Beads serves them better.

---

## 16. The growth path, named

To prevent feature creep on the wrong axis, here is what growth looks like over the next ~year:

**v0.1 (kickoff):** tila ships DO-first architecture (entities + journal + claims in DO SQLite), D1 for auth tokens and idempotency, R2 with Worker-driven cleanup. Worker, read-only UI, `tila` CLI binary. Working schema-as-config. Smart Placement on. Cloudflare-first.

> **Superseded (v0.2 era):** the original "Cloudflare-only, no local mode" framing for v0.1 no longer holds — embedded single-machine local persistence has since been delivered across CLI, SDK, and MCP (plain Node + Bun). See the **Amendment (v0.2 era) — DELIVERED** under §7 and `docs/02-ARCHITECTURE.md` §1.6a. The Cloudflare path remains the default for multi-machine teams.

**v0.2:** GitHub adapter (one-way mirror to GitHub Issues for human visibility). Schema migration tooling matures. Webhooks fire on state changes. Code signing for binaries. Write-capable UI. Cache API caching on entity reads. Token scopes and rotation with overlap windows. `tila metrics` endpoint for Prometheus-format scraping.

**v0.3:** Linear adapter. Upstash Redis CoordinationBackend alternative. Websocket-based event streaming in the UI. Cross-account project migration (`tila migrate --to-account`). DO sharding for projects that have outgrown a single DO. R2 event notifications replace polling.

**v0.4+:** Whatever the actual use has demanded. Resist planning past v0.3 in detail; the surface will look different by then.

---

## 17. TOML parser: smol-toml

**Decision:** Use `smol-toml` (semver range `^1.6.1`) as the sole TOML parser across all packages.

**Rationale:** smol-toml is spec-compliant (TOML v1.0.0), zero-dependency, small bundle (~4KB), and supports both `parse` and `stringify`. It runs in any JS runtime (Node, Bun, Cloudflare Workers) without platform-specific bindings. At the time of adoption it was the only lightweight parser that satisfied all three constraints: Workers-compatible, spec-compliant, supports stringify.

**Usage footprint (as of 2026-05-16):**

| Package | File | API used |
|---------|------|----------|
| `@tila/core` | `src/schema-parser.ts` | `parse` (TOML syntax parsing for `tila.schema.toml`) |
| `@tila/worker` | `src/routes/artifacts.ts` | `parse` (in-request schema validation) |
| `@tila/worker` | `src/routes/entities.ts` | `parse` (in-request slot validation) |
| `tila-cli` | `src/config.ts` | `parse`, `stringify` (read/write `.tila/config.toml`) |

The CLI's use of `stringify` constrains alternative choices — not all TOML parsers support serialization.

**Error-shape coupling:** `schema-parser.ts` extracts `line` and `column` from smol-toml's thrown exceptions to produce user-facing parse-error messages. Any replacement must expose equivalent positional error information.

**Risk classification:**

- Single maintainer (squirrelchat/smol-toml)
- Modest download count relative to `@iarna/toml` or `toml` packages
- Last npm publish: 2026-03-23 (version 1.6.1) — healthy as of documentation date
- Low blast radius: TOML parsing is a leaf dependency with no transitive deps

**Monitoring cadence:** Quarterly manual check (next review: 2026-11).

Check these signals:
1. Last npm publish date (drift > 12 months triggers evaluation)
2. Open security advisories on GitHub or npm
3. Upstream repo archived or maintainer-abandoned signals
4. TOML spec version drift (if TOML v1.1 ships and smol-toml does not follow within 6 months)

**Migration trigger:** If no upstream activity (commits or releases) for 12 consecutive months, evaluate alternatives and open a migration issue.

**Migration candidates (pre-researched):**

| Package | Stringify | TOML spec | Workers-safe | Notes |
|---------|-----------|-----------|--------------|-------|
| `@iarna/toml` | Yes | v1.0.0 | Yes | Larger bundle (~18KB), mature, infrequent updates |
| `@ltd/j-toml` | Yes | v1.0.0 | Yes | TypeScript-native, supports v1.0.0 fully |
| `toml` (npm) | No | v0.5.0 | Yes | No stringify — cannot replace CLI usage; outdated spec |

**Migration effort estimate:** 4 files across 3 packages, plus test verification. The `line`/`column` error-shape contract in `schema-parser.ts` requires explicit porting. Estimated at 2-4 hours including test validation.

**Last-known-healthy state (2026-05-16):**
- Resolved version: 1.6.1
- npm last publish: 2026-03-23
- No known CVEs
- Upstream repo active (squirrelchat/smol-toml)

---

## 18. Read-operation audit policy: write-only journal, AE for reads

**Decision:** The DO journal records only state-changing operations (writes). Read operations are NOT journaled. Workers Analytics Engine provides request-level observability for all HTTP requests, including reads.

**Rationale (privacy / storage / debugging tradeoffs):**

| Concern | Write-only journal + AE for reads | Journal all reads |
|---------|----------------------------------|-------------------|
| Storage volume | AE is fire-and-forget (25M writes/day free); no DO SQLite growth from reads | Every entity list/get, artifact search, token list adds rows — could 10x journal volume for read-heavy projects |
| Privacy | AE captures route, method, projectId, latency, status code — no request bodies, no requester identity beyond projectId | Journal would capture `actor` (token identity) per read — creates a per-user access log that may require data-retention policies |
| Debugging | AE queryable via GraphQL (last 90 days); sufficient for "was the API hit?" questions | Journal gives per-actor attribution but at significant storage cost for a pre-MVP product |
| Operational impact | Zero — already implemented in `packages/worker/src/index.ts:40-49` global middleware | Requires DDL migration, new `JournalEventKind` values, route-level instrumentation across 5+ files |

**What is already implemented (no changes needed):**

1. Global Hono middleware (`packages/worker/src/index.ts:40-49`) calls `emitRequestDatapoint` on every request — reads AND writes. Captures: route, method, projectId, latencyMs, statusCode.
2. `forwardToDO` (`packages/worker/src/lib/do-forward.ts:26-64`) emits `emitDoOperationDatapoint` on every DO-proxied operation including reads. Captures: table, operation type, latency, rowsAffected, projectId.
3. Both datapoints are fire-and-forget via Workers Analytics Engine — if AE is unavailable, operations continue unaffected.

**What is explicitly NOT captured for reads (by design):**

- Requester identity (which token made the read) — not in AE datapoints today
- Request body contents (query parameters for search, filter criteria)
- Response payload size or content

**Re-evaluation trigger:** If tila gains token scopes (v0.2 roadmap, section 16) and a compliance use case emerges requiring "who read what" attribution, re-open this decision. Until then, write-only journal + AE for reads is the settled policy.

**Follow-up implementation issues:** None required. The chosen policy (write-only journal) is already the current state. No code changes needed.

---

## 19. Token revocation cache semantics (v0.1)

**Decision:** When `DELETE /api/tokens/:name` is called, `D1TokenStore.revoke()` returns the token's hash. The route calls `invalidate(tokenHash)` synchronously before responding — clearing the calling Worker isolate's positive cache entry immediately. Other isolates that have the token positively cached will continue accepting it until their cache entry expires (max 60 seconds TTL).

**Option chosen:** Option 2 — SELECT hash during revoke, call `invalidate()` synchronously.

**Options rejected:**

| Option | Reason |
|--------|--------|
| 1: Document-only (no cache fix) | The same-isolate gap is closeable with minimal effort — accepting it when the fix is trivial is not earned |
| 3: DO-based revocation marker (cross-isolate) | Changes the hot-path auth check on every request; significant infrastructure; deferred to v0.2 |

**Accepted characteristics:**
- Multi-isolate window (up to 60s) is a v0.1 characteristic. A future cross-isolate broadcast mechanism (v0.2) would close this gap.
- If `tokenHash` is null (concurrent revoke race), `invalidate()` is skipped — cache entry expires naturally within 60s.

**Invariants:**
- `invalidate()` is called synchronously in the route handler — never via `waitUntil` — so cache is cleared before the 200 response.
- `tokenHash` never appears in logs, API responses, or error messages.

---

## 21. Gate lifecycle: resolve and cancel are permission-gated, not fence-gated

**Decision:** `resolveGate` and `cancelGate` are guarded by `requirePermission("write")`. They do **not** require a fencing token. This is a deliberate exemption from the uniform fence-on-destructive-write rule in §2.

**Rationale:** Gates model cross-agent coordination checkpoints. The agent that *creates* a gate is the claim-holder for the underlying resource (it has the fence). The agent that *resolves* or *cancels* a gate is frequently a different agent — a reviewer, a human operator, or a subsequent worker that was never the claim-holder and therefore never holds the fence. Requiring the creator's fence on resolve would break the primary cross-agent use case: a gate would be unresolvable by anyone except the original creator.

**Where the fence belongs:** `createGate` requires a fence because creating a gate is an assertion about the claim-holder's own resource — it records the fence at gate creation time (`gate.fence`). Resolve and cancel are external acts on the gate entity itself, not on the underlying resource.

**Invariant preserved:** Gate resolution is idempotent-safe via the `pending`-only guard — a gate that has already been settled throws `GateAlreadySettledError`, preventing double-resolution regardless of caller identity.

**Code reference:** `packages/ops-sqlite/src/gate-ops.ts` — `resolveGate` and `cancelGate` each carry a comment pointing to this section.

This document is the constitution. It changes when reality requires it, not when speculation suggests it might.

---

## 20. Token management authorization: flat-admin in v0.1

**Decision:** Every active token with `scopes = "full"` is a project administrator for all token-management operations. There is no admin/non-admin distinction in v0.1.

**Who can perform token operations:**

| Operation | Authorized | Scope required |
|-----------|-----------|----------------|
| Issue a new token (`POST /api/tokens`) | Any active full-scoped token | `full` |
| List all project tokens (`GET /api/tokens`) | Any active full-scoped token | `full` |
| Revoke any token (`DELETE /api/tokens/:name`) | Any active full-scoped token (including self-revocation) | `full` |
| Inspect token audit metadata (created_by, revoked_by, token_id in list response) | Any active full-scoped token | `full` |

**Why flat-admin is correct for v0.1:**

- `scopes = "full"` is the only scope value issued — hardcoded in `D1TokenStore.issue()` (see `packages/backend-d1/src/token-store.ts`).
- The v0.2 roadmap (§16: "Token scopes and rotation with overlap windows") introduces fine-grained scopes. Until then, every token holder is a peer administrator within their project.
- Token routes enforce this policy via an inline `requireTokenAdmin()` guard that rejects non-`"full"` tokens with HTTP 403 and error code `TOKEN_AUTHZ_DENIED`. In v0.1 this guard never fires — it is a forward-compatibility hook.

**Known limitation:** The `/_internal/sweep` route follows the same flat-admin pattern (any full token can trigger sweep). This is acceptable for v0.1 and may be gated separately in v0.2.

## 22. Session JWT migration: issuer/audience are required on newly minted tokens, optional on legacy tokens

**Decision:** Newly minted workspace session JWTs carry `iss="tila"` and `aud="tila"`. Verification remains backward-compatible for legacy tokens that predate those claims, but tokens that present `iss` or `aud` with the wrong value are rejected.

**Rationale:** This tightens token audience binding without forcing an all-at-once logout during rollout. Soft migration is acceptable because signature verification and expiry checks already exist; `iss`/`aud` hardening only narrows acceptance.

**Cross-references:** §14 (platform: Cloudflare-native), §16 (growth path: scoped tokens in v0.2).

---

## C9. Session revocation is a global, PK-only kill-switch; `_revoked_jti.project_id` is provenance, not scope

**Decision:** Session JWT revocation is a **global, unconditional kill-switch keyed solely on `jti`**. A revoked jti is revoked everywhere, for every project, full stop. The `_revoked_jti` lookup that gates acceptance (`D1RevokedJtiStore.isRevoked`) MUST be a single-column PRIMARY-KEY lookup on `jti` — never compound, never filtered by `project_id` or any other column.

**Why PK-only, no project filter:** A jti is a per-token nonce; it is not derivable from a project, and the engine never derives a project from a jti. If `isRevoked` were filtered by `project_id`, a revoked token would be **accepted** whenever the checking request's project differed from the recorded one — a silent **fail-open** of the kill-switch. The whole point of revocation is to fail closed; a scope filter inverts that. This is enforced both at the call site (auth fails closed if the D1 lookup throws) and by the store contract (the WHERE clause stays single-column).

**`_revoked_jti.project_id` is asserted-unverified provenance, not a scope filter.** The `project_id` recorded by `revoke()` exists for audit/forensics — "who asked for this revocation" — and never participates in the acceptance check. Its trustworthiness depends on how the revoke was authenticated:

- A revoke driven by a **verifiable token** records that token's verified project — trustworthy provenance.
- A **bare-jti** revoke (e.g. an infra-owner cross-project admin revoke, which has no per-project token to verify) records the **caller-asserted slug** — *asserted, unverified* provenance. The operator named the project; the engine did not confirm it.

Either way the column is a label on the audit row, not a gate. Cross-project infra revoke is therefore expected and correct: it records the caller-asserted slug and still revokes the jti globally.

**Code references:** `packages/backend-d1/src/revoked-jti-store.ts` (store contract + `isRevoked` DON'T comment), `packages/backend-d1/src/schema.ts` (`_revoked_jti` table), `packages/worker/src/middleware/auth.ts` (fail-closed per-isolate revocation check), `packages/worker/src/routes/admin.ts` and `packages/worker/src/routes/infra.ts` (revoke entry points).
