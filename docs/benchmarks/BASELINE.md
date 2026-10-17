# Coordination benchmark baseline — v0.12.1 release validation

## Release gate summary (2026-10-17)

All live correctness gates passed on disposable Cloudflare infrastructure. The six-scenario matrix, 24-participant owner-contention run, six-participant 500 ms cadence control and five cold restarts recorded 9,779 operations with zero unexpected errors and all 24 invariants passed. A separate three-test persistence gate confirmed task data survived acknowledged Durable Object eviction and restart.

The gate Worker reported version `0.12.1` and commit `951afe21f8e64f20cef6c0b82915110e6fc35a5c` through `/api/health`. Its source checkout and benchmark results were clean. Later release commits change only README release labels and this baseline. The release adds no migrations or Worker coordination changes. Each validation round used its own disposable D1 database and R2 bucket; each Worker had its own Durable Object namespace. The benchmark client ran on macOS arm64 (Apple M3 Pro), and all deployments reported Cloudflare colo `WAW` and placement `local-WAW`.

These coordination benchmarks do not exercise long cloud backup exports directly. The export-lease fix is covered by 22 automated regressions using real transfer operations, routed export requests and bounded fake clocks.

Latency remains advisory. Comparisons use p95 (95th-percentile latency) and p50 (median latency). Compared with the stored v0.12.0 baseline:

| Signal | v0.12.0 baseline | v0.12.1 | Change |
|---|---:|---:|---:|
| Eight-participant contended acquire p95 | 388 ms | 329.333 ms | -15.1% |
| Fenced update p95 | 387 ms | 298 ms | -23.0% |
| Signal send p95 | 430 ms | 514.667 ms | +19.7% |
| Journal replay p95 | 308 ms | 446 ms | +44.8% |
| 24-participant owner-contention acquire p95 | 728 ms | 730 ms | +0.3% |
| Cold-first-request p50 | 270 ms | 166 ms | -38.5% |

Journal replay p95 increased 44.8%, crossing the advisory 25% threshold and triggering a paired comparison against v0.12.0. The canonical comparison used eight participants, 20-second measurements and five-second warmups, alternating previous/release twice for claims and fenced writes:

| Scenario / round | v0.12.0 primary-op p50 | v0.12.1 primary-op p50 | v0.12.0 primary-op p95 | v0.12.1 primary-op p95 | p95 change |
|---|---:|---:|---:|---:|---:|
| claims-uncontended / round 1 (acquire) | 173.429 ms | 166.75 ms | 372 ms | 508 ms | +36.6% |
| fenced-writes / round 1 (update) | 168.063 ms | 164.323 ms | 396 ms | 520 ms | +31.3% |
| claims-uncontended / round 2 (acquire) | 169.833 ms | 165.4 ms | 498 ms | 616 ms | +23.7% |
| fenced-writes / round 2 (update) | 166.208 ms | 170.25 ms | 422.667 ms | 476 ms | +12.6% |

All four release p95 values were higher. Release progression paused for investigation rather than treating similar medians as proof that the tail-latency signal was harmless. These eight comparison runs recorded 6,415 operations, zero unexpected errors and 20/20 passing invariants.

## Latency investigation and crossover

The Worker, benchmark, core, SQLite operations and schema source trees are identical between v0.12.0 and the release candidate. Compiled Worker bundles differ only in `DO_CODE_VERSION`, `PRODUCT_VERSION` and `BUILD_COMMIT`, which are read by health and diagnostic routes. Normalizing only those three constants produces identical SHA-256 hashes (`751516d7742d6f3eec0b7896343afee94698c5cff3014b6a3d388e3f1b404cde`). The changed SDK backup module is a separate entry point and is not imported by the benchmark client.

A bounded follow-up used fresh isolated deployments and all three relevant scenarios: claim acquisition, fenced updates and journal replay. Each run used eight participants, a 30-second measurement and five-second warmup. Epoch 1 ran previous/release. Before epoch 2, the builds were swapped between the same two Worker scripts, and execution order reversed to release/previous. Both scripts retained their original Durable Object namespace IDs, D1 binding, R2 binding and project. Exact health version/commit was verified before every run. Project histories grew between epochs, and preserving a namespace does not guarantee an unchanged physical execution host.

| Primary operation / epoch | v0.12.0 p95 (p50) | v0.12.1 p95 (p50) | p95 change |
|---|---:|---:|---:|
| acquire / epoch 1 | 541.333 ms (233.889) | 484 ms (232.545) | -10.6% |
| update / epoch 1 | 476 ms (228.578) | 521.333 ms (226.615) | +9.5% |
| replay / epoch 1 | 506 ms (197.889) | 501 ms (198.211) | -1.0% |
| acquire / epoch 2 | 540 ms (231.455) | 484 ms (217.077) | -10.4% |
| update / epoch 2 | 476 ms (223.963) | 420 ms (220.159) | -11.8% |
| replay / epoch 2 | 454.667 ms (194.6) | 412 ms (190.125) | -9.4% |

Version no longer consistently predicted slower tails: claims and replay favored the release in both epochs, and the update difference reversed after crossover. All 12 diagnostic child processes exited 0; they recorded 11,303 operations with zero unexpected errors and 32/32 passing invariants. Primary-operation timing coverage was 4,665/4,665 HTTP responses, with zero invalid residuals.

Executable-code equivalence and the balanced crossover provide no evidence of a new coordination-code regression. The original signal is consistent with environmental or timing variation, so release progression resumed. This does not prove latency equality or identify the exact source of the earlier delays; the runs are short and tail measurements remain variable.

