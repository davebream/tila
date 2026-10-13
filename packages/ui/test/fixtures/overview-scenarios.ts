import type { AppliedSchemaResponse } from "@/lib/api";
import type {
  RecordCatalogEntry,
  RuntimeViewResponse,
  WorkCatalogEntry,
} from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { emptyQueue } from "../mocks/handlers";
import { recordEntry } from "../mocks/records";
import { declaredEntry } from "../mocks/tasks";

// Scenario fixtures for the Overview's attention rules (#306). Each describes
// the server state a scenario user meets and what the Overview must conclude.
// The pure rule tests and the rendered page tests share them.

/** A source that failed: an outage, or missing deployment configuration. */
export type SourceFailure = "outage" | "not-configured";
type Source<T> = T | SourceFailure;

export interface ScenarioSources {
  /** Queue group counts (`GET /queue`). */
  queue: Source<Parameters<typeof emptyQueue>[0]>;
  /** Total of `GET /queue?lease=expired`. */
  lease: Source<number>;
  /** Total of `GET /tasks?blocked=1`. */
  blocked: Source<number>;
  /** `GET /tasks?outcome=failure,abandoned`. */
  failed: Source<{ total: number; outcome_types: string[] }>;
  /** Total of `GET /deliveries?state=pending&wake=suppressed`. */
  suppressed: Source<number>;
  /** Total of `GET /deliveries?state=expired&expires_after=…`. */
  expired: Source<number>;
  /** `GET /runtime-view?filter=attention`. */
  runtime: Source<{
    total: number;
    complete?: boolean;
    runs?: "ok" | "unavailable";
  }>;
}

export interface OverviewScenario {
  name: string;
  schema: AppliedSchemaResponse;
  work: WorkCatalogEntry[];
  records: RecordCatalogEntry[];
  sources: ScenarioSources;
  expected: "setup" | "attention" | "idle" | "partial" | "unknown";
  /** The next action's link when `expected` is "attention". */
  next?: string;
}

const applied: AppliedSchemaResponse = {
  ok: true,
  schema: {
    version: 3,
    definition:
      '[work_units.bug]\nfields = [{ name = "title", type = "string" }]\n',
    applied_at: Date.now() - 3_600_000,
    applied_by: "owner@example.test",
  },
  version: 3,
  revision: 3,
};

const notApplied: AppliedSchemaResponse = {
  ok: true,
  schema: null,
  version: null,
  revision: 0,
};

export const QUIET: ScenarioSources = {
  queue: {},
  lease: 0,
  blocked: 0,
  failed: { total: 0, outcome_types: ["bug"] },
  suppressed: 0,
  expired: 0,
  runtime: { total: 0 },
};

const DOWN: ScenarioSources = {
  queue: "outage",
  lease: "outage",
  blocked: "outage",
  failed: "outage",
  suppressed: "outage",
  expired: "outage",
  runtime: "outage",
};

const NO_CONVERSATIONS: Partial<ScenarioSources> = {
  suppressed: "not-configured",
  expired: "not-configured",
};

export const SCENARIOS: OverviewScenario[] = [
  {
    // S1: a solo developer opens a project created without a schema file, on
    // a deployment where conversations are not configured yet.
    name: "S1 new project without definitions or data",
    schema: notApplied,
    work: [],
    records: [],
    sources: { ...QUIET, ...NO_CONVERSATIONS },
    expected: "setup",
  },
  {
    // S1 later: definitions applied, an empty declared type, nothing to do.
    name: "S1 configured project with nothing to do",
    schema: applied,
    work: [declaredEntry("bug", 0)],
    records: [recordEntry("config", 0)],
    sources: QUIET,
    expected: "idle",
  },
  {
    // S1 again, but nobody configured conversations: quiet is not all-clear.
    name: "S1 quiet project with conversations not configured",
    schema: applied,
    work: [declaredEntry("bug", 2)],
    records: [],
    sources: { ...QUIET, ...NO_CONVERSATIONS },
    expected: "partial",
  },
  {
    // S2: the Mac worker lost its session mid-run; its execution lease lapsed
    // and the outcome of an earlier attempt is unknown.
    name: "S2 worker lost its session mid-run",
    schema: applied,
    work: [declaredEntry("bug", 4)],
    records: [],
    sources: {
      ...QUIET,
      queue: { uncertain: 2, active: 1 },
      lease: 1,
      runtime: { total: 1 },
    },
    expected: "attention",
    next: "/p/test-project/queue?state=uncertain",
  },
  {
    // S3: a hotfix task failed and blocks follow-up work while the queue
    // store is unreachable.
    name: "S3 failed hotfix during a queue outage",
    schema: applied,
    work: [declaredEntry("bug", 6)],
    records: [],
    sources: {
      ...QUIET,
      queue: "outage",
      lease: "outage",
      failed: { total: 1, outcome_types: ["bug"] },
      blocked: 3,
    },
    expected: "attention",
    next: "/p/test-project/tasks?outcome=failure,abandoned",
  },
  {
    // S3: everything is unreachable.
    name: "S3 total outage",
    schema: applied,
    work: [declaredEntry("bug", 6)],
    records: [],
    sources: DOWN,
    expected: "unknown",
  },
  {
    // A project with tasks but no definitions is in use, not a new project.
    name: "Tasks written without definitions",
    schema: notApplied,
    work: [{ ...declaredEntry("task", 2), declaration: "undeclared" }],
    records: [],
    sources: {
      ...QUIET,
      queue: { suspended: 3 },
      failed: { total: 0, outcome_types: [] },
    },
    expected: "attention",
    next: "/p/test-project/queue?state=suspended",
  },
];

