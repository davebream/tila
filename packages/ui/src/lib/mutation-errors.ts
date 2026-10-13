import { ApiError } from "@/lib/api";

/**
 * How a failed write should be handled by a form:
 * - `unconfirmed`: no answer, or a server fault. The write may have applied;
 *   retry the same frozen command so the server's receipt decides.
 * - `conflict`: the subject changed (stale fence/revision, superseded state).
 *   Keep the input, reload, and let the user resubmit deliberately.
 * - `exists`: the identifier is already taken.
 * - `forbidden`: access changed or was never there; refresh identity.
 * - `invalid`: the server rejected this input; fix it and resubmit.
 */
export type FailureKind =
  | "unconfirmed"
  | "conflict"
  | "exists"
  | "forbidden"
  | "invalid";

const CONFLICT_CODES = new Set([
  "stale-fence",
  "fence-mismatch",
  "conflict",
  "invalid-state",
  "queue-precondition",
  "queue-conflict",
  "queue-invalid-state",
  "queue-authority-lost",
  "question-precondition",
  "question-invalid-state",
  "question-correlation-conflict",
  "claim-held",
  "claim-not-held",
]);

export function failureKind(error: unknown): FailureKind {
  if (!(error instanceof ApiError)) return "unconfirmed";
  if (error.status === undefined || error.code === "network-error")
    return "unconfirmed";
  if (error.status >= 500 || error.status === 429) return "unconfirmed";
  if (error.code === "already-exists") return "exists";
  if (error.status === 401 || error.status === 403) {
    // A lost execution grant is a state change, not missing access.
    return error.code === "queue-authority-lost" ? "conflict" : "forbidden";
  }
  if (error.status === 409 || error.status === 412) return "conflict";
  if (CONFLICT_CODES.has(error.code)) return "conflict";
  return "invalid";
}

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}