The 500 ms cadence control missed 11 scheduled deadlines, versus 10 in v0.12.0 and an advisory target of 0. Its acquire p95 was 189 ms. This remains an advisory observation, not a correctness failure.

## Cleanup and reproduction

Both validation rounds destroyed their projects successfully, with DO, R2, D1 and local stores reporting `ok` and no failures. Resource API reads confirmed all four disposable Workers, both D1 databases and both R2 buckets were gone. Public health checks independently returned HTTP 404 for removed Workers. Production D1 remained present and production health returned HTTP 200. Production resources were not changed.

Raw JSON is gitignored under `packages/bench/results/release-0121/` (full gates), `release-0121-ab/` (initial comparison) and `release-0121-diagnostic/` (crossover). Regenerate the full gate tables with:

```bash
pnpm bench:report -- --in packages/bench/results/release-0121 --out /tmp/tila-release-0121-baseline.md
```

Latencies below are per facade call. Expected conflicts and stale-fence rejections are excluded from the unexpected-error rate.

# Benchmark baseline

Generated by `pnpm bench:report` from raw harness output (see docs/benchmarks/README.md for methodology and what each tier measures). Latencies are per facade call, measured by the harness around the SDK method; throughput counts every recorded sub-operation across all participants. Conflicts and stale-fence rejections are expected outcomes and are excluded from the error rate.

## http deployed: cold-start (20261017-202027-nr66)

| | |
|---|---|
| **Run** | `20261017-202027-nr66` at 2026-10-17T20:20:27.746Z |
| **Harness** | 1.1.0 (schema 1) |
| **Git** | 951afe21f8 |
| **Tier / target** | http / deployed (tila-rel0121.breamcode.workers.dev, colo WAW, placement local-WAW) |
| **Hardware** | Apple M3 Pro × 12, 36864.0 MiB RAM, darwin 25.6.0 arm64, node v24.19.0 |
| **Load** | 4 participants, 1 principal(s), 10s after 1s warmup |
| **Params** | mode exclusive, groups 1, hold 0 ms, target tasks, steal every 5, sizes 1024/65536/1048576 B, seed 42 |

#### cold-start

POST /admin/restart to evict the DO, then time the first summary read (cold) and three more (warm after restart). 1 participant(s), 13.3s recorded.
Dataset: iterations=5, warm_reads=3, settle_ms=2000.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cold_first_request | 5 | 5 | 0 | 0 | 0 | 0.38 | 166 | 584 | 584 | 585.65 |
| restart | 5 | 5 | 0 | 0 | 0 | 0.38 | 95.5 | 111 | 111 | 111.08 |
| warm_after_restart | 15 | 15 | 0 | 0 | 0 | 1.13 | 98.5 | 134 | 134 | 134.97 |
| **total** | 25 | 25 | 0 | 0 | 0 | 1.88 | 101 | 182 | 584 | 585.65 |

Timing for cold_first_request: 5/5 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 5 | 197.6 | 109 | 547 | 547 |
| auth_rate_limit | 5 | 26.6 | 27.25 | 30 | 30 |
| auth_token | 5 | 33 | 34.5 | 40 | 40 |
| auth_credential | 5 | 0 | 0 | 0 | 0 |
| membership | 5 | 0 | 0 | 0 | 0 |
| transfer | 5 | 0 | 0 | 0 | 0 |
| do | 5 | 138 | 51.5 | 484 | 484 |
| worker_other | 5 | 0 | 0 | 0 | 0 |
| client | 5 | 243.58 | 166 | 584 | 584 |
| transport_client | 5 | 45.98 | 40.5 | 55.5 | 55.5 |

Observed colo/placement: {"WAW/local-WAW":5}.

Timing for restart: 5/5 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 5 | 58.8 | 59.25 | 64 | 64 |
| auth_rate_limit | 5 | 24.8 | 25.25 | 28 | 28 |
| auth_token | 5 | 24 | 25 | 25 | 25 |
| auth_credential | 5 | 0 | 0 | 0 | 0 |
| membership | 5 | 0 | 0 | 0 | 0 |
| transfer | 5 | 6.6 | 7 | 7 | 7 |
| do | 5 | 0 | 0 | 0 | 0 |
| worker_other | 5 | 3.4 | 4 | 4 | 4 |
| client | 5 | 99.91 | 95.5 | 111 | 111 |
| transport_client | 5 | 41.11 | 36.5 | 53.03 | 53.03 |

Observed colo/placement: {"WAW/local-WAW":5}.

Timing for warm_after_restart: 15/15 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 15 | 63.93 | 59.75 | 96 | 96 |
| auth_rate_limit | 15 | 28.53 | 25.25 | 55 | 55 |
| auth_token | 15 | 26.73 | 25.42 | 45 | 45 |
| auth_credential | 15 | 0 | 0 | 0 | 0 |
| membership | 15 | 0 | 0 | 0 | 0 |
| transfer | 15 | 0 | 0 | 0 | 0 |
| do | 15 | 8.67 | 8.22 | 14 | 14 |
| worker_other | 15 | 0 | 0 | 0 | 0 |
| client | 15 | 103.74 | 98.5 | 134 | 134 |
| transport_client | 15 | 39.8 | 37.75 | 58.5 | 58.5 |

Observed colo/placement: {"WAW/local-WAW":15}.

