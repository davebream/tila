/**
 * Shared worker configuration constants.
 * All magic numbers that appear in multiple files or warrant a named constant
 * should be defined here and imported by the relevant modules.
 */

/** HMAC bearer-token TTL in seconds (1 hour). Stateless — not revocable. */
export const SESSION_TTL_SECONDS = 3600;

/**
 * Cookie-session TTL in seconds (8 hours).
 * Intentionally longer than SESSION_TTL_SECONDS because cookie sessions are
 * backed by D1 and can be revoked server-side, so a longer window is safe.
 */
export const COOKIE_SESSION_TTL_SECONDS = 28800;

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
 * The sweep now re-arms this batch in a drain loop until a project is fully
 * cleared (see SWEEP_MAX_DRAIN_ITERATIONS) — so this is a per-round page size,
 * NOT a per-run cap. The DO clamps the accepted value to [1, 500]; we request
 * the clamp ceiling to minimize round-trips while staying within it.
 */
export const SWEEP_BATCH_SIZE = 500;

/**
 * Wall-clock budget for a single sweep run, in milliseconds. When exceeded, the
 * run stops cleanly between projects (or between drain rounds) and records a
 * resume point in the summary so the next run knows where it stopped. Sized
 * well under the Workers cron CPU/wall limits with headroom for a slow night.
 */
export const SWEEP_TIME_BUDGET_MS = 25_000;

/**
 * Safety clamp on the per-project expired-artifact drain loop. Each round
 * tombstones up to SWEEP_BATCH_SIZE keys (removing them from the next round's
 * candidate set), so a project of any realistic size drains in a handful of
 * rounds. This bound prevents an unbounded loop if a DO ever returns a full
 * batch without the candidate set shrinking (e.g. a tombstone-path bug).
 */
export const SWEEP_MAX_DRAIN_ITERATIONS = 50;

/**
 * Minimum number of drift findings that triggers search index reconciliation.
 * Below this threshold the drift is logged but no rebuild is run.
 */
export const DRIFT_RECONCILE_THRESHOLD = 10;

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
