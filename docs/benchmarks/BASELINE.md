# Coordination benchmark baseline (2026-10-10)

## v0.4.0 pre-tag gates

**All correctness gates pass.** The deployed eight-participant matrix, 24-participant owner contention, six-participant 500 ms cadence and five cold-start cycles report zero unexpected errors and passing invariants. The cadence run recorded 360 operations with no missed deadlines. Five acknowledged restarts preserved availability; the separate live persistence test preserved task data across eviction.

The release candidate was deployed into a disposable Worker with its own D1 database, DO namespace and R2 bucket. All D1 migrations through 0031 applied before the Worker. The Worker source matches `f516b3b7`; the benchmark checkout is `9c6c1368`, whose only subsequent change adjusts a UI test. These results do not describe an upgrade of the existing service. Responses reported `WAW/local-WAW`, which does not independently establish DO location. The client was macOS arm64.

Latency is advisory. Compared with the 2026-10-08 release baseline, eight-participant acquire p95 changed from 426 to 303 ms, fenced update from 430 to 309 ms, signal send from 460 to 308 ms, and journal replay from 436 ms (356 ms on its repeat) to 274 ms. Owner contention acquire p95 changed from 867 to 563 ms. Cold-first-read p50 was 198 ms versus 262 ms. Different isolated infrastructure and observation times prevent attributing these changes to code or claiming a performance improvement.

A separate deployed SDK/MCP transport test passed authenticated run creation, publication retry, fetch/crash recovery, acknowledgement, relay body-access denial, binding replacement and revocation. It does not establish the native cross-host or unattended restoration gates under #283.

Raw JSON is gitignored under `packages/bench/results/release-040/`. Regenerate the tables with:

```bash
pnpm bench:report -- --in packages/bench/results/release-040 --out /tmp/tila-release-040-baseline.md
```

Latencies below are per facade call. Expected conflicts and stale-fence rejections are excluded from the unexpected-error rate.

## http deployed: cold-start (20261010-071945-qcsc)

| | |
|---|---|
| **Run** | `20261010-071945-qcsc` at 2026-10-10T07:19:45.022Z |
| **Harness** | 1.1.0 (schema 1) |
| **Git** | 9c6c1368c0 |
| **Tier / target** | http / deployed (tila-release-040-20261010.breamcode.workers.dev, colo WAW, placement local-WAW) |
| **Hardware** | Apple M3 Pro × 12, 36864.0 MiB RAM, darwin 25.6.0 arm64, node v24.19.0 |
| **Load** | 4 participants, 1 principal(s), 10s after 1s warmup |
| **Params** | mode exclusive, groups 1, hold 0 ms, target tasks, steal every 5, sizes 1024/65536/1048576 B, seed 42 |

#### cold-start

POST /admin/restart to evict the DO, then time the first summary read (cold) and three more (warm after restart). 1 participant(s), 14.3s recorded.
Dataset: iterations=5, warm_reads=3, settle_ms=2000.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cold_first_request | 5 | 5 | 0 | 0 | 0 | 0.35 | 198 | 238 | 238 | 239.29 |
| restart | 5 | 5 | 0 | 0 | 0 | 0.35 | 161 | 177.62 | 177.62 | 177.62 |
| warm_after_restart | 15 | 15 | 0 | 0 | 0 | 1.05 | 161.67 | 172.94 | 172.94 | 172.94 |
| **total** | 25 | 25 | 0 | 0 | 0 | 1.75 | 162.75 | 214 | 238 | 239.29 |

Timing for cold_first_request: 5/5 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 5 | 171.6 | 166 | 202 | 202 |
| auth_rate_limit | 5 | 59.2 | 59.5 | 69 | 69 |
| auth_token | 5 | 57.2 | 57.25 | 65 | 65 |
| auth_credential | 5 | 0 | 0 | 0 | 0 |
| membership | 5 | 0 | 0 | 0 | 0 |
| transfer | 5 | 0 | 0 | 0 | 0 |
| do | 5 | 55.2 | 44.5 | 77 | 77 |
| worker_other | 5 | 0 | 0 | 0 | 0 |
| client | 5 | 205.41 | 198 | 238 | 238 |
| transport_client | 5 | 33.81 | 34.5 | 37.29 | 37.29 |

Observed colo/placement: {"WAW/local-WAW":5}.

Timing for restart: 5/5 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 5 | 129.6 | 127 | 144 | 144 |
| auth_rate_limit | 5 | 63.4 | 62.25 | 79 | 79 |
| auth_token | 5 | 58.6 | 58.5 | 66 | 66 |
| auth_credential | 5 | 0 | 0 | 0 | 0 |
| membership | 5 | 0 | 0 | 0 | 0 |
| transfer | 5 | 4.8 | 5.03 | 7 | 7 |
| do | 5 | 0 | 0 | 0 | 0 |
| worker_other | 5 | 2.8 | 3 | 3 | 3 |
| client | 5 | 163.75 | 161 | 177.62 | 177.62 |
| transport_client | 5 | 34.15 | 33.5 | 36.75 | 36.75 |

