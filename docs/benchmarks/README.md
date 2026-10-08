# Coordination benchmarks

`packages/bench` (`@tila/bench`) is the versioned benchmark harness for the workload tila is built for: several independent coding sessions contending on one project's shared state. It answers the questions correctness tests cannot: throughput, tail latency, conflict and stale-fence rates under contention, and growth over long runs.

This document is the methodology and runbook. Measured numbers live in [BASELINE.md](BASELINE.md), rendered from raw JSON results that stay out of git (`packages/bench/results/`).

## Current baseline at a glance

From [BASELINE.md](BASELINE.md), 2026-10-08, harness 1.0.0, client in Warsaw (Cloudflare colo WAW), one principal, exclusive mode unless stated. Per-call latency in ms.

| Tier | Scenario | Participants | ops/s | p50 | p99 | Notes |
|---|---|---:|---:|---:|---:|---|
| deployed | claims-uncontended | 8 | 24.8 | 321 | 664 | 0 errors |
| deployed | claims-contended | 8 | 24.3 | 320 | 556 | 578 conflicts, 0 errors |
| deployed | claims-contended, 24 participants, exclusive | 24 | 34.8 | 678 | 1055 | 980 conflicts |
| deployed | claims-contended, 24 participants, owner | 24 | 34.3 | 715 | 1098 | 184 takeovers, 529 stale fences, journal audit: 0 fence regressions in 604 acquires |
| deployed | fenced-writes (tasks) | 8 | 25.9 | 297 | 589 | 82 stale fences, all recovered |
| deployed | presence-signals | 8 | 26.5 | 296 | 540 | every signal acknowledged |
| deployed | journal-replay | 8 | 26.8 | 293 | 549 | no gaps, no regressions |
| deployed | artifacts (1 KiB / 64 KiB / 1 MiB) | 8 | 14.7 | 480 | 1904 | 1 MiB uploads dominate the tail |
| deployed | claims-uncontended at 500 ms cadence | 6 | 12.0 | 276 | 660 | 6 of 360 paced calls missed the 500 ms deadline |
| deployed | cold-start | 1 | | 230 (cold) / 214 (warm) | | 5 restarts; cold first read ≈ +15–50 ms over warm |
| local wrangler dev | claims-uncontended | 8 | ~290 | 24 | 95 | loopback, miniflare D1/DO |
| inproc | claims-uncontended | 8 | ~4800 | 0.19 | 0.26 | DO router + SQLite only |
| embedded | claims-uncontended | 4 | ~3800 | 0.22 | 1.4 | ops-sqlite under Node |

Read the deployed rows as "every Worker call from this client costs roughly 300 ms"; the DO-side work is well under a millisecond (in-process rows), so the deployed cost is dominated by auth/D1 lookups, the two DO hops and network RTT. The 500 ms per-operation cadence target in `docs/01-DECISIONS.md` holds for ~98% of calls from Warsaw; the tail does not.

## What is measured

Every scenario drives the same SDK facade (`tila-sdk`) and times each facade call around the method. Outcomes are classified per call:

| Class | Meaning | Counted in error rate |
|---|---|---|
| `ok` | 2xx | no |
| `conflict` | 409 `already-held` or `conflict` (someone else holds it) | no |
| `stale_fence` | 409 `stale-fence` / `renew-failed`, 403 `release-ownership-denied` (your lease is no longer current) | no |
| `error` | anything else, including network and 5xx | yes |

The harness never retries. The SDK's `withRetry` is not used, so percentiles contain no backoff time. Scenarios that re-acquire after a stale fence emit that as a separate `reacquire` op so retries are visible, not hidden.

Latency percentiles come from a log-linear histogram (32 buckets per octave, so p50/p95/p99 carry at most ~3% relative error). Min, max, mean and count are exact. Throughput is recorded ops per second across all participants over the recorded window; warmup is excluded.

## Tiers

| Tier | What runs | What it measures | What it skips |
|---|---|---|---|
| `inproc` | Worker route modules + DO router over in-memory better-sqlite3, in one Node process | Worker-route + DO-router + SQLite cost; coordination semantics | auth, D1, idempotency and cache middleware, the transfer-status pre-flight DO call, Analytics Engine, network |
| `embedded` | `tila-sdk/local` (`EmbeddedProject`), one instance per participant on one SQLite file | raw ops-sqlite cost under Node | everything above the ops layer; participants interleave in one thread (synchronous driver), so contention is semantic, not parallel. Artifacts go through `writeText` (no multipart upload in local mode) |
| `http` | `TilaClient` per participant against a Worker URL | the full path: auth, D1 lookups, both DO hops, network. Against `wrangler dev` this is loopback + miniflare; against a deployment it is the real thing | nothing |

