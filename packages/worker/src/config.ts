/**
 * Shared worker configuration constants.
 * All magic numbers that appear in multiple files or warrant a named constant
 * should be defined here and imported by the relevant modules.
 */

/** Bearer-session TTL by permission tier, in seconds. read keeps the 1h window; write/admin
 *  are shortened to minutes to bound post-offboarding exposure (WI-H / #131). */
export const SESSION_TTL_SECONDS_BY_TIER = {
  read: 3600, // 1 hour (unchanged)
  write: 900, // 15 minutes
  admin: 300, // 5 minutes
} as const satisfies Record<"read" | "write" | "admin", number>;

/** @deprecated Back-compat alias = the read tier. Existing importers keep compiling; new code
 *  should select from SESSION_TTL_SECONDS_BY_TIER. */
export const SESSION_TTL_SECONDS = SESSION_TTL_SECONDS_BY_TIER.read;

/**
 * Cookie-session TTL in seconds (8 hours).
 * Intentionally longer than SESSION_TTL_SECONDS because cookie sessions are
 * backed by D1 and can be revoked server-side, so a longer window is safe.
 */
export const COOKIE_SESSION_TTL_SECONDS = 28800;

/**
 * Retention for revocation tombstones before cron GC. Must stay >= the longest
 * session lifetime (COOKIE_SESSION_TTL_SECONDS) so a tombstone is never pruned
 * while a token it denies is still live. 2x for clock-skew + safety margin.
 */
export const REVOCATION_GC_RETENTION_MS = COOKIE_SESSION_TTL_SECONDS * 1000 * 2;

/** Maximum failed auth attempts before rate-limiting an IP. */
export const RATE_LIMIT_MAX_FAILURES = 20;

/** Rate-limit sliding window duration in milliseconds (1 minute). */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Timeout for outbound GitHub API requests in milliseconds. */
export const GITHUB_API_TIMEOUT_MS = 5_000;

/**
 * Minimum interval between last_used_at writes for the same token (debounce).
 * Prevents D1 write storms on high-frequency API calls.
 */
export const DEBOUNCE_MS = 60_000;

/**
 * Maximum number of entries in the in-memory debounce map.
 * Prevents unbounded memory growth under long-running isolate scenarios.
 */
export const MAX_DEBOUNCE_MAP_SIZE = 2000;

/**
 * Number of expired artifact pointers requested from a DO per /sweep call.
 * The sweep re-arms this page in a drain loop until a project is fully cleared
 * (see SWEEP_MAX_DRAIN_ITERATIONS) — so this is a per-round page size, NOT a
 * per-run cap. The DO clamps the accepted value to [1, 500].
 *
 * Kept modest (well under the DO clamp ceiling) so a single drain round can
 * never itself approach the Workers subrequest cap: each key costs
 * SWEEP_SUBREQUESTS_PER_KEY subrequests, so one round is at most
 * page * SWEEP_SUBREQUESTS_PER_KEY (150 * 3 = 450) — leaving the
 * per-invocation bound (SWEEP_SUBREQUEST_BUDGET) as the real limiter.
 */
export const SWEEP_DRAIN_PAGE_SIZE = 150;

/**
 * Candidate cap for the artifact searchable-pointers repair scan
 * (routes/artifacts.ts). This was historically coupled to the sweep batch
 * constant; it is now its own constant so the two evolve independently. Keep
 * at 100 unless the repair scan specifically needs a wider window.
 */
export const ARTIFACT_REPAIR_SCAN_LIMIT = 100;

/**
 * Wall-clock budget for a single sweep run, in milliseconds. When exceeded, the
 * run stops cleanly between projects (or between drain rounds) and records a
 * resume point in the summary so the next run knows where it stopped. Sized
 * well under the Workers cron CPU/wall limits with headroom for a slow night.
 */
export const SWEEP_TIME_BUDGET_MS = 25_000;

/**
 * Subrequests consumed per expired artifact key during the drain:
 *   1. POST /artifact/tombstone   (DO fetch)
 *   2. r2.delete                  (R2 binding call)
 *   3. POST /artifact/confirm-blob-deleted (DO fetch)
 * A failed delete adds a retry, so this is the nominal (not worst-case) cost;
 * the budget ceiling below carries headroom to absorb retries and per-project
 * overhead (/sweep, /journal/archive, /search-drift, reconcile).
 */