Observed colo/placement: {"WAW/local-WAW":5}.

Timing for warm_after_restart: 15/15 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 15 | 128.53 | 127.67 | 142 | 142 |
| auth_rate_limit | 15 | 61.47 | 60.5 | 74 | 74 |
| auth_token | 15 | 61.27 | 61.75 | 68 | 68 |
| auth_credential | 15 | 0 | 0 | 0 | 0 |
| membership | 15 | 0 | 0 | 0 | 0 |
| transfer | 15 | 0 | 0 | 0 | 0 |
| do | 15 | 5.8 | 6.04 | 8 | 8 |
| worker_other | 15 | 0 | 0 | 0 | 0 |
| client | 15 | 162.51 | 161.67 | 172.94 | 172.94 |
| transport_client | 15 | 33.98 | 33.75 | 37.66 | 37.66 |

Observed colo/placement: {"WAW/local-WAW":15}.

Counters: restarts=5, restart_failures=0.

- PASS no errors
- PASS DO answered after every restart

## http deployed: claims-uncontended (20261010-071910-u3h3)

| | |
|---|---|
| **Run** | `20261010-071910-u3h3` at 2026-10-10T07:19:10.556Z |
| **Harness** | 1.1.0 (schema 1) |
| **Git** | 9c6c1368c0 |
| **Tier / target** | http / deployed (tila-release-040-20261010.breamcode.workers.dev, colo WAW, placement local-WAW) |
| **Hardware** | Apple M3 Pro × 12, 36864.0 MiB RAM, darwin 25.6.0 arm64, node v24.19.0 |
| **Load** | 6 participants, 1 principal(s), 30s after 1s warmup, cadence 500 ms |
| **Params** | mode exclusive, groups 1, hold 0 ms, target tasks, steal every 5, sizes 1024/65536/1048576 B, seed 42 |

#### claims-uncontended

Per-participant resource: acquire (exclusive), renew x3, release. No contention; pure claim-path cost. 6 participant(s), 30s recorded.
Dataset: resources=6, ttl_ms=30000, renews_per_cycle=3.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| acquire | 72 | 72 | 0 | 0 | 0 | 2.4 | 248.67 | 326.67 | 334.08 | 334.08 |
| release | 72 | 72 | 0 | 0 | 0 | 2.4 | 233 | 385 | 391 | 391.75 |
| renew | 216 | 216 | 0 | 0 | 0 | 7.2 | 240.25 | 332 | 380 | 393.03 |
| **total** | 360 | 360 | 0 | 0 | 0 | 12 | 240.13 | 332.5 | 388 | 393.03 |

Timing for acquire: 72/72 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 72 | 208.08 | 208.4 | 242 | 259 |
| auth_rate_limit | 72 | 84.04 | 81.25 | 111 | 113 |
| auth_token | 72 | 78.36 | 77.83 | 94.33 | 97 |
| auth_credential | 72 | 0 | 0 | 0 | 0 |
| membership | 72 | 0 | 0 | 0 | 0 |
| transfer | 72 | 15.56 | 14.13 | 32.25 | 34 |
| do | 72 | 29.96 | 30.02 | 34.5 | 37 |
| worker_other | 72 | 0.17 | 0 | 1.02 | 2 |
| client | 72 | 251.23 | 248.67 | 326.67 | 334.08 |
| transport_client | 72 | 43.15 | 37.41 | 93.5 | 127 |

Observed colo/placement: {"WAW/local-WAW":72}.

Timing for release: 72/72 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 72 | 198.99 | 196.5 | 273 | 277 |
| auth_rate_limit | 72 | 76.13 | 75 | 93.5 | 154 |
| auth_token | 72 | 78.9 | 74.17 | 154 | 182 |
| auth_credential | 72 | 0 | 0 | 0 | 0 |
| membership | 72 | 0 | 0 | 0 | 0 |
| transfer | 72 | 14.36 | 11.13 | 30.42 | 34 |
| do | 72 | 29.46 | 29.3 | 32.94 | 34 |
| worker_other | 72 | 0.14 | 0 | 1.02 | 2 |
| client | 72 | 248.78 | 233 | 385 | 391 |
| transport_client | 72 | 49.8 | 34.63 | 171 | 200.46 |

Observed colo/placement: {"WAW/local-WAW":72}.

Timing for renew: 216/216 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 216 | 203.49 | 199.47 | 284 | 348 |
| auth_rate_limit | 216 | 80.27 | 76.84 | 109 | 181 |
| auth_token | 216 | 78.35 | 74.5 | 97 | 199 |
| auth_credential | 216 | 0 | 0 | 0 | 0 |
| membership | 216 | 0 | 0 | 0 | 0 |
| transfer | 216 | 15.15 | 13.16 | 32.17 | 36.25 |
| do | 216 | 29.52 | 29.29 | 33.94 | 36.5 |
| worker_other | 216 | 0.2 | 0 | 1.02 | 2 |
| client | 216 | 246.71 | 240.25 | 332 | 380 |
| transport_client | 216 | 43.22 | 36.12 | 101 | 125.5 |