Counters: restarts=5, restart_failures=0.

- PASS no errors
- PASS DO answered after every restart

## http deployed: claims-uncontended (20261017-201949-pvn9)

| | |
|---|---|
| **Run** | `20261017-201949-pvn9` at 2026-10-17T20:19:49.968Z |
| **Harness** | 1.1.0 (schema 1) |
| **Git** | 951afe21f8 |
| **Tier / target** | http / deployed (tila-rel0121.breamcode.workers.dev, colo WAW, placement local-WAW) |
| **Hardware** | Apple M3 Pro × 12, 36864.0 MiB RAM, darwin 25.6.0 arm64, node v24.19.0 |
| **Load** | 6 participants, 1 principal(s), 30s after 5s warmup, cadence 500 ms |
| **Params** | mode exclusive, groups 1, hold 0 ms, target tasks, steal every 5, sizes 1024/65536/1048576 B, seed 42 |

#### claims-uncontended

Per-participant resource: acquire (exclusive), renew x3, release. No contention; pure claim-path cost. 6 participant(s), 30s recorded.
Dataset: resources=6, ttl_ms=30000, renews_per_cycle=3.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| acquire | 72 | 72 | 0 | 0 | 0 | 2.4 | 138 | 189 | 856 | 856.07 |
| release | 71 | 71 | 0 | 0 | 0 | 2.37 | 141.5 | 404 | 696 | 703.82 |
| renew | 215 | 215 | 0 | 0 | 0 | 7.17 | 141.86 | 468 | 616 | 874.92 |
| **total** | 358 | 358 | 0 | 0 | 0 | 11.93 | 140.88 | 402 | 696 | 874.92 |

Timing for acquire: 72/72 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 72 | 108.43 | 96.25 | 134 | 533 |
| auth_rate_limit | 72 | 31.04 | 29.16 | 51.25 | 58 |
| auth_token | 72 | 34.81 | 29.25 | 55.5 | 292 |
| auth_credential | 72 | 0 | 0 | 0 | 0 |
| membership | 72 | 0 | 0 | 0 | 0 |
| transfer | 72 | 15.19 | 6.11 | 26.25 | 410 |
| do | 72 | 27.36 | 27.11 | 30.13 | 58 |
| worker_other | 72 | 0.03 | 0 | 0 | 1 |
| client | 72 | 152.44 | 138 | 189 | 856 |
| transport_client | 72 | 44.01 | 37.13 | 60.5 | 323.07 |

Observed colo/placement: {"WAW/local-WAW":72}.

Timing for release: 71/71 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 71 | 138.17 | 101.5 | 372 | 664 |
| auth_rate_limit | 71 | 51.37 | 30.38 | 218 | 594 |
| auth_token | 71 | 42.77 | 30.15 | 63.5 | 584 |
| auth_credential | 71 | 0 | 0 | 0 | 0 |
| membership | 71 | 0 | 0 | 0 | 0 |
| transfer | 71 | 11.54 | 7.12 | 24.38 | 33 |
| do | 71 | 32.44 | 26.45 | 30.19 | 436 |
| worker_other | 71 | 0.06 | 0 | 0 | 3 |
| client | 71 | 181.64 | 141.5 | 404 | 696 |
| transport_client | 71 | 43.47 | 37.3 | 69 | 276 |

Observed colo/placement: {"WAW/local-WAW":71}.

Timing for renew: 215/215 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 215 | 133.37 | 103 | 358 | 552 |
| auth_rate_limit | 215 | 33.96 | 29.48 | 58.5 | 142 |
| auth_token | 215 | 42.96 | 29.3 | 65 | 452 |
| auth_credential | 215 | 0 | 0 | 0 | 0 |
| membership | 215 | 0 | 0 | 0 | 0 |
| transfer | 215 | 26.14 | 8.09 | 117 | 388 |
| do | 215 | 30.3 | 27.14 | 37.5 | 58.5 |
| worker_other | 215 | 0.02 | 0 | 0 | 1 |
| client | 215 | 177.13 | 141.86 | 468 | 616 |
| transport_client | 215 | 43.76 | 36.23 | 71 | 166 |

Observed colo/placement: {"WAW/local-WAW":215}.

Counters: missed_cadence_deadlines=11.

- PASS no errors
- PASS no conflicts on disjoint resources
- PASS no stale fences

## http deployed: claims-contended (20261017-201906-ex92)

| | |
|---|---|
| **Run** | `20261017-201906-ex92` at 2026-10-17T20:19:06.812Z |
| **Harness** | 1.1.0 (schema 1) |
| **Git** | 951afe21f8 |
| **Tier / target** | http / deployed (tila-rel0121.breamcode.workers.dev, colo WAW, placement local-WAW) |
| **Hardware** | Apple M3 Pro × 12, 36864.0 MiB RAM, darwin 25.6.0 arm64, node v24.19.0 |
| **Load** | 24 participants, 1 principal(s), 30s after 5s warmup |
| **Params** | mode owner, groups 1, hold 0 ms, target tasks, steal every 5, sizes 1024/65536/1048576 B, seed 42 |

#### claims-contended

Participants contend for one or more hot resources: acquire, hold, release. Reports conflicts, takeovers and fence monotonicity. 24 participant(s), 30.8s recorded.
Dataset: hot_resources=1, mode="owner", hold_ms=0, ttl_ms=5000, principals=1.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| acquire | 939 | 939 | 0 | 0 | 0 | 30.51 | 338.37 | 730 | 1064 | 1577.86 |
| release | 953 | 7 | 0 | 946 | 0 | 30.96 | 327.36 | 737.6 | 1080 | 1369.35 |
| **total** | 1892 | 946 | 0 | 946 | 0 | 61.47 | 332.25 | 731.2 | 1076 | 1577.86 |

