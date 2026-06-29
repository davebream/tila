# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

tila — a state-and-coordination engine for multi-machine agentic work. Cloudflare-native (Worker + DO SQLite + D1 + R2).

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

### Single-package commands

```bash
pnpm --filter @tila/backend-do test          # Test one package
pnpm --filter @tila/backend-do test -- --run artifact-ops  # Single test file (substring match)
pnpm --filter @tila/worker typecheck         # Typecheck one package
```

Tests use Vitest except `backend-local` which uses `bun test`. Each package has its own `vitest.config.ts`. The `backend-do` tests are in `test/` (not `src/`). Integration tests use `@cloudflare/vitest-pool-workers`.

### Local development setup

One-time setup (generates dev config, applies D1 migrations, seeds test data):

```bash
pnpm dev:setup
```

Then start both services:

```bash
pnpm dev                          # Worker on :8787
pnpm --filter @tila/ui dev        # UI on :5173
```

Login with the printed credentials (default: project `dev-project`, token `tila_dev_token_localonly`).

`dev:setup` generates `wrangler.dev.toml` (with a non-empty `database_id` for local D1) and `.dev.vars` (with CORS for localhost). Both are gitignored. Re-run `dev:setup` after pulling changes to `wrangler.toml` or D1 migrations. It is idempotent: re-running clears local D1 and DO state, then reapplies from scratch.

To populate the dashboard with realistic sample data (tasks, records, relationships, claims, presence, artifacts):

```bash
bash scripts/dev-seed.sh
```

Requires the Worker to be running on `:8787`. Creates 11 tasks (1 epic, 2 milestones, 8 tasks) in a 3-level hierarchy, 3 records (deploy config + db schemas), 16 relationships (10 parent-child, 6 blocking), 2 active claims, 3 machine heartbeats, and 5 artifacts.

### Remote development (production data)

Start wrangler in remote mode:

```bash
pnpm --filter @tila/worker exec wrangler dev --remote
```

> **DO migration risk:** `blockConcurrencyWhile` in `project-do.ts` runs any pending
> migrations against **production** DO SQLite on the first request. Never iterate on
> schema migrations while running `--remote` — a bad migration will corrupt production data.

### Pre-commit hooks

Lefthook runs Biome auto-fix, gitleaks secret detection, and targeted version lockstep checks on staged files.

### Release versioning

tila uses one product version for public release artifacts. Bump the root `package.json` marker, `tila-cli`, all `tila-cli-*` platform packages, `tila-sdk`, `tila-mcp-server`, and `packages/mcp-server/server.json` together:

```bash
./scripts/bump-version.sh <version>
pnpm version:check
```

Private workspace packages such as `@tila/core`, `@tila/schemas`, backend packages, worker, and UI are implementation modules. They do not need product-version bumps.

### Git workflow

- Use Conventional Commits for every commit: `<type>(<scope>): <description>`.
- Allowed types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `style`, `chore`, and `revert`.
- Keep each commit to one type. Split mixed docs, tests, fixes, and features.
- Use lowercase imperative descriptions without a trailing period, for example `fix(worker): validate project tokens`.
- PR titles must use the same Conventional Commit format because squash merges use the PR title.
- PR descriptions must include a concise summary, tests run, and any migration, schema, API, or deployment impact.
- If tests are not run, state that explicitly in the PR description with the reason.

## Architecture

Turborepo monorepo under `packages/`:

