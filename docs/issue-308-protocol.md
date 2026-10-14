# S1–S3 protocol and local preparation (#308)

Status: protocol and independent local fixtures only. This document predeclares
the journeys; it does not record live acceptance or close #308. Full S1 waits
for integrated #448 settings transfer. Authenticated S2/S3, #283's native
matrix and #307's operational readiness/activation disposition remain separate
gates. No deployment, production target, credential change or host seed is
part of the local driver.

## Actors and datasets

Use a disposable project per case, synthetic content and separate identities:
an owner, a plain coordinator, two participant workers, and a read-only reviewer.
The workers have distinct principals even if they use the same participant
label. A provider session, binding epoch, attempt fence and principal are
different identifiers. An owner permission never stands in for worker authority.
Test read restrictions and revoke membership while the detail drawer is open.
Local D1-issued test sessions exercise HTTP authorization; they are not proof
of authenticated native provider accounts.

S1 starts twice, in separate projects: zero definitions/data through the UI,
and a one-time synthetic TOML file. Use an empty declared type, a custom `bug`
type, an undeclared legacy type, 301 tasks with searchable titles, one record,
one artifact kind and one template. The local large-data case declares custom
`bug` and empty `empty` types and creates 301 tasks; legacy/catalog and mixed
search coverage also comes from existing UI/runtime suites. S2 uses two tasks,
two workers, two distinct questions and synthetic old/replacement sessions.
S3 uses an original terminal task/result plus a separate corrective hotfix and
an open question. Native runs must additionally declare OS/runtime/adapter
versions, non-secret profile aliases and account-distinctness verification.
Never publish account identifiers, credential locations or transcript bodies.

## Predeclared journeys

| Step | Action and injected failure | Required outcome / local foundation |
| --- | --- | --- |
| S1.1 | UI-only bootstrap; separate one-time file bootstrap; edit all ordinary definitions and identity/access settings | Current settings inventory in architecture §14.2; UI settings suites, runtime `project-bootstrap`, `definition-editor`, `settings-identities`, `settings-access`, `service-identity-revisions`. No assumption that a mock click proves browser-only acceptance. |
| S1.2 | Empty/custom/legacy types, 301 items, walk list/search pages through restart | Every expected ID exactly once; complete search, no 250-item truncation. UI tasks/search/catalog suites; `product-scenarios` runtime. |
| S1.3 | Semantic definition/settings export/import, explicit mappings, partial input, secret-bearing input | Preserve unrelated fields; reject secrets without echoing them; preview before applying. Existing definition transfer coverage only. Mapped non-secret settings transfer is blocked on #448's integrated UI/CLI/MCP surfaces. |
| S1.4 | Stale original file and simultaneous UI/CLI/MCP revisionful edits; legacy revisionless apply | One revisionful winner, other writes rejected; replay creates no duplicate revision. #416 compatibility path emits the deprecation warning and minimal journal event. Old clients are **not** all revision-enforced. HTTP contenders labelled UI/CLI/MCP in a fixture model request ordering only; real clients remain a live journey. |
| S1.5 | Restore history, keep draft during conflict, fail secondary fetch | Restore is a new revision; draft survives; failure remains unknown/partial. UI editor/history and overview foundations, runtime schema revision/restore suites. |
| S2.1 | Assign and accept as independently authenticated workers | Durable identity stays distinct from provider session, epoch and fence; wrong principal/participant cannot use another grant. HTTP authority suites plus composed local fixture. |
| S2.2 | Ask two distinct questions, answer one, escalate the other, answer while requester is offline | Persist both questions/routing/acknowledged answers; replay after DO eviction gives one logical effect. Reuse `questions`, `question-api` and composed local fixture. |
| S2.3 | Mac→Linux and Linux→Mac, Mac outage, busy draft, replacement/reconnect | Native correlated evidence required; reuse #283 evidence, do not repeat isolated transport experiments as live proof. Local eviction/session replacement is only persistence evidence. |
| S2.4 | Submit explicit artifact-linked result; stale old fence and wrong account submit | Reject crossover/stale authority; session attach/delivery/reconnect never completes a task. Runtime authority/continuity and artifact suites. Native result must link an actual content-addressed artifact. Synthetic fixture evidence references are not uploaded artifacts. |
| S3.1 | Blocked/failed attention leads to hotfix; change settings mid-attempt | Explicit unknown/partial source failures, current settings govern finish; do not authorize from captured settings. Overview and attempt-continuity suites. |
| S3.2 | Cancellation/result/replacement/late answer in both orderings | Preserve an acknowledged answer as evidence even when no longer applicable; reject retired grants, retain immutable terminal result; duplicate replay adds no decision/result. Existing race/authority suites plus composed local fixture. |
| S3.3 | Explicit completion and corrective work; read-only reviewer, revoke while drawer is open | Corrections link to original immutable terminal result; permission loss stops mutation and privileged reads. UI work/decisions/runtime suites, HTTP question membership and corrections suites. |
| S3.4 | Reconstruct journal after restart; fail readiness prerequisites | Retain original result and accepted decisions in audit; readiness failure stays failed/unavailable. Runtime readiness and replay suites. |

Local fixtures assert four hard gates: zero silent settings overwrites (revisionful
conflicts are rejected; legacy changes require explicit warning/journal evidence),
zero lost acknowledged decisions, zero accepted stale-authority
writes, and zero completions inferred from delivery/runtime. A passing suite
means its assertions passed on its stated dataset, not that an unexecuted
journey passed. A failed gate needs a bounded corrective issue/slice and remains
failed until a linked retest; retain the first failure and every rerun.