Observed colo/placement: {"WAW/local-WAW":216}.


- PASS no errors
- PASS no conflicts on disjoint resources
- PASS no stale fences

## http deployed: claims-contended (20261010-071832-pb72)

| | |
|---|---|
| **Run** | `20261010-071832-pb72` at 2026-10-10T07:18:32.859Z |
| **Harness** | 1.1.0 (schema 1) |
| **Git** | 9c6c1368c0 |
| **Tier / target** | http / deployed (tila-release-040-20261010.breamcode.workers.dev, colo WAW, placement local-WAW) |
| **Hardware** | Apple M3 Pro × 12, 36864.0 MiB RAM, darwin 25.6.0 arm64, node v24.19.0 |
| **Load** | 24 participants, 1 principal(s), 30s after 1s warmup |
| **Params** | mode owner, groups 1, hold 0 ms, target tasks, steal every 5, sizes 1024/65536/1048576 B, seed 42 |

#### claims-contended

Participants contend for one or more hot resources: acquire, hold, release. Reports conflicts, takeovers and fence monotonicity. 24 participant(s), 30.5s recorded.
Dataset: hot_resources=1, mode="owner", hold_ms=0, ttl_ms=5000, principals=1.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| acquire | 803 | 803 | 0 | 0 | 0 | 26.34 | 449.71 | 562.67 | 599.2 | 610.8 |
| release | 810 | 1 | 0 | 809 | 0 | 26.57 | 437.13 | 545.41 | 586.29 | 631.72 |
| **total** | 1613 | 804 | 0 | 809 | 0 | 52.9 | 444.08 | 554.89 | 595.33 | 631.72 |

Timing for acquire: 803/803 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 803 | 424.28 | 417.11 | 531.11 | 569.23 |
| auth_rate_limit | 803 | 183.19 | 176.32 | 274 | 306.4 |
| auth_token | 803 | 197.71 | 193.46 | 278.67 | 312.8 |
| auth_credential | 803 | 0 | 0 | 0 | 0 |
| membership | 803 | 0 | 0 | 0 | 0 |
| transfer | 803 | 12.84 | 6.12 | 33.25 | 40.5 |
| do | 803 | 30.27 | 29.4 | 35.86 | 44.75 |
| worker_other | 803 | 0.27 | 0 | 1.03 | 2.05 |
| client | 803 | 457.2 | 449.71 | 562.67 | 599.2 |
| transport_client | 803 | 32.92 | 31.5 | 40.96 | 52.5 |

Observed colo/placement: {"WAW/local-WAW":803}.

Timing for release: 810/810 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 810 | 404.87 | 403.63 | 510.18 | 553 |
| auth_rate_limit | 810 | 182.67 | 179.5 | 266.93 | 316 |
| auth_token | 810 | 193.56 | 190.18 | 256.57 | 304.8 |
| auth_credential | 810 | 0 | 0 | 0 | 0 |
| membership | 810 | 0 | 0 | 0 | 0 |
| transfer | 810 | 12.74 | 7 | 34.03 | 46.5 |
| do | 810 | 15.44 | 9.05 | 32.5 | 37.75 |
| worker_other | 810 | 0.45 | 0 | 2.04 | 3.05 |
| client | 810 | 438.11 | 437.13 | 545.41 | 586.29 |
| transport_client | 810 | 33.24 | 31.7 | 41.71 | 48.83 |

Observed colo/placement: {"WAW/local-WAW":810}.

Counters: takeovers=43, fence_reorders_observed=18, journal_fence_regressions=0, journal_acquires_audited=834.

- PASS no errors
- PASS journal fences never regress per resource (0 regressions in 834 acquires)
- PASS outcome classes sum to ops
- PASS owner mode: same-principal takeovers observed (43 takeovers)

## http deployed: all (20261010-071251-y0ba)

| | |
|---|---|
| **Run** | `20261010-071251-y0ba` at 2026-10-10T07:12:51.689Z |
| **Harness** | 1.1.0 (schema 1) |
| **Git** | 9c6c1368c0 |
| **Tier / target** | http / deployed (tila-release-040-20261010.breamcode.workers.dev, colo WAW, placement local-WAW) |
| **Hardware** | Apple M3 Pro × 12, 36864.0 MiB RAM, darwin 25.6.0 arm64, node v24.19.0 |
| **Load** | 8 participants, 1 principal(s), 30s after 5s warmup |
| **Params** | mode exclusive, groups 1, hold 0 ms, target tasks, steal every 5, sizes 1024/65536/1048576 B, seed 42 |