export const SWEEP_SUBREQUESTS_PER_KEY = 3;

/**
 * Per-Worker-invocation subrequest budget for the sweep — a DELIBERATE
 * conservative self-throttle, NOT the platform cap.
 *
 * Cloudflare's real per-invocation subrequest limits (verified 2026-06, after
 * the old uniform "1000 per invocation" cap was removed on 2026-02-11):
 *   - Paid plan: 10,000 subrequests/invocation by default (raisable via
 *     `limits.subrequests` in wrangler config, up to 10M).
 *   - Free plan: 50 EXTERNAL fetch() subrequests, plus a separate ceiling of
 *     1,000 subrequests to internal Cloudflare services (DO, R2, D1, KV).
 * A cron sweep is ONE invocation fanning out across every project and drain
 * round, and every call it makes is to an internal service (DO `/sweep`,
 * R2 put/delete, D1) — so the binding constraint on the smallest plan is the
 * Free-plan 1,000-internal-services ceiling, not the external-fetch limit.
 *
 * 800 stays safely under that 1,000 internal-services ceiling (so the sweep is
 * correct even on Free) with ~200 of headroom for delete-retries, per-project
 * journal/drift/reconcile overhead, and the global session-cleanup call — and
 * is trivially within the Paid-plan budget. When the running counter would
 * cross this self-imposed ceiling the run stops cleanly and records a resume
 * point; the NEXT cron run continues the backlog. Draining a large backlog
 * across multiple daily runs is expected and correct. Do NOT raise this to
 * chase the platform max — the multi-run drain is the intended design.
 */
export const SWEEP_SUBREQUEST_BUDGET = 800;

/**
 * Safety clamp on the per-project expired-artifact drain loop. Each round
 * tombstones up to SWEEP_DRAIN_PAGE_SIZE keys (removing them from the next
 * round's candidate set), so a project of any realistic size drains in a
 * handful of rounds. This bound prevents an unbounded loop if a DO ever
 * returns a full page without the candidate set shrinking (e.g. a
 * tombstone-path bug). Hitting it marks ONLY that project degraded — it does
 * NOT abort the run for sibling projects.
 */
export const SWEEP_MAX_DRAIN_ITERATIONS = 50;

/**
 * Minimum number of drift findings that triggers search index reconciliation.
 * Below this threshold the drift is logged but no rebuild is run.
 */
export const DRIFT_RECONCILE_THRESHOLD = 10;

/**
 * Worst-case subrequests the drift step issues for one project:
 *   1. GET  /artifact/search-drift        (always)
 *   2. GET  /artifact/search-rebuild-scan (only when reconciliation fires)
 *   3. POST /artifact/search-rebuild      (only when reconciliation fires)
 * The sweep reserves this many before entering the drift step so reconciliation
 * firing near the budget edge can never push the per-invocation subrequest
 * total past the ceiling.
 */
export const SWEEP_DRIFT_MAX_SUBREQUESTS = 3;

/**
 * Cap on the number of HEALTHY per-project sweep Analytics datapoints emitted in
 * one invocation. Cloudflare Analytics Engine hard-caps writeDataPoint at 250
 * calls PER INVOCATION; beyond that, calls are silently dropped. A cron sweep is
 * one invocation, so a >250-project fleet would lose per-project metrics for the
 * overflow.
 *
 * The sweep self-limits below that hard cap: healthy projects emit only up to
 * this many datapoints, while DEGRADED/TRUNCATED projects (the operator-critical
 * ones) always emit, and a single run-level ROLLUP datapoint always emits. 200
 * leaves ~50 of headroom under the 250 cap for the always-emit degraded/rollup
 * datapoints, so aggregate observability survives at any fleet size.
 */
export const SWEEP_ANALYTICS_MAX_PROJECT_DATAPOINTS = 200;

/**
 * Maximum number of D1-fail-open events from a single IP before the in-isolate
 * secondary rate-limit guard returns 429 (C8).
 * This threshold is intentionally higher than RATE_LIMIT_MAX_FAILURES because
 * this is a defense-in-depth fallback for D1 blips, not the primary guard.
 */
export const ISOLATE_RL_MAX_FAILURES = 30;