Timing for acquire: 939/939 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 939 | 328.27 | 298.54 | 588 | 916 |
| auth_rate_limit | 939 | 130.98 | 120.55 | 214.8 | 490 |
| auth_token | 939 | 141.03 | 129.85 | 217 | 552 |
| auth_credential | 939 | 0 | 0 | 0 | 0 |
| membership | 939 | 0 | 0 | 0 | 0 |
| transfer | 939 | 24.25 | 9.21 | 38.3 | 396 |
| do | 939 | 31.76 | 28.36 | 43.56 | 61.5 |
| worker_other | 939 | 0.25 | 0 | 1.03 | 2.06 |
| client | 939 | 386.11 | 338.37 | 730 | 1064 |
| transport_client | 939 | 57.84 | 34.87 | 186 | 532 |

Observed colo/placement: {"WAW/local-WAW":939}.

Timing for release: 953/953 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 953 | 316.74 | 288.39 | 558 | 932 |
| auth_rate_limit | 953 | 130.04 | 120.11 | 210 | 420 |
| auth_token | 953 | 138.28 | 128.58 | 224.29 | 436 |
| auth_credential | 953 | 0 | 0 | 0 | 0 |
| membership | 953 | 0 | 0 | 0 | 0 |
| transfer | 953 | 28.89 | 9.17 | 49.5 | 418.5 |
| do | 953 | 19.18 | 21.11 | 40.14 | 51.5 |
| worker_other | 953 | 0.35 | 0 | 2.03 | 4.03 |
| client | 953 | 376.17 | 327.36 | 737.6 | 1080 |
| transport_client | 953 | 59.42 | 34.74 | 258 | 584 |

Observed colo/placement: {"WAW/local-WAW":953}.

Counters: takeovers=36, fence_reorders_observed=40, journal_fence_regressions=0, journal_acquires_audited=1108.

- PASS no errors
- PASS journal fences never regress per resource (0 regressions in 1108 acquires)
- PASS outcome classes sum to ops
- PASS owner mode: same-principal takeovers observed (36 takeovers)

## http deployed: all (20261017-201311-j9zc)

| | |
|---|---|
| **Run** | `20261017-201311-j9zc` at 2026-10-17T20:13:11.815Z |
| **Harness** | 1.1.0 (schema 1) |
| **Git** | 951afe21f8 |
| **Tier / target** | http / deployed (tila-rel0121.breamcode.workers.dev, colo WAW, placement local-WAW) |
| **Hardware** | Apple M3 Pro × 12, 36864.0 MiB RAM, darwin 25.6.0 arm64, node v24.19.0 |
| **Load** | 8 participants, 1 principal(s), 30s after 5s warmup |
| **Params** | mode exclusive, groups 1, hold 0 ms, target tasks, steal every 5, sizes 1024/65536/1048576 B, seed 42 |

#### claims-uncontended

Per-participant resource: acquire (exclusive), renew x3, release. No contention; pure claim-path cost. 8 participant(s), 30.6s recorded.
Dataset: resources=8, ttl_ms=30000, renews_per_cycle=3.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| acquire | 251 | 251 | 0 | 0 | 0 | 8.19 | 164.95 | 482 | 700 | 728.57 |
| release | 256 | 256 | 0 | 0 | 0 | 8.36 | 160.2 | 428 | 732 | 763.51 |
| renew | 757 | 757 | 0 | 0 | 0 | 24.71 | 160.93 | 470 | 712 | 1066.76 |
| **total** | 1264 | 1264 | 0 | 0 | 0 | 41.26 | 161.59 | 466 | 716 | 1066.76 |

Timing for acquire: 251/251 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 251 | 140.34 | 122.78 | 318 | 468 |
| auth_rate_limit | 251 | 46.32 | 37.72 | 71.67 | 278 |
| auth_token | 251 | 46.31 | 37.3 | 67.67 | 316 |
| auth_credential | 251 | 0 | 0 | 0 | 0 |
| membership | 251 | 0 | 0 | 0 | 0 |
| transfer | 251 | 18.95 | 14.2 | 31.46 | 113 |
| do | 251 | 28.6 | 28.08 | 32.92 | 61.5 |
| worker_other | 251 | 0.15 | 0 | 1.03 | 2.05 |
| client | 251 | 195.5 | 164.95 | 482 | 700 |
| transport_client | 251 | 55.16 | 38.75 | 71 | 536 |

Observed colo/placement: {"WAW/local-WAW":251}.

Timing for release: 256/256 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 256 | 138.34 | 119.38 | 222 | 508 |
| auth_rate_limit | 256 | 46.03 | 36.61 | 71 | 372 |
| auth_token | 256 | 46.17 | 37.08 | 65 | 332 |
| auth_credential | 256 | 0 | 0 | 0 | 0 |
| membership | 256 | 0 | 0 | 0 | 0 |
| transfer | 256 | 17.06 | 13.17 | 32.17 | 81 |
| do | 256 | 28.93 | 27.32 | 33.63 | 81.5 |
| worker_other | 256 | 0.14 | 0 | 1.02 | 2.06 |
| client | 256 | 187.79 | 160.2 | 428 | 732 |
| transport_client | 256 | 49.45 | 39.62 | 66.5 | 552 |