#### claims-uncontended

Per-participant resource: acquire (exclusive), renew x3, release. No contention; pure claim-path cost. 8 participant(s), 30.9s recorded.
Dataset: resources=8, ttl_ms=30000, renews_per_cycle=3.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| acquire | 199 | 199 | 0 | 0 | 0 | 6.44 | 234.83 | 303 | 356 | 370.84 |
| release | 207 | 207 | 0 | 0 | 0 | 6.69 | 233.38 | 302.67 | 364 | 388.5 |
| renew | 617 | 617 | 0 | 0 | 0 | 19.95 | 233.48 | 293.5 | 343 | 378.17 |
| **total** | 1023 | 1023 | 0 | 0 | 0 | 33.08 | 233.7 | 298 | 354 | 388.5 |

Timing for acquire: 199/199 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 199 | 206.4 | 201.17 | 271 | 324 |
| auth_rate_limit | 199 | 81.6 | 78.64 | 116.5 | 168 |
| auth_token | 199 | 82.65 | 79.36 | 112.5 | 175 |
| auth_credential | 199 | 0 | 0 | 0 | 0 |
| membership | 199 | 0 | 0 | 0 | 0 |
| transfer | 199 | 12.06 | 7.07 | 30.44 | 53.5 |
| do | 199 | 29.98 | 29.45 | 33.17 | 58 |
| worker_other | 199 | 0.1 | 0 | 1.02 | 1.03 |
| client | 199 | 239.75 | 234.83 | 303 | 356 |
| transport_client | 199 | 33.35 | 32.63 | 40.88 | 46.2 |

Observed colo/placement: {"WAW/local-WAW":199}.

Timing for release: 207/207 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 207 | 205.55 | 199.54 | 268 | 332 |
| auth_rate_limit | 207 | 82.23 | 78.21 | 115 | 190 |
| auth_token | 207 | 80.01 | 78.72 | 105.25 | 139 |
| auth_credential | 207 | 0 | 0 | 0 | 0 |
| membership | 207 | 0 | 0 | 0 | 0 |
| transfer | 207 | 12.89 | 9.1 | 30.41 | 44.5 |
| do | 207 | 30.24 | 29.35 | 32.59 | 67.5 |
| worker_other | 207 | 0.16 | 0 | 1 | 1 |
| client | 207 | 238.75 | 233.38 | 302.67 | 364 |
| transport_client | 207 | 33.2 | 31.8 | 41.75 | 46.5 |

Observed colo/placement: {"WAW/local-WAW":207}.

Timing for renew: 617/617 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 617 | 204.14 | 199.95 | 260 | 316 |
| auth_rate_limit | 617 | 80.95 | 78.12 | 110.17 | 173 |
| auth_token | 617 | 81.44 | 78.95 | 108.33 | 166 |
| auth_credential | 617 | 0 | 0 | 0 | 0 |
| membership | 617 | 0 | 0 | 0 | 0 |
| transfer | 617 | 11.89 | 8.01 | 30.26 | 35.17 |
| do | 617 | 29.75 | 29.34 | 32.45 | 44.5 |
| worker_other | 617 | 0.11 | 0 | 1.02 | 1.03 |
| client | 617 | 237.08 | 233.48 | 293.5 | 343 |
| transport_client | 617 | 32.94 | 31.77 | 40.65 | 61.5 |

Observed colo/placement: {"WAW/local-WAW":617}.


- PASS no errors
- PASS no conflicts on disjoint resources
- PASS no stale fences

#### claims-contended

Participants contend for one or more hot resources: acquire, hold, release. Reports conflicts, takeovers and fence monotonicity. 8 participant(s), 30.4s recorded.
Dataset: hot_resources=1, mode="exclusive", hold_ms=0, ttl_ms=5000, principals=1.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| acquire | 977 | 113 | 864 | 0 | 0 | 32.13 | 212.59 | 291.11 | 343 | 373.11 |
| release | 114 | 114 | 0 | 0 | 0 | 3.75 | 235.67 | 324 | 372 | 385.06 |
| **total** | 1091 | 227 | 864 | 0 | 0 | 35.88 | 214.63 | 293 | 347 | 385.06 |

Timing for acquire: 977/977 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 977 | 184.68 | 179.06 | 256.5 | 309.6 |
| auth_rate_limit | 977 | 84.78 | 81.05 | 119.5 | 197.5 |
| auth_token | 977 | 83.97 | 81.67 | 111 | 188.5 |
| auth_credential | 977 | 0 | 0 | 0 | 0 |
| membership | 977 | 0 | 0 | 0 | 0 |
| transfer | 977 | 7.6 | 5.04 | 28.35 | 34.5 |
| do | 977 | 8.22 | 3.06 | 30.41 | 35.25 |
| worker_other | 977 | 0.12 | 0 | 1.02 | 2.04 |
| client | 977 | 218.04 | 212.59 | 291.11 | 343 |
| transport_client | 977 | 33.36 | 31.86 | 41.45 | 49.5 |