/**
 * Maximum number of IPs tracked by the in-isolate sliding-window failure map.
 * Prevents unbounded memory growth under long-running isolate scenarios.
 */
export const ISOLATE_RL_MAX_MAP_SIZE = 2000;

/**
 * TTL for the per-isolate jti revocation status cache (C9).
 * Revocation is effective within at most this duration across isolates.
 * The revoking isolate invalidates its own cache entry immediately.
 *
 * Security posture: fail-closed (D1 lookup error → deny); bounded ≤TTL
 * staleness across isolates (not instant cross-isolate propagation).
 */
export const JTI_REVCHECK_TTL_MS = 60_000; // 60 seconds

/**
 * Maximum number of jti entries in the per-isolate revocation status cache (C9).
 * Consistent with ISOLATE_RL_MAX_MAP_SIZE and MAX_DEBOUNCE_MAP_SIZE — all
 * per-isolate maps are capped to prevent unbounded memory growth.
 * Oldest entry is evicted on overflow (same pattern as isolateFailMap).
 */
export const JTI_REV_CACHE_MAX_SIZE = 2000;

/**
 * TTL for the per-isolate subject revocation status cache (C7/C9).
 * Revocation is effective within at most this duration across isolates.
 * The revoking isolate invalidates its own cache entry immediately.
 *
 * Security posture: fail-closed (D1 lookup error → deny); bounded ≤TTL
 * staleness across isolates (not instant cross-isolate propagation).
 */
export const SUBJECT_REVCHECK_TTL_MS = 60_000; // 60 seconds

/**
 * Maximum number of subject revocation entries in the per-isolate cache (C7/C9).
 * Consistent with JTI_REV_CACHE_MAX_SIZE — all per-isolate maps are capped
 * to prevent unbounded memory growth. Oldest entry is evicted on overflow.
 */
export const SUBJECT_REV_CACHE_MAX_SIZE = 2000;

/** TTL for the per-isolate admin-grants roster cache (≤10s per OR-2; fail-closed). */
export const ADMIN_GRANTS_CACHE_TTL_MS = 10_000; // 10 seconds

/** Maximum number of roster entries in the per-isolate admin-grants cache (oldest-evict on overflow). */
export const ADMIN_GRANTS_CACHE_MAX_SIZE = 2000;

/**
 * TTL for the per-isolate permission re-check cache (Layer B, WI-H).
 * A cached positive result (permission still sufficient) is accepted for at most
 * this long before another GitHub round-trip is required. Mirrors
 * JTI_REVCHECK_TTL_MS — both are 60-second staleness windows.
 */
export const PERMISSION_RECHECK_TTL_MS = 60_000; // 60 seconds

/**
 * Back-off window for a cached negative permission result (Layer B, WI-H).
 * After a confirmed downgrade / absent result, the deny is re-asserted for
 * this duration before the next re-check is attempted (prevents hammering
 * the GitHub API after a mass-offboarding event).
 */
export const PERMISSION_RECHECK_BACKOFF_MS = 10_000; // 10 seconds

/**
 * Maximum number of jti entries in the per-isolate permission re-check cache (Layer B, WI-H).
 * Consistent with JTI_REV_CACHE_MAX_SIZE, ISOLATE_RL_MAX_MAP_SIZE, and MAX_DEBOUNCE_MAP_SIZE —
 * all per-isolate maps are capped to prevent unbounded memory growth.
 * Oldest entry is evicted on overflow (same pattern as isolateFailMap / jtiRevCache).
 */
export const PERMISSION_RECHECK_CACHE_MAX_SIZE = 2000;

/**
 * Maximum age of a DPoP proof `iat` claim relative to the server clock, in
 * milliseconds. Proofs older than this window are rejected as stale (WI-G / C3).
 *
 * 60 s matches the existing JTI_REVCHECK_TTL_MS precedent and is a reasonable
 * two-sided window for Smart Placement clock drift. The value is tunable later.
 */
export const DPOP_PROOF_MAX_AGE_MS = 60_000; // 60 seconds

/**
 * Allowed future-dated `iat` skew for DPoP proofs, in milliseconds.
 * A proof whose `iat` is at most this far in the future is still accepted,
 * accommodating minor client clock drift without widening the replay window.
 */
export const DPOP_CLOCK_SKEW_MS = 5_000; // 5 seconds
