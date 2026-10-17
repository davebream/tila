# Live gates on disposable infrastructure

Procedure for Gate 1 (DO restart persistence) and Gate 4 (deployed benchmarks) from
`docs/05-OPERATIONS.md` "Pre-Tag Gates". That section owns the pass criteria; this file
owns the mechanics.

## Why disposable infrastructure

`tila infra provision` hard-codes the production D1 database (`tila-global`) and R2
bucket (`tila-artifacts`) in `packages/cli/src/lib/resource-names.ts`. A second slug
would share production storage, and `tila infra teardown` could delete it. The scripts
here deploy a Worker script named `$SLUG` (for example `tila-rel080`) with its own D1
database, DO namespace and R2 bucket, and refuse any name or ID that matches
`~/.tila/infra.toml`.

Never run `wrangler dev --remote` for gates: pending DO migrations would run against
production DO SQLite.

## 1. Gate worktree and variables

Live gates build the Worker and UI. Running them in the main checkout while the local
gates run would race on `dist/` and generated `version.ts` files, so they use a separate
plain worktree at the release commit. `$RD/vars.sh` comes from SKILL.md steps 1 to 4.

```bash
source <RD>/vars.sh                           # RD, MAIN, V, VTAG, SLUG, LAST, RELEASE_COMMIT
git -C "$MAIN" worktree add --detach "$RD/wt-gates" "$RELEASE_COMMIT"
for kv in "REPO=$RD/wt-gates" "GATE_HOME=$RD/gate-home" \
  "S=$RD/wt-gates/.agents/skills/tila-release/scripts" \
  "RESULTS=$RD/wt-gates/packages/bench/results/release-$VTAG" \
  "PREV=$RD/wt-prev" "PREV_HOME=$RD/gate-home-prev"; do echo "$kv" >> "$RD/vars.sh"; done
source "$RD/vars.sh"; cd "$REPO" && pnpm install --frozen-lockfile && pnpm build
```

`GATE_HOME` is a disposable `TILA_HOME` that receives a Cloudflare token copy. Shell
state does not carry over between commands: start every later block with
`source <RD>/vars.sh; cd "$REPO"`, and append each new value to `vars.sh` as shown. The
scripts find the checkout from the working directory. (Claude Code: do not use the Agent tool's `isolation: "worktree"`, whose Bash
calls can lose their working directory. Create the worktree yourself and tell the
subagent to `cd` into it.)

## 2. Provision

```bash
TILA_HOME=$GATE_HOME bun --tsconfig-override $REPO/tsconfig.json $S/provision-gate-infra.ts --slug $SLUG > $RD/provision.log 2>&1
echo "WORKER_URL=$(grep -h '"worker_url"' $RD/provision.log | jq -r .worker_url)" >> $RD/vars.sh
source $RD/vars.sh; sleep 10; curl -s $WORKER_URL/api/health | jq '{version, commit}'
```

- The token is copied from `~/.tila/.env` into `$GATE_HOME/.env`.
- Bun prints `Internal error: directory mismatch ... tsconfig.json`. It is harmless.
- A UI build error such as `failed to resolve import "zod"` means `node_modules` is
  stale for this commit: run `pnpm install --frozen-lockfile` and retry.
- Health must report `$V` and `$RELEASE_COMMIT`. It answers a few seconds after deploy.

## 3. Throwaway project

```bash
mkdir -p $RD/proj && (cd $RD/proj && git init -q && \
  env -i HOME="$HOME" PATH="$PATH" TILA_HOME="$GATE_HOME" \
  bun --tsconfig-override $REPO/tsconfig.json $REPO/packages/cli/src/index.ts \
  project create --name tila-bench-$(date +%Y%m%d) --skip-github --json) > $RD/project.json
echo "PROJECT_ID=$(jq -r .result.project_id $RD/project.json)" >> $RD/vars.sh; source $RD/vars.sh
```

`$RD/project.json` holds the full-scope project token at `.result.token`. Never print it.
Run project creation and destruction with the clean environment shown here: inherited
runtime-session variables otherwise select the current managed run instead of the
disposable infrastructure-owner workflow.

## 4. Gate 1: DO restart persistence

```bash
env -i HOME="$HOME" PATH="$PATH" TILA_BASE_URL="$WORKER_URL" TILA_PROJECT_ID="$PROJECT_ID" \
  TILA_TOKEN="$(jq -r .result.token $RD/project.json)" \
  pnpm --filter @tila/integration-tests exec vitest run src/do-eviction.test.ts
```

Pass: 3 tests. The latency check inside it is advisory.

## 5. Gate 4: deployed benchmarks (about 7 minutes)

```bash
$S/run-gate-bench.sh full "$WORKER_URL" "$PROJECT_ID" $RD/project.json "$RESULTS" > $RD/bench.log 2>&1
grep -E 'EXIT|ops in' $RD/bench.log
pnpm bench:report -- --in "$RESULTS" --out $RD/baseline-tables.md
jq '[.scenarios[].invariants[] | select(.ok != true)] | length' "$RESULTS"/*.json   # each 0 (hard)
jq '[.scenarios[].invariants[]] | length' "$RESULTS"/*.json                         # totals, for the summary
grep -h -o '"missed_cadence_deadlines": *[0-9]*' "$RESULTS"/*.json                   # advisory, target 0
mkdir -p "$MAIN/packages/bench/results" && cp -R "$RESULTS" "$MAIN/packages/bench/results/"
```

