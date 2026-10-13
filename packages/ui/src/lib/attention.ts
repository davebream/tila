import {
  ApiError,
  type AppliedSchemaResponse,
  type RuntimeView,
  getRuntimeView,
  inspectQueue,
  listDeliveries,
  listQuestions,
  listTasks,
  whoami,
} from "@/lib/api";
import {
  deliveryFiltersFromSearch,
  questionQueryFromSearch,
  queueQueryFromSearch,
  runtimeQueryFromSearch,
  taskFiltersFromSearch,
  taskListParams,
} from "@/lib/list-queries";
import type { AccessTarget } from "@/lib/navigation";
import type { ErrorKind, SectionState, StaleInfo } from "@/lib/query-state";
import type {
  DeliveryListResponse,
  PaginatedEntityListResponse,
  QuestionListResult,
  QueueInspection,
  RecordTypesResponse,
  WorkCatalogResponse,
} from "@tila/schemas";

// Attention rules for the project Overview (#306). Each rule turns one observed
// server fact (an exact, permission-scoped count) into an inferred reason for a
// person to act. The fact and the inference are kept apart so the page can show
// both, and every count links to the list it was counted from.

export type Severity = "red" | "amber";

/** One server read, shared by every rule that observes it. */
export interface AttentionSource<T = unknown> extends AccessTarget {
  id: string;
  /** What failed to load, for "Could not load …". */
  label: string;
  fetch(projectId: string): Promise<T>;
}

export interface Observation {
  /** Matching items visible to the caller. */
  total: number;
  /** False when the server only scanned part of the data: `total` is a floor. */
  complete: boolean;
  /** What the count covers, e.g. "excluding archived". */
  scope?: string;
  /** The rule cannot apply to this project yet; never shown as zero. */
  notApplicable?: string;
}

/** A list page and the query string that applies a rule's filter. */
export interface ListLink {
  segment: string;
  search: string;
}

export interface AttentionRule<T = unknown> {
  id: string;
  source: AttentionSource<T>;
  /** The observed fact's noun, singular and plural. */
  noun: readonly [string, string];
  /** The inference: why a non-zero count needs a person. */
  rule: string;
  severity: Severity;
  /** The list the count was taken from, with the same filter. */
  link(data: T): ListLink;
  observe(data: T): Observation;
}

/** A source counting one list: the list query built from the link's URL. */
function listSource<T>(
  source: Omit<AttentionSource<T>, "fetch">,
  fetch: (projectId: string) => Promise<T>,
): AttentionSource<T> {
  return { ...source, fetch };
}

const params = (search: string) => new URLSearchParams(search);

const queueSource = listSource<QueueInspection>(
  {
    id: "queue",
    label: "the execution queue",
    requires: ["tasks:read"],
    surface: "queue",
  },
  // `counts` group entries with the same predicate as the `state` filter and
  // cover the same caller-visible entries, so each equals that list's total.
  (projectId) =>
    inspectQueue(projectId, { ...queueQueryFromSearch(params("")), limit: 1 }),
);

const LEASE_LAPSED = "?lease=expired";
const leaseSource = listSource<QueueInspection>(
  {
    id: "queue-lease",
    label: "the execution queue",
    requires: ["tasks:read"],
    surface: "queue",
  },
  (projectId) =>
    inspectQueue(projectId, {
      ...queueQueryFromSearch(params(LEASE_LAPSED)),
      limit: 1,
    }),
);

const taskSource = (id: string, search: string) =>
  listSource<PaginatedEntityListResponse>(
    { id, label: "tasks", requires: ["tasks:read"], surface: "tasks" },
    (projectId) =>
      listTasks(projectId, {
        ...taskListParams(taskFiltersFromSearch(params(search))),
        limit: 1,
      }) as Promise<PaginatedEntityListResponse>,
  );

const BLOCKED = "?blocked=1";
const FAILED = "?outcome=failure,abandoned";

const deliverySource = <T>(
  id: string,
  fetch: (projectId: string) => Promise<T>,
) =>
  listSource<T>(
    {
      id,
      label: "deliveries",
      requires: ["conversations:manage"],
      surface: "deliveries",
    },
    fetch,
  );

const SUPPRESSED = "?state=pending&wake=suppressed";
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Rounded to the minute, so refetches within a minute share one link. */
const expiredSince = (since: number) => `?state=expired&expires_after=${since}`;

