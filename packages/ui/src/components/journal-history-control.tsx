import { Button } from "@/components/ui/button";
import type { JournalHistory } from "@/hooks/use-journal-history";
import { HISTORY_MAX_ROWS } from "@/lib/journal-history";

const count = (value: number) => value.toLocaleString("en-US");

/**
 * Sequences the live view trimmed after history was loaded. The history below
 * ends at `from - 1` and the live view now starts at `through + 1`, so these
 * are in neither list until the history is cleared and read again.
 */
export type HistoryGap = { from: number; through: number };

function summary(history: JournalHistory, filtered: boolean): string {
  if (history.covered === null) {
    return history.loading
      ? "Loading older events…"
      : "Reads events older than the live view from history, archived ones included.";
  }
  if (history.scanned === 0) {
    return "Nothing older: the live view already starts at the first event.";
  }
  const scanned = `Scanned ${count(history.scanned)} sequences back to #${count(history.covered)}`;
  const held = filtered
    ? `${count(history.rows.length)} match the active filters`
    : `${count(history.rows.length)} events loaded`;
  const tail = history.loading
    ? " · Loading older events…"
    : history.done
      ? " · Reached the first event."
      : history.full
        ? ` · Buffer full at ${count(HISTORY_MAX_ROWS)} events: clear history to load more.`
        : "";
  return `${scanned} · ${held}${tail}`;
}

/**
 * Pages older journal events in from history. It renders beside the live tail,
 * never in place of it: every state here, including failures, is local to this
 * strip and leaves the tail polling and its rows alone.
 */
export function JournalHistoryControl({
  history,
  filtered,
  gap,
}: {
  history: JournalHistory;
  /** Whether any filter is active, so matches are counted against the scan. */
  filtered: boolean;
  gap: HistoryGap | null;
}) {
  if (history.restricted) {
    return (
      <output
        className="block font-mono text-[11px] text-fg-faint"
        data-testid="journal-history-restricted"
      >
        Older history needs journal read access, which this credential does not
        have. The live tail is unaffected.
      </output>
    );
  }

  const engaged = history.anchor !== null;
  const canLoad = !history.done && !history.full;
  const { problem } = history;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {canLoad && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={history.loading}
            aria-busy={history.loading}
            onClick={history.loadOlder}
          >
            Load older
          </Button>
        )}
        {engaged && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={history.loading}
            onClick={history.clear}
          >
            Clear history
          </Button>
        )}
        <output className="block font-mono text-[11px] text-fg-faint">
          {summary(history, filtered)}
        </output>
      </div>

      {gap && (
        <output className="block font-mono text-[11px] text-status-amber">
          Sequences #{count(gap.from)} to #{count(gap.through)} are not shown:
          the live view trimmed them after this history was loaded. Clear
          history and load older again to include them.
        </output>
      )}

      {problem && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-xs text-status-red"
        >
          <span>
            {problem.kind === "unavailable" &&
              "Older history is unavailable right now: archived events could not be read in full. The live tail is unaffected."}
            {problem.kind === "invalid-cursor" &&
              "The history position is no longer valid, so no older events were loaded. Restart history to read from the live view again."}
            {problem.kind === "failed" &&
              `Could not load older events: ${problem.message}`}
          </span>
          {problem.kind === "invalid-cursor" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={history.clear}
            >
              Restart history
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={history.loading}
              onClick={history.loadOlder}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
