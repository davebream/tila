---
name: tila-release
description: Use when cutting, preparing, rehearsing or publishing a tila release — version bump, changelog and upgrade notes, pre-tag gates on disposable Cloudflare infrastructure, release PR through Mergify, tag push, npm and GitHub release verification. Triggers on "cut a release", "new release", "release 0.x", "ship vX.Y.Z", "prepare the release", "tag a release".
---

# tila release

Guides one release from inventory to verified publication, one step at a time.

## Source of truth

| What | Where |
|---|---|
| This procedure (canonical, shared by Claude Code and Codex) | `.agents/skills/tila-release/` |
| Claude Code entry point | `.claude/skills/tila-release`, a symlink to the folder above. Never copy it. |
| Gate pass criteria (Gates 1 to 4) | `docs/05-OPERATIONS.md`, "Pre-Tag Gates" |
| Commit, PR and merge-queue rules | `CLAUDE.md` / `AGENTS.md`, "Git workflow" |
| Version lockstep | `scripts/bump-version.sh`, `pnpm version:check` |
| Release pipeline | `.github/workflows/release.yml` |

Change the procedure here and the criteria in the docs. Do not restate criteria here.

## How to run it

- Do the steps in order. Finish each step's **Check** before the next step, and give
  the user a one-line status per step.
- Record every value in `$RD/vars.sh` the moment it is known (`echo "V=0.8.0" >> "$RD/vars.sh"`).
  Shell state does not survive between commands, so start every command block with
  `source <RD>/vars.sh`, using the literal `$RD` path printed in step 1. Give that path
  to every subagent and to the user. The table below lists the variables.
- Never print tokens. Never mention AI tools or agents in commits, PRs or the changelog.
- Stage files by name or with `git add -u`. Never `git add -A`: the scratch directory,
  generated `wrangler.tila-rel*.toml` files and build output must not be committed.
- **Stop and ask the user** when the version is ambiguous, a hard gate fails, the A/B
  check points at the code, before pushing the tag (unless the user asked in this
  request to publish), or anything would touch the production Worker, D1 database or bucket.
- Production deploy is not part of a release. Mention it at the end; do it only on request.

| Variable | Set in | Meaning |
|---|---|---|
| `RD` | 1 | Scratch directory (holds a Cloudflare token copy and a project token) |
| `MAIN`, `BRANCH` | 1 | Main checkout path and release branch |
| `LAST` | 2 | Previous release tag, e.g. `v0.7.0` |
| `V`, `VTAG`, `SLUG` | 2 | Version `0.8.0`, dotless `080`, gate Worker name `tila-rel080` |
| `RELEASE_COMMIT`, `REHEARSAL_RUN` | 4 | Commit the gates test; rehearsal workflow run ID |
| `PR`, `MERGE` | 8 | Release PR number; its merge commit on main |
| `TAG_RUN` | 9 | Release workflow run for the tag |

### Parallel work

Steps 5 and 6 and the changelog cold-read run at the same time, after step 4. Use
subagents where your CLI has them (Claude Code: the Agent tool; Codex: subagents when
enabled); otherwise use background shell jobs, or run them in sequence.

```
step 2: [subagent] changelog draft from PR bodies   (you: version decision)
step 4 push ──┬── [background] GitHub release rehearsal ─────────────────┐
              ├── [background] local gates, step 5 ──────────────────────┤
              ├── [subagent]   live gates in a separate worktree, step 6 ├──> step 7
              └── [subagent]   cold-read of the changelog section ───────┘
```

Live gates run in their own worktree because they build the Worker and UI while the
local gates build the same packages. The PR body is drafted in step 7, once the gate
results exist.

## Steps

### 1. Preflight

Do:
```bash
git fetch origin --tags
cat .claude/branch-policy                       # expect: pr
git status --porcelain                          # expect: empty
git switch -c release/next origin/main          # any name; or stay on a workspace branch fresh from origin/main
pnpm install --frozen-lockfile
gh auth status && bun --version && jq --version
grep -q '^CLOUDFLARE_API_TOKEN=' ~/.tila/.env && echo "Cloudflare token present"
RD=$(git check-ignore -q .context && echo "$PWD/.context/release" || echo "${TMPDIR:-/tmp}/tila-release")
mkdir -p -m 700 "$RD"
{ echo "RD=$RD"; echo "MAIN=$PWD"; echo "BRANCH=$(git branch --show-current)"; } > "$RD/vars.sh"
echo "vars file: $RD/vars.sh"                   # every later block sources this path
```

Check: the policy is `pr`, the tree was clean, the branch starts at current
`origin/main`, and the token exists.

### 2. Inventory and version

