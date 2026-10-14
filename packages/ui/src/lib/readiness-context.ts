import type { SectionState } from "@/lib/query-state";
import type { WorkCatalogResponse } from "@tila/schemas";

// What a blocked-work count assumes about each task type (#398). The server
// decides readiness with the shared rules in ops-sqlite: a type that declares
// no lifecycle is judged by the legacy rule, where only status `closed` is
// finished. This module only reads which visible types the type catalog says
// declare no lifecycle, so the dashboard can say so beside the count. It never
// decides what a status means and never removes a type from the count.

/** What the catalog could not establish about lifecycle coverage. */
export type CoverageGap =
  /** The catalog was not read, or only its last known copy is available. */
  | "catalog"
  /** The schema could not be read: no type's declaration is known. */
  | "definitions"
  /** Stored types could not be listed: the types named may not be all of them. */
  | "types";

/** What the credential's own namespace restrictions imply for the catalog. */
export interface CredentialScope {
  /** A `task_types` restriction: the credential sees only some task types. */
  taskTypes: boolean;
  /**
   * Any restriction, task types or records. The catalog hides the schema's
   * read state from every restricted caller and reports an unreadable schema
   * as undeclared types, so a legacy type may merely be one it cannot confirm.
   */
  any: boolean;
}

export interface ReadinessContext {
  /** Visible types that declare no lifecycle, sorted. Never inferred from rows. */
  legacy: string[];
  gap: CoverageGap | null;
  /**
   * Task-type restrictions narrow the catalog: prerequisites of types this
   * credential cannot see are counted but never named.
   */
  restricted: boolean;
  /** An undeclared type may be an unreadable schema this credential cannot see. */
  schemaMasked: boolean;
}

/**
 * The context for a blocked count, or null when there is nothing to explain:
 * the caller cannot read task types, the catalog is still loading, or every
 * type is declared with a lifecycle in a catalog the caller sees in full.
 *
 * A failed or stale catalog is unknown coverage, never "all declared". A
 * catalog narrowed to some task types stays a context even without legacy
 * types, because its absence of names says nothing about the types it cannot
 * see. The caller passes the work catalog, not a page of rows: a page can omit
 * a type.
 *
 * `credential` is the caller's own restrictions. The catalog scope reports
 * only task-type narrowing, so a records-only restriction is carried apart: it
 * makes an undeclared type unconfirmable without hiding any task type.
 */
export function readinessContext(
  work: SectionState<WorkCatalogResponse> | "hidden",
  credential: CredentialScope = { taskTypes: false, any: false },
): ReadinessContext | null {
  if (work === "hidden" || work.phase === "pending") return null;
  if (work.phase === "failed" || work.stale)
    return {
      legacy: [],
      gap: "catalog",
      restricted: credential.taskTypes,
      schemaMasked: credential.any,
    };

  const { types, scope, incomplete } = work.data;
  // A declared type without a lifecycle, or one the schema does not declare,
  // is judged by the legacy rule. `unknown` is a type whose schema was unread.
  const legacy = types
    .filter(
      (entry) =>
        entry.declaration === "undeclared" ||
        (entry.declaration === "declared" && !entry.definition?.lifecycle),
    )
    .map((entry) => entry.type)
    .sort();
  const gap: CoverageGap | null = incomplete?.declared_types
    ? "definitions"
    : incomplete?.in_use_types
      ? "types"
      : types.some((entry) => entry.declaration === "unknown")
        ? "definitions"
        : null;
  const restricted = credential.taskTypes || scope.restricted;
  // Only a narrowed task catalog is worth saying when nothing else is: a
  // records-only restriction hides no task type, so complete stays complete.
  return legacy.length > 0 || gap !== null || restricted
    ? {
        legacy,
        gap,
        restricted,
        schemaMasked: credential.any || restricted,
      }
    : null;
}