Observed colo/placement: {"WAW/local-WAW":256}.

Timing for renew: 757/757 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 757 | 132.93 | 120.35 | 195 | 540 |
| auth_rate_limit | 757 | 42.08 | 36.35 | 66.11 | 146 |
| auth_token | 757 | 43.16 | 37.18 | 65.75 | 229 |
| auth_credential | 757 | 0 | 0 | 0 | 0 |
| membership | 757 | 0 | 0 | 0 | 0 |
| transfer | 757 | 17.37 | 13.03 | 31.32 | 59.5 |
| do | 757 | 30.2 | 27.29 | 31.34 | 81 |
| worker_other | 757 | 0.11 | 0 | 1.02 | 2.05 |
| client | 757 | 189.97 | 160.93 | 470 | 712 |
| transport_client | 757 | 57.05 | 38.99 | 85.67 | 552 |

Observed colo/placement: {"WAW/local-WAW":757}.


- PASS no errors
- PASS no conflicts on disjoint resources
- PASS no stale fences

#### claims-contended

Participants contend for one or more hot resources: acquire, hold, release. Reports conflicts, takeovers and fence monotonicity. 8 participant(s), 30.4s recorded.
Dataset: hot_resources=1, mode="exclusive", hold_ms=0, ttl_ms=5000, principals=1.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| acquire | 1234 | 138 | 1096 | 0 | 0 | 40.65 | 148.26 | 329.33 | 724 | 1289.74 |
| release | 140 | 140 | 0 | 0 | 0 | 4.61 | 168.67 | 452 | 584 | 726.97 |
| **total** | 1374 | 278 | 1096 | 0 | 0 | 45.26 | 151.32 | 332 | 722.67 | 1289.74 |

Timing for acquire: 1234/1234 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 1234 | 124 | 108.11 | 229.5 | 534 |
| auth_rate_limit | 1234 | 46.94 | 42.93 | 70.88 | 162 |
| auth_token | 1234 | 51.16 | 43.46 | 77.5 | 308 |
| auth_credential | 1234 | 0 | 0 | 0 | 0 |
| membership | 1234 | 0 | 0 | 0 | 0 |
| transfer | 1234 | 15.57 | 7.06 | 28.34 | 350.67 |
| do | 1234 | 10.26 | 5.03 | 29.48 | 32.94 |
| worker_other | 1234 | 0.06 | 0 | 0 | 1.03 |
| client | 1234 | 172 | 148.26 | 329.33 | 724 |
| transport_client | 1234 | 48 | 37.09 | 55.58 | 404 |

Observed colo/placement: {"WAW/local-WAW":1234}.

Timing for release: 140/140 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 140 | 153 | 129.69 | 425.33 | 552 |
| auth_rate_limit | 140 | 58.93 | 46.5 | 95 | 364 |
| auth_token | 140 | 51.11 | 47.12 | 73.5 | 162 |
| auth_credential | 140 | 0 | 0 | 0 | 0 |
| membership | 140 | 0 | 0 | 0 | 0 |
| transfer | 140 | 14.72 | 6.1 | 15.13 | 388 |
| do | 140 | 28.21 | 27.41 | 32.83 | 45.5 |
| worker_other | 140 | 0.02 | 0 | 0 | 1 |
| client | 140 | 191.62 | 168.67 | 452 | 584 |
| transport_client | 140 | 38.62 | 36.9 | 50.75 | 58.5 |

Observed colo/placement: {"WAW/local-WAW":140}.

Counters: takeovers=0, fence_reorders_observed=0, journal_fence_regressions=0, journal_acquires_audited=163.

- PASS no errors
- PASS journal fences never regress per resource (0 regressions in 163 acquires)
- PASS outcome classes sum to ops

#### fenced-writes

Fenced task updates (owner-mode claims) with a thief forcing stale-fence retries, or CAS record writes between paired participants. 8 participant(s), 31s recorded.
Dataset: target="tasks", tasks=7, records=0, thief=true, steal_every=5, ttl_ms=30000.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| reacquire | 119 | 119 | 0 | 0 | 0 | 3.84 | 170 | 242 | 680 | 756.23 |
| steal | 126 | 126 | 0 | 0 | 0 | 4.07 | 170.8 | 452 | 872 | 1180.83 |
| update | 1048 | 930 | 0 | 118 | 0 | 33.84 | 161.15 | 298 | 588 | 999.19 |
| **total** | 1293 | 1175 | 0 | 118 | 0 | 41.76 | 162.76 | 319.2 | 664 | 1180.83 |

Timing for reacquire: 119/119 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 119 | 147.18 | 129.5 | 195 | 648 |
| auth_rate_limit | 119 | 50.93 | 40.25 | 76.5 | 388 |
| auth_token | 119 | 48.51 | 41.5 | 73 | 292 |
| auth_credential | 119 | 0 | 0 | 0 | 0 |
| membership | 119 | 0 | 0 | 0 | 0 |
| transfer | 119 | 19.33 | 15.04 | 32.17 | 69 |
| do | 119 | 28.35 | 28.08 | 33.7 | 35.75 |
| worker_other | 119 | 0.05 | 0 | 0 | 1.03 |
| client | 119 | 186.83 | 170 | 242 | 680 |
| transport_client | 119 | 39.65 | 36.81 | 53.25 | 61.5 |

Observed colo/placement: {"WAW/local-WAW":119}.

