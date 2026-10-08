# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/davebream/tila/compare/v0.3.0...HEAD
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