// --- Response bodies, shared by pure and rendered tests ---

export const failureBody = (failure: SourceFailure) => ({
  ok: false,
  error: {
    code: failure === "outage" ? "do-unreachable" : "config-unavailable",
    message: failure === "outage" ? "Store unavailable" : "Not configured",
  },
});

export const taskPage = (total: number, outcome_types?: string[]) => ({
  ok: true as const,
  entities: [],
  total,
  limit: 1,
  offset: 0,
  has_more: total > 1,
  next_cursor: null,
  scope: {
    restricted: false,
    archived: "excluded" as const,
    ...(outcome_types ? { outcome_types } : {}),
  },
});

export const deliveryPage = (total: number) => ({
  ok: true as const,
  deliveries: [],
  has_more: total > 1,
  cursor: null,
  total,
});

export const runtimeView = (
  data: Exclude<ScenarioSources["runtime"], SourceFailure>,
): RuntimeViewResponse => ({
  ok: true,
  server_now: Date.now(),
  sources: {
    agents: "ok",
    runs: data.runs ?? "ok",
    enrollments: "ok",
    presence: "ok",
  },
  rows: [],
  next_cursor: null,
  total: data.total,
  scan: { agents: 10, complete: data.complete ?? true },
});

export type SourceBody = { failure: SourceFailure } | { data: unknown };

/**
 * Each source's HTTP response body, keyed by the Overview's source id. The
 * queue body is the `{ result }` envelope the API returns.
 */
export function sourceBodies(
  sources: ScenarioSources,
): Record<string, SourceBody> {
  const isFailure = (value: unknown): value is SourceFailure =>
    value === "outage" || value === "not-configured";
  const body = <T>(
    value: Source<T>,
    make: (value: T) => unknown,
  ): SourceBody =>
    isFailure(value) ? { failure: value } : { data: make(value as T) };
  return {
    queue: body(sources.queue, (counts) => ({ result: emptyQueue(counts) })),
    "queue-lease": body(sources.lease, (total) => ({
      result: { ...emptyQueue(), total },
    })),
    "tasks-blocked": body(sources.blocked, (total) => taskPage(total)),
    "tasks-failed": body(sources.failed, (failed) =>
      taskPage(failed.total, failed.outcome_types),
    ),
    "deliveries-suppressed": body(sources.suppressed, deliveryPage),
    "deliveries-expired": body(sources.expired, deliveryPage),
    runtime: body(sources.runtime, runtimeView),
  };
}

const respond = (entry: SourceBody): Response =>
  "failure" in entry
    ? HttpResponse.json(failureBody(entry.failure), { status: 503 })
    : HttpResponse.json(entry.data as Record<string, unknown>);

/** MSW handlers serving every Overview source for a scenario. */
export function sourceHandlers(
  sources: ScenarioSources,
  onRequest?: (path: string, params: URLSearchParams) => void,
) {
  const bodies = sourceBodies(sources);
  const seen = (request: Request) => {
    const url = new URL(request.url);
    onRequest?.(url.pathname, url.searchParams);
    return url.searchParams;
  };
  return [
    http.get("*/projects/*/queue", ({ request }) =>
      respond(
        seen(request).get("lease") ? bodies["queue-lease"] : bodies.queue,
      ),
    ),
    http.get("*/projects/*/tasks", ({ request }) =>
      respond(
        seen(request).get("blocked")
          ? bodies["tasks-blocked"]
          : bodies["tasks-failed"],
      ),
    ),
    http.get("*/projects/*/deliveries", ({ request }) =>
      respond(
        seen(request).get("wake")
          ? bodies["deliveries-suppressed"]
          : bodies["deliveries-expired"],
      ),
    ),
    http.get("*/projects/*/runtime-view", ({ request }) => {
      seen(request);
      return respond(bodies.runtime);
    }),
  ];
}
