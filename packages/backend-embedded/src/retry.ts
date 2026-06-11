/**
 * Runtime-neutral SQLITE_BUSY retry wrapper.
 *
 * Sync SQLite drivers (bun:sqlite, better-sqlite3) execute synchronously. When a
 * write fails because another process holds the write lock (and the driver's
 * built-in `busy_timeout` has already been exhausted), this wrapper retries with
 * exponential backoff + jitter.
 *
 * The retry fires AFTER SQLite's built-in `busy_timeout` (typically 5000ms) has
 * been exhausted — this is a second-layer retry for truly contended workloads.
 *
 * Unlike `@tila/backend-local`'s original `withBusyRetry`, this version is
 * runtime-agnostic: it takes an injected `sleepSync(ms)` rather than calling
 * `Bun.sleepSync`. This keeps `@tila/backend-embedded` free of `bun:*`/`node:*`
 * imports (the package's runtime-import invariant — see the `no-runtime-imports`
 * fitness test). The host (bun wrapper, node wrapper, test harness) supplies the
 * concrete blocking-sleep primitive.
 */

export type SleepSync = (ms: number) => void;

function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Check top-level message (direct driver errors)
  if (
    err.message.includes("SQLITE_BUSY") ||
    err.message.includes("database is locked")
  ) {
    return true;
  }
  // Check wrapped cause (Drizzle wraps driver errors with "Failed to run the query …").
  // The actual SQLITE_BUSY message is in err.cause.
  if (err.cause instanceof Error) {
    return (
      err.cause.message.includes("SQLITE_BUSY") ||
      err.cause.message.includes("database is locked")
    );
  }
  return false;
}

/**
 * Run `fn`, retrying on SQLITE_BUSY with exponential backoff. The blocking sleep
 * between attempts is delegated to the injected `sleepSync`.
 */
export function withBusyRetry<T>(
  fn: () => T,
  sleepSync: SleepSync,
  maxRetries = 5,
): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delay = 2 ** attempt * 50 + Math.random() * 50;
        sleepSync(delay);
      }
    }
  }
  throw lastError;
}
