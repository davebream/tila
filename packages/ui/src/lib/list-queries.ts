import {
  type DeliveryListQuery,
  LIFECYCLE_OUTCOMES,
  type LifecycleOutcome,
  type QuestionListQuery,
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
    // Rows and counts read only the title/name and lifecycle state of a task;
    // opening a row loads the full task. Other queue readers (task detail)
    // build their own query and keep the full view.
    compact: true,
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
  /**
   * Only tasks in one of these states: the value of each type's lifecycle
   * field, or `status` for a type with no lifecycle. This is the value the
   * State column shows.
   */
  state: string[];
}

const isOutcome = (value: string): value is LifecycleOutcome =>
  (LIFECYCLE_OUTCOMES as readonly string[]).includes(value);

export function taskFiltersFromSearch(params: URLSearchParams): TaskFilters {
  return {
    type: list(params.get("type")),
    archived: params.get("archived") === "1",
    blocked: params.get("blocked") === "1",
    outcome: list(params.get("outcome")).filter(isOutcome),
    state: list(params.get("state")),
  };
}

/** Task filters where the attention filters may be left out. */
export type TaskFilterInput = Pick<TaskFilters, "type" | "archived"> &
  Partial<Pick<TaskFilters, "blocked" | "outcome" | "state">>;

/** The task list API's filter parameters; sort and paging are separate. */
export function taskListParams(filters: TaskFilterInput) {
  return {
    type: filters.type.length > 0 ? filters.type : undefined,
    archived: filters.archived ? undefined : "0",
    blocked: filters.blocked ? ("1" as const) : undefined,
    outcome: filters.outcome?.length ? filters.outcome : undefined,
    state: filters.state?.length ? filters.state : undefined,
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

export const DECISION_VIEWS = [
  "mine",
  "open",
  "answered",
  "cancelled",
  "superseded",
] as const;
export type DecisionView = (typeof DECISION_VIEWS)[number];

/** The decisions inbox view; "Waiting on me" is the default. */
export function decisionViewFromSearch(params: URLSearchParams): DecisionView {
  const view = params.get("view");
  return DECISION_VIEWS.find((value) => value === view) ?? "mine";
}

export type DecisionListQuery = Pick<
  QuestionListQuery,
  "state" | "responder_principal_id" | "escalated"
>;

/**
 * "Waiting on me" is the open questions routed to the signed-in principal;
 * an escalation routes a question to one named owner, so it is included. Null
 * when the caller has no principal: nothing can be waiting on it.
 */
export function questionQueryFromSearch(
  params: URLSearchParams,
  me: string | undefined,
): DecisionListQuery | null {
  const view = decisionViewFromSearch(params);
  if (view === "mine" && !me) return null;
  return {
    ...(view === "mine"
      ? { state: "open", responder_principal_id: me }
      : { state: view }),
    ...(params.get("escalated") === "1" ? { escalated: true } : {}),
  };
}