Observed colo/placement: {"WAW/local-WAW":977}.

Timing for release: 114/114 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 114 | 207.67 | 204.4 | 270 | 340 |
| auth_rate_limit | 114 | 86.61 | 83 | 121 | 206 |
| auth_token | 114 | 85.71 | 83.31 | 109 | 196 |
| auth_credential | 114 | 0 | 0 | 0 | 0 |
| membership | 114 | 0 | 0 | 0 | 0 |
| transfer | 114 | 5.8 | 5.02 | 9.13 | 41.5 |
| do | 114 | 29.5 | 29.33 | 30.48 | 32.75 |
| worker_other | 114 | 0.04 | 0 | 0 | 1 |
| client | 114 | 240.85 | 235.67 | 324 | 372 |
| transport_client | 114 | 33.19 | 31.43 | 40.63 | 41.83 |

Observed colo/placement: {"WAW/local-WAW":114}.

Counters: takeovers=0, fence_reorders_observed=0, journal_fence_regressions=0, journal_acquires_audited=130.

- PASS no errors
- PASS journal fences never regress per resource (0 regressions in 130 acquires)
- PASS outcome classes sum to ops

#### fenced-writes

Fenced task updates (owner-mode claims) with a thief forcing stale-fence retries, or CAS record writes between paired participants. 8 participant(s), 30.3s recorded.
Dataset: target="tasks", tasks=7, records=0, thief=true, steal_every=5, ttl_ms=30000.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| reacquire | 103 | 103 | 0 | 0 | 0 | 3.4 | 230 | 308 | 326.67 | 357.88 |
| steal | 112 | 112 | 0 | 0 | 0 | 3.7 | 234.6 | 308 | 364 | 406.51 |
| update | 796 | 694 | 0 | 102 | 0 | 26.3 | 226.24 | 308.67 | 378 | 433.05 |
| **total** | 1011 | 909 | 0 | 102 | 0 | 33.41 | 227.95 | 308.5 | 372 | 433.05 |

Timing for reacquire: 103/103 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 103 | 200.22 | 196.29 | 276 | 302 |
| auth_rate_limit | 103 | 77.6 | 75.5 | 99.5 | 154 |
| auth_token | 103 | 79.99 | 76.83 | 113 | 179 |
| auth_credential | 103 | 0 | 0 | 0 | 0 |
| membership | 103 | 0 | 0 | 0 | 0 |
| transfer | 103 | 12.71 | 7.03 | 31.25 | 62.5 |
| do | 103 | 29.82 | 29.34 | 35.17 | 37.5 |
| worker_other | 103 | 0.1 | 0 | 1.01 | 1.03 |
| client | 103 | 234.27 | 230 | 308 | 326.67 |
| transport_client | 103 | 34.04 | 31.88 | 42.7 | 84.5 |

Observed colo/placement: {"WAW/local-WAW":103}.

Timing for steal: 112/112 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 112 | 202.93 | 202.33 | 274 | 314 |
| auth_rate_limit | 112 | 80.38 | 78.14 | 105.5 | 178 |
| auth_token | 112 | 79.29 | 76.71 | 106.33 | 178 |
| auth_credential | 112 | 0 | 0 | 0 | 0 |
| membership | 112 | 0 | 0 | 0 | 0 |
| transfer | 112 | 13.96 | 9.16 | 32.5 | 55.5 |
| do | 112 | 29.21 | 29.14 | 33.5 | 34.83 |
| worker_other | 112 | 0.08 | 0 | 1 | 1 |
| client | 112 | 238.98 | 234.6 | 308 | 364 |
| transport_client | 112 | 36.05 | 32.89 | 46.75 | 91 |

Observed colo/placement: {"WAW/local-WAW":112}.

Timing for update: 796/796 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 796 | 198.34 | 192.48 | 268 | 332 |
| auth_rate_limit | 796 | 78.28 | 74.02 | 109 | 178 |
| auth_token | 796 | 79.76 | 76.56 | 107.88 | 182 |
| auth_credential | 796 | 0 | 0 | 0 | 0 |
| membership | 796 | 0 | 0 | 0 | 0 |
| transfer | 796 | 12.28 | 6.11 | 32.14 | 52.25 |
| do | 796 | 27.94 | 29.5 | 33.36 | 64.33 |
| worker_other | 796 | 0.09 | 0 | 1.01 | 1.03 |
| client | 796 | 233.52 | 226.24 | 308.67 | 378 |
| transport_client | 796 | 35.17 | 32.41 | 44.56 | 93 |

Observed colo/placement: {"WAW/local-WAW":796}.

Counters: steals=131, reacquires=120.

- PASS no errors
- PASS stale fences were rejected

#### presence-signals