interface RecentExpiries {
  page: DeliveryListResponse;
  /** The cutoff the count used; the link opens the list with it. */
  since: number;
}

const RUNTIME = "?filter=attention";
/** The decisions inbox's default view, "Waiting on me". */
const WAITING_ON_ME = "";

function deliveryTotal(page: DeliveryListResponse): Observation {
  return page.total === undefined
    ? {
        total: 0,
        complete: false,
        notApplicable: "This server does not report delivery totals.",
      }
    : { total: page.total, complete: true };
}

function questionTotal(page: QuestionListResult | null): Observation {
  if (page === null)
    return {
      total: 0,
      complete: true,
      notApplicable: "This credential has no principal to wait on.",
    };
  return page.total === undefined
    ? {
        total: 0,
        complete: false,
        notApplicable: "This server does not report question totals.",
      }
    : { total: page.total, complete: true };
}

function runtimeObservation(view: RuntimeView): Observation {
  if (view.total === undefined || !view.scan)
    return {
      total: 0,
      complete: false,
      notApplicable: "This server does not report runtime totals.",
    };
  const gaps = [
    view.scan.complete ? null : `first ${view.scan.agents} agents only`,
    view.sources.runs === "ok" && view.sources.enrollments === "ok"
      ? null
      : "run records unavailable",
    view.sources.presence === "unavailable" ? "presence unavailable" : null,
  ].filter((gap): gap is string => gap !== null);
  return {
    total: view.total,
    complete: gaps.length === 0,
    scope: gaps.length > 0 ? gaps.join(" · ") : undefined,
  };
}

/** Type-check a rule against its source's data, then store it untyped. */
const defineRule = <T>(rule: AttentionRule<T>) => rule as AttentionRule;
const fixed = (segment: string, search: string) => () => ({ segment, search });

