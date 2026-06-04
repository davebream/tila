import { isTilaApiError } from "./client";

export interface RetryOptions {
  /** Maximum number of retry attempts after the first failure. Default: 3. */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff. Default: 200. */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds. Default: 30000. */
  maxDelayMs?: number;
  /** Whether to apply full jitter to the delay. Default: true. */
  jitter?: boolean;
}

/**
 * Retry wrapper with exponential backoff and full jitter.
 *
 * Follows the AWS "Full Jitter" pattern:
 *   sleep = random(0, min(cap, base * 2^attempt))
 *
 * Hard stop: if the thrown error is a TilaApiError with retryable === false,
 * it is re-thrown immediately without waiting or counting against maxRetries.
 * This is unconditional -- callers cannot override it.
 *
 * Non-TilaApiError errors (network errors, timeouts, TypeErrors) are always
 * retried up to maxRetries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 200;
  const maxDelayMs = opts?.maxDelayMs ?? 30_000;
  const jitter = opts?.jitter ?? true;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Hard stop: TilaApiError with retryable === false is never retried
      if (isTilaApiError(err) && err.retryable === false) {
        throw err;
      }
      // Exhausted all retries
      if (attempt === maxRetries) {
        throw err;
      }
      // Calculate delay with exponential backoff
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const sleepMs = jitter ? Math.random() * cap : cap;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
  // Unreachable but satisfies TypeScript
  throw new Error("withRetry: unreachable");
}