Timing for steal: 126/126 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 126 | 164.91 | 127 | 412 | 824 |
| auth_rate_limit | 126 | 51.69 | 39.58 | 87 | 520 |
| auth_token | 126 | 61.68 | 40.88 | 142 | 404 |
| auth_credential | 126 | 0 | 0 | 0 | 0 |
| membership | 126 | 0 | 0 | 0 | 0 |
| transfer | 126 | 22.2 | 15.18 | 37.5 | 308 |
| do | 126 | 29.28 | 27.36 | 35.63 | 81 |
| worker_other | 126 | 0.06 | 0 | 0 | 2 |
| client | 126 | 208.38 | 170.8 | 452 | 872 |
| transport_client | 126 | 43.47 | 40.1 | 56.25 | 186 |

Observed colo/placement: {"WAW/local-WAW":126}.

Timing for update: 1048/1048 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 1048 | 139.21 | 122.03 | 247.33 | 525.33 |
| auth_rate_limit | 1048 | 44.51 | 37.49 | 80.25 | 230 |
| auth_token | 1048 | 46.6 | 39.04 | 84.25 | 249 |
| auth_credential | 1048 | 0 | 0 | 0 | 0 |
| membership | 1048 | 0 | 0 | 0 | 0 |
| transfer | 1048 | 18.57 | 13.02 | 33.92 | 138 |
| do | 1048 | 29.5 | 28.33 | 35.35 | 79 |
| worker_other | 1048 | 0.04 | 0 | 0 | 1.02 |
| client | 1048 | 180.32 | 161.15 | 298 | 588 |
| transport_client | 1048 | 41.11 | 35.95 | 52.83 | 77 |

Observed colo/placement: {"WAW/local-WAW":1048}.

Counters: steals=144, reacquires=134.

- PASS no errors
- PASS stale fences were rejected

#### presence-signals

Presence heartbeat, then a participant-targeted signal to a random peer, then inbox read and acknowledgement of every pending bench signal. 8 participant(s), 30.6s recorded.
Dataset: participants=8, signal_ttl_ms=60000.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ack | 335 | 335 | 0 | 0 | 0 | 10.95 | 158.64 | 418 | 776 | 1548.78 |
| heartbeat | 328 | 328 | 0 | 0 | 0 | 10.72 | 161.06 | 420 | 632 | 820.38 |
| inbox | 334 | 334 | 0 | 0 | 0 | 10.92 | 137.29 | 356 | 616 | 710.66 |
| send | 332 | 332 | 0 | 0 | 0 | 10.85 | 163.3 | 514.67 | 920 | 945.57 |
| **total** | 1329 | 1329 | 0 | 0 | 0 | 43.45 | 155.79 | 420 | 728 | 1548.78 |

Timing for ack: 335/335 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 335 | 138.71 | 123.13 | 190 | 616 |
| auth_rate_limit | 335 | 46.65 | 41.47 | 68.33 | 138 |
| auth_token | 335 | 48.7 | 42.58 | 71 | 178 |
| auth_credential | 335 | 0 | 0 | 0 | 0 |
| membership | 335 | 0 | 0 | 0 | 0 |
| transfer | 335 | 17.37 | 8.05 | 27.32 | 324 |
| do | 335 | 25.91 | 26.12 | 28.48 | 30.45 |
| worker_other | 335 | 0.08 | 0 | 1.01 | 1.03 |
| client | 335 | 184.89 | 158.64 | 418 | 776 |
| transport_client | 335 | 46.19 | 34.55 | 49.5 | 396 |

Observed colo/placement: {"WAW/local-WAW":335}.

Timing for heartbeat: 328/328 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 328 | 132.76 | 123.42 | 190 | 436 |
| auth_rate_limit | 328 | 42.76 | 41.17 | 67.5 | 93 |
| auth_token | 328 | 46.83 | 41.73 | 75 | 181 |
| auth_credential | 328 | 0 | 0 | 0 | 0 |
| membership | 328 | 0 | 0 | 0 | 0 |
| transfer | 328 | 16.33 | 8.19 | 29.06 | 292 |
| do | 328 | 26.77 | 25.32 | 28.42 | 39.25 |
| worker_other | 328 | 0.07 | 0 | 1.01 | 1.03 |
| client | 328 | 184.5 | 161.06 | 420 | 632 |
| transport_client | 328 | 51.74 | 35.5 | 57.5 | 412 |

Observed colo/placement: {"WAW/local-WAW":328}.

Timing for inbox: 334/334 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 334 | 110.64 | 99.47 | 175 | 460 |
| auth_rate_limit | 334 | 47.96 | 42.81 | 75.5 | 190 |
| auth_token | 334 | 48 | 41.95 | 69.75 | 182 |
| auth_credential | 334 | 0 | 0 | 0 | 0 |
| membership | 334 | 0 | 0 | 0 | 0 |
| transfer | 334 | 0 | 0 | 0 | 0 |
| do | 334 | 14.68 | 10.13 | 28.07 | 30.44 |
| worker_other | 334 | 0 | 0 | 0 | 0 |
| client | 334 | 158.91 | 137.29 | 356 | 616 |
| transport_client | 334 | 48.27 | 35.02 | 70.5 | 412 |

Observed colo/placement: {"WAW/local-WAW":334}.

