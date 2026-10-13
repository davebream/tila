import { ApiError, type AppliedSchemaResponse, inspectQueue } from "@/lib/api";
import { queueQueryFromSearch } from "@/lib/list-queries";
import type { AccessTarget } from "@/lib/navigation";
import type { ErrorKind, SectionState, StaleInfo } from "@/lib/query-state";
import type {
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

export interface AttentionRule<T = unknown> {
  id: string;
  source: AttentionSource<T>;
  /** The observed fact's noun, singular and plural. */
  noun: readonly [string, string];
  /** The inference: why a non-zero count needs a person. */
  rule: string;
  severity: Severity;
  /** The list the count links to; it applies the same filter. */
  link: { segment: string; search: string };
  observe(data: T): Observation;
}

const queueSource: AttentionSource<QueueInspection> = {
  id: "queue",
  label: "the execution queue",
  requires: ["tasks:read"],
  surface: "queue",
  // `counts` group entries with the same predicate as the `state` filter and
  // cover the same caller-visible entries, so each equals that list's total.
  fetch: (projectId) =>
    inspectQueue(projectId, {
      ...queueQueryFromSearch(new URLSearchParams()),
      limit: 1,
    }),
};

/** Type-check a rule against its source's data, then store it untyped. */
const defineRule = <T>(rule: AttentionRule<T>) => rule as AttentionRule;

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
    link: { segment: "queue", search: "?state=uncertain" },
    observe: (data) => ({ total: data.counts.uncertain, complete: true }),
  }),
  defineRule({
    id: "execution.suspended",
    source: queueSource,
    noun: ["suspended execution", "suspended executions"],
    rule: "Paused work stays parked until someone resumes or cancels it.",
    severity: "amber",
    link: { segment: "queue", search: "?state=suspended" },
    observe: (data) => ({ total: data.counts.suspended, complete: true }),
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
  if (records.phase === "failed") return records.kind === "forbidden";
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