## Comparison protocol (#194)

Before measured execution, #194's study owner must agree the paired rubric,
repository shape, task list, participants, environments, runtime versions and
counterbalanced order of with-tila / baseline runs. Reset independent projects
between pairs. Keep workload, failure schedule and available information equal;
declare differences and interventions. Do not score this preparation as a study.

Record setup action count and elapsed time (start setup → usable project),
blocked-work diagnosis time (visible injected blockage → correct diagnosis),
recovery time (outage/replacement → first authorized resumed action), logical
duplicates, lost acknowledged decisions, stale writes rejected, and operator
interventions. #194 additionally owns conflicting attempts avoided, handoff
completeness, task success, representative MCP call/token costs and compaction
or machine-change recovery. Timings carry dataset/environment and raw event
timestamps; absent measurements are null, never zero. Report failures and
limitations, paired outcomes and sample count; no universal latency SLA or
causal benefit inferred from fixture duration. Suite elapsed time is validation
cost only.

## Evidence contract

Each observation has `{scenario, step, provenance, result, candidate_sha,
release, migrations, environment, timestamps, artifact_refs, blocker_owner}`.
The driver validates this shape with `validateObservation` in
`scripts/issue-308-scenarios.mjs`; its tests exercise invalid provenance,
missing metadata, checksum tampering and failure retention. Additional fields
include an observation ID, exact command, source-tree checksum, measurement
slots and rerun link. Provenance is exactly `unit/fixture`,
`local Cloudflare runtime`, `isolated host probe`, or `authenticated live`.
Results are `passed`, `failed`, `blocked` or `not-run`. Blocked/failed records
have a product issue/suite owner and prerequisite/reason. The local driver
cannot emit host/live acceptance. Its suite observations aggregate assertions;
their logs retain individual test names and failures, not individual usability
measurements. No conclusion extends beyond the command's coverage.

Metadata includes exact git SHA and product release, checksummed DO/D1 migration
files and Worker config, OS/architecture, Node/pnpm and local runtime package
versions, test-only profile declaration, ISO start/end times, and relative
artifact references with SHA-256. Migration metadata describes local test setup
(D1/DO/R2), never deployed migration state. Dirty source is rejected. Retained
preflight failure excerpts explicitly mark unavailable execution timestamps as
null and provide their recording time and limitation; no duration is inferred.
Generated
versions and evidence outputs are excluded from the source checksum; this
allows an evidence-only commit while preserving which source was tested.

Each run gets a new exclusively-created directory and append-only JSONL ledger;
the complete JSON summary can be rebuilt from that ledger if interrupted.
Use `--previous <report>` to link a rerun; never replace the earlier directory.
Logs are redacted before storage (workspace/user paths and credentials).
Runtime JSON reports are copied and sanitized before another suite can replace
the shared report; an earlier report is never attached to a command that did
not start. Review sanitized logs before publishing. Checksums cover the stored
sanitized bytes. Keep missing
dependencies and failed commands in the ledger. A suite process exit alone is
not sufficient for the required runtime gate: `pnpm test:runtime` also validates
its report, rejects skipped/TODO tests and requires all assertions to pass.

## Runnable local preparation

From a dependency-installed checkout (`pnpm install`), with no dev service or
credentials required:

```sh
node --test scripts/issue-308-scenarios.test.mjs
node scripts/issue-308-scenarios.mjs --list
node scripts/issue-308-scenarios.mjs --run --output .ci-reports/issue-308
# Repeat without deleting the failure; link the previous report explicitly:
node scripts/issue-308-scenarios.mjs --run --output .ci-reports/issue-308 --previous .ci-reports/issue-308/<run>/report.json
# Target S1 after a fixture correction, before repeating the full driver:
env -i HOME="$HOME" PATH="$PATH" pnpm --filter @tila/integration-tests exec vitest run --config vitest.runtime.config.ts runtime/product-scenarios.test.ts -t S1
```

`--list` prints the exact fixed local commands: `pnpm build`, UI test/typecheck,
integration typecheck, S1/S2/S3 focused runtime suites, the mandatory full
`pnpm test:runtime` gate, `pnpm test:scripts`, and `pnpm lint` (including version
lockstep and test quality). Every child uses the equivalent of
`env -i HOME="$HOME" PATH="$PATH"`, preserving only those two quoted environment
values. This prevents ambient client/runtime configuration from changing test
behavior. For a direct root-script rerun use:

```sh
env -i HOME="$HOME" PATH="$PATH" pnpm test:scripts
```

No arbitrary target or command is accepted. The driver
continues after failures and exits nonzero if any command fails. It records
blocked full S1 and authenticated S2/S3 separately on every run. A missing
dependency is a failed observation, not a skip. For publication, explicitly
choose `--output docs/evidence/issue-308-local`; the path is constrained to those
two evidence roots. Keep all committed run directories, including failed ones.

Reusable historical sources:
[acceptance v3](evidence/issue-283-acceptance-v3.json) and
[isolated Herdr probes v2](evidence/issue-283-herdr-0-9-3-v2.json).
The driver records their checksums without republishing private profile details.
Their fixture/isolated probe successes and incomplete live matrix retain their
original dates/provenance. They are references, not fresh observations. Full
closure still requires agreed #194 rubric, integrated #448, authenticated
browser journeys, both real host directions, all #283 gates and verified #307
readiness/activation disposition.