Timing for send: 332/332 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 332 | 143.49 | 126.44 | 250 | 600 |
| auth_rate_limit | 332 | 47.99 | 42.85 | 75 | 194 |
| auth_token | 332 | 50.95 | 41.73 | 65.67 | 396 |
| auth_credential | 332 | 0 | 0 | 0 | 0 |
| membership | 332 | 0 | 0 | 0 | 0 |
| transfer | 332 | 17.64 | 8.17 | 28.13 | 364 |
| do | 332 | 26.81 | 26.3 | 30.04 | 37.5 |
| worker_other | 332 | 0.11 | 0 | 1.01 | 1.03 |
| client | 332 | 198.41 | 163.3 | 514.67 | 920 |
| transport_client | 332 | 54.92 | 35.6 | 99 | 600 |

Observed colo/placement: {"WAW/local-WAW":332}.

Counters: inbox_backlog_max=5, signals_sent=385, signals_acked=385.

- PASS no errors
- PASS every sent signal was acknowledged after drain (385/385)

#### journal-replay

Writers append journal rows via claim cycles while readers page the journal with replay cursors and acknowledge progress. 8 participant(s), 30.2s recorded.
Dataset: writers=4, readers=4, page_limit=200, ttl_ms=30000.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| acknowledge | 337 | 337 | 0 | 0 | 0 | 11.15 | 160.35 | 506 | 884 | 1089.48 |
| replay | 335 | 335 | 0 | 0 | 0 | 11.08 | 135.6 | 446 | 584 | 933.9 |
| write_acquire | 327 | 327 | 0 | 0 | 0 | 10.82 | 159.54 | 486 | 616 | 1252.3 |
| write_release | 329 | 329 | 0 | 0 | 0 | 10.88 | 154.84 | 260 | 632 | 781.36 |
| **total** | 1328 | 1328 | 0 | 0 | 0 | 43.93 | 152.13 | 449 | 738.67 | 1252.3 |

Timing for acknowledge: 337/337 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 337 | 149.04 | 122.23 | 404 | 781.33 |
| auth_rate_limit | 337 | 47.42 | 40.82 | 76.25 | 154 |
| auth_token | 337 | 52.31 | 41.38 | 67.75 | 676 |
| auth_credential | 337 | 0 | 0 | 0 | 0 |
| membership | 337 | 0 | 0 | 0 | 0 |
| transfer | 337 | 21.95 | 9.05 | 28.25 | 380 |
| do | 337 | 27.34 | 25.46 | 30.41 | 43.5 |
| worker_other | 337 | 0.01 | 0 | 0 | 1 |
| client | 337 | 196.95 | 160.35 | 506 | 884 |
| transport_client | 337 | 47.91 | 35.42 | 77.5 | 394 |

Observed colo/placement: {"WAW/local-WAW":337}.

Timing for replay: 335/335 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 335 | 116 | 97.08 | 219 | 524 |
| auth_rate_limit | 335 | 44.6 | 40.72 | 69.25 | 162 |
| auth_token | 335 | 48.67 | 42.29 | 68.5 | 388 |
| auth_credential | 335 | 0 | 0 | 0 | 0 |
| membership | 335 | 0 | 0 | 0 | 0 |
| transfer | 335 | 0 | 0 | 0 | 0 |
| do | 335 | 22.64 | 11.13 | 29.38 | 422 |
| worker_other | 335 | 0.09 | 0 | 1.01 | 1.03 |
| client | 335 | 160.35 | 135.6 | 446 | 584 |
| transport_client | 335 | 44.35 | 36.32 | 58.75 | 348 |

Observed colo/placement: {"WAW/local-WAW":335}.

Timing for write_acquire: 327/327 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 327 | 145.1 | 119.92 | 412 | 552 |
| auth_rate_limit | 327 | 44.63 | 39.61 | 69.67 | 147 |
| auth_token | 327 | 45.01 | 40.08 | 66.5 | 178 |
| auth_credential | 327 | 0 | 0 | 0 | 0 |
| membership | 327 | 0 | 0 | 0 | 0 |
| transfer | 327 | 23.83 | 9.15 | 33.17 | 382 |
| do | 327 | 31.59 | 27.17 | 32.17 | 123 |
| worker_other | 327 | 0.05 | 0 | 0 | 1.02 |
| client | 327 | 191.92 | 159.54 | 486 | 616 |
| transport_client | 327 | 46.82 | 35.8 | 65 | 292 |

Observed colo/placement: {"WAW/local-WAW":327}.

Timing for write_release: 329/329 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 329 | 133.54 | 118.93 | 183.5 | 600 |
| auth_rate_limit | 329 | 46.74 | 39.86 | 75 | 155 |
| auth_token | 329 | 45.63 | 40.5 | 64.5 | 154 |
| auth_credential | 329 | 0 | 0 | 0 | 0 |
| membership | 329 | 0 | 0 | 0 | 0 |
| transfer | 329 | 13.89 | 8.04 | 28.45 | 61.5 |
| do | 329 | 27.24 | 26.5 | 32.25 | 43.25 |
| worker_other | 329 | 0.03 | 0 | 0 | 1.02 |
| client | 329 | 174.75 | 154.84 | 260 | 632 |
| transport_client | 329 | 41.21 | 35.11 | 57.75 | 250 |

Observed colo/placement: {"WAW/local-WAW":329}.

Counters: reader_lag_max=0, reader_lag_mean=0, seq_regressions=0, seq_gaps=0, pages_with_events=396.

- PASS no errors
- PASS replay pages are strictly increasing
- PASS no sequence gaps inside pages (0 gaps)