| Package | Role |
|---|---|
| `@tila/schemas` | Zod schemas — single source of truth for all types |
| `@tila/core` | Backend interfaces, fence logic, schema-as-config parser |
| `@tila/ops-sqlite` | Shared SQLite ops modules (entity-ops, artifact-ops, etc.), Drizzle schema, migrations. Used by both `backend-do` and `backend-local` |
| `@tila/backend-embedded` | Runtime-agnostic embedded SQLite core — `EmbeddedProject` facade, `BlobStore` seam, shared `EMBEDDED_MIGRATIONS`; consumed by `backend-local` (Bun) and `tila-sdk/local` (Node) |
| `@tila/backend-d1` | D1 global store (tokens, idempotency, project registry, sessions) |
| `@tila/backend-do` | Durable Object wrapper — constructs `ProjectDO`, runs migrations via `blockConcurrencyWhile`, delegates to `ops-sqlite` |
| `@tila/backend-local` | Local SQLite backend for CLI offline mode (`bun:sqlite`). Delegates to `@tila/backend-embedded`; shares ops via `ops-sqlite` |
| `@tila/backend-r2` | R2 artifact storage (content-addressed, sha256-keyed) |
| `@tila/worker` | Cloudflare Worker with Hono routing, Smart Placement |
| `tila-sdk` | TypeScript SDK for tila consumers (client, resource methods, retry, error codes) |
| `tila-mcp-server` | MCP server exposing tila API as tools/resources/prompts for AI agents |
| `@tila/ui` | Read-only SPA served by Worker |
| `@tila/auth-store` | Client-side auth persistence — instance registry, credential store, keychain seam. Consumed by `tila-cli` |
| `tila-cli` | `tila` CLI binary (Citty framework, Bun-compiled for multi-platform distribution) |
| `tila-cli-{platform}` | Platform-specific binary packages for npm distribution |
| `@tila/integration-tests` | E2E tests via `@cloudflare/vitest-pool-workers` |

### Naming: tasks vs entities

The public API uses **tasks** (`/tasks`, `POST /tasks`, `/tasks/relationships`). The internal
database table is named `entities` — that is an implementation detail of `@tila/ops-sqlite`.
User-facing documentation and seed data refer to "tasks"; internal code and DO/DON'T rules
that reference "entity" are referring to the table-level concept.

### Package dependency flow

```
schemas → core → ops-sqlite → backend-do        → worker
                            → backend-embedded → backend-local   (Bun, bun:sqlite)
                                               → tila-sdk/local  (Node, better-sqlite3)
         core → backend-d1                → worker
         core → backend-r2                → worker
schemas → sdk → mcp-server
                                    worker ← ui
cli (standalone, imports schemas only)
```

`schemas` and `core` are platform-agnostic (no Cloudflare Workers types). `ops-sqlite` is the shared SQLite layer — it contains all Drizzle table definitions, migrations, and ops modules. `backend-do` consumes `ops-sqlite` directly (DO SQLite). `backend-embedded` wraps `ops-sqlite` into a runtime-agnostic embedded core consumed by `backend-local` (Bun via `bun:sqlite`) and `tila-sdk/local` (Node via `better-sqlite3`) — so **local mode now runs under plain Node** (SDK + MCP server), not just Bun. The DB file is portable between the CLI and a Node SDK/MCP consumer because both run the same `EMBEDDED_MIGRATIONS` (see `docs/02-ARCHITECTURE.md` §1.6a).

### Request flow

HTTP → Worker (Hono) → auth middleware → project middleware (resolves DO stub) → route handler → DO `fetch()` → `project-do-router.ts` (Hono sub-router inside DO) → ops modules from `@tila/ops-sqlite` → Drizzle → DO SQLite.

The `ProjectDO` class in `backend-do/src/project-do.ts` is thin: it constructs Drizzle, runs migrations in `blockConcurrencyWhile`, and delegates all domain logic to the router built from ops-sqlite modules.

### Auth model

Two auth paths unified in `middleware/auth.ts`:
1. **GitHub session tokens** — short-lived, repo-scoped, default auth path (see `docs/07-GITHUB-SCOPED-AUTH.md`)
2. **D1 API tokens** — hashed, stored in D1, admin/bootstrap credential

All resolve to `UnifiedTokenResult` in `worker/src/types.ts`.

### Worker bindings

