# AGENTS.md

Guidance for Codex and other coding agents working in this repository.

## Project

tila is a state-and-coordination engine for multi-machine agentic work. It is Cloudflare-native, built around a Worker, Durable Object SQLite, D1, and R2.

## Commands

```bash
pnpm dev              # Start development (Worker via wrangler dev)
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
cli (standalone, imports schemas only)
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
- Do not modify `.github/workflows/`; CI configuration is managed by the scaffold tool.

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
- `docs/03-ROADMAP.md` - v0.1 scope, success criteria, build order
- `docs/04-PERSISTENCE-SCHEMA.md` - ER diagram and cross-store boundaries
- `docs/05-OPERATIONS.md` - production procedures, observability, troubleshooting

## Contributor Dev MCP Server

When you open this repo in Claude Code, Cursor, or VS Code, the `tila-dev` MCP server is
auto-configured to point at `http://localhost:8787`. Start it with:

```bash
pnpm install   # ensures tsx is available for npx resolution
pnpm dev       # starts the Worker locally via wrangler dev
```

Set `TILA_PROJECT_ID` in `.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json` to your
project ID before using MCP tools.