Every `EXIT` line must be 0. The raw JSON is gitignored; the copy in `$MAIN` keeps the
BASELINE.md regeneration command working after the worktree is removed.

Compare with the previous `docs/benchmarks/BASELINE.md`: p95 for acquire, update, send
and replay; owner-contention acquire p95; cold-first-request p50.

| Signal | Class | Action |
|---|---|---|
| A failed invariant or an unexpected error | hard | Stop. Do not tag. Report it to the user. |
| p95 more than ~25% worse, or cold p50 doubled | advisory | Run the A/B check (step 6) before calling it a regression |
| Missed cadence deadlines above 0 | advisory | Note it in BASELINE.md |

## 6. A/B check for a latency jump

Deployed latency moves a lot between days: the 2026-10-08 baseline was ~300 ms per
call, 0.6.0 measured ~200 ms and 0.7.0 ~400 ms. When everything is slower by a similar
factor, deploy the previous release beside this one and benchmark both in turns. The
previous release's Worker gets its own script name (and so its own DO namespace) but
reuses this gate's D1 database and bucket, which keeps teardown to one set of storage.
D1 migrations only ever add, so the older Worker runs on the newer schema.

```bash
git -C "$MAIN" worktree add --detach $PREV $LAST
(cd $PREV && pnpm install --frozen-lockfile && pnpm build)
TILA_HOME=$PREV_HOME bun --tsconfig-override $PREV/tsconfig.json $S/provision-gate-infra.ts \
  --repo $PREV --slug ${SLUG}ab --d1 $SLUG-global --r2 $SLUG-artifacts > $RD/provision-prev.log 2>&1
echo "PREV_URL=$(grep -h '"worker_url"' $RD/provision-prev.log | jq -r .worker_url)" >> $RD/vars.sh
mkdir -p $RD/proj-prev && (cd $RD/proj-prev && git init -q && \
  env -i HOME="$HOME" PATH="$PATH" TILA_HOME="$PREV_HOME" \
  bun --tsconfig-override $PREV/tsconfig.json $PREV/packages/cli/src/index.ts \
  project create --name tila-ab-$(date +%Y%m%d) --skip-github --json) > $RD/project-prev.json
echo "PREV_ID=$(jq -r .result.project_id $RD/project-prev.json)" >> $RD/vars.sh; source $RD/vars.sh
$S/run-gate-bench.sh ab "$PREV_URL" "$PREV_ID" $RD/project-prev.json "$WORKER_URL" "$PROJECT_ID" $RD/project.json $RD/ab
```

The script stops on the first failed child command and preserves its exit status.
It prints primary-operation p50/p95 (`acquire` for claims and `update` for fenced
writes), not a server timing component. Round 1 runs A (previous), B (release);
round 2 reverses to B, A to reduce time-order bias. If both sides
are equally slow, the cause is the environment: put the table in BASELINE.md. If B is
consistently slower, stop and report a likely code regression to the user.
`curl -s -o /dev/null -w '%{time_total}\n' $WORKER_URL/api/health` (~60 ms from
Wrocław) is a quick check that the network itself is fine.

## 7. Destroy and tear down

Destroy every gate project first, each with its own home and CLI:

```bash
(cd $RD/proj && env -i HOME="$HOME" PATH="$PATH" TILA_HOME="$GATE_HOME" bun --tsconfig-override $REPO/tsconfig.json $REPO/packages/cli/src/index.ts project destroy --force --json)
(cd $RD/proj-prev && env -i HOME="$HOME" PATH="$PATH" TILA_HOME="$PREV_HOME" bun --tsconfig-override $PREV/tsconfig.json $PREV/packages/cli/src/index.ts project destroy --force --json)   # A/B only
```

Expect `"stores":{"do":"ok","r2":"ok","d1":"ok","local":"ok"}` and `"failures":[]`. Then:

```bash
TILA_HOME=$GATE_HOME $S/teardown-gate-infra.sh            # append ${SLUG}ab if the A/B Worker exists
```

Every verification line must show `success: false` (gone), and the production D1 line
must print `true`. Then leave the worktrees and clean up:

```bash
cd "$MAIN"
git worktree remove --force "$REPO"; [ -d "$PREV" ] && git worktree remove --force "$PREV"
rm -rf "$GATE_HOME" "$PREV_HOME" "$RD"/project*.json
```

## 8. BASELINE.md

Replace `docs/benchmarks/BASELINE.md` with a release summary followed by
`$RD/baseline-tables.md`. Use the 0.7.0 version in git history as the template
(`git show v0.7.0:docs/benchmarks/BASELINE.md | head -40`). The summary states: gates
passed, operation count, unexpected errors, invariants passed out of total, the
isolated-infra setup and `$RELEASE_COMMIT`, latency against the previous baseline
(advisory), the A/B table if one ran, cadence misses, cleanup confirmation, and the
regeneration command for `packages/bench/results/release-$VTAG`.

## Subagent brief (live gates)

Give the subagent the path of `$RD/vars.sh` and of this file, and ask it to run steps
1 to 7. It returns only: health version and commit, the Gate 1 result, the `EXIT`
lines, invariant failures and total, missed cadence deadlines, a p95 comparison table
against the previous baseline, the A/B table if run, destroy results and the teardown
verification lines. It must never print tokens, must not edit tracked files, and must
stop and report any hard failure instead of working around it. It must always run step 7,
even after a failure.
