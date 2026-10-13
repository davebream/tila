# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-10-13

### Upgrade notes

- Deploy the Worker and its bundled UI together, before upgrading clients. There is no new D1 migration. Shared DO/embedded migrations 37 to 40 apply on the first request after deploy; all four are additive.
- Queue control is now restricted (the managed work queue from 0.6.0). Cancel, suspend, resume and retry requests are accepted only from the attempt's current owner, the principal that enrolled the work, or a maintainer. Queue `edit` and `withdraw` need the enroller or a maintainer. Other members get `403 queue-authority-lost`. Enrollments made before this release have no recorded enroller and fall back to owner or maintainer.
- `journal:append` is a new capability. The worker preset includes it, but existing scoped credentials must be reissued to append project-reported events.
- The runtime view's `work_attempt` and a delivery's `work_result` used to be constant (`null` and `not-reported`). They now carry real attempt data. Clients that relied on the constant values need the new shapes.
- Backups from this Worker report migration 40 and require the `attempt-corrections-v1` feature, which `GET /health` advertises. Restore them with the 0.7.0 SDK or CLI; older versions refuse them before writing anything.
- Projects open on the new Overview page instead of the task list (see Dashboard below).

### Durable work attempts (#303)

- `POST /attempts/:id/replace-session` attaches a new native session to the same attempt after the recorded one stopped. It issues a fresh fence, revokes the old one and keeps the attempt ID, so a provider restart no longer forces abandon-and-retry. `QueueExecutor` maps a `{ state: "replaced" }` adapter observation to it.
- Attempts record the definition version and queue policy revision at admission, at each authorization and at the result. `GET /attempts/:id` returns them with `current_revisions`. When the current definition rejects a transition, the error names both versions.
- Attempt lists accept `principal_id`, `participant_id` and `active`, filtered in SQL. `QueueExecutor.recoverable()` uses the owner filter.
- `POST /attempts/:id/correct` links a finished attempt to the task that corrects it, without changing the original result. SQLite triggers now reject any change to the outcome of a terminal attempt and keep corrections append-only.
- The runtime view lists up to five unfinished attempts per bound participant. Delivery traces report the linked attempt's result as `pending`, `reported`, `unlinked` or `hidden`.
- All of this is available over HTTP, in the remote and embedded SDKs, as `tila attempt replace-session` and `tila attempt correct`, and through MCP `tila_attempt`. `GET /health` advertises `attempt-control-v1`, `attempt-session-replacement-v1` and `attempt-corrections-v1`.

### Project-reported journal events (#383)

- `POST /projects/:projectId/journal` appends an authenticated observation to the project journal, through HTTP, the SDK, the CLI, MCP and the dashboard. Reports never change tasks, claims, attempts, gates or capacity.
- Claim-bound reports check live ownership and the fence. Each report has a seven-day idempotency receipt and is limited to 60 per principal and 300 per project per UTC minute. Local mode returns `unsupported-capability`.

### Dashboard (#386, #387, #388, #389)

- The twelve header tabs are grouped into Work, Conversations, Runtime and Settings. Old flat links redirect into the active project and keep their sub-path, query and fragment. The ⌘K palette now lists every page, and pages the credential cannot read are hidden.
- The new Overview page runs eight attention checks: uncertain and suspended executions, expired execution leases, blocked tasks, failed or abandoned tasks, suppressed and recently expired deliveries, and agents whose runtime needs a check. Each count is the exact total of the list it links to. A check that failed or could not run is never shown as zero.
- Settings has a read-only Definitions page with the applied revision, the work and record types and the revision history.
- The attempt drawer shows captured and current revisions, lists corrections and can link a corrective task. Control buttons follow the new authority rule.

### API

- New list filters with exact totals: `GET /tasks?blocked=1`, `GET /tasks?outcome=failure,abandoned`, `GET /deliveries?wake=suppressed` and `expires_after`, `GET /queue?lease=expired`, and `GET /runtime-view?filter=attention`. All response changes are additive.

### Fixes