Only the `http` tier against a deployed Worker reflects production latency. The in-process tiers exist for CI, for isolating the DO/SQLite cost, and for cheap local comparisons.

## Scenarios

| Scenario | Workload | Reported extras |
|---|---|---|
| `claims-uncontended` | per-participant resource: acquire (exclusive) → renew ×3 → release. With `--cadence`, each iteration is a single call so the pacing applies per operation | with `--cadence 500ms`: `missed_cadence_deadlines` (tests the per-operation 500 ms cadence target in `docs/01-DECISIONS.md`) |
| `claims-contended` | all participants acquire/hold/release `--groups` hot resources. `--mode exclusive`: losers conflict. `--mode owner`: a different participant under the same principal takes over and bumps the fence; the displaced holder's release fails (`stale_fence`). `--principals K` spreads participants across K credentials; cross-principal owner attempts are conflicts | `takeovers`, `fence_regressions` |
| `fenced-writes` | `--target tasks`: each holder keeps an owner-mode claim on its task and updates it with the fence; a thief participant takes over a random claim every `--steal-every` iterations, so holders see 409 stale-fence and re-acquire. `--target records`: paired participants `set` one record with the fence they last saw; the loser refreshes and retries | `steals`, `reacquires` |
| `presence-signals` | heartbeat → participant-targeted signal to a random peer → inbox → ack everything pending | `inbox_backlog_max`, `signals_sent`, `signals_acked` |
| `journal-replay` | writers run claim cycles (two journal rows each) while readers page the journal with `replay(after_seq)` and `acknowledge` the durable cursor | `reader_lag_max/mean` (snapshot `through_seq` − acknowledged), `seq_gaps`, `seq_regressions` |
| `artifacts` | upload blobs of `--sizes` (default 1 KiB, 64 KiB, 1 MiB) with no claim, read metadata back, list every fifth op | `meta_size_mismatches`, `bytes_uploaded` |
| `cold-start` | `http` only, explicit: `POST /admin/restart` evicts the DO, then time the first summary read and three warm reads, `--cold-start-iterations` times | `restarts`; ops `cold_first_request` vs `warm_after_restart` |

`--scenario all` runs every scenario except `cold-start` one after another with all participants. `--scenario mix` runs `claims-contended`, `fenced-writes`, `presence-signals` and `journal-replay` concurrently on partitioned participants; it is the soak workload.

Every scenario ships invariants (exactly one winner per contended acquire, stale fences rejected, zero errors, monotonic journal pages, metadata byte counts). A run exits non-zero when any invariant fails. Absolute latency is never asserted.

Two measurement details matter when reading results:

- **Fence monotonicity is audited from the journal, not from responses.** Under concurrency a client sees acquire responses out of server order (the deployed owner-mode run observed 74 such reorders in 571 acquires), so `claims-contended` replays the journal in teardown and checks `claim.acquired` fences per resource in sequence order. `fence_reorders_observed` is informational; `journal_fence_regressions` is the invariant.
- **`cold-start` counts a 5xx from `POST /admin/restart` as a successful trigger.** The DO route aborts the object before its response is flushed, so Cloudflare reports the request as failed even though the eviction happened; the following `cold_first_request` proves the DO came back. Only 401/403/404 are errors.

## Same principal, different participant

Since #209 the principal comes from the credential and each session is told apart only by `X-Tila-Participant-Id`. The harness gives every virtual participant its own id on one token by default, which is exactly how two coding sessions on one machine share a key. `claims-contended --mode owner` and `fenced-writes` exercise the takeover semantics this implies; `--principals K` (with `TILA_BENCH_TOKENS` on the http tier) adds cross-principal contention.

## Running

```bash
pnpm bench -- list                                     # scenarios and tiers
pnpm bench -- --tier inproc --scenario all --participants 8 --duration 30s --warmup 5s --md
pnpm bench -- --tier embedded --scenario all --participants 4 --duration 30s
pnpm bench -- --tier inproc --scenario claims-contended --mode owner --participants 24
pnpm bench -- --tier inproc --scenario claims-uncontended --cadence 500ms --participants 6
```

Results go to `packages/bench/results/<tier>-<runId>.json` (gitignored) unless `--out` is given; `--md` writes a markdown rendering next to it. `pnpm bench -- --help` lists every flag.

