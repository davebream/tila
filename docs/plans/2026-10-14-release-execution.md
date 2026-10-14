# Release preparation execution plan — 2026-10-14

## Authority, ownership and completion boundary

Release preparation is elected. This document is the dispatch contract for a separate fourth worker, **`release-prepare-sol` (GPT-6.1-Sol, xhigh)**, reporting to **`lead-backlog`**. Coding workers remain `build-399-task-filters`, `build-440-ghes-oidc` and `build-448-settings-transfer` (use the lead's current agent names if renamed). The lead arranges the single `tila` workspace's Brain, Builders and Release tabs; never infer a pane ID. Four workers is a ceiling, not permission to add changelog, live-gate or review subagents. The release worker performs the skill's suggested delegated tasks itself; the lead supplies the independent cold read. Schedule heavy local builds/runtime tests with the lead to avoid competing with the three builders.

**Present planning scope:** only this document, in `/home/dawid/code/tila-workers/release-plan`, branch `docs/release-execution-plan`, immutable base `ff7bdf3de31f472dafec9606244c426e5166c2e2`. Commit it locally for lead review. No version bump, deployment, secret mutation, tag, PR, push or worker orchestration is performed by this planning task. Do not write to `backlog-plan` or another worker's checkout.

**Future execution scope, after lead dispatch:** prepare release metadata, validate a frozen candidate, run a non-publishing Actions rehearsal, complete disposable live gates when prerequisites exist, and hand a reviewed release PR to Mergify. Stop before tag creation/push. Publication requires an explicit decision on the exact version and merged SHA. Production deployment, production secret rotation, #307 activation and Homebrew publication remain separate decisions. Passing a release rehearsal does not establish product live acceptance.

Follow the current canonical [tila-release skill](../../.agents/skills/tila-release/SKILL.md), [changelog/PR reference](../../.agents/skills/tila-release/reference/changelog-and-pr.md) and [live-gates reference](../../.agents/skills/tila-release/reference/live-gates.md), in their numbered order below. Operational authority is [AGENTS.md](../../AGENTS.md), [Operations](../05-OPERATIONS.md), [.github/workflows/release.yml](../../.github/workflows/release.yml), and [version policy](../../scripts/version-policy-lib.mjs). The skill explicitly says **“Stop and ask the user”** for an ambiguous version, a failed hard gate, an A/B result pointing to code, before tag push without publishing authorization, or anything touching production. Report the concrete evidence and blocked action; never weaken a gate to finish the release. The latest lead update places Brain/Builders/Release in one workspace; use agent names and the lead's reserved Release slot, not persisted pane numbers.

## Snapshot and scope selection

This is an inventory, not a claim that pending changes shipped. Refresh it at freeze and record the timestamp, every accepted/excluded PR and reason in the private release dossier.

| Evidence at planning | Observed state |
| --- | --- |
| Last public release | `v0.8.0`, published 2026-10-13 18:13:01 UTC; tag commit `31103a49c5e7bef738d97e42090781f848d43025` |
| Public registry check | `tila-cli`, `tila-sdk`, `tila-mcp-server` each report `latest=0.8.0`; all eleven packages must be checked at execution |
| Planning checkout | `ff7bdf3d`; clean before adding this plan; branch policy `pr` |
| Later observed GitHub main | `bbe0252d619626001db08139c1b95e0a5b4af465`, 2026-10-14 13:02 UTC; this does not move the planning branch |
| Release workflow | Active; manual dispatch and tag triggers; manual dispatch skips publishing jobs |
| GitHub access | Authenticated repository read/push/admin permissions reported; dispatch not exercised |

### Delivered since v0.8.0

| Change | Accepted inventory / upgrade consequence |
| --- | --- |
| #442 | Access-settings restore revision watermarks; D1 `0035_access_settings_revision_watermarks.sql` |
| #443–#446 | Shared definition-transfer planning/guards, CLI and UI import/export, documentation; additive user-facing features |
| #450 / PR451 | Deployment target selection and binding/identity checks before mutation; merged `ba26881e5ac36032e33670eb324ed58c63117a58`. No duplicate worker; secrets are preserved by normal deploy |
| #400 / PR453 | Step-up return navigation, including Strict Mode; preserve reviewed drafts across authentication |
| #449 / PR456 | Reviewed MCP definition import/export; retain exact reviewed payload, revision and idempotency key after lost responses; valid server receipt replay must survive stale local preflight |
| #398 / PR458 | Honest legacy blocked-count explanation and one queue/readiness model; no auth or local-mode retirement |
| #439 / PR459 | Service-account/workload-binding revisions; D1 `0036_service_identity_revisions.sql`; revision-aware updates and restore history |
| PR314 | UI dependency update, merged at planning base `ff7bdf3d` |
| #362 / PR463 | Bounded cleanup guide, not expanded worker delete authority; GitHub MERGED at `626fd8275127c7287d1b3418315844a4e8f4e44d`, issue closed |
| PR311 | Cloudflare tooling update; GitHub MERGED at `bbe0252d619626001db08139c1b95e0a5b4af465` |
| PR452 and later plan documentation | Internal execution contracts; do not inflate product release claims |

The lead subsequently independently confirmed GitHub MERGED and fetched-main ancestry for PR463 and PR311. Refresh those checks at freeze, as for every later PR.

### Pending work and freeze disposition

| Item | Release disposition and proof required |
| --- | --- |
| #416 / PR465 | Include after reviewed merge; observed head `9249ff3fce282f99344ca5e0987971ad45b4d72b`, aggregate CI success; lead confirms actual queue draft466. Queued is not merged. Warning-first compatibility, transactional journaling/replay and packed declarations must survive integration |
| #399 | Active builder. Include completed HTTP/local filter/page metadata parity, CLI/MCP surfaces, public type compatibility and runtime evidence; no partial parity claims |
| #440 | Active builder. Include final reviewed issuer/host propagation, sponsor-context/recovery and atomic JWKS corrections with runtime regressions; server-first upgrade notes and contextless legacy limitation are required |
| #448 | Active builder. Include completed shared settings format, explicit identity mapping, resumable partial apply, CLI/UI/MCP surfaces and runtime evidence; a partial slice is not full issue acceptance |
| PR312 | Repair exported `createHumanAuth`/`accountAuth` portable types for nested `better-call@1.4.0` TS2742, then validate the dependency update. Do not suppress declaration checks. Lead schedules an issue/PR-isolated coding slot; release worker does not absorb application fixes into metadata commits |
| #307 | Complete feasible runbook/evidence audit first if the lead schedules it. Existing build identity, cursor key and readiness work is already delivered. Production activation and any HASH_PEPPER rotation remain held; a passing local cutover rehearsal does not activate production |
| #283 | Actual cross-host/native-account transport gates remain open without the required resources and observed evidence. Do not advertise native restoration or supported runtime combinations from local Herdr coding |
| #308 | Deterministic fixtures/protocol preparation can land if feasible; S1–S3 live acceptance must have actual evidence. A release does not substitute for those journeys |
| #194 | Rubric/preparation may land; measured dogfood results require actual comparable runs. Never manufacture token savings or a case study |
| #292 | Parent acceptance remains criterion-based; do not close it because a release or children merged |
| #261 | Ongoing dependency automation; never a closure or release-completion target |

**Freeze rule:** finish remaining feasible fixes before electing the candidate, especially #399/#440/#448/#416 and PR312. The lead records each pending item as merged-and-verified, explicitly deferred with reason, or blocked on named external input. Do not silently drop a still-active feasible fix to begin tagging. No indefinite wait for unavailable #283/#308/#194 resources: preserve those open gates and describe the release as the capabilities actually delivered. A hard security/correctness defect cannot be waived by calling it deferred. Any scope disagreement goes to the lead before metadata work.

### Version recommendation

**Recommend 0.9.0, subject to refreshing the last published version at freeze.** The skill table requires a minor bump for any feature, new capability, migration or behavior change; pre-1.0 client-breaking changes also require a minor with upgrade notes. Already merged definition-transfer features and D1 migrations 0035/0036 satisfy this without relying on unfinished #448/#440. A patch is inappropriate. Nothing observed calls for 1.0.0. If another release lands first, recalculate from the actual last published tag and residual diff; if publication/tag/registry versions disagree or compatibility scope is ambiguous, stop for a decision. Do not reserve or create a tag during planning.

## Read-only prerequisites and missing inputs

| Prerequisite | Planning evidence / next action |
| --- | --- |
| Local tools | Linux x86_64; git 2.43.0, gh 2.102.0, Node 22.22.3, pnpm 9.15.0, Bun 1.4.2, jq 1.7 available. Workflow uses Node 24; use the declared toolchain for final local gates or record the difference and rely on required Node 24 rehearsal, not an assumed local match |
| GitHub rehearsal | Workflow active, repository permissions present; actual dispatch/runner availability and complete matrix remain untested |
| Operator Cloudflare files | `~/.tila/.env` and `~/.tila/infra.toml` absent. Thus no configured production account/D1/bucket/Worker exclusion inventory is available to the gate scripts |
| Ambient Cloudflare credential | Present, never printed. Read-only token verification returned HTTP 401; account listing HTTP 403. Treat as unusable/unverified, not authorization to provision. No ambient account ID supplied |
| Disposable Cloudflare target | Missing verified account, working token with required Worker/DO/D1/R2 and Worker-secret permissions, workers.dev availability, and run-owned resource allocation. Read calls cannot prove all mutation permissions |
| Publication | GitHub v0.8.0 and three primary npm packages agree. Repository has no environments/protection rules returned; `ENABLE_HOMEBREW_PUBLISH` unset. npm trusted-publisher configuration for all eleven packages and future tag publication are not re-proven by read-only repo access |
| Product live resources | No proof obtained of run-owned Mac/Linux pair, two independent Claude accounts, plain Codex coordinator, safe project/endpoint and measured study instrumentation; #283/#308/#194 remain honest open inputs |

The lead/operator must supply a valid operator configuration through the existing private credential mechanism, not chat or tracked files, and identify the intended account plus production exclusions. This task does not write those files or rotate credentials. **The formal workflow is blocked at step 1**, because the skill requires each step's Check before the next. While waiting, the fourth worker may independently prepare a readiness package: inspect scope, draft inventory/upgrade notes outside release metadata, track merged/pending fixes, and document exact missing inputs. It must not bump versions, push a release branch, dispatch rehearsal, or advance formal gates before required preflight passes, absent an explicit override. Do not request future tag approval prematurely. A readiness package is useful progress, not completed release preflight.

## Execution graph, worktrees and evidence

Hard path: `lead handoff → preflight → inventory/freeze/version → metadata → committed candidate + rehearsal dispatch → local gates → disposable live gates → baseline/cold review + rehearsal success → Mergify merge verification → explicit publication decision → tag workflow → publication verification`.

Live prerequisites feed step 6. Reviewed feasible backlog merges feed freeze. Rehearsal runs asynchronously after step 4 and must finish by step 7; it does not authorize skipping local/live gates. Heavy local builds are serialized with builders by scheduling, not a product dependency. A/B is conditional on advisory regression. No dependency requires closing #261 or fabricating the live epics.

| Checkout / state | Ownership and purpose |
| --- | --- |
| `release-plan` / `docs/release-execution-plan` | Planner's docs-only artifact, starting at ff7bdf3d; lead reviews it |
| `/home/dawid/code/tila-workers/release-readiness` / `docs/release-readiness` | Lead-created at `bbe0252d` for `release-prepare-sol` while preflight is blocked; docs-only inventory, upgrade drafts, prerequisite/evidence ledger. No bump, push/rehearsal or live mutation in this readiness assignment |
| `/home/dawid/code/tila-workers/release-next` / `release/0.9.0` | Proposed new release-worker checkout, created from freshly fetched frozen `origin/main`; adjust branch after version selection and persist it. Never reuse a builder checkout |
| `$RD/wt-gates` / detached `$RELEASE_COMMIT` | Same release worker, disposable live Worker build and gate execution; separate generated outputs |
| `$RD/wt-prev` / detached `$LAST` | Optional same-worker A/B checkout only; no additional agent |
| Root checkout and `backlog-plan` | Lead-owned; never clean/edit them. In particular preserve root's existing untracked `packages/backend-do/src/version.ts` |

Use a fresh private run directory under a checked ignored path, or `mktemp -d /tmp/tila-release-20261014-XXXXXX` if the checkout has no suitable ignored directory (`.context` was not confirmed ignored here). Set `umask 077`, directory mode 0700 and `vars.sh` mode 0600. Immediately write shell-escaped `RD`, `MAIN` (release checkout), `BRANCH`, then each value as it becomes known: `FREEZE`, `LAST`, `V`, `VTAG`, unique `SLUG`, `RELEASE_COMMIT`, `REHEARSAL_RUN`, `REPO`, `GATE_HOME`, `RESULTS`, `WORKER_URL`, `PROJECT_ID`, optional `PREV`/`PREV_HOME`, `PR`, `MERGE`, and later authorized `TAG_RUN`. Use `printf '%s=%q\n' NAME "$value"` in bash; do not copy unsafe shell text from arbitrary metadata.

Give the lead the exact private vars-file path immediately. **Every subsequent command block starts by sourcing that literal path**, not by assuming `$RD` survives across shells. While blocked, use a separate readiness dossier with `RD` and `READINESS_ROOT`; do not invent `MAIN` or `RELEASE_COMMIT` before the actual release checkout/candidate exists. Copy only reviewed non-secret readiness evidence into the fresh execution dossier. Tokens stay in protected gate config/project JSON, not vars, logs, commits or messages. Protect copied `.env`, `infra.toml`, project receipts and credential-bearing logs with 0600 permissions. Keep sanitized evidence separate. Never `git add -A`; stage exact paths or reviewed tracked changes. Resource cleanup is mandatory even after failures; secret scratch is removed only after required non-secret evidence has been retained.

Each gate receipt records candidate SHA, command, start/end UTC, tool/runtime versions, exit status, counts, log path and observed/blocked outcome. A pending cell never means passed. Graphify was refreshed here and `verifyRelease` queried; source confirms the pack/smoke/attestation/publish chain. Graph SQL extraction was unavailable, so migrations were read directly. The graph is orientation, not release evidence.

## Ordered execution contract

Commands below are future execution instructions, not actions performed by this plan. All use the private vars-file rule above. Finish and report each Check before the next numbered step. The current dispatch can prepare readiness material only while step 1 is blocked.

### 1. Preflight — currently blocked

1. Read the skill and both references from the intended current source; refresh changed instructions. Confirm release-preparation scope, four-worker ceiling and exclusive release checkout ownership with the lead. Check `gh auth status` privately, repository/workflow access, git/pnpm/Bun/jq and the intended Node toolchain. Never dump environment variables.
2. Fetch `origin` and tags, verify the latest published release/tag against main and registry, and inspect worktree/branch lists. Remain in `release-readiness` while builders finish. Once the lead agrees the feasible scope has landed or been explicitly dispositioned, create `release-next` from that freshly fetched main, only if its path and branch are unused. Confirm clean state and branch policy `pr`; initialize private RD/vars immediately. Do not reset or reuse someone else's branch. Step 2 records and verifies that exact frozen source rather than silently advancing it.
3. Obtain the working private operator configuration and explicit account/exclusion inventory. Read-only verify token status, intended account visibility, current production identifiers for exclusion, and resource listings. The provisioning helper selects `accounts.result[0]`: require that to be the intended account, or stop for a reviewed account-selection correction; do not rely on an arbitrary first account. Verify a unique run slug `tila-rel090-<run-id>` (recompute after version choice), Worker name, D1 name and bucket are unallocated or demonstrably owned by this same run. Do not reuse another release's infrastructure.
4. Check token precedence: `resolveCfApiToken` prefers ambient `CLOUDFLARE_API_TOKEN`. The currently invalid ambient value must not shadow the valid private configuration. Future gate blocks must unset that variable with `env -u CLOUDFLARE_API_TOKEN` and use the protected `TILA_HOME` config, or use a verified same-account value through the private mechanism. Never set/rotate production secrets to satisfy release tests. The helper copies `~/.tila/.env`; absent source files are a real block, even if an ambient token becomes valid.
5. Run `pnpm install --frozen-lockfile` in the owned checkout when scheduling allows. Confirm free disk/process capacity for isolated build, compiled artifacts and Cloudflare runtime; no deployed service is needed for `pnpm test:runtime`.

**Check:** clean release checkout from known main; policy `pr`; tools/install usable; authenticated GitHub access; valid configured Cloudflare credential and verified intended account/exclusion inventory, no target ambiguity; private vars path reported. Current result: **blocked, not passed**. Record missing inputs and remain in readiness preparation until resolved. No bump, push or rehearsal dispatch while this Check is incomplete.

### 2. Inventory, freeze and version

After preflight, reconcile the pending table with the lead. Inventory actual commits/PR bodies since the previous **published** tag, not simply the nearest possibly unpublished tag. Save the full source list and PR impact sections to `$RD/prs.md`; enumerate changes to migrations, schemas, public SDK declarations, workflows and lockfile. Read final #440/#448 behavior and notes from merged source, not this plan's anticipated contract.

Freeze exactly one freshly fetched main commit and immediately persist `FREEZE`. Require GitHub MERGED plus `git merge-base --is-ancestor <merge-sha> origin/main` for every included PR; persist merge SHAs and final excluded items/reasons. The release branch starts at this commit; do not cherry-pick unfinished work or borrow a worker's build output. If main advanced since checkout creation, review the difference and deliberately reselect the still-clean candidate before metadata, never reset tracked edits. Declare the accepted source manifest to the lead. Later code additions require reopening the freeze.

Recheck tag/release/eleven package versions; apply the table to the complete residual diff. Record `LAST=v0.8.0`, `V=0.9.0`, `VTAG=090` only if still correct, and persist the unique `SLUG`. A release already published elsewhere changes these values and restarts inventory; never overwrite a version on npm.

**Check:** complete reviewed merged-source manifest; all feasible pending fixes merged or explicitly dispositioned; no invented live acceptance; version justified and available. Expected recommendation is **0.9.0**, not an automatic fixed value.

### 3. Version metadata and upgrade notes

Run `./scripts/bump-version.sh "$V"`, `pnpm install --lockfile-only`, format only changed JSON with Biome, then `pnpm version:check` and `pnpm version:test`. Do not refresh unrelated dependencies. Lockstep covers the root marker, `tila-cli`, eight `tila-cli-*` platform packages, `tila-sdk`, `tila-mcp-server`, MCP `server.json`, CLI platform pins and the Homebrew formula metadata. Eleven npm packages are public; private `@tila/*` packages are not separately bumped. Formula metadata changes do not elect tap publication.

Draft Keep a Changelog content below Unreleased, group user-visible changes by feature area with PR references, update comparison links and README status/primary upgrade instruction. Answer the reference's entire upgrade checklist. At minimum include:

| Area | Required truthful upgrade instructions |
| --- | --- |
| D1/DO | Inventory final migration range. At planning base, new D1 files are **0035 and 0036**, no new DO migration beyond already released 42. Do not call 42 new. Apply all pending D1 migrations in order **before** Worker upload; normal target-verified `tila deploy` does so. `--no-migrate` must refuse pending migrations. Migration files are not one atomic transaction; preserve recovery/rerun instructions and do not recommend restoring a whole D1 snapshot as revision-safe rollback |
| #439 | `0036_service_identity_revisions.sql` adds revision 1 defaults to existing/new service accounts and workload bindings, plus retained watermark tracking after 0035. Update responses expose revisions; stale supplied revisions return 412, absent targets 404. Legacy omission remains unconditional and increments revision; revocation is not revision-guarded. Metadata restore assigns above retained destination history; old archives remain supported. Whole-database rollback is outside that protection |
| #416 | Revisionless definition applies still work but **warn visibly and journal** writes now; strict revision enforcement is a later change, not enabled here. Describe the committed transactional journal event, nochange warning without fictitious write, replay/old-receipt compatibility, CLI JSON diagnostics on stderr, MCP diagnostics and SDK warning sink containment. Tell integrators to send the reviewed revision and preserve exact payload/idempotency key across ambiguous retries |
| #440 | Deploy Worker and bundled UI **before** clients/configuration using new Actions issuer/host context. Explain optional validated `GITHUB_ACTIONS_TRUSTED_ISSUERS`, built-in GitHub.com default, exact issuer/host/repository separation, current policy/trust checks after exchange, sponsor-bound descendants/recovery and isolated JWKS cache. Old servers can drop new context; do not enable GHES clients against them. **Pre-fix contextless Actions personal enrollments cannot be retrospectively attributed**: identify affected enrollments and revoke/re-enroll through existing controls; do not blanket-revoke human/generic-OIDC enrollments or claim an automatic repair. Trust removal and policy narrowing must affect retained-context descendants. No new secret is implied by optional trusted issuer configuration |
| #448 | Name final merged format/commands. Planned `tila-project-settings` v1 envelope separates optional definitions from agents/rooms/signal groups; original definition-only v1 stays compatible. Require explicit mapping/drop of every identity before writes. Source revisions are provenance, not destination preconditions. Explain partial per-resource commits, exact reviewed resume receipt, and lack of cross-resource rollback. Exclude credentials, memberships, access policy, enrollments and runtime/message/lease data; permission omissions must be visible |
| #399 / readiness | Explain remote/local blocked/outcome filters and honest totals/cursors/outcome scope if fully delivered. Preserve additive compatibility and legacy blocked-count explanation; no auth/local-mode retirement claim |
| #450 / target safety | Deploy now verifies chosen installation/account/Worker/D1/R2 and routing before mutation; `--infra` does not bypass verification. Normal deploy preserves existing secrets. A dry-run validates the embedded payload **without contacting Cloudflare**, so it is not target-authorization proof |
| Remaining operations | Audit capabilities/reissue requirements, response/type changes, backup required-feature/version compatibility, new variables/secrets and disabled-by-default behavior against final PR bodies. Keep #307 activation/HASH_PEPPER outside the release; never imply #283/#308/#194 passed. Existing cursor/readiness/identity features may be operational prerequisites but are not all new since 0.8.0 |

**Check:** metadata diff limited to intended package JSON, server.json, lockfile, formula, CHANGELOG and README. JSON changes are version-only. All migration/API/auth/backup/deploy notes reflect final source; no unreviewed application fix or future-support claim slipped in.

### 4. Commit, push and dispatch non-publishing rehearsal

Only after steps 1–3 pass, commit metadata as `build(release): prepare tila <version>` and notes separately as `docs(release): document tila <version> upgrade` to honor AGENTS' one-type-per-commit rule. Stage exact reviewed files; hooks must pass. Ensure no source drift or untracked secret/build output is staged. Push the release branch, record final `RELEASE_COMMIT` immediately, and dispatch `gh workflow run release.yml --ref "$BRANCH"`.

Find the actual `workflow_dispatch` run with matching branch **and full `headSha == RELEASE_COMMIT`**, not merely the newest run. Persist nonempty `REHEARSAL_RUN` and its URL. Inspect jobs/trigger: manual dispatch cannot run `npm-publish`, `github-release` or Homebrew. Report status while it runs; no waiting call exceeds 60 seconds.

**Check:** committed clean source and metadata; exact run/commit match; rehearsal started with publishing excluded. If dispatch points at another head, stop and identify the mismatch; no stale run may satisfy this candidate.

### 5. Local gates — Operations Gates 2 and 3

Coordinate a heavy-test window with the lead; execute in the release checkout, log each status independently and preserve the failing command's exit code through log capture:

```sh
# Start this block with source <literal-private-RD>/vars.sh.
pnpm run typecheck
pnpm lint
pnpm run check
git diff --exit-code
env -i HOME="$HOME" PATH="$PATH" pnpm test
env -i HOME="$HOME" PATH="$PATH" pnpm run test:scripts
pnpm test:runtime
pnpm version:check
pnpm version:test
```

Use clean environment isolation so live connector/session credentials and the invalid ambient token cannot affect fixtures. Do not skip required Cloudflare runtime cases/TODOs or remove distribution tests to save time. Record actual package/task/test counts, not prior branch totals. The formatter is a gate: if it changes files, review, commit by type, mint a new candidate SHA and restart affected evidence; don't treat its exit zero as an unchanged checkout. Inspect generated files before deleting only owned reproducible outputs; never globally clean other worktrees.

Review targeted builder evidence against the merged source and run necessary integrated regressions: #399 HTTP/Node/Bun local paging and filters; #416 journal/receipt/nochange/managed guard and warning sinks plus strict public declaration consumers; #439 migration/restore revisions; #440 exchange/session/credential/runtime/enrollment recovery/trust removal/JWKS atomic refresh; #448 identity mapping, hidden fields, zero-write preflight, partial replay and revision races; #450 wrong-target/no-migrate/secret-preservation behavior. Package commands/test paths must come from the final merged package scripts; retain the full runtime gate even when focused tests pass.

Packed checks must use built public packages, clean package-only consumers and ESM/CJS TypeScript resolution with no monorepo path aliases. For a focused MCP tarball use **`pnpm --dir packages/mcp-server pack`**, not pnpm 9's failing `--filter ... pack`. The release payload itself is produced by `scripts/release-pack.mjs` and checked by `scripts/release-verify.mjs`; do not substitute ad hoc tarballs for its manifest. Verify SDK declaration rollup has no inaccessible private workspace/nested dependency type references, including PR312's portable declarations. Record actual tarball size/content changes, not stale #449 baseline sizes as acceptance.

**Check:** every required command passes with counts/logs, formatting leaves no tracked diff, targeted integrated concerns resolved and candidate identity unchanged. A failure is a hard stop with diagnostics and a bounded correction proposal; no independent bump/retry around a failed gate.

### 6. Disposable live gates — Operations Gates 1 and 4

This is nonproduction infrastructure only, after all earlier Checks. Use the skill helpers from the frozen candidate in a detached `$RD/wt-gates`; install frozen dependencies and build there. Immediately persist `REPO`, `S` (that checkout's skill scripts), `GATE_HOME`, `RESULTS`, optional previous-checkout variables, and each provisioned resource identity. Confirm no production paths or IDs are used before **every** mutation, including teardown. A private directory is not itself proof of target isolation.

Never use `tila infra provision`, normal infrastructure teardown, or `wrangler dev --remote` for these gates: normal provision hard-codes production D1/R2 names. The skill helper validates its slug and rejects known production resources, but additionally verify exact account and run ownership from step 1. No production deployment or secret changes are authorized. Fresh disposable Worker secrets created by the helper are part of the gate fixture, not production rotation.

1. Run `env -u CLOUDFLARE_API_TOKEN TILA_HOME="$GATE_HOME" bun --tsconfig-override "$REPO/tsconfig.json" "$S/provision-gate-infra.ts" --slug "$SLUG"` with output redirected to private `$RD/provision.log`. Protect copied secrets. Extract only non-secret Worker URL/resource identities into vars; never print whole config or provision logs indiscriminately. Verify returned D1/bucket/Worker belong to this run and intended account. If partial provisioning fails, inventory and clean only resources positively owned by this run; preserve the original failure.
2. Poll the gate Worker's **`/api/health`** with a bounded deadline; require exact `version == V` and full `commit == RELEASE_COMMIT`. A healthy old version does not pass. Record health, account/resource identities, actual client OS/tool versions and observed colo/network context.
3. Create a throwaway git project under `$RD/proj` using the candidate CLI, `TILA_HOME="$GATE_HOME"`, `project create --name tila-bench-<run-id> --skip-github --json`. Clear unrelated ambient auth/target selectors, verify configured endpoint, redirect to mode-0600 `$RD/project.json`, and immediately persist `PROJECT_ID`. `.result.token` is a full-scope credential: never print, commit or share it with builders.
4. Gate 1: in the gate checkout, `env -i HOME="$HOME" PATH="$PATH" TILA_BASE_URL="$WORKER_URL" TILA_PROJECT_ID="$PROJECT_ID" TILA_TOKEN="$(jq -r .result.token "$RD/project.json")" pnpm --filter @tila/integration-tests exec vitest run src/do-eviction.test.ts`. Require all **3 tests**, acknowledged write survival across DO restart and subsequent reads. The latency threshold is advisory, not permission to skip persistence assertions.
5. Gate 4: `"$S/run-gate-bench.sh" full "$WORKER_URL" "$PROJECT_ID" "$RD/project.json" "$RESULTS"`, logged privately. Require six-scenario matrix at 8 participants, 30s measured/5s warmup, owner-contention at 24, 500ms cadence at 6, and cold-start samples. Do not silently shorten durations. The helper prints `MATRIX`, `OWNER`, `CADENCE`, `COLD` EXIT values but can itself exit zero after a failed benchmark: require all four records and all values zero, complete raw JSON, **zero failed invariants and zero unexpected errors**. Expected claim conflicts/stale fences are classified by the harness, not manually excused errors.
6. Generate tables with `pnpm bench:report -- --in "$RESULTS" --out "$RD/baseline-tables.md"`; count raw invariant/results/cadence fields and retain the exact regeneration command. Compare acquire/update/send/replay p95, owner-contention acquire p95 and cold-first-request p50 to the prior baseline. More than roughly 25% worse p95 or doubled cold p50 triggers A/B investigation; missed cadence deadlines are reported advisories. The 0.8.0 baseline was macOS/M3 Pro/WAW; this planning host is Linux x86_64. Do not attribute cross-machine/day differences to code without comparison.
7. Conditional A/B: detached `$LAST` at `$RD/wt-prev`, separate private home, Worker and DO namespace (`${SLUG}ab`). The reference shares only this run's disposable D1/R2. First inspect actual migration compatibility; 0035/0036 are additive, but do not generalize that every future migration permits older code. If unsafe, stop and propose independently provisioned disposable stores or another bounded comparison. Run the reference's previous/current alternating rounds; inspect raw JSON and command statuses because `AB EXIT 0` alone is not evidence of successful inner commands. If B is consistently slower, stop/report the likely code regression; if environmental, retain the comparison and explain the advisory.
8. Cleanup on success **or failure**: destroy each run-owned project with its corresponding home/CLI and exact endpoint, expecting `stores` do/r2/d1/local all `ok` and `failures: []`. Then `TILA_HOME="$GATE_HOME" "$S/teardown-gate-infra.sh"` with the positively identified A/B Worker argument only if created. Preserve cleanup logs and verify Worker/D1/bucket absence via authenticated inventory. An HTTP denial or generic `success:false` is not proof of absence. Verify the pre-recorded production D1 remains present and production resource identities remain untouched. If cleanup fails, stop, record residual resource IDs privately and escalate; never broaden deletion scope.
9. Copy non-secret raw benchmark results to `$MAIN/packages/bench/results/` (gitignored) and preserve sanitized receipts before removing only this run's detached worktrees/homes/token files. Inspect ownership and paths before force removal; do not run generic root cleanup. Retain private RD/vars for remaining release steps, with tokens removed when no longer needed.

**Check:** exact candidate health, Gate 1 3/3, complete Gate 4 matrix with all exits/invariants/errors passing, explained advisory/A/B results, raw evidence retained and independently verified disposable cleanup. No live result is currently available; this plan claims none.

### 7. Baseline, packed rehearsal, PR body and independent review

Write `docs/benchmarks/BASELINE.md` only from the completed run: release/tested SHA, client and colo, actual operations/invariants/errors, matrix tables, cadence, cold metrics, A/B explanation, cleanup proof and raw-result regeneration. Commit as a separate `docs(bench): record tila <version> release baseline`. Have `lead-backlog` cold-read changelog, README and upgrade notes twice (facts/omissions, then user clarity) without adding another worker. Commit corrections by type.

Require every rehearsal job at the **recorded source SHA** to pass:

| Job | Required payload/behavior |
| --- | --- |
| `validate-build` | Fresh toolchain/build cache, lint/types/package tests/root scripts/Cloudflare runtime/audit/build; compile all eight targets with one matching Worker/UI sidecar; pack eleven npm artifacts; validate manifest revision/checksums |
| `consumers` | Node 22 and 24 × SQLite 12.10.0 and 13.0.3, clean packed SDK/CLI/MCP consumers, real local SQLite persistence, ESM/CJS and dependency resolution |
| `platforms` | Linux x64/arm64, macOS x64/arm64, Windows x64/arm64 on native runners; installed binary/npm CLI/native addon and local installer fixture; no cross-compile-only substitute |
| `musl` | Linux x64-musl and arm64-musl in native-architecture Alpine; executable payload/persistence checks |
| `attest` | Provenance for tested binaries/tarballs/manifest/checksums plus per-target SBOM; verification matches repository/workflow and source SHA |
| Publishing jobs | `npm-publish`, `github-release`, Homebrew **skipped** for manual dispatch |

The smoke script requires raw binary, installed binary and npm CLI `deploy --dry-run --json` to report matching embedded version, D1 migrations and bundled UI. Confirm output manifest full SHA, eight target names, all eleven package versions/integrities, empty production UI API override, and no host-specific build/config leakage. MCP smoke uses a fake managed broker/stdio discovery and rejection after broker revocation, never real native account credentials. Do not remove fixtures to simplify release validation. These packed tests supplement the target-selection regression tests; dry-run deliberately makes no Cloudflare calls.

Manual rehearsal and a later tag workflow are separate runs. A tag run will build/test its own exact merged SHA. **Within each run**, publish only its tested and attested tarballs/binaries, without rebuilding between tests and publication. Do not imply that manual rehearsal artifacts are automatically the bytes of a later tag run. Download/inspect manifests as needed; artifact retention is seven days, so record age and availability.

Prepare `$RD/pr-body.md` using the skill template: summary, exact tests/counts and run URLs, migration/schema/API/auth/persistence/UI/deployment implications of the release range, tested SHA versus final docs-only head, live baseline and honest limitations. Distinguish release metadata diff from upgrade effects of included product changes. No TODO/pass placeholders, secret snippets, or AI/tool/agent mentions in commit/PR/changelog prose.

**Check:** required rehearsal jobs succeeded and publishing skipped; baseline is factual; notes and PR body reviewed by lead. Source-bearing changes after `RELEASE_COMMIT` invalidate earlier evidence under the rules below. Only reviewed documentary changes may remain beyond that tested source.

### 8. Release PR through Mergify and actual-state verification

Push reviewed documentation commits and create/update a non-draft PR targeting main with title `build(release): prepare tila <version>` and `--body-file "$RD/pr-body.md"`; persist PR number/URL. Respect any lead review hold. Once local/live/rehearsal gates and review pass, disable GitHub auto-merge if present, then apply `merge-ready`. Do not directly merge or use `gh pr merge --auto`.

Inspect actual Mergify queue/check state. A neutral “Merge queue is ready” means eligible, not queued. Report eligible/queued/integrating/blocked/merged accurately, including queue PR/check evidence. Do not rebase a waiting PR merely because main advanced; Mergify owns queue updates. Remove `merge-ready` before any correction/conflict edit, validate and push, then reapply it. A stalled/failed handoff is reported, not bypassed.

On reported merge, record `MERGE` immediately and independently confirm (1) GitHub PR state MERGED with that merge commit, (2) fetched `origin/main` contains it via `git merge-base --is-ancestor "$MERGE" origin/main`, and (3) public version markers at `MERGE` equal `V`. Compare the **actual merged source** against the gated candidate, not just the release PR diff. Review all intervening main changes using the source-drift rules. Never tag a convenient latest main or a PR head instead of the reviewed merged SHA.

**Check:** exact merged commit confirmed by GitHub and branch history, correct lockstep version and accepted source evidence, no unresolved queue failure or drift. This is release preparation complete, **not published**.

### 9. Final tag/publication authorization checkpoint — not authorized now

Stop here and present a concrete dossier: proposed `v$V`, exact `MERGE`, included/excluded scope, migration and upgrade instructions, local/runtime/packed/native/live evidence with tested SHAs, source-equivalence assessment, cleanup confirmation and remaining limitations. Only then request explicit tag/publication authorization. Do not ask while preflight or builders are unfinished. The user has elected preparation, not publication.

After explicit authorization only, verify the tag is absent, create the annotated version tag at the approved **MERGE**, and push that exact tag. This triggers irreversible registry publication after workflow gates. Persist `TAG_RUN` matched by tag and exact head SHA; verify tag target/main ancestry via `release-validate.mjs` and monitor all required jobs. If a new correction is needed, do not move a published tag or republish different bytes under an existing version.

**Check after authorization:** exact tag workflow succeeds. A repeat attempt must preserve release provenance; do not bypass failing tests or rebuild a partially published payload locally.

### 10. Publication verification — conditional on step 9 authorization

Verify all eleven npm packages expose version `V` and intended `latest=V`, integrity matches that run's tested manifest, GitHub release is public at the correct tag with expected binaries/installers/manifest/SBOM assets, and attestations verify the tested source. Account for registry propagation with bounded retries. npm publication precedes GitHub release; a partial failure is not success. Use the skill's failed-job retry against retained same-run artifacts (seven-day retention), checking already published integrities; if artifacts expired or differ, stop for recovery rather than rebuilding different bytes into an existing version. Homebrew remains disabled unless separately elected and configured.

**Check:** public state independently matches the authorized version/commit/artifacts across registry and GitHub, with remaining manual distribution steps stated.

### 11. Wrap-up

Report version/tag/merge and workflow URLs, exact verification results, upgrade instructions and remaining live/product gates. Preserve sanitized evidence; remove only owned disposable worktrees and private credentials when no longer needed. Update the release ledger truthfully. Production deployment remains a separate operator action with explicit target verification and authorization; release success does not enable conversations, rotate HASH_PEPPER or close #283/#308/#194/#292. If scope stops at preparation, report the merged release PR and **awaiting publication decision**, without marking steps 9–10 complete.

## Source drift, correction ownership and escalation

Maintain a source manifest at `FREEZE`, `RELEASE_COMMIT`, final PR head and `MERGE`. Compare full trees, including packages, scripts, root build/config, lockfile, workflows, migrations, release policy and skill helper inputs. A directory name alone does not establish harmlessness: README/package documentation can enter tarballs. Record exact permitted documentation-only deltas and their packaging effect; never claim byte equality when a file differs.

| Change / failure | Required action |
| --- | --- |
| Pure baseline or explanatory documentation after tested candidate | Lead reviews exact diff; keep tested source SHA explicit. No product/runtime gate rerun solely for wording. Any packaging change still needs matching pack/manifest verification; tag workflow validates its own final bytes |
| Application, schema, migration, dependency, public type, build configuration, release workflow or executable helper change | Remove merge-ready if applied; route application fixes to the appropriate issue-isolated coding worker. Reopen freeze, record new candidate, rerun local/runtime and manual rehearsal; repeat live gates against the new source SHA. No old exact-SHA live receipt is relabelled as new evidence |
| Main advances while queued | Let Mergify update/integrate. After merge inspect actual aggregate delta. If code differs from gated candidate, do not tag; establish a clean detached checkout at exact MERGE, repeat gates/rehearsal/live at that SHA. Dispatch rehearsal through a temporary branch pinned to that commit and verify run headSha; never create a tag just to obtain a rehearsal ref. Persist any new baseline documentation through a reviewed PR; assess its final merge by the same rule |
| Version or published state changes elsewhere | Stop metadata/publication progression; re-inventory and select an unused version. Never amend an existing public release in place |
| Missing credentials/account identity or ambiguous disposable resource ownership | Stop before mutation; request the exact private input/correction through the lead. Continue docs-only readiness work. Never infer credentials from another worker's environment |
| Hard test/invariant failure, authorization hole, migration incompatibility or confirmed A/B regression | Preserve evidence, clean owned infrastructure, report a bounded correction to lead/user per skill. No gate waiver, additional authority or production experiment |
| Rehearsal/queue failure or unavailable native runner | Keep status blocked/pending with run URL and cause. Only a justified same-commit retry can reuse source evidence; never count skipped required jobs as passed |
| Cleanup failure | Report exact owned leftovers privately; retry only verified run-owned resources. Do not treat script exit zero or permission-denied lookup as teardown proof |

Release worker may fix release metadata/evidence mistakes in its own checkout with separate conventional commit types. Source fixes remain issue-isolated and within the three coding slots; coordinate through the lead rather than opening an unreviewed fourth application effort. No independent worker orchestration is authorized by this plan.

## Progress ledger and dispatch brief

Update states through `pending → preparing/running → passed` or `blocked`; record evidence before advancing. Snapshot observations above remain historical, while this ledger may change with new evidence. `merged` requires GitHub state, exact merge SHA and main ancestry; `published` additionally requires registry/release verification. No immutable “must remain pending” assertion prevents progress.

| Deliverable | Current state | Evidence / exit condition |
| --- | --- | --- |
| Release election and worker allocation | Preparation elected | User authorized fourth `release-prepare-sol`; lead owns layout/dispatch |
| Planning artifact | Ready for lead review on local commit | This document; docs-only branch based ff7bdf3d; no release mutations |
| Readiness checkout | Prepared by lead | `/home/dawid/code/tila-workers/release-readiness`, `docs/release-readiness`, base bbe0252d |
| Step 1 preflight | **Blocked** | Missing private operator files and verified account/exclusion configuration; ambient credential probes 401/403; final source still pending |
| Independent inventory/notes | Initial inventory prepared | Recommendation 0.9.0; update #399/#440/#448/#416/PR312 and any feasible runbook work before freeze |
| Step 2 frozen scope/version | Pending | Full accepted/deferred list, actual release baseline and persisted FREEZE/LAST/V |
| Step 3 metadata | Pending | No version edits made by planner |
| Step 4 rehearsal | Pending | No branch push or dispatch performed |
| Step 5 local/packed/runtime gates | Pending | Planner ran no application tests; no prior builder result is substituted |
| Step 6 live gates/cleanup | Blocked on preflight, not executed | Exact SHA health, Gate 1 and Gate 4 receipts, conditional A/B, cleanup proof |
| Step 7 notes/baseline/rehearsal review | Pending | Lead cold read and actual complete evidence |
| Step 8 Mergify handoff | Pending | No release PR created; future queue and merge evidence required |
| Steps 9–10 publication | **Not authorized** | Future exact-version/exact-merge decision, only after concrete preparation is complete |
| Production deployment/#307 activation | **Not authorized** | Separate operational decision; never inferred from release election |

**Immediate brief for `release-prepare-sol`:** work only in the lead-created `release-readiness` docs branch while preflight is blocked. Read this plan and current skill/references; establish a private readiness dossier/vars path immediately and send its path to the lead. Keep secrets out of docs. Reconcile each newly merged PR against GitHub and fetched main; maintain a concise scope/migration/API matrix and draft 0.9.0 upgrade notes, with pending material labelled conditional. Produce the exact missing credential/account/production-exclusion handoff and a source-backed gate checklist. Do not bump, push, dispatch workflows, provision infrastructure, tag or deploy in this readiness assignment. Lead reviews readiness docs and releases formal execution only after preflight inputs and feasible coding work are resolved. Later use fresh `release-next` from the accepted frozen main, not this docs branch as release source.

**Remaining inputs for the lead:** a valid privately configured Cloudflare token and intended account/production-exclusion inventory; disposition and merge evidence for pending feasible changes; final #440 contextless-enrollment operational note and #448 merged format/commands. No current version-policy ambiguity is identified. Native/product-study resources remain separate open acceptance inputs, and tag/publication approval is deliberately deferred until there is a completed concrete dossier.