Defined in `packages/worker/wrangler.toml`: `PROJECT` (DO), `DB` (D1), `ARTIFACTS` (R2), `ANALYTICS` (Analytics Engine), `ASSETS` (static). Daily cron at 03:00 UTC runs sweep.

### DO/DON'T

- DO: Keep shared code in `packages/` — import across packages, never copy-paste
- DO: Use pnpm workspace filters for targeted builds (`pnpm --filter @tila/worker build`)
- DO: Use Zod schemas from `@tila/schemas` as the single source of truth for all data types
- DO: Use Drizzle for all database operations — no raw SQL except in migrations
- DO: Co-locate entity and claim writes in single DO SQLite transactions
- DO: Content-address all artifacts by sha256 — key format: `<prefix>/<id>/<sha256>.<ext>`
- DO: Validate fencing tokens on every destructive operation downstream of a claim
- DO: Canonicalize entity coordination resources to `<type>:<id>` at the route or facade boundary before reading claim/fence state
- DO: Fail closed when a required fence row is missing; do not add `if (fenceRow)` best-effort guards on required-fence paths
- DO: Add new ops modules to `@tila/ops-sqlite`, not to `backend-do` directly
- DON'T: Create circular dependencies between workspace packages
- DON'T: Import Cloudflare Workers types in packages that don't run on Workers (schemas, core, ops-sqlite, cli, sdk)
- DON'T: Store business logic in Worker route handlers — extract to backend packages
- DON'T: Modify `.github/workflows/` — CI configuration is managed by the scaffold tool
- DO: Deploy via `tila infra provision --force-redeploy` or `tila deploy` — both route through `deployWorkerWithAssets`, which generates a per-deploy `wrangler.<slug>.toml` and shells out to `wrangler deploy`. `wrangler deploy` **preserves Worker secrets** (secrets are never deleted by a deployment); plain `[vars]` absent from the generated config ARE removed (`keep_vars=false` by default — intentional, since `CORS_ALLOWED_ORIGINS` is dropped under same-origin deployment). Do NOT run `wrangler deploy` manually; let the CLI manage config generation and secret injection. `wrangler dev` for local development is fine.
- DON'T: Poll a DO to check if it restarted — each request resets the 70-140s idle eviction timer, preventing the restart you're waiting for

### Correctness model

First-writer-wins with fencing tokens. Every claim returns a monotonic fence. Every destructive write carries the fence. The DO validates fences — stale fences are rejected. See `docs/01-DECISIONS.md` section 2 for the full model.

### Three-layer persistence

1. **DO SQLite** (per-project): entities, relationships, journal, claims, fences, presence, schema history, FTS5 search
2. **D1** (global): API tokens, idempotency keys, project metadata, sessions
3. **R2**: content-addressed artifact blobs with Worker-driven lifecycle cleanup

### Key design documents

- `docs/01-DECISIONS.md` — settled decisions (the constitution)
- `docs/02-ARCHITECTURE.md` — technical specification
- `docs/03-ROADMAP.md` — v0.1 scope, success criteria, build order
- `docs/04-PERSISTENCE-SCHEMA.md` — ER diagram and cross-store boundaries
- `docs/05-OPERATIONS.md` — production procedures, observability, troubleshooting
- `docs/07-GITHUB-SCOPED-AUTH.md` — GitHub-scoped auth — default auth model
- `docs/08-RECORDS.md` — typed mutable records design (implemented)
- `DESIGN.md` — UI design system (colors, typography, components)

### Contributor dev MCP server

MCP config templates are provided as `.example` files. Copy them to create your local configs:

```bash
cp .mcp.json.example .mcp.json
cp .cursor/mcp.json.example .cursor/mcp.json
cp .vscode/mcp.json.example .vscode/mcp.json
```

Then start the local Worker:

```bash
pnpm install   # ensures tsx is available for npx resolution
pnpm dev       # starts the Worker locally via wrangler dev
```

Set `TILA_PROJECT_ID` to your project ID before using MCP tools.
The actual config files (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`) are gitignored.