Presence heartbeat, then a participant-targeted signal to a random peer, then inbox read and acknowledgement of every pending bench signal. 8 participant(s), 30.9s recorded.
Dataset: participants=8, signal_ttl_ms=60000.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ack | 271 | 271 | 0 | 0 | 0 | 8.78 | 229.58 | 298 | 342 | 386.9 |
| heartbeat | 264 | 264 | 0 | 0 | 0 | 8.55 | 230.13 | 298 | 364 | 375.95 |
| inbox | 266 | 266 | 0 | 0 | 0 | 8.62 | 203.47 | 284 | 330 | 340.66 |
| send | 266 | 266 | 0 | 0 | 0 | 8.62 | 232.6 | 308 | 372 | 376.67 |
| **total** | 1067 | 1067 | 0 | 0 | 0 | 34.56 | 224.05 | 300.4 | 348 | 386.9 |

Timing for ack: 271/271 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 271 | 198.17 | 193.4 | 260 | 310.67 |
| auth_rate_limit | 271 | 79.47 | 76.88 | 105.75 | 170 |
| auth_token | 271 | 81.53 | 77.95 | 111.5 | 193 |
| auth_credential | 271 | 0 | 0 | 0 | 0 |
| membership | 271 | 0 | 0 | 0 | 0 |
| transfer | 271 | 9.67 | 5.12 | 28.13 | 31.38 |
| do | 271 | 27.48 | 27.4 | 29.4 | 31 |
| worker_other | 271 | 0.03 | 0 | 0 | 1 |
| client | 271 | 232.63 | 229.58 | 298 | 342 |
| transport_client | 271 | 34.46 | 32.98 | 43.58 | 52.5 |

Observed colo/placement: {"WAW/local-WAW":271}.

Timing for heartbeat: 264/264 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 264 | 199.47 | 196.14 | 260 | 329.33 |
| auth_rate_limit | 264 | 80.01 | 76.81 | 109.5 | 186 |
| auth_token | 264 | 81.64 | 79.21 | 109 | 189 |
| auth_credential | 264 | 0 | 0 | 0 | 0 |
| membership | 264 | 0 | 0 | 0 | 0 |
| transfer | 264 | 10.36 | 5.12 | 28.31 | 42.5 |
| do | 264 | 27.42 | 27.25 | 29.14 | 31.38 |
| worker_other | 264 | 0.03 | 0 | 0 | 1.02 |
| client | 264 | 234.51 | 230.13 | 298 | 364 |
| transport_client | 264 | 35.04 | 33.03 | 44.13 | 56.5 |

Observed colo/placement: {"WAW/local-WAW":264}.

Timing for inbox: 266/266 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 266 | 174.69 | 167.13 | 250 | 292 |
| auth_rate_limit | 266 | 82.13 | 77.79 | 116.5 | 194 |
| auth_token | 266 | 81.45 | 77.75 | 106.5 | 190 |
| auth_credential | 266 | 0 | 0 | 0 | 0 |
| membership | 266 | 0 | 0 | 0 | 0 |
| transfer | 266 | 0 | 0 | 0 | 0 |
| do | 266 | 11.11 | 6.1 | 30.08 | 48.5 |
| worker_other | 266 | 0 | 0 | 0 | 0 |
| client | 266 | 209.83 | 203.47 | 284 | 330 |
| transport_client | 266 | 35.14 | 33.14 | 46.13 | 51.75 |

Observed colo/placement: {"WAW/local-WAW":266}.

Timing for send: 266/266 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 266 | 203.36 | 196.5 | 276 | 333 |
| auth_rate_limit | 266 | 80.59 | 77.31 | 114.33 | 174 |
| auth_token | 266 | 82.57 | 78.07 | 111.67 | 194 |
| auth_credential | 266 | 0 | 0 | 0 | 0 |
| membership | 266 | 0 | 0 | 0 | 0 |
| transfer | 266 | 10.88 | 5.1 | 29.44 | 69 |
| do | 266 | 29.27 | 28.14 | 30.4 | 79 |
| worker_other | 266 | 0.06 | 0 | 1 | 1.03 |
| client | 266 | 239.34 | 232.6 | 308 | 372 |
| transport_client | 266 | 35.98 | 33.68 | 46.17 | 89 |

Observed colo/placement: {"WAW/local-WAW":266}.

Counters: inbox_backlog_max=4, signals_sent=312, signals_acked=312.

- PASS no errors
- PASS every sent signal was acknowledged after drain (312/312)

#### journal-replay

Writers append journal rows via claim cycles while readers page the journal with replay cursors and acknowledge progress. 8 participant(s), 30.3s recorded.
Dataset: writers=4, readers=4, page_limit=200, ttl_ms=30000.

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| acknowledge | 267 | 267 | 0 | 0 | 0 | 8.81 | 236.56 | 293 | 404 | 434.96 |
| replay | 266 | 266 | 0 | 0 | 0 | 8.78 | 206.14 | 274 | 318 | 408.84 |
| write_acquire | 250 | 250 | 0 | 0 | 0 | 8.25 | 233.29 | 290 | 396 | 464.52 |
| write_release | 254 | 254 | 0 | 0 | 0 | 8.38 | 232.18 | 310 | 354 | 436.43 |
| **total** | 1037 | 1037 | 0 | 0 | 0 | 34.23 | 228.03 | 295.71 | 354 | 464.52 |

