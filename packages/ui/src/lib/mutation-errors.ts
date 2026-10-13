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
  "already-held",
  // Settings writes (#298): a stale revision, an agent archived meanwhile, or
  // an archive whose reviewed binding occupant changed.
  "revision-conflict",
  "agent-archived",
  "stale-binding",
  // The key was used with a different body: the subject changed between
  // sends, so the outcome must be re-read rather than reported as invalid.
  "idempotency-key-conflict",
  "queue-idempotency-conflict",
  "question-idempotency-conflict",
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
  if (CONFLICT_CODES.has(error.code)) return "conflict";
  if (error.status === 409 || error.status === 412) return "conflict";
  return "invalid";
}

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

/**
 * A `revision-conflict` answer: the write named a revision that is no longer
 * current. `revision` is the current one, or null when the resource no longer
 * exists. Null for any other failure.
 */
export function revisionConflict(
  error: unknown,
): { revision: number | null } | null {
  if (!(error instanceof ApiError) || error.code !== "revision-conflict")
    return null;
  const revision = error.body?.revision;
  return { revision: typeof revision === "number" ? revision : null };
}

/** A definition problem the server or the client parser reported. */
export type DefinitionProblem = {
  message: string;
  path?: string;
  line?: number;
  column?: number;
};

/**
 * How a failed definition preview or apply should be handled:
 * - `parse`: the definition is invalid; show each problem and keep the draft.
 * - `conflict`: another revision was applied; rebase the draft onto it.
 * - `review`: the reviewed preview no longer matches what was sent, or a
 *   destructive change needs one; preview again before applying.
 * - otherwise the generic kinds from `failureKind`.
 */
export type SchemaFailure =
  | { kind: "parse"; problems: DefinitionProblem[] }
  | { kind: "conflict"; revision: number | null }
  | { kind: "review" }
  | { kind: Exclude<FailureKind, "conflict"> };

export function schemaFailure(error: unknown): SchemaFailure {
  if (error instanceof ApiError) {
    const body = error.body ?? {};
    if (error.code === "schema-parse-error") {
      const problems = Array.isArray(body.errors)
        ? (body.errors as DefinitionProblem[]).filter(
            (p) => typeof p?.message === "string",
          )
        : [];
      return {
        kind: "parse",
        problems: problems.length ? problems : [{ message: error.message }],
      };
    }
    if (error.code === "schema-revision-conflict") {
      return {
        kind: "conflict",
        revision: typeof body.revision === "number" ? body.revision : null,
      };
    }
    if (
      error.code === "schema-review-mismatch" ||
      error.code === "schema-review-required" ||
      error.code === "schema-revision-required" ||
      error.code === "schema-destructive"
    ) {
      return { kind: "review" };
    }
  }
  const kind = failureKind(error);
  return kind === "conflict" ? { kind: "conflict", revision: null } : { kind };
}
