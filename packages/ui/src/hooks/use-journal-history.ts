import { replayJournal } from "@/lib/api";
import {
  AUTO_FILL_SPAN,
  type HistoryProblem,
  type JournalFilters,
  type JournalHistoryEvent,
  classifyHistoryError,
  gapWindow,
  hasRoomForPage,
  liveGap,
  matchesJournalFilters,
  olderWindow,
} from "@/lib/journal-history";
import { useCallback, useEffect, useRef, useState } from "react";

/** Where older history starts: just below the oldest row the live view shows. */
export type HistoryAnchor = {
  /** The sequence the live view begins at; history is everything below it. */
  seq: number;
  /** False when the live view is empty and `seq` is only its cursor plus one. */
  fromRow: boolean;
};

type State = {
  /** The project and filters this history was read for. */
  scope: string;
  /** Matching events, ascending by sequence. */
  rows: JournalHistoryEvent[];
  anchor: HistoryAnchor | null;
  /** The lowest sequence examined; everything from here up is covered. */
  covered: number | null;
  /** The highest sequence examined: the top edge facing the live view. */
  ceiling: number | null;
  /** Sequences examined since the history was last cleared. */
  scanned: number;
  /** The request in flight, if any; a result applies only while this matches. */
  pending: number | null;
  problem: Exclude<HistoryProblem, { kind: "restricted" }> | null;
  /** Which read produced `problem`, so a retry repeats that one. */
  failedRead: "older" | "newer" | null;
};

const emptyState = (scope: string): State => ({
  scope,
  rows: [],
  anchor: null,
  covered: null,
  ceiling: null,
  scanned: 0,
  pending: null,
  problem: null,
  failedRead: null,
});

export type JournalHistory = {
  /** Matching events below the live view, ascending by sequence. */
  rows: JournalHistoryEvent[];
  anchor: HistoryAnchor | null;
  /** The lowest sequence examined, or null before the first read. */
  covered: number | null;
  scanned: number;
  /** The first event has been examined: nothing older exists. */
  done: boolean;
  /** The buffer is at capacity: loading more needs a clear. */
  full: boolean;
  loading: boolean;
  /** The credential may not read replay: the control degrades to a notice. */
  restricted: boolean;
  problem: State["problem"];
  /**
   * Sequences the live view moved past after history was loaded, so they sit
   * in neither list. Closed by `fillGap`, on its own when `fillsItself`.
   */
  gap: { from: number; through: number } | null;
  /** The gap is small and the buffer has room: a read for it is under way. */
  fillsItself: boolean;
  loadOlder: () => void;
  fillGap: () => void;
  /** Repeat the read that failed. */
  retry: () => void;
  /** Forget a "restricted" finding and try the read again. */
  retryAccess: () => void;
  clear: () => void;
};

/**
 * Older journal history, read through replay and held apart from the live
 * tail. It owns its own cursors and buffer: nothing here reads the tail's
 * cursor except `readAnchor`, once, to learn where the live view begins, and
 * nothing here can move it. Filters apply client-side to each window, so a
 * filter change starts a fresh history rather than reinterpreting old rows.
 *
 * The history has two edges. `loadOlder` extends the bottom one, on request.
 * The live view's first row only ever moves up (pruning, reseeding), which
 * would leave a hole above the history's top edge; the hole is the range
 * `[ceiling + 1, liveLow - 1]`, and replaying it closes it. A small hole closes
 * by itself; a large one waits for `fillGap`. Both edges share one read path
 * and one request at a time, and a failure never retries on its own.
 *
 * `credential` is whatever changes when the signed-in session is re-read: a
 * "restricted" finding applies to the credential that produced it, not to the
 * project, so a new session snapshot starts from "unknown" again.
 */