Timing for acknowledge: 267/267 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 267 | 204.04 | 200.14 | 262 | 372 |
| auth_rate_limit | 267 | 83.24 | 78.23 | 112.5 | 182 |
| auth_token | 267 | 81.34 | 79.72 | 105.5 | 162 |
| auth_credential | 267 | 0 | 0 | 0 | 0 |
| membership | 267 | 0 | 0 | 0 | 0 |
| transfer | 267 | 11.63 | 6.09 | 30.21 | 33.75 |
| do | 267 | 27.79 | 27.45 | 30.03 | 32.83 |
| worker_other | 267 | 0.04 | 0 | 0 | 1.03 |
| client | 267 | 239.81 | 236.56 | 293 | 404 |
| transport_client | 267 | 35.77 | 34.33 | 44.88 | 60.5 |

Observed colo/placement: {"WAW/local-WAW":267}.

Timing for replay: 266/266 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 266 | 175.28 | 169.88 | 242 | 284 |
| auth_rate_limit | 266 | 82.36 | 78.23 | 107.75 | 182 |
| auth_token | 266 | 82.68 | 79.74 | 108.33 | 188.67 |
| auth_credential | 266 | 0 | 0 | 0 | 0 |
| membership | 266 | 0 | 0 | 0 | 0 |
| transfer | 266 | 0 | 0 | 0 | 0 |
| do | 266 | 10.21 | 6.08 | 29.11 | 31.25 |
| worker_other | 266 | 0.03 | 0 | 0 | 1.02 |
| client | 266 | 211.23 | 206.14 | 274 | 318 |
| transport_client | 266 | 35.95 | 34.5 | 43.58 | 63.5 |

Observed colo/placement: {"WAW/local-WAW":266}.

Timing for write_acquire: 250/250 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 250 | 203.39 | 199.57 | 258 | 364 |
| auth_rate_limit | 250 | 82.03 | 77.59 | 108.33 | 190 |
| auth_token | 250 | 81.48 | 80.14 | 102.6 | 163 |
| auth_credential | 250 | 0 | 0 | 0 | 0 |
| membership | 250 | 0 | 0 | 0 | 0 |
| transfer | 250 | 10.5 | 6.03 | 29.31 | 33.5 |
| do | 250 | 29.32 | 29.27 | 32.1 | 34.75 |
| worker_other | 250 | 0.06 | 0 | 0 | 1.03 |
| client | 250 | 237.87 | 233.29 | 290 | 396 |
| transport_client | 250 | 34.48 | 32.8 | 42.81 | 45.5 |

Observed colo/placement: {"WAW/local-WAW":250}.

Timing for write_release: 254/254 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 254 | 204.1 | 198.5 | 270 | 322 |
| auth_rate_limit | 254 | 81.21 | 78.1 | 107.5 | 185 |
| auth_token | 254 | 83.66 | 80.25 | 111 | 198 |
| auth_credential | 254 | 0 | 0 | 0 | 0 |
| membership | 254 | 0 | 0 | 0 | 0 |
| transfer | 254 | 9.73 | 5.11 | 29.23 | 32.5 |
| do | 254 | 29.46 | 29.21 | 31.36 | 36.5 |
| worker_other | 254 | 0.04 | 0 | 0 | 1.03 |
| client | 254 | 238.72 | 232.18 | 310 | 354 |
| transport_client | 254 | 34.62 | 32.56 | 44.3 | 64.5 |

Observed colo/placement: {"WAW/local-WAW":254}.

Counters: reader_lag_max=0, reader_lag_mean=0, seq_regressions=0, seq_gaps=0, pages_with_events=310.

- PASS no errors
- PASS replay pages are strictly increasing
- PASS no sequence gaps inside pages (0 gaps)

#### artifacts

Artifact upload (no claim; sizes round-robin), metadata read-back, and a periodic kind-filtered list. The embedded tier writes text blobs via writeText. 8 participant(s), 30.8s recorded.
Dataset: sizes_bytes=[1024,65536,1048576], list_every=5, kind="bench".

| op | ops | ok | conflicts | stale fence | errors | ops/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| list | 65 | 65 | 0 | 0 | 0 | 2.11 | 200.4 | 300 | 353.49 | 353.49 |
| meta | 344 | 344 | 0 | 0 | 0 | 11.18 | 188.13 | 300 | 393.33 | 417.72 |
| upload_1k | 112 | 112 | 0 | 0 | 0 | 3.64 | 402.5 | 532 | 632 | 660.56 |
| upload_1m | 115 | 115 | 0 | 0 | 0 | 3.74 | 527.27 | 668 | 776 | 883.89 |
| upload_64k | 114 | 114 | 0 | 0 | 0 | 3.7 | 429.67 | 588 | 712 | 898.94 |
| **total** | 750 | 750 | 0 | 0 | 0 | 24.37 | 260 | 578.18 | 669.33 | 898.94 |

