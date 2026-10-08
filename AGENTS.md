# AGENTS.md

Guidance for Codex and other coding agents working in this repository.

## Project

tila is evolving into one self-hosted development-management product, with a reusable state-and-coordination core. Cloudflare (Worker, DO SQLite, D1, R2) is the authoritative shared backend. The first workflow is one orchestrator coordinating workers across macOS and Linux hosts; native Mac/iPhone clients and other interaction topologies come later.

This is the target direction, not a claim that orchestration, native clients, key-only auth, or local-mode retirement have shipped. Preserve current compatibility until the corresponding migration is implemented. Keep the canonical project memberships delivered by #184 / #218. Evaluate existing host runtimes before building a terminal/process supervisor; Herdr is the first candidate, not an adopted dependency. See `docs/03-ROADMAP.md` for acceptance criteria and backlog drafts.

## Commands

```bash
pnpm dev              # Source development: Worker :8787 + Vite UI :5173
pnpm dev:cli --help   # Run the CLI from this checkout
pnpm dev:mcp          # Run the MCP server from this checkout
pnpm build            # Production build (turbo, all packages)
pnpm test             # Run all tests (turbo)
pnpm lint             # Biome check (read-only, CI-safe)
pnpm run check        # Biome check --write (auto-fixes formatting + imports)
pnpm run typecheck    # TypeScript type checking (turbo)
pnpm version:check    # Verify public release version lockstep
pnpm version:test     # Test version policy scripts
```

Target one package with workspace filters:

```bash
pnpm --filter @tila/backend-do test
pnpm --filter @tila/backend-do test -- --run artifact-ops
pnpm --filter @tila/worker typecheck
```

Tests use Vitest except `backend-local` which uses `bun test`. Each package has its own `vitest.config.ts`. `backend-do` tests live in `test/`, not `src/`. Integration tests use `@cloudflare/vitest-pool-workers`.

Lefthook runs Biome auto-fix, gitleaks secret detection, and targeted version lockstep checks on staged files.

## Release Versioning

tila uses one product version for public release artifacts. Bump the root `package.json` marker, `tila-cli`, all `tila-cli-*` platform packages, `tila-sdk`, `tila-mcp-server`, and `packages/mcp-server/server.json` together with:

```bash
./scripts/bump-version.sh <version>
pnpm version:check
```

Private workspace packages such as `@tila/core`, `@tila/schemas`, backend packages, worker, and UI are implementation modules. They do not need product-version bumps.

## Architecture

This is a Turborepo monorepo with packages under `packages/`:

| Package | Role |
|---|---|
| `@tila/schemas` | Zod schemas, single source of truth for all types |
| `@tila/core` | Backend interfaces, fence logic, schema-as-config parser |
| `@tila/ops-sqlite` | Shared SQLite ops modules, Drizzle schema, and migrations. Used by both `backend-do` and `backend-embedded` |
| `@tila/backend-embedded` | Runtime-agnostic embedded SQLite core — `EmbeddedProject` facade, `BlobStore` seam, shared `EMBEDDED_MIGRATIONS`; consumed by `backend-local` (Bun) and `tila-sdk/local` (Node) |
| `@tila/backend-d1` | D1 global store for tokens, idempotency, project registry, sessions |
| `@tila/backend-do` | Durable Object wrapper — runs migrations, delegates to `ops-sqlite` |
| `@tila/backend-local` | Local SQLite backend for CLI offline mode (`bun:sqlite`). Delegates to `@tila/backend-embedded`; shares ops via `ops-sqlite` |
| `@tila/backend-r2` | R2 artifact storage |
| `@tila/worker` | Cloudflare Worker with Hono routing and Smart Placement |
| `tila-sdk` | TypeScript SDK for tila consumers |
| `tila-mcp-server` | MCP server exposing tila API as tools/resources/prompts for AI agents |
| `@tila/ui` | Read-only SPA served by the Worker |
| `tila-cli` | `tila` CLI binary using Citty, Bun-compiled for multi-platform distribution |
| `@tila/integration-tests` | E2E tests via Cloudflare Vitest pool |

Package dependency flow:

```text
schemas -> core -> ops-sqlite -> backend-do        -> worker
                              -> backend-embedded -> backend-local   (Bun, bun:sqlite)
                                                  -> tila-sdk/local  (Node, better-sqlite3)
          core -> backend-d1                      -> worker
          core -> backend-r2                      -> worker
schemas -> sdk -> mcp-server
                                       worker <- ui
cli -> schemas, core, auth-store, backend-local, sdk
```

`schemas` and `core` must remain platform-agnostic. `ops-sqlite` is the shared SQLite layer containing all Drizzle table definitions, migrations, and ops modules. Do not import Cloudflare Workers types into `schemas`, `core`, `ops-sqlite`, `cli`, or `sdk`.

Request flow:

```text
HTTP -> Worker (Hono) -> auth middleware -> project middleware -> route handler
  -> DO fetch() -> project-do-router.ts (Hono sub-router) -> ops-sqlite modules -> Drizzle -> DO SQLite
```