export const ATTENTION_RULES: readonly AttentionRule[] = [
  defineRule({
    id: "execution.uncertain",
    source: queueSource,
    noun: [
      "execution with an uncertain outcome",
      "executions with an uncertain outcome",
    ],
    rule: "Nobody knows whether these ran. Reconcile each one before it is retried.",
    severity: "red",
    link: fixed("queue", "?state=uncertain"),
    observe: (data) => ({ total: data.counts.uncertain, complete: true }),
  }),
  defineRule({
    id: "execution.lease-lapsed",
    source: leaseSource,
    noun: [
      "execution running past its lease",
      "executions running past their lease",
    ],
    rule: "Their worker stopped renewing. Check it before anyone retries; these turn uncertain next.",
    severity: "red",
    link: fixed("queue", LEASE_LAPSED),
    observe: (data) => ({ total: data.total, complete: true }),
  }),
  defineRule({
    id: "decisions.waiting",
    source: listSource<QuestionListResult | null>(
      {
        id: "questions-mine",
        label: "decisions",
        requires: ["tasks:read"],
        surface: "questions",
      },
      async (projectId) => {
        const query = questionQueryFromSearch(
          params(WAITING_ON_ME),
          (await whoami()).principal_id,
        );
        return query && listQuestions(projectId, { ...query, limit: 1 });
      },
    ),
    noun: ["question waiting on you", "questions waiting on you"],
    // An unanswered question stops the worker that asked it.
    rule: "A worker stopped to ask and is waiting. Answer it, escalate it to an owner, or cancel it.",
    severity: "red",
    link: fixed("decisions", WAITING_ON_ME),
    observe: questionTotal,
  }),
  defineRule({
    id: "work.failed",
    source: taskSource("tasks-failed", FAILED),
    noun: [
      "task that failed or was abandoned",
      "tasks that failed or were abandoned",
    ],
    // A failure state is terminal, so only archiving clears the count; the
    // rule says so, and stays amber rather than an urgent standing alarm.
    rule: "These ended without success. Follow up on each one, then archive it to clear it from this check.",
    severity: "amber",
    link: fixed("tasks", FAILED),
    observe: (data) =>
      data.scope?.outcome_types?.length === 0
        ? {
            total: 0,
            complete: true,
            notApplicable:
              "No task type declares a failure or abandoned outcome.",
          }
        : {
            total: data.total,
            complete: true,
            scope: data.scope?.outcome_types?.length
              ? `types: ${data.scope.outcome_types.join(", ")}`
              : undefined,
          },
  }),
  defineRule({
    id: "work.blocked",
    source: taskSource("tasks-blocked", BLOCKED),
    noun: [
      "open task waiting on prerequisites",
      "open tasks waiting on prerequisites",
    ],
    rule: "Their prerequisites are unfinished, missing or circular. Unblock or re-plan them.",
    severity: "amber",
    link: fixed("tasks", BLOCKED),
    observe: (data) => ({
      total: data.total,
      complete: true,
      scope: "excluding archived",
    }),
  }),
  defineRule({
    id: "execution.suspended",
    source: queueSource,
    noun: ["suspended execution", "suspended executions"],
    rule: "Paused work stays parked until someone resumes or cancels it.",
    severity: "amber",
    link: fixed("queue", "?state=suspended"),
    observe: (data) => ({ total: data.counts.suspended, complete: true }),
  }),
  defineRule({
    id: "delivery.wake-suppressed",
    source: deliverySource("deliveries-suppressed", (projectId) =>
      listDeliveries(projectId, {
        ...deliveryFiltersFromSearch(params(SUPPRESSED)),
        limit: 1,
      }),
    ),
    noun: [
      "pending delivery no longer being woken",
      "pending deliveries no longer being woken",
    ],
    rule: "Wakes stopped after a stall or a budget limit. Resume them or check the recipient.",
    severity: "amber",
    link: fixed("deliveries", SUPPRESSED),
    observe: deliveryTotal,
  }),
  defineRule({
    id: "delivery.expired-recent",
    source: deliverySource<RecentExpiries>(
      "deliveries-expired",
      async (projectId) => {
        const since = Math.floor((Date.now() - DAY_MS) / MINUTE_MS) * MINUTE_MS;
        const page = await listDeliveries(projectId, {
          ...deliveryFiltersFromSearch(params(expiredSince(since))),
          limit: 1,
        });
        return { page, since };
      },
    ),
    noun: [
      "delivery expired unacknowledged in the last day",
      "deliveries expired unacknowledged in the last day",
    ],
    rule: "Their recipients never acknowledged them. The messages may need resending.",
    severity: "amber",
    link: (data) => ({
      segment: "deliveries",
      search: expiredSince(data.since),
    }),
    observe: (data) => deliveryTotal(data.page),
  }),
  defineRule({
    id: "runtime.occupant",
    source: listSource<RuntimeView>(
      {
        id: "runtime",
        label: "runtime observations",
        requires: ["agents:read"],
        surface: "runtime-view",
      },
      (projectId) =>
        getRuntimeView(projectId, {
          ...runtimeQueryFromSearch(params(RUNTIME)),
          limit: 1,
        }),
    ),
    noun: [
      "agent whose mailbox occupant needs a check",
      "agents whose mailbox occupant needs a check",
    ],
    rule: "The run holding the mailbox expired, cannot be confirmed, or its host stopped reporting.",
    severity: "amber",
    link: fixed("runtime", RUNTIME),
    observe: runtimeObservation,
  }),
];

export type RowState =
  | { kind: "pending" }
  /** The caller's access does not include this source. */
  | { kind: "hidden" }
  | { kind: "failed"; error: ErrorKind; cause: unknown }
  /** The deployment lacks configuration the source needs. */
  | { kind: "not-configured" }
  | { kind: "not-applicable"; reason: string }
  | {
      kind: "ready";
      total: number;
      complete: boolean;
      scope?: string;
      link: ListLink;
      updatedAt: number;
      stale: StaleInfo | null;
    };

export interface AttentionRow {
  rule: AttentionRule;
  state: RowState;
}

const notConfigured = (error: unknown) =>
  error instanceof ApiError && error.code === "config-unavailable";

/** A rule's row from its source's query state. */
export function ruleRow(
  rule: AttentionRule,
  source: SectionState<unknown> | "hidden",
): RowState {
  if (source === "hidden") return { kind: "hidden" };
  if (source.phase === "pending") return { kind: "pending" };
  if (source.phase === "failed") {
    if (source.kind === "forbidden") return { kind: "hidden" };
    if (notConfigured(source.error)) return { kind: "not-configured" };
    return { kind: "failed", error: source.kind, cause: source.error };
  }
  if (source.stale && notConfigured(source.stale.error))
    return { kind: "not-configured" };
  const observed = rule.observe(source.data);
  if (observed.notApplicable)
    return { kind: "not-applicable", reason: observed.notApplicable };
  return {
    kind: "ready",
    total: observed.total,
    complete: observed.complete,
    scope: observed.scope,
    link: rule.link(source.data),
    updatedAt: source.updatedAt,
    stale: source.stale,
  };
}

