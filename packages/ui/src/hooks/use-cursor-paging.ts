import { ApiError } from "@/lib/api";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

/**
 * Cursors of the pages before the current one, kept in history state so
 * "Previous" works without the server offering backward cursors. `fromStart`
 * says the trail reaches page one, so the page number is known.
 */
export type PageTrail = { cursors: (string | null)[]; fromStart: boolean };

export function readTrail(state: unknown): PageTrail | null {
  if (!state || typeof state !== "object" || !("pageTrail" in state)) {
    return null;
  }
  const trail = (state as { pageTrail?: unknown }).pageTrail;
  if (
    !trail ||
    typeof trail !== "object" ||
    !Array.isArray((trail as PageTrail).cursors)
  ) {
    return null;
  }
  return trail as PageTrail;
}

export function isInvalidCursor(error: unknown): boolean {
  return error instanceof ApiError && error.code === "invalid-cursor";
}

/**
 * Keyset paging driven by the `after` URL param. Next pushes a history entry
 * (so browser Back returns to the previous page); filter changes are expected
 * to drop `after` themselves.
 */
export function useCursorPaging() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const after = searchParams.get("after") ?? undefined;
  const trail = readTrail(location.state);
  // Shown after an expired or foreign page link was dropped. Cleared by the
  // next deliberate navigation.
  const [cursorReset, setCursorReset] = useState(false);

  function goToPage(cursor: string | null, nextTrail: PageTrail) {
    setCursorReset(false);
    const next = new URLSearchParams(searchParams);
    if (cursor) next.set("after", cursor);
    else next.delete("after");
    const search = next.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "" },
      { state: { pageTrail: nextTrail } },
    );
  }

  const canGoPrevious = Boolean(after) && (trail?.cursors.length ?? 0) > 0;

  return {
    after,
    /** Zero-based page number, or null when a deep link hides it. */
    pageIndex: !after ? 0 : trail?.fromStart ? trail.cursors.length : null,
    canGoPrevious,
    cursorReset,
    markCursorReset: () => setCursorReset(true),
    clearCursorReset: () => setCursorReset(false),
    goNext(nextCursor: string) {
      goToPage(
        nextCursor,
        after
          ? {
              cursors: [...(trail?.cursors ?? []), after],
              fromStart: trail?.fromStart ?? false,
            }
          : { cursors: [null], fromStart: true },
      );
    },
    goPrevious() {
      if (!trail || trail.cursors.length === 0) return;
      goToPage(trail.cursors[trail.cursors.length - 1], {
        cursors: trail.cursors.slice(0, -1),
        fromStart: trail.fromStart,
      });
    },
    goFirst() {
      goToPage(null, { cursors: [], fromStart: true });
    },
  };
}

export type CursorPaging = ReturnType<typeof useCursorPaging>;

/**
 * A 400 `invalid-cursor` (expired, or issued for another filter or sort) drops
 * `after` so the first page loads, and raises the reset notice.
 */
export function useDropInvalidCursor(error: unknown, paging: CursorPaging) {
  const [, setSearchParams] = useSearchParams();
  const invalid = isInvalidCursor(error);
  const { after, markCursorReset } = paging;
  // biome-ignore lint/correctness/useExhaustiveDependencies: markCursorReset only sets state
  useEffect(() => {
    if (!invalid || !after) return;
    markCursorReset();
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("after");
        return next;
      },
      { replace: true },
    );
  }, [invalid, after, setSearchParams]);
  return invalid && Boolean(after);
}

/** "101–200 of 312" when the page number is known, else "Showing n of total". */
export function pagePosition(
  pageIndex: number | null,
  pageSize: number,
  count: number,
  total: number,
): string {
  if (pageIndex === null) return `Showing ${count} of ${total}`;
  const start = pageIndex * pageSize + 1;
  return `${start}–${start + count - 1} of ${total}`;
}

export const CURSOR_RESET_NOTICE =
  "That page link is no longer valid; showing the first page.";