export function useJournalHistory({
  projectId,
  filters,
  readAnchor,
  liveLow,
  credential,
}: {
  projectId: string | null;
  filters: JournalFilters;
  readAnchor: () => HistoryAnchor;
  /** The first sequence the live view shows, or null while it holds no row. */
  liveLow: number | null;
  credential: unknown;
}): JournalHistory {
  const scope = JSON.stringify([projectId, filters]);
  const [state, setState] = useState<State>(() => emptyState(scope));
  // A different project or filters is a different history; the old one is
  // simply no longer the current state.
  const view = state.scope === scope ? state : emptyState(scope);
  const [denied, setDenied] = useState<{
    projectId: string;
    credential: unknown;
  } | null>(null);
  const restricted =
    projectId !== null &&
    denied !== null &&
    denied.projectId === projectId &&
    denied.credential === credential;

  const gap = liveGap(view.ceiling, view.anchor?.fromRow ?? false, liveLow);
  const roomForPage = hasRoomForPage(view.rows.length);
  const fillsItself =
    gap !== null &&
    gap.through - gap.from + 1 <= AUTO_FILL_SPAN &&
    roomForPage &&
    view.problem === null &&
    !restricted;

  const latest = useRef({
    projectId,
    scope,
    filters,
    view,
    readAnchor,
    liveLow,
    credential,
  });
  useEffect(() => {
    latest.current = {
      projectId,
      scope,
      filters,
      view,
      readAnchor,
      liveLow,
      credential,
    };
  });
  const requests = useRef(0);

  const read = useCallback((direction: "older" | "newer") => {
    const { projectId, scope, filters, view, readAnchor, liveLow, credential } =
      latest.current;
    if (!projectId || view.pending !== null) return;
    if (!hasRoomForPage(view.rows.length)) return;

    const anchor = view.anchor ?? readAnchor();
    const covered = view.covered ?? anchor.seq;
    const ceiling = view.ceiling ?? anchor.seq - 1;
    const gap = liveGap(ceiling, anchor.fromRow, liveLow);
    const bounds =
      direction === "older" ? olderWindow(covered) : gap && gapWindow(gap);
    if (!bounds) {
      // Older: sequence 1 is already accounted for. Newer: nothing to close.
      if (direction === "older")
        setState({ ...view, anchor, covered, ceiling, problem: null });
      return;
    }

    requests.current += 1;
    const id = requests.current;
    setState({ ...view, anchor, covered, ceiling, pending: id, problem: null });
    const span = bounds.through - bounds.after;
    replayJournal(projectId, {
      after_seq: bounds.after,
      through_seq: bounds.through,
      limit: span,
    }).then(
      (page) => {
        const matched = page.events
          .filter(
            (event) =>
              event.seq > bounds.after &&
              event.seq <= bounds.through &&
              matchesJournalFilters(event, filters),
          )
          .sort((a, b) => a.seq - b.seq);
        setState((prev) => {
          if (prev.scope !== scope || prev.pending !== id) return prev;
          const held = new Set(prev.rows.map((row) => row.seq));
          const fresh = matched.filter((event) => !held.has(event.seq));
          return {
            ...prev,
            rows:
              direction === "older"
                ? [...fresh, ...prev.rows]
                : [...prev.rows, ...fresh],
            covered: direction === "older" ? bounds.after + 1 : prev.covered,
            ceiling: direction === "older" ? prev.ceiling : bounds.through,
            scanned: prev.scanned + span,
            pending: null,
            problem: null,
          };
        });
      },
      (error: unknown) => {
        const problem = classifyHistoryError(error);
        if (problem.kind === "restricted") setDenied({ projectId, credential });
        setState((prev) => {
          if (prev.scope !== scope || prev.pending !== id) return prev;
          return {
            ...prev,
            pending: null,
            problem: problem.kind === "restricted" ? null : problem,
            failedRead: problem.kind === "restricted" ? null : direction,
          };
        });
      },
    );
  }, []);

  // The live view may have had no row when history began, so its anchor was
  // only a cursor. The first row to arrive becomes the anchor, and from then on
  // the top edge is tracked like any other.
  useEffect(() => {
    if (liveLow === null) return;
    setState((prev) => {
      if (prev.scope !== scope || !prev.anchor || prev.anchor.fromRow)
        return prev;
      return {
        ...prev,
        anchor: { ...prev.anchor, fromRow: true },
        ceiling: Math.max(prev.ceiling ?? 0, liveLow - 1),
      };
    });
  }, [liveLow, scope]);

  // Close a small gap without being asked. `fillsItself` already excludes
  // failure and a full buffer, so an error here cannot loop: the problem it
  // leaves holds the effect off until the operator retries or clears.
  const gapKey = gap ? `${gap.from}-${gap.through}` : null;
  const settled = view.pending === null;
  useEffect(() => {
    if (fillsItself && settled && gapKey !== null) read("newer");
  }, [fillsItself, settled, gapKey, read]);

  const loadOlder = useCallback(() => read("older"), [read]);
  const fillGap = useCallback(() => read("newer"), [read]);
  const retry = useCallback(
    () => read(latest.current.view.failedRead ?? "older"),
    [read],
  );
  const retryAccess = useCallback(() => {
    setDenied(null);
    read("older");
  }, [read]);
  const clear = useCallback(() => {
    setState(emptyState(latest.current.scope));
  }, []);

  return {
    rows: view.rows,
    anchor: view.anchor,
    covered: view.covered,
    scanned: view.scanned,
    done: view.covered !== null && view.covered <= 1,
    full: !roomForPage,
    loading: view.pending !== null,
    restricted,
    problem: view.problem,
    gap,
    fillsItself,
    loadOlder,
    fillGap,
    retry,
    retryAccess,
    clear,
  };
}
