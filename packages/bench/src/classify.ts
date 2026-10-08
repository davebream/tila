import type { OutcomeClass } from "./types";

export interface Classified {
  cls: OutcomeClass;
  status?: number;
  code?: string;
  message: string;
}

/** 409 codes that mean "someone else holds it" rather than a failure. */
const CONFLICT_CODES = new Set(["already-held", "conflict", "already-exists"]);

/** Codes that mean "your fence or lease is no longer current". */
const STALE_CODES = new Set([
  "stale-fence",
  "renew-failed",
  "release-ownership-denied",
  "expired-claim",
]);

/** `@tila/core` error class names surfaced raw by the embedded tier. */
const STALE_ERROR_NAMES = new Set([
  "FenceError",
  "ExpiredClaimError",
  "ClaimOwnershipError",
  "StaleFenceError",
]);

/**
 * Map a thrown error to an outcome class using HTTP status, the server error
 * code, and (for the embedded tier) the core error class name. The SDK folds
 * unknown codes into "UNKNOWN", so the raw message is consulted too.
 */
export function classifyError(err: unknown): Classified {
  if (err && typeof err === "object") {
    const e = err as {
      name?: string;
      status?: number;
      code?: string;
      message?: string;
    };
    const message = e.message ?? String(err);
    const status = typeof e.status === "number" ? e.status : undefined;
    const code = typeof e.code === "string" ? e.code : undefined;
    const lowered = `${code ?? ""} ${message}`.toLowerCase();

    if (e.name && STALE_ERROR_NAMES.has(e.name))
      return { cls: "stale_fence", status, code: code ?? e.name, message };

    if (status === 409 || status === 403 || status === 400) {
      if (code && STALE_CODES.has(code))
        return { cls: "stale_fence", status, code, message };
      if (code && CONFLICT_CODES.has(code))
        return { cls: "conflict", status, code, message };
      // The SDK maps codes it does not know to "UNKNOWN"; fall back to text.
      if (/stale[- ]fence|renew[- ]failed|ownership/.test(lowered))
        return { cls: "stale_fence", status, code, message };
      if (status === 409 && /already (held|exists)|conflict/.test(lowered))
        return { cls: "conflict", status, code, message };
    }
    return { cls: "error", status, code, message };
  }
  return { cls: "error", message: String(err) };
}