Do: follow `reference/changelog-and-pr.md` "Inventory": set `LAST`, list commits and PRs
since it, list new DO and D1 migrations, and save PR bodies to `$RD/prs.md`. Hand the
changelog draft to a subagent (brief at the end of that file) while you choose the
version with the table there. Then record:
```bash
echo "LAST=$LAST" >> $RD/vars.sh
echo "V=0.8.0" >> $RD/vars.sh; source $RD/vars.sh
echo "VTAG=${V//./}" >> $RD/vars.sh; echo "SLUG=tila-rel${V//./}" >> $RD/vars.sh
```

Check: the version follows the table. If a breaking change is unclear, ask the user.

### 3. Bump and release metadata

Do:
```bash
./scripts/bump-version.sh $V             # package.json files, platform pins, server.json, Homebrew formula
pnpm install --lockfile-only             # workspace versions in pnpm-lock.yaml
./node_modules/.bin/biome check --write $(git diff --name-only -- '*.json')
pnpm version:check
```
Then write the CHANGELOG section, its compare links and the README status line from the
reviewed draft (`reference/changelog-and-pr.md`).

Check: `git diff --stat` touches only package JSON files, `server.json`,
`pnpm-lock.yaml`, `homebrew/Formula/tila.rb`, `CHANGELOG.md` and `README.md`, and the
JSON diffs are version lines only (the bump script expands inline arrays; Biome folds
them back). The changelog answers every upgrade-notes question.

### 4. Commit, push, rehearse

Do:
```bash
git add -u && git commit -m "build(release): prepare tila $V"
git push -u origin HEAD
echo "RELEASE_COMMIT=$(git rev-parse HEAD)" >> $RD/vars.sh
gh workflow run release.yml --ref "$BRANCH"            # manual dispatch never publishes
for i in $(seq 1 20); do
  REHEARSAL_RUN=$(gh run list --workflow release.yml --branch "$BRANCH" --event workflow_dispatch --limit 5 \
    --json databaseId,headSha -q "map(select(.headSha==\"$(git rev-parse HEAD)\"))[0].databaseId // empty")
  [ -n "$REHEARSAL_RUN" ] && break; sleep 6; done
echo "REHEARSAL_RUN=$REHEARSAL_RUN" >> $RD/vars.sh          # must not be empty
```
Now start step 5 in the background, step 6 as a subagent, and the changelog cold-read
(`reference/changelog-and-pr.md` "Self-sufficiency review").

Check: `gh run view $REHEARSAL_RUN` shows the run in progress.

### 5. Local gates (background; Gates 2 and 3)

Do, from `$MAIN`:
```bash
pnpm run typecheck
pnpm lint                                   # if a wrapper mangles Biome output: ./node_modules/.bin/biome check .
pnpm run check && git diff --exit-code      # Gate 3: no formatting drift
env -i HOME="$HOME" PATH="$PATH" pnpm test
env -i HOME="$HOME" PATH="$PATH" pnpm run test:scripts
pnpm test:runtime
```

Keep the `env -i` and the quotes. Inside an agent or terminal session, three
`@tila/connector` tests detect the live session and fail, turbo appends a rules block to
`AGENTS.md`, and two `ci-scopes` script tests fail. `PATH` contains spaces
("Application Support"), so unquoted it breaks `env`.

Check: every command passes; record the `pnpm test` task count and the script and
runtime test counts for the PR. If `git status` shows `AGENTS.md` modified, run
`git diff AGENTS.md`: if it is only the appended turbo block, `git checkout AGENTS.md`;
if you edited AGENTS.md yourself, delete only that block. Discard regenerated
`packages/*/src/version.ts` files.

### 6. Live gates (subagent, separate worktree; Gates 1 and 4)

Do: `reference/live-gates.md` steps 1 to 7: gate worktree at `$RELEASE_COMMIT`,
provision `$SLUG`, health check, throwaway project, Gate 1, Gate 4, the A/B check if
latency jumped, destroy, teardown. Use the brief at the end of that file.

Check: health showed `$V` and `$RELEASE_COMMIT`; Gate 1 passed 3/3; every EXIT code
was 0; no invariant failed; zero unexpected errors; teardown showed every resource gone
and production present. Any hard failure: stop and report.

### 7. Baseline, PR body, review

Do:
- Write `docs/benchmarks/BASELINE.md` (`reference/live-gates.md` step 8), then
  `git add docs/benchmarks/BASELINE.md && git commit -m "docs(release): record $V coordination baseline"`.
- Apply the cold-read fixes to `CHANGELOG.md`/`README.md` and commit them as
  `docs(release): clarify $V upgrade notes`.
- Wait for the rehearsal: `gh run watch $REHEARSAL_RUN`, then
  `gh run view $REHEARSAL_RUN --json conclusion,jobs -q '.jobs[]|"\(.name): \(.conclusion)"'`.
- Draft `$RD/pr-body.md` (`reference/changelog-and-pr.md` "Release PR") with the step 5
  and 6 results and the rehearsal link, then give it a self-sufficiency review.

