/**
 * SQLITE_BUSY retry wrapper.
 *
 * bun:sqlite operations are synchronous. When a write fails because
 * another process holds the write lock (and busy_timeout has already expired),
 * this wrapper retries with exponential backoff + jitter.
 *
 * The retry fires AFTER SQLite's built-in busy_timeout (5000ms) has been
 * exhausted -- this is a second-layer retry for truly contended workloads.
 */

function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Check top-level message (direct bun:sqlite errors)
  if (
    err.message.includes("SQLITE_BUSY") ||
    err.message.includes("database is locked")
  ) {
    return true;
  }
  // Check wrapped cause (Drizzle wraps bun:sqlite errors with "Failed to run the query ...")
  // The actual SQLITE_BUSY message is in err.cause.
  if (err.cause instanceof Error) {
    return (
      err.cause.message.includes("SQLITE_BUSY") ||
      err.cause.message.includes("database is locked")
    );
  }
  return false;
}

/** Sleep helper: uses Bun.sleepSync in production (bun runtime), falls back to no-op in test envs. */
function sleepSync(ms: number): void {
  if (typeof Bun !== "undefined" && typeof Bun.sleepSync === "function") {
    Bun.sleepSync(ms);
  }
  // In non-Bun environments (e.g., vitest under Node): skip sleep.
  // Tests verify retry logic via attempt counts, not timing.
}

async function sleep(ms: number): Promise<void> {
  if (typeof Bun !== "undefined" && typeof Bun.sleep === "function") {
    await Bun.sleep(ms);
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

export function withBusyRetry<T>(fn: () => T, maxRetries = 5): T {
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

export async function withBusyRetryAsync<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delay = 2 ** attempt * 50 + Math.random() * 50;
        await sleep(delay);
      }
    }
  }
  throw lastError;
}
