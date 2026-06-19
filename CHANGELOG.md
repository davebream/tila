# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING — HTTP error codes are now uniformly kebab-case.** Worker auth/admin-plane error responses previously emitted SCREAMING_SNAKE `error.code` values (e.g. `UNAUTHORIZED`, `RATE_LIMITED`, `VALIDATION_ERROR`, `PROJECT_NOT_FOUND`) while the resource plane used kebab-case. All codes are now kebab-case (`^[a-z][a-z0-9-]*$`), and four cross-plane duplicates are collapsed onto the existing kebab spelling: `VALIDATION_ERROR`→`validation-error`, `NOT_FOUND` and `PROJECT_NOT_FOUND`→`not-found`, `INTERNAL_ERROR`→`internal`. OIDC verification codes (`OIDC_*`) are likewise kebab-cased. Consumers branching on `error.code` must migrate to the kebab values (SDK typed error-code union tracked in #75). `error.retryable` and HTTP status codes are unchanged.

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
- Cloudflare deployment path (Worker + Durable Object SQLite + D1 + R2) and local mode (`tila init --local`, bun:sqlite)
- `tila` CLI distributed as self-contained native binaries for macOS, Linux (glibc + musl), and Windows
- TypeScript SDK (`tila-sdk`) and MCP server (`tila-mcp-server`) for Claude Code, Cursor, and VS Code
- Read-only dashboard SPA served by the Worker
- GitHub-scoped authentication (default) and D1 API tokens (admin)

[Unreleased]: https://github.com/davebream/tila/compare/v0.2.7...HEAD
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