`ProjectDO` in `packages/backend-do/src/project-do.ts` is thin: it constructs Drizzle, runs migrations in `blockConcurrencyWhile`, and delegates all domain logic to the router built from ops-sqlite modules.

## Working Rules

- Keep shared code in `packages/`; import across packages instead of copy-pasting.
- Use pnpm workspace filters for targeted builds and tests.
- Use Zod schemas from `@tila/schemas` as the source of truth for API and data shapes.
- Use Drizzle for database operations. Raw SQL belongs in migrations.
- Keep entity and claim writes in single DO SQLite transactions when correctness depends on both.
- Content-address artifacts by SHA-256. Key format is `<prefix>/<id>/<sha256>.<ext>`.
- Validate fencing tokens on every destructive operation downstream of a claim.
- Add new ops modules to `@tila/ops-sqlite`, not to `backend-do` directly.
- Do not create circular dependencies between workspace packages.
- Do not store business logic in Worker route handlers; move it into backend packages.
- Maintain `.github/workflows/` directly. Preserve the required `ci` gate and validate workflow changes.

## Git Workflow

- Use Conventional Commits for every commit: `<type>(<scope>): <description>`.
- Allowed types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `style`, `chore`, and `revert`.
- Keep each commit to one type. If a change mixes docs, tests, fixes, or features, split it into separate commits.
- Use lowercase imperative descriptions without a trailing period, for example `fix(worker): validate project tokens`.
- PR titles must use the same Conventional Commit format because squash merges use the PR title.
- PR descriptions must include a concise summary, tests run, and any migration, schema, API, or deployment impact.
- If tests are not run, state that explicitly in the PR description with the reason.

## Correctness Model

tila uses first-writer-wins coordination with fencing tokens. Every claim returns a monotonic fence. Every destructive write carries the fence, and the DO rejects stale fences. See `docs/01-DECISIONS.md` section 2 for the full model.

## Persistence

tila uses three persistence layers:

1. DO SQLite per project: entities, relationships, journal, claims, fences, presence, schema history, FTS5 search.
2. D1 global: API tokens, idempotency keys, project metadata, sessions.
3. R2: content-addressed artifact blobs with Worker-driven lifecycle cleanup.

## Key Docs

- `docs/01-DECISIONS.md` - settled decisions
- `docs/02-ARCHITECTURE.md` - technical specification
- `docs/03-ROADMAP.md` - current milestone, runtime evaluation, and backlog drafts
- `docs/04-PERSISTENCE-SCHEMA.md` - ER diagram and cross-store boundaries
- `docs/05-OPERATIONS.md` - production procedures, observability, troubleshooting

## Contributor Dev MCP Server

Copy the applicable `.mcp.json.example`, `.cursor/mcp.json.example`, or
`.vscode/mcp.json.example` to the same filename without `.example`. These templates
run `pnpm --silent dev:mcp` from the workspace root, using this checkout's source.
They target the local Cloudflare Worker with the credentials from `pnpm dev:setup`.

```bash
pnpm install
pnpm dev:setup # Local fixture setup; clears existing local D1/DO state
pnpm dev
```

The root `tsconfig.json` maps workspace imports to source for Wrangler, Bun and tsx.
Package builds and typechecks retain their own configs and public exports.
`pnpm test` still builds packages: it includes distribution/interop coverage.
Do not remove those checks merely to speed up interactive development.

## graphify

A local knowledge graph of the code lives in `graphify-out/` (gitignored). It maps files, symbols, imports and calls across all packages. Query it to orient before reading files, when planning a change, and when investigating a bug. One query usually replaces a round of searching and file reads.

If `graphify-out/graph.json` is missing (fresh clone, new worktree), build it with `graphify update .`. That parses code locally with no API key and finishes in under a minute. If the `graphify` CLI is not installed (`uv tool install graphifyy`), skip this section and work from source.

| Task | Command |
|---|---|
| Investigate a symbol: where it lives, what touches it | `graphify explain "<symbol>"` |
| Gather context for a feature or bug | `graphify query "<names from the code>"` |
| Plan a change: what depends on X | `graphify affected "<symbol>" --depth 2` |
| Trace how two parts connect | `graphify path "<A>" "<B>" --undirected` |
| Find the hubs before a refactor | `graphify god-nodes` |
| Survey the whole codebase | `graphify-out/GRAPH_REPORT.md` |

Rules:

- Query with names from the code (`assertFence`, `EmbeddedProject`, `record-ops`), not prose. Matching is by keyword: "how are fencing tokens validated" lands on the API-token routes, not the fence logic.
- Treat results as pointers. Each node carries a file and line. Read the source there before you rely on it or edit it.
- The graph is code-only (see `.graphifyignore`). For rationale, read `docs/01-DECISIONS.md` and `docs/02-ARCHITECTURE.md`.
- Imports made by workspace package name (`@tila/core`) are not resolved to the imported symbol, so `affected` misses consumers in other packages. Confirm cross-package impact by searching for the symbol name.
- Functions that share a name within one file, such as the `run` handlers in CLI commands, collapse into one node.
- After changing code, run `graphify update .` so later queries see the change. Checkouts where `graphify hook install` was run rebuild after each commit, except in linked worktrees.
- Give these rules to any subagent that explores code.
