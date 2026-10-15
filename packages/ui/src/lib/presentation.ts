import type {
  CatalogIncomplete,
  TypeDeclaration,
  WorkCatalogEntry,
  WorkLifecycle,
} from "@tila/schemas";
import { presentedTitle } from "@tila/schemas";

export type StateVariant = "green" | "red" | "amber" | "default" | "gray";

/**
 * Badge colour for a lifecycle value, from the type's declared lifecycle only.
 * Never guesses from the value's name: an undeclared value is neutral gray.
 *
 * green: satisfies dependents; red: the declared failure outcome; amber: the
 * value a start moves to; blue (`default`): ready to dispatch.
 */
export function lifecycleVariant(
  value: string,
  lifecycle: WorkLifecycle,
): StateVariant {
  if (lifecycle.dependency_satisfied.includes(value)) return "green";
  if (lifecycle.outcomes?.failure === value) return "red";
  if (lifecycle.on_start === value) return "amber";
  if (lifecycle.dispatchable.includes(value)) return "default";
  return "gray";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export type TaskState = { value: string; variant: StateVariant };

/**
 * The task's state as its type declares it. With a declared lifecycle this is
 * the lifecycle field's value; without one, a plain `status` string is shown
 * neutral. Returns null when there is nothing to show.
 */
export function taskState(
  data: Record<string, unknown> | null | undefined,
  entry: WorkCatalogEntry | undefined,
): TaskState | null {
  const lifecycle = entry?.definition?.lifecycle;
  if (lifecycle) {
    const value = nonEmptyString(data?.[lifecycle.field]);
    return value
      ? { value, variant: lifecycleVariant(value, lifecycle) }
      : null;
  }
  const status = nonEmptyString(data?.status);
  return status ? { value: status, variant: "gray" } : null;
}

/**
 * The states a declared type names, for offering as filter options: its
 * lifecycle's states and the values its state field allows, or the allowed
 * `status` values when it declares no lifecycle. An undeclared type names none.
 */
export function declaredStates(entry: WorkCatalogEntry | undefined): string[] {
  const definition = entry?.definition;
  if (!definition) return [];
  const lifecycle = definition.lifecycle;
  const field = lifecycle?.field ?? "status";
  const allowed = definition.fields.find((f) => f.name === field)?.values ?? [];
  const named = lifecycle
    ? [
        ...lifecycle.dispatchable,
        ...lifecycle.terminal,
        ...lifecycle.dependency_satisfied,
        ...(lifecycle.on_start ? [lifecycle.on_start] : []),
        ...Object.values(lifecycle.outcomes ?? {}),
      ]
    : [];
  return [...new Set([...allowed, ...named])].filter(
    (state) => state.trim().length > 0,
  );
}

/** Title per the type's presentation metadata, or the documented fallback. */
export function taskTitle(
  data: Record<string, unknown> | null | undefined,
  entry: WorkCatalogEntry | undefined,
): string | null {
  return presentedTitle(data, entry?.definition?.presentation);
}

export function catalogIndex(
  types: WorkCatalogEntry[] | undefined,
): Map<string, WorkCatalogEntry> {
  return new Map((types ?? []).map((entry) => [entry.type, entry]));
}

/**
 * What the current schema says about one task or record type.
 * `unavailable`: the catalog failed, or it could not read definitions.
 * `undeclared`: the schema does not declare the type; stored data stays readable.
 */
export type TypeDefinitions<E> =
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "undeclared" }
  | { status: "declared"; entry: E };

export function resolveDefinitions<
  E extends { type: string; declaration: TypeDeclaration },
>(
  catalog: { entries?: E[]; incomplete?: CatalogIncomplete } | undefined,
  catalogFailed: boolean,
  type: string,
): TypeDefinitions<E> {
  if (!catalog) return { status: catalogFailed ? "unavailable" : "pending" };
  if (!catalog.entries) return { status: "unavailable" };
  const entry = catalog.entries.find((e) => e.type === type);
  if (!entry) {
    // A type missing from a complete catalog is not declared by the schema.
    return catalog.incomplete?.declared_types
      ? { status: "unavailable" }
      : { status: "undeclared" };
  }
  if (entry.declaration === "declared") return { status: "declared", entry };
  if (entry.declaration === "undeclared") return { status: "undeclared" };
  return { status: "unavailable" };
}
