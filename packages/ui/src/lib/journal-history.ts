import { ApiError } from "@/lib/api";
import type { JournalReplayResponse } from "@tila/schemas";

/** One event as replay returns it, archived or live. */
export type JournalHistoryEvent = JournalReplayResponse["events"][number];

/** The most sequences replay serves in one request (its `limit` maximum). */
export const HISTORY_PAGE_SPAN = 200;

/**
 * The most older events held at once. Loading stops at the cap instead of
 * evicting rows the operator already read; clearing the history makes room.
 */
export const HISTORY_MAX_ROWS = 2000;

/** The journal page's active filters, in the shape the live tail sends. */
export type JournalFilters = {
  resource: string;
  kind: string[];
  clientName: string[];
  eventName: string;
  correlationId: string;
};

export function hasActiveFilters(filters: JournalFilters): boolean {
  return (
    filters.resource !== "" ||
    filters.kind.length > 0 ||
    filters.clientName.length > 0 ||
    filters.eventName !== "" ||
    filters.correlationId !== ""
  );
}

/**
 * Whether `event` passes `filters`, with the same meaning `GET /journal` gives
 * them server-side: every selector is an exact match, `kind` and `client_name`
 * match any listed value, and an event or correlation selector only ever
 * matches a `custom.reported` event carrying that exact value.
 */
export function matchesJournalFilters(
  event: Pick<
    JournalHistoryEvent,
    "kind" | "resource" | "environment" | "data"
  >,
  filters: JournalFilters,
): boolean {
  if (filters.resource !== "" && event.resource !== filters.resource)
    return false;
  if (filters.kind.length > 0 && !filters.kind.includes(event.kind))
    return false;
  if (filters.clientName.length > 0) {
    const client = event.environment?.client_name;
    if (client === undefined || !filters.clientName.includes(client))
      return false;
  }
  if (filters.eventName !== "" || filters.correlationId !== "") {
    if (event.kind !== "custom.reported") return false;
    const data = event.data ?? {};
    if (filters.eventName !== "" && data.event_name !== filters.eventName)
      return false;
    if (
      filters.correlationId !== "" &&
      data.correlation_id !== filters.correlationId
    )
      return false;
  }
  return true;
}

/**
 * The replay window just below `covered`, the lowest sequence already
 * accounted for. Replay reads `(after, through]`, so this is the page of up to
 * `HISTORY_PAGE_SPAN` sequences ending at `covered - 1`; `null` once the first
 * event (sequence 1) is accounted for and nothing older exists.
 */
export function olderWindow(
  covered: number,
): { after: number; through: number } | null {
  const through = covered - 1;
  if (through <= 0) return null;
  return { after: through - Math.min(HISTORY_PAGE_SPAN, through), through };
}

/**
 * Gaps up to this many sequences close on their own. A burst can move the live
 * view's first row far past where history ends, and a sparse filter can make
 * that many sequences hold almost no events; past this the operator chooses.
 */
export const AUTO_FILL_SPAN = HISTORY_PAGE_SPAN * 5;

/**
 * The sequences between the top of the history and the first row of the live
 * view. The live tail prunes (or reseeds) on its own schedule, so its first row
 * only ever moves up; whatever it passed is in neither list until read through
 * replay. Null while the two meet, or when the live view had no row to anchor to.
 */
export function liveGap(
  ceiling: number | null,
  anchoredToRow: boolean,
  liveLow: number | null,
): { from: number; through: number } | null {
  if (ceiling === null || !anchoredToRow || liveLow === null) return null;
  return liveLow > ceiling + 1
    ? { from: ceiling + 1, through: liveLow - 1 }
    : null;
}

/** The next replay window upward through `gap`, at most one page. */
export function gapWindow(gap: { from: number; through: number }): {
  after: number;
  through: number;
} {
  return {
    after: gap.from - 1,
    through: Math.min(gap.through, gap.from - 1 + HISTORY_PAGE_SPAN),
  };
}

/** True while a whole further page still fits under the cap. */
export function hasRoomForPage(held: number): boolean {
  return held + HISTORY_PAGE_SPAN <= HISTORY_MAX_ROWS;
}

/** Why a history read failed, in the terms the control has to tell apart. */
export type HistoryProblem =
  /** The credential may not read replay: degrade, never retry on its own. */
  | { kind: "restricted" }
  /** Archived rows could not be read in full: transient, retry is safe. */
  | { kind: "unavailable"; message: string }
  /** The window lies outside the journal: retrying cannot help, restart. */
  | { kind: "invalid-cursor"; message: string }
  | { kind: "failed"; message: string; code?: string };

export function classifyHistoryError(error: unknown): HistoryProblem {
  if (error instanceof ApiError) {
    if (error.status === 403) return { kind: "restricted" };
    if (error.code === "invalid-cursor")
      return { kind: "invalid-cursor", message: error.message };
    if (error.code === "journal-history-unavailable" || error.status === 503)
      return { kind: "unavailable", message: error.message };
    return { kind: "failed", message: error.message, code: error.code };
  }
  return {
    kind: "failed",
    message:
      error instanceof Error ? error.message : "Failed to load older events",
  };
}
