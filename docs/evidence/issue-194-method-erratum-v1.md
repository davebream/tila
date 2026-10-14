# #194 local-MCP factual erratum, version 1

ID: `issue-194-local-mcp-erratum-v1`

Issued at: **2026-10-14T20:14:13Z**

Inspected source: **`8c788a220ab4497d2220f32385d619fe5242f8fc`**

Classification: **factual correction; no change to intervention, measurement,
scoring, exclusions or analysis**.

This append-only erratum accompanies the [v3 protocol](../14-DOGFOOD-STUDY-PROTOCOL.md).
The frozen rubrics and v3 declaration retain their original bytes, including the
erroneous clauses listed below. Any later correction requires a new erratum
version; this file does not amend a rubric or authorize a scored run.

## Immutable statements being corrected

These two clauses are false in each of v1, v2 and v3:

| JSON field | Original erroneous clause | Corrected fact |
|---|---|---|
| `metrics.mcp_calls.availability_rule` | “the local backend rejects MCP configuration, so this pilot records unavailable” | Explicit complete local MCP configuration is supported. This pilot selects CLI/SDK and disables MCP; the actual MCP workflow is not exercised, so B MCP counts remain unavailable/null. |
| `known_limitations[id=KL-no-local-cli-handoff].statement` | “the MCP server rejects local SQLite configuration” | The server accepts explicit complete local SQLite configuration. The selected SDK handoff/reentry method is unchanged. |

The unaffected portions of those statements and their handling rules retain their
declared meaning. In particular, this correction does not add a local CLI handoff
surface or change the study's SDK handling.

| Frozen rubric | Availability field line | Limitation statement line |
|---|---|---|
| [v1](issue-194-rubric-v1.json) | 310 | 440 |
| [v2](issue-194-rubric-v2.json) | 357 | 502 |
| [v3](issue-194-rubric-v3.json) | 367 | 512 |

Line locations refer to the inspected source above. The mutable protocol's metric
note and coverage-limit row, and the B reason in `deriveLedger().metrics.mcp_calls`,
are corrected to describe selection and non-exercise rather than lack of support.

## Source evidence and limits

- [Configuration](../../packages/mcp-server/src/config.ts), lines 29–80:
  `TILA_MODE=local` or `TILA_BACKEND=local` selects explicit local mode. It requires
  `TILA_PROJECT_ID` and absolute `TILA_DB_PATH` and `TILA_ARTIFACTS_PATH`.
  Nonempty remote credentials/API URL or run bindings are rejected in this mode.
  Bare local paths without explicit local mode are rejected (lines 81–91).
  These conditional rejections do not mean local MCP is unsupported.
- [Facade](../../packages/mcp-server/src/facade.ts), lines 40–65: the local branch
  constructs `createTila({ backend: "local", ... })` with local paths and participant
  metadata, without resolving a remote run.
- [Config test](../../packages/mcp-server/src/__tests__/config.test.ts), lines 46–74:
  incomplete local configuration fails, complete explicit local configuration
  resolves, and mixed remote authority fails.
- [Workflow tests](../../packages/mcp-server/src/__tests__/workflow-protocol.test.ts)
  exercise local facades over in-memory MCP transport, including handoff/reentry.
- [Packed executable test](../../packages/mcp-server/src/__tests__/settings-packed.test.ts),
  lines 10–87: explicit local configuration starts the packed executable over stdio,
  lists tools and exports schema. Settings export returns the specific
  `unsupported-backend` error. Dependencies are linked from the workspace; this is
  fixture coverage, not an isolated consumer installation, full local-MCP parity
  or a scored native-agent trial.

The explicit-local config and facade branches and config acceptance test already
exist at the first v3 declaration commit,
`5b8aaf9601ebb331f98397535498ff456dbd09f3`. The support explanation was false at
declaration, rather than becoming outdated because support was added later.

## Preserved identities

These are SHA-256 digests of the exact file bytes, unchanged from their first
commits (v1 `583907af`, v2 `59f64b79`, v3/declaration `5b8aaf96`):

| Artifact | File SHA-256 |
|---|---|
| [Rubric v1](issue-194-rubric-v1.json) | `819ae6483ccb60c1359ba55a642d73d6398adfcca4420ada626cdc13a49243d7` |
| [Rubric v2](issue-194-rubric-v2.json) | `d0bef5d5003856ba8c2b7998df0b31adb2623f1ad6b53c30b655632f40443956` |
| [Rubric v3](issue-194-rubric-v3.json) | `d9706a022131a5cb919c741a5e550f5f958332dc49af2f20d8a97a723702612f` |
| [Declaration v3](issue-194-manifest-v3.json) | `267802195cf1ffd4fbe7ef588f4cd85cff1245aca494f20399b86f30afcbf975` |

The distinct v3 canonical declaration-body digest is
`c5f54a3e1f0f07a8d311ce8580b52d7b3fc43611e11d536640e1ec9067f4cd4f`.
It hashes recursively key-sorted JSON excluding `declaration_sha256`, not the
declaration file bytes. No v1/v2 declaration is created by this correction.

## Unchanged method

Condition B continues to use CLI/SDK only; MCP remains disabled in both conditions.
A `mcp_calls` remains `not_applicable` with null and its existing reason. B remains
`unavailable` with null; only its explanatory reason changes. No absent MCP event
is converted to zero, and no MCP count or workflow token-cost comparison is claimed.
SDK/CLI covered operations remain SDK/CLI operations, not MCP calls.

Tasks, variants/allocation, worker packets/training, Sol/high, the 12-minute
window, 40 covered operations per base role including replacement, claim TTL,
schedule, gates, thresholds, exclusions, all four original denominators and
analysis remain unchanged. V3 paths/defaults, fixtures, counter logic and scoring
are retained. This correction supplies no readiness verdict or study result.

## Timing and observation exposure

This is a post-declaration correction. The retained-record inventory inspected at
issue time found an earlier **v2** `t1` event stream labelled `local_agent_trial`,
including `trial.started`, `worker.replaced` and `result.declared`, and a v2 `t2`
preparation record. No retained ledger or evaluation was found for that bundle.
Its completion, authenticity, validity and scoring are not established by this
inventory; a declared result event is not a validated score. Earlier trial activity
has therefore been seen, and this erratum does **not** claim issuance before the
first scored trial or before all observation.

The inventory also found prepared `w-A`/`w-B` warm-up records with scenario
`warmup-w`, `harness_fixture` provenance and only `trial.prepared` events. These
are unscored fixture preparations, not proof of installed-runtime smoke success.
No retained v3 scored bundle was found in the inspected workspace and scratch
locations. That bounded inventory cannot establish absence of runs elsewhere or
deleted records. Synthetic tests and support fixtures are separate from subject
observations; no scored trial was started to make this correction.

Original records, source, manifests and ledgers must remain intact. This correction
does not rescore earlier records or pool versions. A later explanatory projection
of an existing ledger must be a separate retained copy with original and analysis
source identities. Fresh final-source smoke and readiness checks, then a fresh
freeze, remain required before prospective v3 execution; older receipts cannot be
relabeled as validating the corrected source.
