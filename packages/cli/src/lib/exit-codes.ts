import { TILA_ERRORS } from "tila-sdk";

/**
 * Stable process exit codes for CLI automation.
 *
 * - **SUCCESS (0):** Command completed without errors.
 * - **USER_ERROR (1):** Non-retryable failure — bad input, auth error,
 *   conflict, not-found, validation. Automation should NOT retry without
 *   a human fix.
 * - **NETWORK_ERROR (2):** Transient/retryable failure — the backend was
 *   unreachable, rate-limited, or returned an internal server error.
 *   Automation MAY retry with backoff.
 *
 * Note: `doctor` uses its own 0/1/2 health-tier contract (all-pass/warn/fail)
 * and does NOT route through this map.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  USER_ERROR: 1,
  NETWORK_ERROR: 2,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * The set of TILA_ERRORS values that indicate a transient/retryable network or
 * server error (exit code 2). Everything else — including UNKNOWN and any
 * unmapped string — is USER_ERROR (exit code 1).
 *
 * Keyed off TILA_ERRORS const values so a future casing migration only touches
 * one file (error-codes.ts in tila-sdk).
 */
const NETWORK_ERROR_CODES = new Set<string>([
  TILA_ERRORS.DO_UNREACHABLE, // "do-unreachable"
  TILA_ERRORS.RATE_LIMITED, // "RATE_LIMITED"
  TILA_ERRORS.INTERNAL_ERROR, // "INTERNAL_ERROR"
  TILA_ERRORS.INTERNAL, // "internal"
  // SDK-generated fetch/network failures (no HTTP code from server)
  "fetch-failed",
  "network-error",
]);

/**
 * Map a TILA_ERRORS code (or any raw string) to the appropriate process exit
 * code.
 *
 * - Transient/retryable errors → `EXIT_CODES.NETWORK_ERROR` (2)
 * - Everything else (incl. unmapped codes and UNKNOWN) → `EXIT_CODES.USER_ERROR` (1)
 *
 * The UNKNOWN default ensures an unmapped literal like `"NETWORK_ERROR"` (the
 * old signal.ts code, before C2 fixed it) never silently signals "retry" to
 * automation — it falls through to USER_ERROR.
 */
export function exitCodeFor(code: string): ExitCode {
  if (NETWORK_ERROR_CODES.has(code)) {
    return EXIT_CODES.NETWORK_ERROR;
  }
  return EXIT_CODES.USER_ERROR;
}