Timing for list: 65/65 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 65 | 167.35 | 159.5 | 254 | 320 |
| auth_rate_limit | 65 | 80.43 | 74.2 | 111 | 224 |
| auth_token | 65 | 76.51 | 71.75 | 113 | 178 |
| auth_credential | 65 | 0 | 0 | 0 | 0 |
| membership | 65 | 0 | 0 | 0 | 0 |
| transfer | 65 | 0 | 0 | 0 | 0 |
| do | 65 | 10.41 | 9.1 | 21.25 | 32 |
| worker_other | 65 | 0 | 0 | 0 | 0 |
| client | 65 | 208.49 | 200.4 | 300 | 353.49 |
| transport_client | 65 | 41.13 | 38.5 | 52.25 | 146 |

Observed colo/placement: {"WAW/local-WAW":65}.

Timing for meta: 344/344 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 344 | 164.06 | 152.25 | 254 | 350.67 |
| auth_rate_limit | 344 | 79.73 | 71.3 | 146 | 238 |
| auth_token | 344 | 74.84 | 70.97 | 100.5 | 186 |
| auth_credential | 344 | 0 | 0 | 0 | 0 |
| membership | 344 | 0 | 0 | 0 | 0 |
| transfer | 344 | 0 | 0 | 0 | 0 |
| do | 344 | 0 | 0 | 0 | 0 |
| worker_other | 344 | 9.49 | 6.05 | 28.42 | 35.5 |
| client | 344 | 200.49 | 188.13 | 300 | 393.33 |
| transport_client | 344 | 36.43 | 33.95 | 47.75 | 66.5 |

Observed colo/placement: {"WAW/local-WAW":344}.

Timing for upload_1k: 112/112 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 112 | 380.57 | 368.4 | 484 | 600 |
| auth_rate_limit | 112 | 73.59 | 70.5 | 97.5 | 166 |
| auth_token | 112 | 75.47 | 69.36 | 103 | 206 |
| auth_credential | 112 | 0 | 0 | 0 | 0 |
| membership | 112 | 0 | 0 | 0 | 0 |
| transfer | 112 | 10.36 | 5.07 | 32.25 | 65 |
| do | 112 | 31.03 | 31.02 | 33.5 | 35.83 |
| worker_other | 112 | 190.13 | 181 | 259 | 276 |
| client | 112 | 415.84 | 402.5 | 532 | 632 |
| transport_client | 112 | 35.27 | 34.14 | 44.5 | 50.5 |

Observed colo/placement: {"WAW/local-WAW":112}.

Timing for upload_1m: 115/115 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 115 | 452.04 | 437.25 | 568 | 664 |
| auth_rate_limit | 115 | 76.81 | 72.13 | 105 | 182 |
| auth_token | 115 | 75.38 | 72.11 | 95.67 | 186 |
| auth_credential | 115 | 0 | 0 | 0 | 0 |
| membership | 115 | 0 | 0 | 0 | 0 |
| transfer | 115 | 8.38 | 5.07 | 27.38 | 35 |
| do | 115 | 32.52 | 31.11 | 35.83 | 83.5 |
| worker_other | 115 | 258.94 | 241.67 | 380 | 444 |
| client | 115 | 540.5 | 527.27 | 668 | 776 |
| transport_client | 115 | 88.47 | 78.75 | 152.67 | 193 |

Observed colo/placement: {"WAW/local-WAW":115}.

Timing for upload_64k: 114/114 HTTP responses covered; 0 invalid residuals.

| component | count | mean ms | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| worker | 114 | 399.24 | 384.86 | 540 | 680 |
| auth_rate_limit | 114 | 80.6 | 71.25 | 186 | 276 |
| auth_token | 114 | 73.97 | 73 | 95.5 | 106 |
| auth_credential | 114 | 0 | 0 | 0 | 0 |
| membership | 114 | 0 | 0 | 0 | 0 |
| transfer | 114 | 8.53 | 5.07 | 26.25 | 33.5 |
| do | 114 | 30.55 | 30.39 | 33.17 | 34.75 |
| worker_other | 114 | 205.59 | 196.46 | 268 | 372 |
| client | 114 | 447.82 | 429.67 | 588 | 712 |
| transport_client | 114 | 48.58 | 41.63 | 77 | 87 |

Observed colo/placement: {"WAW/local-WAW":114}.

Counters: meta_size_mismatches=0, bytes_uploaded=148311040.

- PASS no errors
- PASS metadata byte counts match uploads