#### artifacts

Artifact upload (no claim; sizes round-robin), metadata read-back, and a periodic kind-filtered list. The embedded tier writes text blobs via writeText. 8 participant(s), 30.6s recorded.
Dataset: sizes_bytes=[1024,65536,1048576], list_every=5, kind="bench".

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| list | 86 | 86 | 0 | 0 | 0 | 2.81 | 120.2 | 175.5 | 648 | 652.63 |
| meta | 418 | 418 | 0 | 0 | 0 | 13.66 | 111.36 | 308 | 674.67 | 793.62 |
| upload_1k | 137 | 137 | 0 | 0 | 0 | 4.48 | 326.29 | 692 | 884 | 884.18 |
| upload_1m | 137 | 137 | 0 | 0 | 0 | 4.48 | 443.5 | 788 | 845.33 | 865.94 |
| upload_64k | 138 | 138 | 0 | 0 | 0 | 4.51 | 352.67 | 612 | 840 | 849.74 |
| **total** | 916 | 916 | 0 | 0 | 0 | 29.93 | 175.6 | 605 | 833.6 | 884.18 |

Timing for list: 86/86 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 86 | 94.77 | 77.25 | 131 | 476 |
| auth_rate_limit | 86 | 41.09 | 32.25 | 69 | 420 |
| auth_token | 86 | 35.14 | 32.25 | 60.25 | 153 |
| auth_credential | 86 | 0 | 0 | 0 | 0 |
| membership | 86 | 0 | 0 | 0 | 0 |
| transfer | 86 | 0 | 0 | 0 | 0 |
| do | 86 | 18.54 | 11.19 | 30.25 | 372 |
| worker_other | 86 | 0 | 0 | 0 | 0 |
| client | 86 | 139.63 | 120.2 | 175.5 | 648 |
| transport_client | 86 | 44.86 | 41.08 | 56.5 | 248.63 |

Observed colo/placement: {"WAW/local-WAW":86}.

Timing for meta: 418/418 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 418 | 95.36 | 74.07 | 198 | 620 |
| auth_rate_limit | 418 | 38.6 | 29.49 | 68.5 | 206 |
| auth_token | 418 | 41.29 | 30.43 | 60.83 | 372 |
| auth_credential | 418 | 0 | 0 | 0 | 0 |
| membership | 418 | 0 | 0 | 0 | 0 |
| transfer | 418 | 0 | 0 | 0 | 0 |
| do | 418 | 0 | 0 | 0 | 0 |
| worker_other | 418 | 15.47 | 8.01 | 30.35 | 300 |
| client | 418 | 138.37 | 111.36 | 308 | 674.67 |
| transport_client | 418 | 43.02 | 36.29 | 55.5 | 182 |

Observed colo/placement: {"WAW/local-WAW":418}.

Timing for upload_1k: 137/137 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 137 | 316.79 | 285.45 | 572 | 792 |
| auth_rate_limit | 137 | 33.96 | 30.04 | 65 | 93 |
| auth_token | 137 | 34.21 | 29.28 | 65 | 134 |
| auth_credential | 137 | 0 | 0 | 0 | 0 |
| membership | 137 | 0 | 0 | 0 | 0 |
| transfer | 137 | 17.64 | 7.01 | 37.5 | 412 |
| do | 137 | 37.09 | 28.29 | 40.25 | 316 |
| worker_other | 137 | 193.88 | 176.6 | 290 | 536 |
| client | 137 | 368.13 | 326.29 | 692 | 884 |
| transport_client | 137 | 51.34 | 35.95 | 105 | 584 |

Observed colo/placement: {"WAW/local-WAW":137}.

Timing for upload_1m: 137/137 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 137 | 380.47 | 353 | 628 | 760 |
| auth_rate_limit | 137 | 34.39 | 27.44 | 71.5 | 158 |
| auth_token | 137 | 37.77 | 29.43 | 52.75 | 254 |
| auth_credential | 137 | 0 | 0 | 0 | 0 |
| membership | 137 | 0 | 0 | 0 | 0 |
| transfer | 137 | 22.69 | 7.09 | 37.25 | 372 |
| do | 137 | 32.03 | 28.41 | 38.5 | 93 |
| worker_other | 137 | 253.59 | 238.8 | 362 | 484 |
| client | 137 | 481.86 | 443.5 | 788 | 845.33 |
| transport_client | 137 | 101.39 | 85.8 | 174 | 476 |

Observed colo/placement: {"WAW/local-WAW":137}.

Timing for upload_64k: 138/138 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 138 | 333.38 | 302 | 568 | 804 |
| auth_rate_limit | 138 | 36.98 | 30.28 | 70.5 | 150 |
| auth_token | 138 | 39.8 | 30.4 | 83 | 250 |
| auth_credential | 138 | 0 | 0 | 0 | 0 |
| membership | 138 | 0 | 0 | 0 | 0 |
| transfer | 138 | 15.7 | 7 | 31.25 | 348 |
| do | 138 | 35.86 | 28.25 | 38.5 | 306 |
| worker_other | 138 | 205.04 | 187.4 | 324 | 484 |
| client | 138 | 388.45 | 352.67 | 612 | 840 |
| transport_client | 138 | 55.08 | 42.88 | 83 | 324 |

Observed colo/placement: {"WAW/local-WAW":138}.

Counters: meta_size_mismatches=0, bytes_uploaded=179602432.

- PASS no errors
- PASS metadata byte counts match uploads