/**
 * True only when the server affirmatively reports a project nobody has set up:
 * no applied definitions, and no tasks or records at all. Anything unread,
 * stale or partial is not evidence of an empty project.
 */
export function isUnconfigured(input: {
  schema: SectionState<AppliedSchemaResponse>;
  work: SectionState<WorkCatalogResponse>;
  records: SectionState<RecordTypesResponse>;
}): boolean {
  const { schema, work, records } = input;
  if (schema.phase !== "ready" || schema.stale || schema.data.schema)
    return false;
  if (
    work.phase !== "ready" ||
    work.stale ||
    work.data.incomplete?.in_use_types
  )
    return false;
  const workRows = work.data.types.reduce(
    (sum, type) => sum + type.count + type.archived_count,
    0,
  );
  if (workRows > 0) return false;
  if (records.phase !== "ready" || records.stale) return false;
  if (records.data.incomplete?.in_use_types) return false;
  const entries = records.data.entries;
  if (!entries) return records.data.types.length === 0;
  return entries.every((entry) => entry.count + entry.archived_count === 0);
}

export type OverviewState =
  /** Still loading; nothing conclusive yet. */
  | "pending"
  /** A new project: nothing configured or stored. */
  | "setup"
  /** At least one rule found something. */
  | "attention"
  /** Every check completed and found nothing. */
  | "idle"
  /** Nothing found, but some checks failed or were partial. */
  | "partial"
  /** No check could be completed. */
  | "unknown"
  /** The caller's access includes no checks at all. */
  | "unchecked";

export interface OverviewView {
  state: OverviewState;
  /** Visible rows: findings first, then unknowns, then the rest. */
  rows: AttentionRow[];
  /** The most urgent finding. */
  next: (AttentionRow & { state: Extract<RowState, { kind: "ready" }> }) | null;
  /** Some visible check failed, is stale, partial, or still loading. */
  incomplete: boolean;
  /** Rules the caller's access does not include. */
  hidden: AttentionRule[];
}

const SEVERITY_RANK: Record<Severity, number> = { red: 0, amber: 1 };

function rank(row: AttentionRow): number {
  const { state } = row;
  if (state.kind === "ready" && state.total > 0) return 0;
  if (state.kind === "failed" || state.kind === "not-configured") return 1;
  if (state.kind === "pending") return 2;
  if (state.kind === "ready") return 3;
  return 4;
}

const isFinding = (
  row: AttentionRow,
): row is AttentionRow & { state: Extract<RowState, { kind: "ready" }> } =>
  row.state.kind === "ready" && row.state.total > 0;

/** Decide what the Overview says. Pure, so scenarios can be tested directly. */
export function evaluateOverview(input: {
  rows: AttentionRow[];
  unconfigured: boolean;
}): OverviewView {
  const hidden = input.rows
    .filter((row) => row.state.kind === "hidden")
    .map((row) => row.rule);
  const rows = input.rows
    .filter((row) => row.state.kind !== "hidden")
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      if (isFinding(a) && isFinding(b))
        return (
          SEVERITY_RANK[a.rule.severity] - SEVERITY_RANK[b.rule.severity] ||
          b.state.total - a.state.total
        );
      return 0;
    });
  const findings = rows.filter(isFinding);
  const incomplete = rows.some(
    ({ state }) =>
      state.kind === "pending" ||
      state.kind === "failed" ||
      state.kind === "not-configured" ||
      (state.kind === "ready" && (state.stale !== null || !state.complete)),
  );
  const next = findings[0] ?? null;
  const view = { rows, next, incomplete, hidden };

  if (findings.length > 0) return { ...view, state: "attention" };
  if (input.unconfigured) return { ...view, state: "setup" };
  if (rows.some((row) => row.state.kind === "pending"))
    return { ...view, state: "pending" };
  if (rows.length === 0) return { ...view, state: "unchecked" };
  if (!rows.some((row) => row.state.kind === "ready"))
    return { ...view, state: "unknown" };
  return { ...view, state: incomplete ? "partial" : "idle" };
}

/** "3 suspended executions" */
export function countLabel(rule: AttentionRule, total: number): string {
  const [one, many] = rule.noun;
  return `${total.toLocaleString("en-US")} ${total === 1 ? one : many}`;
}
