/**
 * Typed error code constants for all tila API error responses.
 *
 * Keys are normalized identifiers. Values are the exact wire-format strings
 * returned by the worker and DO layers.
 *
 * NOTE: The codebase uses two conventions for error codes:
 * - SCREAMING_SNAKE_CASE for worker/auth-layer codes ("UNAUTHORIZED", "SESSION_EXPIRED")
 * - kebab-case for DO-layer codes ("stale-fence", "not-found")
 * TILA_ERRORS preserves both conventions in its values. The _UPPER suffix on
 * VALIDATION_ERROR_UPPER disambiguates the two distinct wire values for
 * "validation error" used in different layers.
 */
export const TILA_ERRORS = {
  // Auth / middleware (worker layer — SCREAMING_SNAKE_CASE wire values)
  UNAUTHORIZED: "UNAUTHORIZED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  RATE_LIMITED: "RATE_LIMITED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  PROJECT_MISMATCH: "PROJECT_MISMATCH",
  CSRF_MISSING_ORIGIN: "CSRF_MISSING_ORIGIN",
  CSRF_ORIGIN_MISMATCH: "CSRF_ORIGIN_MISMATCH",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  DO_UNREACHABLE: "do-unreachable",
  // Auth endpoint specific
  REPO_NOT_ALLOWED: "REPO_NOT_ALLOWED",
  GITHUB_AUTH_FAILED: "GITHUB_AUTH_FAILED",
  HMAC_NOT_CONFIGURED: "HMAC_NOT_CONFIGURED",
  // Token endpoint specific
  TOKEN_NAME_CONFLICT: "TOKEN_NAME_CONFLICT",
  TOKEN_AUTHZ_DENIED: "TOKEN_AUTHZ_DENIED",
  TOKEN_NOT_FOUND: "TOKEN_NOT_FOUND",
  // Validation (worker layer uses SCREAMING_SNAKE for this code)
  VALIDATION_ERROR: "VALIDATION_ERROR",
  // DO errors (project-do-router — kebab-case wire values)
  STALE_FENCE: "stale-fence",
  NOT_FOUND: "not-found",
  GATE_ALREADY_SETTLED: "gate-already-settled",
  NO_FENCE: "no-fence",
  GATE_FENCE_CONFLICT: "gate-fence-conflict",
  INTERNAL: "internal",
  CONSTRAINT_VIOLATION: "constraint-violation",
  IDEMPOTENCY_KEY_CONFLICT: "idempotency-key-conflict",
  // DO-layer validation uses kebab-case (distinct from VALIDATION_ERROR above)
  VALIDATION_ERROR_DO: "validation-error",
  ALREADY_HELD: "already-held",
  RENEW_FAILED: "renew-failed",
  RELEASE_OWNERSHIP_DENIED: "release-ownership-denied",
  BAD_REQUEST: "bad-request",
  MISSING_QUERY: "missing-query",
  INVALID_QUERY: "invalid-query",
  INVALID_SLOT: "invalid-slot",
  INVALID_RELATIONSHIP_TYPE: "invalid-relationship-type",
  // Repo allowlist route (POST/DELETE /api/repos) — kebab-case wire values.
  // token-authz-denied is emitted by the require-project-admin middleware guarding
  // these management routes; the other four come from routes/repos.ts. Distinct key
  // from the existing (unused) SCREAMING TOKEN_AUTHZ_DENIED above.
  REPO_TOKEN_AUTHZ_DENIED: "token-authz-denied",
  REPO_ACCESS_DENIED: "repo-access-denied",
  REPO_NOT_FOUND: "repo-not-found",
  GITHUB_API_TIMEOUT: "github-api-timeout",
  GITHUB_API_ERROR: "github-api-error",
  // SDK-generated for non-HTTP artifact failures (no wire code from server)
  ARTIFACT_GET_FAILED: "artifact-get-failed",
  ARTIFACT_GET_LATEST_FAILED: "artifact-get-latest-failed",
  // Fallback (SDK-generated when response is unparseable)
  UNKNOWN: "UNKNOWN",
} as const;

export type TilaErrorCode = (typeof TILA_ERRORS)[keyof typeof TILA_ERRORS];

/** Set of all known wire-format error code strings for fast membership lookup. */
const KNOWN_CODES = new Set<string>(Object.values(TILA_ERRORS));

/**
 * Normalize a raw wire error-code string to a typed `TilaErrorCode`.
 *
 * If the string is not a known member of `TILA_ERRORS`, it is mapped to
 * `"UNKNOWN"` — the designated fallback for unmapped or future codes. This
 * guarantees `TilaApiError.code` is always a valid union member, enabling
 * exhaustive switch/match patterns in consumers.
 */
export function toTilaErrorCode(raw: string): TilaErrorCode {
  if (KNOWN_CODES.has(raw)) {
    return raw as TilaErrorCode;
  }
  return TILA_ERRORS.UNKNOWN;
}

/**
 * Utility for documenting exhaustiveness in switch statements.
 * Call this in the `default` branch when you want TS to verify all
 * `TilaErrorCode` variants are handled.
 *
 * @example
 * switch (err.code) {
 *   case TILA_ERRORS.NOT_FOUND: ...; break;
 *   // ... all other cases ...
 *   default: assertUnreachable(err.code);
 * }
 */
export function assertUnreachable(x: never): never {
  throw new Error(`Unhandled TilaErrorCode: ${String(x)}`);
}
