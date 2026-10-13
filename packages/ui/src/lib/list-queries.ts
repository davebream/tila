import {
  type DeliveryListQuery,
  LIFECYCLE_OUTCOMES,
  type LifecycleOutcome,
  type QueueListQuery,
} from "@tila/schemas";

// One translation from a list page's URL to its API query (#306). The list page
// and the Overview both call it, so a count shown on the Overview is the total
// of exactly the list its link opens; only the page size differs.

function list(raw: string | null): string[] {
  return raw?.split(",").filter(Boolean) ?? [];
}

export function queueQueryFromSearch(params: URLSearchParams): QueueListQuery {
  const state = params.get("state");
  const lease = params.get("lease");
  return {
    limit: 100,
    offset: Math.max(0, Number(params.get("offset")) || 0),
    // An unknown state reaches the server, which rejects it visibly.
    ...(state ? { state: state as QueueListQuery["state"] } : {}),
    ...(lease ? { lease: lease as QueueListQuery["lease"] } : {}),
    ...Object.fromEntries(
      ["task_id", "type", "target_principal", "capability"]
        .filter((key) => params.get(key))
        .map((key) => [key, params.get(key)]),
    ),
    ...(params.has("priority") && params.get("priority") !== ""
      ? { priority: Number(params.get("priority")) }
      : {}),
  };
}

export interface TaskFilters {
  type: string[];
  /** Include archived tasks. The default list excludes them. */
  archived: boolean;
  /** Only open tasks held back by their prerequisites. */
  blocked: boolean;
  /** Only tasks in the state their type's lifecycle names for an outcome. */
  outcome: LifecycleOutcome[];
}

const isOutcome = (value: string): value is LifecycleOutcome =>
  (LIFECYCLE_OUTCOMES as readonly string[]).includes(value);

export function taskFiltersFromSearch(params: URLSearchParams): TaskFilters {
  return {
    type: list(params.get("type")),
    archived: params.get("archived") === "1",
    blocked: params.get("blocked") === "1",
    outcome: list(params.get("outcome")).filter(isOutcome),
  };
}

/** Task filters where the attention filters may be left out. */
export type TaskFilterInput = Pick<TaskFilters, "type" | "archived"> &
  Partial<Pick<TaskFilters, "blocked" | "outcome">>;

/** The task list API's filter parameters; sort and paging are separate. */
export function taskListParams(filters: TaskFilterInput) {
  return {
    type: filters.type.length > 0 ? filters.type : undefined,
    archived: filters.archived ? undefined : "0",
    blocked: filters.blocked ? ("1" as const) : undefined,
    outcome: filters.outcome?.length ? filters.outcome : undefined,
  };
}

const DELIVERY_STATES = ["pending", "acked", "expired"] as const;

export function deliveryFiltersFromSearch(
  params: URLSearchParams,
): DeliveryListQuery {
  const state = params.get("state");
  const expiresAfter = Number(params.get("expires_after"));
  return {
    agent: params.get("agent") || undefined,
    room: params.get("room") || undefined,
    id: params.get("id") || undefined,
    state: DELIVERY_STATES.find((value) => value === state),
    wake: params.get("wake") === "suppressed" ? "suppressed" : undefined,
    expires_after:
      params.get("expires_after") && Number.isSafeInteger(expiresAfter)
        ? Math.max(0, expiresAfter)
        : undefined,
  };
}

export interface RuntimeListQuery {
  cursor?: string;
  /** Only agents whose current occupant needs a person. */
  filter?: "attention";
}

export function runtimeQueryFromSearch(
  params: URLSearchParams,
): RuntimeListQuery {
  return {
    cursor: params.get("cursor") ?? undefined,
    filter: params.get("filter") === "attention" ? "attention" : undefined,
  };
}
