import { abortable } from "./abort";
import { isTilaApiError } from "./errors";
import { TokenProviderError } from "./token-provider";

export interface RetryOptions {
  /** Cancel attempts and backoff, preserving the signal reason. */
  signal?: AbortSignal;
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
 * Hard stop: if a TilaApiError or TokenProviderError has retryable === false,
 * it is re-thrown immediately without waiting or counting against maxRetries.
 * This is unconditional -- callers cannot override it.
 *
 * Caller cancellation and AbortError also stop immediately. Other errors
 * (network errors, timeouts, TypeErrors) are retried up to maxRetries.
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
    opts?.signal?.throwIfAborted();
    try {
      const work = fn();
      return await (opts?.signal ? abortable(work, opts.signal) : work);
    } catch (err) {
      // Hard stop: TilaApiError with retryable === false is never retried
      if (
        ((isTilaApiError(err) || err instanceof TokenProviderError) &&
          err.retryable === false) ||
        opts?.signal?.aborted ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        throw err;
      }
      // Exhausted all retries
      if (attempt === maxRetries) {
        throw err;
      }
      // Calculate delay with exponential backoff
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const sleepMs = jitter ? Math.random() * cap : cap;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const delay = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, sleepMs);
      });
      try {
        await (opts?.signal ? abortable(delay, opts.signal) : delay);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  // Unreachable but satisfies TypeScript
  throw new Error("withRetry: unreachable");
}
