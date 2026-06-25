/**
 * Typed error code constants for all tila API error responses.
 *
 * Keys are normalized identifiers. Values are the exact kebab-case wire-format
 * strings returned by the worker and DO layers.
 */
export const TILA_ERRORS = {
  // Auth / middleware (worker layer)
  UNAUTHORIZED: "unauthorized",
  SESSION_EXPIRED: "session-expired",
  SESSION_REVOKED: "session-revoked",
  SUBJECT_REVOKED: "subject-revoked",
  RATE_LIMITED: "rate-limited",
  PERMISSION_DENIED: "permission-denied",
  PERMISSION_REVOKED: "permission-revoked",
  PROJECT_MISMATCH: "project-mismatch",
  CSRF_MISSING_ORIGIN: "csrf-missing-origin",
  CSRF_ORIGIN_MISMATCH: "csrf-origin-mismatch",
  DO_UNREACHABLE: "do-unreachable",
  // Auth endpoint specific
  REPO_NOT_ALLOWED: "repo-not-allowed",
  GITHUB_AUTH_FAILED: "github-auth-failed",
  HMAC_NOT_CONFIGURED: "hmac-not-configured",
  // Token endpoint specific
  TOKEN_NAME_CONFLICT: "token-name-conflict",
  TOKEN_NOT_FOUND: "token-not-found",
  // Validation (worker + DO layers)
  VALIDATION_ERROR: "validation-error",
  // DO errors (project-do-router — kebab-case wire values)
  STALE_FENCE: "stale-fence",
  NOT_FOUND: "not-found",
  GATE_ALREADY_SETTLED: "gate-already-settled",
  NO_FENCE: "no-fence",
  GATE_FENCE_CONFLICT: "gate-fence-conflict",
  INTERNAL: "internal",
  CONSTRAINT_VIOLATION: "constraint-violation",
  IDEMPOTENCY_KEY_CONFLICT: "idempotency-key-conflict",
  ALREADY_HELD: "already-held",
  RENEW_FAILED: "renew-failed",
  RELEASE_OWNERSHIP_DENIED: "release-ownership-denied",
  BAD_REQUEST: "bad-request",
  MISSING_QUERY: "missing-query",
  INVALID_QUERY: "invalid-query",
  INVALID_SLOT: "invalid-slot",
  INVALID_RELATIONSHIP_TYPE: "invalid-relationship-type",
  // Instance binding (worker auth middleware — kebab-case wire value)
  INSTANCE_MISMATCH: "instance-mismatch",
  // Repo allowlist route (POST/DELETE /api/repos) — kebab-case wire values.
  // token-authz-denied is emitted by the require-project-admin middleware guarding
  // these management routes (the same value is also emitted on /api/tokens routes, so
  // the REPO_ prefix is a readability alias — consumers branch on the value); the other
  // four come from routes/repos.ts.
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