- Project destroy no longer fails for a project that has a worker question (#391). The question and journal-report tables were missing from the destroy list, so the foreign-key check rolled back the whole destroy. A drift test now compares that list with every table the migrations create.
- Finishing a suspended attempt checks the command's fence against the recorded fence, not only the revision.
- `reconcile` with `observation: "stopped"` can no longer record `success` for a reservation that was never accepted.
- Maintainer force recovery and stopped reconciliation are journaled with the maintainer as actor and the owner named separately.
- Retrying `enroll` under a new idempotency key while the first enrollment is unfinished returns `409 queue-conflict` naming the existing entry.

## [0.6.0] - 2026-10-12

### Upgrade notes

- Deploy the Worker before upgrading clients. There is no new D1 migration. Shared DO/embedded migrations 32 to 35 apply on the first request after deploy. Migration 35 rebuilds each project's task search index once, so that first request waits for the rebuild.
- `tila-sdk`, `tila-mcp-server` and the CLI now use zod 4. Code that mixes its own zod schemas with the SDK's exported schemas needs zod 4 too (see Zod 4 below).
- `GET /tasks` rejects an unknown `sort` or `order` with 400 instead of falling back to `created_at`. `GET /search` now needs `records:read` and `artifacts:read` to return record and artifact results; `search:read` alone returns tasks only. Record lists default to key order and return a real `next_cursor` instead of `"truncated"`.
- Installed CLIs can now run `tila deploy` and `tila infra provision`. Every earlier binary release failed with `ENOENT ... migrations/global`.
- Conversations no longer need `HASH_PEPPER`. Set `CONVERSATION_CURSOR_KEY` to enable them without touching credential hashing.
- The managed work queue ships disabled. Nothing is dispatched until a maintainer enables a project and sets a positive execution limit.

### Managed work queue (#303)

- Repository-owned pipelines can enroll tasks in a shared project queue and admit work atomically: one SQLite transaction checks policy, lifecycle eligibility, targeting, capabilities and separate execution/WIP capacity, then creates the claim, the execution attempt and a durable grant receipt.
- Attempts support confirmed suspension and same-attempt resume, durable cancellation, reconciliation of uncertain execution, ownership rebinding, force recovery with a recorded reason, and opt-in bounded retry. An expired accepted execution stays uncertain and keeps its capacity; it never authorizes a duplicate.
- The queue is available through HTTP, `tila-sdk` (`queue`, `attempts`), `tila queue` / `tila attempt` CLI commands, two MCP tools and local embedded mode. `QueueExecutor` runs queued work through a repository adapter; a foreground-process example for macOS and Linux shows restart recovery.
- Backups include queue state (`managed-queue-v1`). Restore pauses dispatch, raises fences above both source and destination, requires reconciliation of saved executions, and refuses a destination that still has unfinished executions or retained WIP.
- Roll back by pausing admission. Do not downgrade to code that ignores managed-task guards, and do not delete queue state.

### Configuration revisions and lifecycle readiness

- Schema/configuration writes can carry the revision the editor reviewed. Stale writes fail with 412, destructive writes without the reviewed definition fail with 428, and exact retries replay their receipt. History and preview work in remote and embedded SDKs, the CLI and MCP.
- Work definitions can declare their lifecycle field, dispatchable, terminal and successful states. Readiness uses them and reports dependency, gate and cycle reasons; unconfigured types keep the old rules. The checked-in task definition now separates `done` from `cancelled`.

### Catalogs, paging and search (#300)

- `GET /tasks/~/types` lists every work type the caller can read, including declared types with no rows and undeclared types that still have rows, with counts and the type definition. `GET /records/_types` adds the same catalog as `entries`, plus `scope`.
- Schemas can declare optional display-only `presentation` slots (`title`, `summary`, `description` for work; `title`, `summary`, `kind` for records).
- `GET /tasks` adds a keyset cursor with a stable `id` tie-break; `GET /records/:type` and record history add cursors, `sort`, `order` and `key_contains`. A cursor reused with different filters returns `400 invalid-cursor`. `tila record list --cursor` continues a listing, and `tila record export` follows cursors instead of stopping at 200.
- `GET /search` adds `kind`, `type`, `cursor`, `syntax=literal` and a `scope` that names the kinds searched and left out. Namespace-restricted credentials may now search.

### Dashboard

- Tasks page: server-side type filters, search and 100-row cursor paging with deep-linkable pages; titles and states come from the schema, never "Untitled". Task detail shows work content first, then fields, relationships, artifacts, the latest 20 history events and claim state, and each section fails on its own.
- Records page uses the record catalog, pages through every record and marks types that are no longer declared.
- New Queue view: filters, enrollment edits, withdrawal, pause/resume, capacity settings, and attempt details with cancel, suspend, resume, retry, reconcile, rebind and force recovery. The dashboard never launches or kills remote processes.
- New Runtime tab (#301) shows which run, host, native session and account hold each agent mailbox, keeps the replaced occupant visible, and offers a staged Release command.
- Message deliveries (#302): each room message shows delivery counts, and a Deliveries page and trace drawer show stored, wake, fetched, acknowledged and work result separately. Signals show payload, resource links, expiry countdown and recipient state, and page past 100.
- Rooms show "Conversations are not configured" instead of a raw error when no cursor key is set.

### Zod 4

- `tila-sdk`, `tila-mcp-server`, the CLI and the Worker now use zod 4 (`^4.6.6`). The schemas exported by `tila-sdk` (`CredentialPolicySchema`, `CapabilitySchema`, `NamespaceRestrictionsSchema`) are zod 4 schemas, and `RequestOptions.schema` takes a zod 4 `ZodType`. Code that combines them with its own zod schemas needs zod 4.
- Validation messages use zod 4 wording, for example `Invalid input: expected string, received undefined` instead of `Required`. Error codes and response envelopes are unchanged.
- UUID fields now require RFC 9562 version and variant bits. IDs generated by tila already meet this.
- MCP tool schemas are generated by zod 4: discriminated-union inputs are advertised as `oneOf`, numeric and string bounds are explicit, and repeated definitions are inlined instead of referenced with `$ref`.

### Release identity (#307)

- `GET /api/health` now reports the product release `version` and full source `commit` of the deployed build, generated at build time from the root release marker. It previously always reported `0.1.0`. `apiVersion` and `minCliVersion` remain the separate protocol compatibility fields; `commit` is optional in `HealthResponseSchema` so older Workers still validate.

### Fixes

- Release binaries now include their deploy payload (Worker, UI, D1 migrations), verified against an embedded manifest and staged under `~/.tila/cache/deploy-payload/`. `tila deploy --dry-run` checks it without contacting Cloudflare.
- Every release binary now contains its own `@napi-rs/keyring` native addon. In 0.5.0, `tila auth setup` failed with "Cannot find native binding" on all targets except linux-x64 glibc.
- Artifact uploads that name a task by its claim resource (`task:<id>`) no longer fail with a retryable 502; unknown resources are rejected before any blob is written.
- The Worker allows `X-Tila-Conversation-Protocol` in CORS preflight, so Rooms work when the UI runs on another origin (local development).
- `scripts/dev-seed.sh` works again on a fresh local stack.

### Bootstrap token hashing (#307)

- `tila project create` now hashes the first project token with `TILA_HASH_PEPPER` (environment or `~/.tila/.env`) when it is set, matching a Worker that uses `HASH_PEPPER`. Previously it always wrote a plain SHA-256 digest, so on a peppered Worker the new token never authenticated.

### Conversation cursor key (#307)

- Conversation routes no longer require `HASH_PEPPER`. Set the new `CONVERSATION_CURSOR_KEY` Worker secret (at least 32 random characters) to enable them without touching credential hashing; tokens and sessions keep working. When it is unset, cursors are still derived from `HASH_PEPPER` exactly as before, so peppered deployments keep their outstanding cursors. With neither secret, routes still fail closed with `config-unavailable`; callers that can manage conversations now also get `details.reason`.

## [0.5.0] - 2026-10-12

### Upgrade notes

- Apply additive D1 migration `0032_human_accounts.sql` and deploy the Worker before upgrading clients. Existing project memberships are preserved. Configure `AUTH_SECRET` (at least 32 random characters), or retain `INFRA_ADMIN_TOKEN` for the purpose-separated fallback; deployments require `nodejs_compat` and enough CPU budget for password hashing.
- Bootstrap the first administrator with `tila auth setup`, then invite users from Account. Human accounts use email/password independently of GitHub. GitHub browser login requires explicit `GITHUB_LOGIN_ENABLED=true` and configured OAuth credentials; existing GitHub CLI exchanges remain supported.
- `POST /auth/session` now returns 410: API tokens can no longer mint browser sessions. Use `tila login` for remembered CLI access and `tila open` for an explicitly confirmed, single-use browser handoff. CLI logins use the OS credential store and are not inherited by managed runtimes or CI.

### Human accounts and remembered CLI login

- Add invitation-only human accounts, instance administrator controls, recovery links, project-scoped personal API tokens, device approval, and remembered CLI login with `tila login` / `tila logout`.
- Require recent authentication for sensitive account changes. Device revocation invalidates transferred browser sessions; password recovery invalidates account sessions. GitHub accounts require explicit linking and cannot self-register or merge implicitly by email.
- Optional invitation email delivery uses `RESEND_API_KEY` and `EMAIL_FROM`; invitation and recovery links remain usable without email delivery.

### Agent status

- Correct agent lease timestamps and distinguish current presence, expired leases, and unavailable observations in the dashboard.

### Dashboard resilience (#295)

- Task detail, settings, record history, artifact search and record types no longer present a pending, failed or forbidden request as "none": claims, artifacts, relationships, repositories, membership changes, history and search results each show loading, access denied, unavailable (with retry), or the last good data with its last-success time and the refresh failure. A failed section no longer erases other sections or typed input, and the membership policy select no longer reads "explicit" before the policy is known.
- `GET /records/_types` now reports `incomplete` (`declared_types`: `unavailable` or `invalid`; `in_use_types`: `unavailable`) when the schema or the in-use listing could not be read, instead of returning an empty list. The field is additive and omitted when nothing failed; it is never sent to credentials with namespace restrictions. A project with no schema is still a complete, empty answer.

## [0.4.0] - 2026-10-10

### Release notes

- Upgrade the backend before clients: apply additive D1 migrations through 0031 and deploy the compatible Worker. MCP now requires a managed shared-project run; direct credentials and local SQLite MCP mode are removed.
- Durable conversations and the dashboard are included. Herdr registration/opening, busy native draft guarantees and unattended restoration remain unsupported pending #283 acceptance gates.
- Validate packed MCP initialization and tool discovery through an isolated authenticated run broker, including denial after run access ends.

### Native transport verification

- Fix Codex daemon observation and wake transport to use a WebSocket handshake over the native proxy pipes. Preserve account/profile checks and request allowlists; no daemon lifecycle or configuration changes are required.
- Verify the compiled Linux account probe against an existing daemon, plus isolated Linux Herdr restart and socket identity checks. Cross-host delivery and authenticated native restoration remain open.

### Profile verification

- Verify plain Codex CLI credentials through a read-only stdio account probe without requiring a background daemon; reject a mismatched reported profile home before reading the account. Live session observation continues to use the existing daemon.

### Conversation dashboard (#283, slice 5)

- Add project rooms, thread panels, agent status and deep-linkable delivery inspection.
- Preserve reply operation IDs across network retries and fresh sign-in, including newer edits after late responses.
- Add compatible backward conversation history with an independent forward tail cursor.
- Keep live Mac/Linux acceptance and Herdr activation explicitly open under #283.

### Herdr evaluation (#283, slice 4)

- Add pinned read-only Herdr observations that reject stale server/pane/process identity and treat events only as invalidation.
- Add plugin status/startup reconciliation through the authenticated host connector. Register/open fail with `unsupported-capability` until the required native gates pass; no terminal fallback is enabled.
- Record redacted, versioned isolated-runtime evidence and the outstanding live Linux, profile, draft and restoration prerequisites. This does not complete #283 or establish supported Herdr combinations.

### Native host connector (#283, slice 3)

- Add an authenticated host connector with private JSON recovery state, bounded relay registrations, verified native session/profile discovery, and body-free Claude/Codex notices.
- Preserve managed acting-run identity through native hooks; redact and purge Claude messaging credentials. Record launch intent before explicit attended restoration and reconcile uncertain wakes using server attempt metadata.
- Deploy additive dispatch status metadata before connector clients; no new migration is required. Codex idle start is opt-in, ordinary busy wakes remain pending without a supported queue, and unattended restoration/Herdr/live cross-host acceptance remain separate gates.

### Durable conversations (#283, slice 2)

- Add rooms, memberships, threads, author-idempotent publication, offline recipient snapshots, inbox fetch/ack/watch, metadata-only dispatch reconciliation and bounded wake retries.
- Add SDK conversation/inbox/dispatch methods, CLI room/inbox commands and opt-in MCP conversation tools with typed errors and recovery guidance. Peer content never conveys human approval.
- Shared DO/embedded migration 31 adds conversation storage; backups include the new tables and restore invalidates bindings, leases and cursors. Configure `HASH_PEPPER` before enabling conversation routes. No additional D1 migration beyond slice 1 is required; deploy the server before clients.

### Agent identity foundation (#283, slice 1)

- Add optional immutable agent/role pins to authenticated runs, conditional DO consumer bindings, redacted inspection, and revocation/restore invalidation.
- Add SDK/CLI agent operations, local credential profiles, profile-qualified lifecycle keys, and `run exec --agent --profile` with an environment allowlist and account checks.
- Apply additive global D1 migration 0031 before the Worker; shared DO/embedded migration 30 follows automatically. Existing unpinned runs and default worker authority remain compatible. Local agent operations return `unsupported-capability`. Durable conversations follow in slice 2; host connectors remain a subsequent slice.

### 0.4.0 breaking cutover

- **Strict project MCP:** MCP requires a managed run backed by the shared server. Direct personal/owner credentials, ambient keychain lookup, and private SQLite MCP mode are removed without fallback. Operator CLI authentication and CLI/SDK local functionality remain available.
- **Unattended runs:** Personal/shared installation enrollment, single-use invitations, runtime OIDC exchange, protected installation storage, `tila machine` management, and `tila run exec` provide separate participants and automatically renewed proof-bound credentials. Current membership, sponsor/workload restrictions, lease, and policy are checked before access and replay.
- **Upgrade backend first:** Apply additive D1 migration 0030, deploy the compatible Worker, then upgrade public artifacts together to 0.4.0. Enroll installations, regenerate client configuration, and restart sessions. Preserve project data and ownership; retain additive schema during explicit rollback. Authentication review and isolated deployment/client validation remain required before production cutover.

## [0.3.0] - 2026-10-08

### Upgrade notes

- **Upgrade clients and the Worker together.** Mutations now require a stable `X-Tila-Participant-Id`; older clients without it receive `400 participant-required`. Credentials identify the principal, while participant IDs distinguish concurrent sessions.
- **Plan a low-activity migration window.** SQLite migration 23 clears legacy active claims and presence while preserving fence counters and historical journal entries. Reacquire claims after upgrading. The corresponding D1 migration clears browser sessions without immutable principals, requiring users to sign in again. Migration 25 discards pending legacy signals, whose display-name targets cannot be authorized safely. See [deployment guidance](docs/05-OPERATIONS.md#v23-canonical-identity-migration-deploy-guidance).
- **MCP defaults to six workflow tools.** Set `TILA_MCP_TOOLS=all` to retain the primitive tool catalog, or select existing named groups. Update integrations that assume every primitive tool is advertised by default.
- **Signals use canonical recipients and participant deliveries.** Update integrations that address or acknowledge signals by display name to use principal and participant identities.
- **HTTP error codes use kebab-case.** Update comparisons such as `UNAUTHORIZED` → `unauthorized`, `RATE_LIMITED` → `rate-limited`, `VALIDATION_ERROR` → `validation-error`, `PROJECT_NOT_FOUND` → `not-found`, and `INTERNAL_ERROR` → `internal`. SDK error constants and types now match the wire values; HTTP status codes and `error.retryable` remain unchanged.

### Fixed

- **Auth:** Privilege-escalation-by-transport gap closed. A GitHub *write* user's browser cookie no longer satisfies `requirePermission("admin")`; the cookie session now carries a normalized permission tier (`read`/`write`/`admin`) derived from the user's actual GitHub role, and the admin gate maps it through the same `PERMISSION_LEVELS` table that the bearer path uses.
- **Authorization:** Fail closed when protected GitHub permissions cannot be verified; enforce bounded repository roles, workload admission, OIDC policies, sender-constrained sessions, and project capability checks.
- **Persistence:** Harden daily sweep, archive safety, artifact deletion and stale-fence rejection; deduplicate fence-mutating writes within DO transactions and prune expired idempotency records.
- **CLI and SDK:** Apply trigger-safe D1 migrations before deployment, use the correct claim-state route, preserve authored session handoffs through shutdown, and verify artifact downloads and revision drawer navigation.
- **Dependencies:** Update vulnerable dependencies and validate packed SDK/MCP native addons with SQLite 12 and 13 across supported platforms.

### Added

- **API:** `GET /auth/session/status` now returns two additional fields: `permission` (effective permission tier: `read`, `write`, `admin`, or `none`) and `canManageTokens` (boolean, true only when the effective permission is `admin`). The change is additive and backward-compatible; existing consumers that only read `ok` and `projectId` are unaffected.
- **Access management:** Canonical project memberships, admin roster management, scoped service accounts and capability credentials, workload token exchange, principal revocation, and dashboard membership/credential controls.
- **Artifacts and recovery:** Opt-in artifact revision storage, history and restore APIs, navigable dashboard history, provenance and explicit review state, and complete project export/restore.
- **Session continuity:** Durable journal cursors, immutable handoffs, native coding-session lifecycle integration, and grouped MCP workflows.
- **CLI, SDK and diagnostics:** Installation-aware `tila update`, automation output/exit-code contracts, multi-instance credential resolution, refreshable SDK token providers, reproducible coordination benchmarks, and deployed request timing attribution.

### Changed

- **Release validation:** Validate the exact main-reachable tag commit, test packed consumers and all eight binaries on native runners, verify provenance/SBOM attestations, and publish the tested payload without rebuilding. Manual Release dispatch remains a non-publishing rehearsal; Homebrew publication remains opt-in.
- **CI:** Require local Cloudflare runtime coverage, retain verification diagnostics, and use dependency-aware Mergify queue validation.

## [0.2.7] - 2026-06-19

### Changed

- Bump dependency versions (dompurify, lucide-react, tsx, @clack/prompts). No user-facing changes.
- Attach install scripts to releases and refresh Homebrew formula.

## [0.2.6] - 2026-06-17

### Fixed

- **CLI:** Fence rejections from all commands now render as clean one-line errors instead of raw stack traces.

## [0.2.5] - 2026-06-16

### Fixed

- Stale-fence error cleanup; local artifact dedup and full-text search fixes.
- Worker token hashing with keyed HMAC when `HASH_PEPPER` is set.
- Session JWT `iss`/`aud` enforcement; array-form OIDC `aud` accepted.
- Idempotency middleware now fails closed and uses caller-scoped keys.
- Reconcile skips live-fence gate; expired-claim release path fixed.
- MCP advertises canonical claim modes; artifact-edit and claim-list corrected.
- `default_for_legacy` honored in entity schema diff; journal write-path fixed.
- HTTP-written records attributed to caller; artifact resource reference validated.
- Zombie write rejection: destructive ops require a live claim on the entity.
- Signal `ack` now authorized against the addressee.

### Added

- DO migration atomicity model documented.

## [0.2.4] - 2026-06-13

### Fixed

- SDK: declare `drizzle-orm` as a runtime dependency so it resolves in consumer projects.

## [0.2.3] - 2026-06-12

### Fixed

- MCP server: bundle `better-sqlite3` via `optionalDependencies` for local mode so `npm install` pulls the native driver automatically.

## [0.2.2] - 2026-06-11

No user-facing changes. Refresh pnpm lockfile for 0.2.1.

## [0.2.1] - 2026-06-11

### Added

- MCP server: fenceless `tila_record_put` upsert tool for single-writer record patterns.
- MCP server: backend selectable via `TILA_BACKEND` env var.
- Dashboard: hero screenshot in README.

### Fixed

- Coordination audit findings across claims and migration safety.
- MCP context-audit tool surface issues.
- UI: task-detail claim state for canonical resource format.
- Documentation drift after v0.2.0 release.

## [0.2.0] - 2026-06-11

### Added

- **Full local persistence under plain Node.** A runtime-agnostic `@tila/backend-embedded` core (`EmbeddedProject` + `BlobStore` seam + shared `EMBEDDED_MIGRATIONS`) now backs local mode for the CLI (Bun via `bun:sqlite`) **and** the TypeScript SDK + MCP server (plain Node via `better-sqlite3`). See `docs/02-ARCHITECTURE.md` §1.6a.
- **`createTila` SDK facade** — one uniform resource-method surface over both the local (in-process SQLite) and cloudflare (HTTP) backends; swap `config.backend` without changing call sites. `tila-sdk/local` exposes `createTilaLocal` for direct local use. `better-sqlite3` is an optional peer dependency (range `>=11 <13`; CI-tested on 12.x).
- **MCP server local mode** (`backend = "local"`) — runs under plain Node, configured via `TILA_DB_PATH` / `TILA_ARTIFACTS_PATH` / `TILA_ORG` (precedence: config value > env > default; `org` defaults to the OS username).

### Changed

- **Records now work in local mode** across the CLI, SDK, and MCP — previously remote-only.
- **Local-mode artifact `put` now honors `kind` / `resource` / `fence`.** The old `LocalArtifactBackend` silently dropped them.
- **`record types` is consistently in-use-only** across local and remote (`listRecordTypesInUse`). The CLI `record types` (no flag) composes the merged declared∪in-use view; `--in-use` shows in-use only.

### Fixed

- **`entityOps.list` `dataFilter` `json_extract` comparison** (production DO bug): server-side `?status=` / `?parent=` entity filtering in the Durable Object returned an empty list because JSON scalar values were not normalized to what `json_extract` returns. Now correct and covered by tests.

## [0.1.2] - 2026-06-05

### Fixed

- CLI: embed version via generated module so the compiled binary works without `package.json` at runtime.
- SDK: embed version via generated module so it survives bundling into the compiled CLI binary.
- Build: publish launcher only (`bin/`) and build full workspace in release npm-publish job.
- CI: build full workspace before compiling CLI so the worker sidecar resolves UI assets.
- Build: enable `link-workspace-packages` so the lockfile resolves CLI platform binaries.

## [0.1.0] - 2026-06-04

First public release.

### Added

- Content-addressed artifact storage (R2, sha256-keyed, deduplicated) with FTS5 full-text search and server-side grep
- Typed, schema-validated records with revision history and fencing tokens
- Coordination primitives: claims, gates, signals, presence, and an append-only journal
- First-writer-wins concurrency with monotonic fencing tokens (stale writes rejected)
- Cloudflare deployment path (Worker + Durable Object SQLite + D1 + R2) and local mode (`tila project create --local`, bun:sqlite)
- `tila` CLI distributed as self-contained native binaries for macOS, Linux (glibc + musl), and Windows
- TypeScript SDK (`tila-sdk`) and MCP server (`tila-mcp-server`) for Claude Code, Cursor, and VS Code
- Read-only dashboard SPA served by the Worker
- GitHub-scoped authentication (default) and D1 API tokens (admin)

[Unreleased]: https://github.com/davebream/tila/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/davebream/tila/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/davebream/tila/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/davebream/tila/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/davebream/tila/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/davebream/tila/compare/v0.2.7...v0.3.0
[0.2.7]: https://github.com/davebream/tila/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/davebream/tila/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/davebream/tila/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/davebream/tila/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/davebream/tila/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/davebream/tila/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/davebream/tila/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/davebream/tila/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/davebream/tila/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/davebream/tila/releases/tag/v0.1.0
