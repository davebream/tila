# Contributing

Thank you for considering contributing to tila.

## Getting Started

```bash
git clone https://github.com/davebream/tila.git
cd tila
pnpm install
pnpm dev:setup # one-time: generates dev config, applies D1 migrations, seeds test data
pnpm dev       # start Worker on :8787
pnpm --filter @tila/ui dev  # start UI on :5173 (separate terminal)
pnpm test      # run all tests
```

Login at `http://localhost:5173` with project `dev-project` and token `tila_dev_token_localonly`.

## Reporting Bugs

Open a [GitHub issue](../../issues/new) with:

- A clear description of the bug
- Steps to reproduce
- Expected vs. actual behavior
- Environment details (OS, Node version, tila version)

## Requesting Features

Open a [GitHub issue](../../issues/new) describing:

- The use case you are trying to solve
- Your proposed solution (if you have one)
- Alternatives you considered

## Development Setup

Prerequisites:

- **Node.js 22+**
- **pnpm** (latest)
- **Bun** (for CLI binary compilation only)

This is a Turborepo monorepo. Use workspace filters for targeted work:

```bash
pnpm --filter @tila/backend-do test      # test one package
pnpm --filter @tila/worker typecheck     # typecheck one package
```

## Code Style

[Biome](https://biomejs.dev/) handles formatting and lint. Run before committing:

```bash
pnpm run check    # auto-fix formatting and imports
pnpm lint         # read-only check (CI-safe)
```

Pre-commit hooks (via Lefthook) run Biome and gitleaks automatically on staged files.

## Commits

Use Conventional Commits for every commit:

```text
<type>(<scope>): <description>
```

Allowed types:

- `feat` - user-facing feature
- `fix` - bug fix
- `docs` - documentation only
- `test` - test additions or updates
- `refactor` - behavior-preserving code structure change
- `perf` - measurable performance improvement
- `build` - build system, dependencies, packaging
- `ci` - CI configuration
- `style` - formatting-only change
- `chore` - maintenance that does not fit another type
- `revert` - revert a previous commit

Rules:

- Keep one commit to one type. Split mixed docs, tests, fixes, and features.
- Use a focused scope when useful, such as `worker`, `backend-do`, `sdk`, `cli`, or `docs`.
- Write descriptions in lowercase imperative mood, without a trailing period.
- Mark breaking changes with `!` before the colon and a `BREAKING CHANGE:` footer.

Examples:

```text
feat(cli): add local backend selector
fix(worker): reject stale fencing tokens
docs: document release process
```

## Pull Requests

PR titles must also use Conventional Commit format because squash merges use the PR title.

Every PR description should include:

- A concise summary of what changed
- Tests run, or an explicit note that tests were not run
- Any migration, schema, API, auth, persistence, or deployment impact
- Screenshots or recordings for UI changes

Before opening a PR, run the narrowest useful verification first. Prefer workspace filters for package-specific changes:

```bash
pnpm --filter @tila/backend-do test
pnpm --filter @tila/worker typecheck
```

For broad changes, use the repo-level checks:

```bash
pnpm lint
pnpm run typecheck
pnpm test
```
