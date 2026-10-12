import type { WorkCatalogEntry, WorkLifecycle } from "@tila/schemas";
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
