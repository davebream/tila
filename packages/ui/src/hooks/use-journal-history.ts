import { replayJournal } from "@/lib/api";
import {
  type HistoryProblem,
  type JournalFilters,
  type JournalHistoryEvent,
  classifyHistoryError,
  hasRoomForPage,
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
  /** Matching older events, ascending by sequence. */
  rows: JournalHistoryEvent[];
  anchor: HistoryAnchor | null;
  /** The lowest sequence already examined; everything from here up is covered. */
  covered: number | null;
  /** Sequences examined since the history was last cleared. */
  scanned: number;
  /** The request in flight, if any; a result applies only while this matches. */
  pending: number | null;
  problem: Exclude<HistoryProblem, { kind: "restricted" }> | null;
};

const emptyState = (scope: string): State => ({
  scope,
  rows: [],
  anchor: null,
  covered: null,
  scanned: 0,
  pending: null,
  problem: null,
});

export type JournalHistory = {
  /** Matching older events, ascending by sequence. */
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
  loadOlder: () => void;
  clear: () => void;
};

/**
 * Older journal history, read through replay and held apart from the live
 * tail. It owns its own cursor and buffer: it never reads the tail's cursor
 * except once, through `readAnchor`, to learn where the live view begins, and
 * nothing here can move it. Filters apply client-side to each window, so a
 * filter change starts a fresh history rather than reinterpreting old rows.
 *
 * Every state change is user-driven (`loadOlder`, `clear`); there is no
 * polling, and a failure never retries by itself.
 */
export function useJournalHistory({
  projectId,
  filters,
  readAnchor,
}: {
  projectId: string | null;
  filters: JournalFilters;
  readAnchor: () => HistoryAnchor;
}): JournalHistory {
  const scope = JSON.stringify([projectId, filters]);
  const [state, setState] = useState<State>(() => emptyState(scope));
  // A different project or filters is a different history; the old one is
  // simply no longer the current state.
  const view = state.scope === scope ? state : emptyState(scope);
  // Not part of the scope: a credential that cannot read replay cannot read it
  // under any filter, so the finding outlives filter changes.
  const [restrictedProject, setRestrictedProject] = useState<string | null>(
    null,
  );

  const latest = useRef({ projectId, scope, filters, view, readAnchor });
  useEffect(() => {
    latest.current = { projectId, scope, filters, view, readAnchor };
  });
  const requests = useRef(0);

  const loadOlder = useCallback(() => {
    const { projectId, scope, filters, view, readAnchor } = latest.current;
    if (!projectId || view.pending !== null) return;
    if (!hasRoomForPage(view.rows.length)) return;

    const anchor = view.anchor ?? readAnchor();
    const covered = view.covered ?? anchor.seq;
    const bounds = olderWindow(covered);
    if (!bounds) {
      // Sequence 1 is already accounted for: nothing older to ask for.
      setState({ ...view, anchor, covered, problem: null });
      return;
    }

    requests.current += 1;
    const id = requests.current;
    setState({ ...view, anchor, covered, pending: id, problem: null });
    const span = bounds.through - bounds.after;
    replayJournal(projectId, {
      after_seq: bounds.after,
      through_seq: bounds.through,
      limit: span,
    }).then(
      (page) => {
        const matched = page.events.filter(
          (event) =>
            event.seq > bounds.after &&
            event.seq <= bounds.through &&
            matchesJournalFilters(event, filters),
        );
        setState((prev) => {
          if (prev.scope !== scope || prev.pending !== id) return prev;
          const held = new Set(prev.rows.map((row) => row.seq));
          const older = matched
            .filter((event) => !held.has(event.seq))
            .sort((a, b) => a.seq - b.seq);
          return {
            ...prev,
            rows: [...older, ...prev.rows],
            covered: bounds.after + 1,
            scanned: prev.scanned + span,
            pending: null,
            problem: null,
          };
        });
      },
      (error: unknown) => {
        const problem = classifyHistoryError(error);
        if (problem.kind === "restricted") setRestrictedProject(projectId);
        setState((prev) => {
          if (prev.scope !== scope || prev.pending !== id) return prev;
          return {
            ...prev,
            pending: null,
            problem: problem.kind === "restricted" ? null : problem,
          };
        });
      },
    );
  }, []);

  const clear = useCallback(() => {
    setState(emptyState(latest.current.scope));
  }, []);

  return {
    rows: view.rows,
    anchor: view.anchor,
    covered: view.covered,
    scanned: view.scanned,
    done: view.covered !== null && view.covered <= 1,
    full: !hasRoomForPage(view.rows.length),
    loading: view.pending !== null,
    restricted: projectId !== null && restrictedProject === projectId,
    problem: view.problem,
    loadOlder,
    clear,
  };
}