Check: the rehearsal shows validate-build, consumers, platforms, musl and attest
passing, with github-release, npm-publish and homebrew skipped. It ran on
`$RELEASE_COMMIT`; later commits are docs-only. The PR body has no placeholders and no
tool mentions.

### 8. Release PR through the merge queue

Mergify integrates PRs into `main`: the `merge-ready` label queues the PR, and Mergify
merges it once the required `ci` check passes.

Do:
```bash
git push
PR=$(gh pr create --base main --title "build(release): prepare tila $V" --body-file $RD/pr-body.md | grep -o '[0-9]*$')
echo "PR=$PR" >> $RD/vars.sh
[ -z "$(gh pr view $PR --json autoMergeRequest -q .autoMergeRequest)" ] || gh pr merge $PR --disable-auto
gh pr edit $PR --add-label merge-ready
for i in $(seq 1 90); do                                     # up to 45 minutes
  s=$(gh pr view $PR --json state -q .state); [ "$s" != OPEN ] && break
  gh pr checks $PR --json bucket -q '.[].bucket' | grep -q fail && { echo "check failed"; break; }
  sleep 30; done; echo "state=$s"
[ "$s" = MERGED ] || echo "NOT MERGED: stop and report"
```
Do not merge directly, enable auto-merge, or rebase while the PR is queued. If a check
fails or the PR is still open after the loop, stop and report the blocking check.

Check: confirm the merge from two sources, and stop if they disagree:
```bash
MERGE=$(gh pr view $PR --json mergeCommit -q .mergeCommit.oid); echo "MERGE=$MERGE" >> $RD/vars.sh
git fetch origin main && git merge-base --is-ancestor $MERGE origin/main && echo "on main"
git show $MERGE:package.json | jq -r .version                # expect $V
```

### 9. Tag and publish

Pushing the tag publishes to npm and creates the GitHub release. Neither can be undone.
Confirm with the user unless they asked in this request to publish.

Do:
```bash
git tag -a v$V $MERGE -m "tila $V"
git push origin v$V
for i in $(seq 1 20); do
  TAG_RUN=$(gh run list --workflow release.yml --branch v$V --event push --limit 5 \
    --json databaseId,headSha -q "map(select(.headSha==\"$MERGE\"))[0].databaseId // empty")
  [ -n "$TAG_RUN" ] && break; sleep 6; done
echo "TAG_RUN=$TAG_RUN" >> $RD/vars.sh                       # must not be empty
gh run watch $TAG_RUN --exit-status
```

Check: the run succeeded. If a test job failed on a timing flake (for example
`queue-local.test.ts` over its timeout), run `gh run rerun $TAG_RUN --failed` and watch
again. Nothing publishes before validate-build passes. Any other failure: stop and report.

### 10. Verify publication

Do:
```bash
for p in tila-cli tila-sdk tila-mcp-server tila-cli-{darwin-arm64,darwin-x64,linux-arm64,linux-arm64-musl,linux-x64,linux-x64-musl,windows-arm64,windows-x64}; do
  echo "$p $(npm view $p@$V version) latest=$(npm view $p dist-tags.latest)"; done
gh release view v$V --json isDraft,isPrerelease,assets -q '"draft=\(.isDraft) pre=\(.isPrerelease) assets=\(.assets|length)"'
```

Check: all 11 packages show `$V` with `latest=$V` (if the registry lags, retry after a
minute). The release is neither draft nor prerelease and has its assets (28 for 0.7.0).

### 11. Wrap up

Do:
- Report to the user: version, what shipped (feature areas), gate results, latency
  versus baseline and the A/B verdict, PR and release links, anything skipped.
- Remind the user: production deploy is theirs to trigger (`tila deploy`, Worker and UI
  together, before upgrading clients), and Homebrew publication is opt-in.
- Clean up: remove the gate worktrees (their `packages/worker/wrangler.tila-rel*.toml`
  files go with them), the gate homes in `$RD` that hold token copies, and `$RD/project*.json`.
- If something in this procedure was wrong or missing, fix this skill in a follow-up PR.

## Known traps

| Trap | Handling |
|---|---|
| `tila infra provision` reuses production D1 and R2 | Use only `scripts/provision-gate-infra.ts` for gates |
| Bump script expands JSON arrays | Biome on the changed JSON files (step 3) |
| Agent/terminal env breaks tests; turbo edits `AGENTS.md` | `env -i HOME="$HOME" PATH="$PATH"` (step 5) |
| Stale `node_modules` after `main` moves | `pnpm install --frozen-lockfile` before building or deploying |
| Deployed latency swings 2x between days | A/B against the previous release before calling it a regression |
| zsh does not word-split unquoted `$VARS` | Quote variables as shown, or use the scripts |
| A shell output wrapper (such as `rtk`) shortens `git log` lines and drops `(#N)` | Run the command unwrapped (`rtk proxy git log ...`) |
| Bun prints "Internal error: directory mismatch" | Harmless |
| Tag run timing flake | `gh run rerun $TAG_RUN --failed` |