### Local Worker (`wrangler dev`)

```bash
env -u CLOUDFLARE_ACCOUNT_ID pnpm dev:setup     # once; idempotent
pnpm dev                                        # separate terminal, Worker on :8787
TILA_BASE_URL=http://localhost:8787 TILA_TOKEN=tila_dev_token_localonly TILA_PROJECT_ID=dev-project \
  pnpm bench -- --tier http --scenario all --participants 8 --duration 30s --warmup 5s --md
```

### Deployed Cloudflare

Use a throwaway project so the benchmark journal and artifacts never land in a real project.

```bash
mkdir -p /tmp/tila-bench && cd /tmp/tila-bench && git init -q
tila project create --name tila-bench-$(date +%Y%m%d) --skip-github --json   # needs CLOUDFLARE_API_TOKEN (env or ~/.tila/.env)
# .tila/config.toml now holds worker_url and project_id; .tila/.env holds TILA_API_TOKEN (full scope)

export TILA_BASE_URL=https://<your-worker>.workers.dev
export TILA_TOKEN=<TILA_API_TOKEN from .tila/.env>
export TILA_PROJECT_ID=tila-bench-<date>
export TILA_BENCH_ALLOW_REMOTE=1
cd <repo>
pnpm bench -- --tier http --scenario all --participants 8 --duration 30s --warmup 5s --md
pnpm bench -- --tier http --scenario claims-contended --mode owner --participants 24 --duration 30s
pnpm bench -- --tier http --scenario claims-uncontended --cadence 500ms --participants 6 --duration 30s
pnpm bench -- --tier http --scenario cold-start --cold-start-iterations 5
pnpm bench:report -- --in packages/bench/results --out docs/benchmarks/BASELINE.md

cd /tmp/tila-bench && tila project destroy --force                            # removes the DO, R2 objects and D1 rows
```

Guards: any non-localhost base URL needs `TILA_BENCH_ALLOW_REMOTE=1`; more than 64 participants on the http tier needs `--allow-large`. The region is read from the `cf-ray` and `cf-placement` response headers; pass `--region` when they are absent. Keep deployed runs short: a 30 s run with 8 participants is roughly 10k requests against the Workers daily quota.

### Soak

```bash
pnpm bench -- --tier inproc --scenario mix --participants 8 --soak --duration 2h --sample-interval 30s --sweep-every 10m --md
SWEEP_SECRET=... pnpm bench -- --tier http --scenario mix --participants 8 --soak --duration 2h --sample-interval 60s --sweep-every 15m
```

Every sample records process RSS and heap, the backend row counts per domain table, and the database size in bytes (in-process and embedded tiers only; over HTTP `/admin/store-counts` exposes counts but not bytes). With `--sweep-every` the sampler runs the sweep step itself: in-process it calls `sweepOps.sweep` and times the journal-archive scan (which loads every archivable row into memory); over HTTP it posts to `/_internal/sweep`, which sweeps every project on that Worker, so only do that on a deployment you own.

## CI

`pnpm test` runs `packages/bench/test/smoke.test.ts`: every scenario in-process for a fixed iteration count, invariants only, a few seconds total. There is no Cloudflare credential in CI, so the deployed matrix is a release gate (`docs/05-OPERATIONS.md`, Pre-Tag Gates) and a step after any material coordination change, not a workflow. `.github/workflows/` is managed by the scaffold tool and is intentionally untouched.

## Publishing a baseline

1. Run the deployed matrix above (and the local Worker comparison if the change touches the Worker path).
2. `pnpm bench:report -- --in packages/bench/results --out docs/benchmarks/BASELINE.md`.
3. Commit `BASELINE.md`. Raw JSON stays local; attach it to the PR if a reviewer wants it.
4. Update the citations in `docs/01-DECISIONS.md`, `docs/02-ARCHITECTURE.md` and `docs/05-OPERATIONS.md` when a claim moves.

Bump `HARNESS_VERSION` in `packages/bench/src/result-schema.ts` whenever metric semantics change, so baselines from different harness versions are not compared blindly.

## Result file layout

Top level: `harness_version`, `schema_version`, `run_id`, timestamps, `git {sha, dirty}`, `tier`, `target {base_url_host, deployed, region, notes}`, `hardware`, `params`, `scenarios[]`, `soak`. Each scenario has `ops` (per-operation metrics), `totals`, `invariants`, `extra` (scenario counters) and `dataset`. The zod schema in `packages/bench/src/result-schema.ts` is the contract; `pnpm bench:report` refuses files that do not parse.
