import type { QueueListQuery } from "@tila/schemas";

// One translation from a list page's URL to its API query (#306). The list page
// and the Overview both call it, so a count shown on the Overview is the total
// of exactly the list its link opens; only the page size differs.

export function queueQueryFromSearch(params: URLSearchParams): QueueListQuery {
  const state = params.get("state");
  return {
    limit: 100,
    offset: Math.max(0, Number(params.get("offset")) || 0),
    // An unknown state reaches the server, which rejects it visibly.
    ...(state ? { state: state as QueueListQuery["state"] } : {}),
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
