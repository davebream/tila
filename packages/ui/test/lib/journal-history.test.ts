import { ApiError } from "@/lib/api";
import {
  AUTO_FILL_SPAN,
  HISTORY_MAX_ROWS,
  HISTORY_PAGE_SPAN,
  type JournalFilters,
  classifyHistoryError,
  gapWindow,
  hasActiveFilters,
  hasRoomForPage,
  liveGap,
  matchesJournalFilters,
  olderWindow,
} from "@/lib/journal-history";

const none: JournalFilters = {
  resource: "",
  kind: [],
  clientName: [],
  eventName: "",
  correlationId: "",
};

function event(
  extra: Partial<{
    kind: string;
    resource: string;
    environment: { client_name?: string };
    data: Record<string, unknown>;
  }> = {},
) {
  return {
    kind: "entity.created",
    resource: "task-1",
    environment: { client_name: "cli" },
    data: {},
    ...extra,
  };
}

describe("matchesJournalFilters", () => {
  test("no active filter matches every event", () => {
    expect(hasActiveFilters(none)).toBe(false);
    expect(matchesJournalFilters(event(), none)).toBe(true);
  });

  test("resource is an exact match, not a prefix or substring", () => {
    const f = { ...none, resource: "task-1" };
    expect(matchesJournalFilters(event({ resource: "task-1" }), f)).toBe(true);
    expect(matchesJournalFilters(event({ resource: "task-10" }), f)).toBe(
      false,
    );
    expect(matchesJournalFilters(event({ resource: "task:task-1" }), f)).toBe(
      false,
    );
  });

  test("kind and client match any listed value", () => {
    const f = {
      ...none,
      kind: ["claim.acquired", "claim.released"],
      clientName: ["mcp", "sdk"],
    };
    const base = { environment: { client_name: "mcp" } };
    expect(
      matchesJournalFilters(event({ ...base, kind: "claim.released" }), f),
    ).toBe(true);
    expect(
      matchesJournalFilters(event({ ...base, kind: "claim.renewed" }), f),
    ).toBe(false);
    expect(
      matchesJournalFilters(
        event({ kind: "claim.acquired", environment: { client_name: "cli" } }),
        f,
      ),
    ).toBe(false);
  });

  test("an event without a client name never matches a client filter", () => {
    const f = { ...none, clientName: ["cli"] };
    expect(matchesJournalFilters(event({ environment: {} }), f)).toBe(false);
  });

  test("event name and correlation id only ever match custom.reported events", () => {
    const f = { ...none, eventName: "deploy.finished", correlationId: "run-7" };
    const report = {
      kind: "custom.reported",
      data: { event_name: "deploy.finished", correlation_id: "run-7" },
    };
    expect(matchesJournalFilters(event(report), f)).toBe(true);
    // Same data under another kind is not a project report.
    expect(
      matchesJournalFilters(event({ ...report, kind: "entity.updated" }), f),
    ).toBe(false);
    // Both selectors must hold, each exactly.
    expect(
      matchesJournalFilters(
        event({
          kind: "custom.reported",
          data: { event_name: "deploy.finished", correlation_id: "run-8" },
        }),
        f,
      ),
    ).toBe(false);
    expect(
      matchesJournalFilters(
        event({ kind: "custom.reported", data: { event_name: "deploy.fin" } }),
        { ...none, eventName: "deploy.finished" },
      ),
    ).toBe(false);
  });

  test("filters combine with AND", () => {
    const f = { ...none, resource: "task-1", kind: ["entity.updated"] };
    expect(matchesJournalFilters(event({ kind: "entity.updated" }), f)).toBe(
      true,
    );
    expect(matchesJournalFilters(event({ kind: "entity.created" }), f)).toBe(
      false,
    );
    expect(hasActiveFilters(f)).toBe(true);
  });
});

describe("olderWindow", () => {
  test("pages backwards in whole replay windows", () => {
    // 1151 is the lowest sequence accounted for: ask for (950, 1150].
    expect(olderWindow(1151)).toEqual({ after: 950, through: 1150 });
    // Contiguous with the window above it, no gap and no overlap.
    expect(olderWindow(951)).toEqual({ after: 750, through: 950 });
  });

  test("the last window starts at the journal's first sequence", () => {
    expect(olderWindow(151)).toEqual({ after: 0, through: 150 });
    expect(olderWindow(HISTORY_PAGE_SPAN + 1)).toEqual({
      after: 0,
      through: HISTORY_PAGE_SPAN,
    });
  });

  test("offers nothing once sequence 1 is accounted for", () => {
    expect(olderWindow(1)).toBeNull();
    expect(olderWindow(0)).toBeNull();
  });
});

describe("hasRoomForPage", () => {
  test("allows a page only while the whole page fits under the cap", () => {
    expect(hasRoomForPage(0)).toBe(true);
    expect(hasRoomForPage(HISTORY_MAX_ROWS - HISTORY_PAGE_SPAN)).toBe(true);
    expect(hasRoomForPage(HISTORY_MAX_ROWS - HISTORY_PAGE_SPAN + 1)).toBe(
      false,
    );
    expect(hasRoomForPage(HISTORY_MAX_ROWS)).toBe(false);
  });
});

describe("classifyHistoryError", () => {
  test("a forbidden read is restricted, whatever the server called it", () => {
    expect(
      classifyHistoryError(
        new ApiError("permission-denied", "denied", undefined, 403),
      ),
    ).toEqual({ kind: "restricted" });
    expect(
      classifyHistoryError(
        new ApiError("token-authz-denied", "denied", undefined, 403),
      ),
    ).toEqual({ kind: "restricted" });
  });

  test("an invalid cursor is told apart so the control restarts, not retries", () => {
    expect(
      classifyHistoryError(
        new ApiError("invalid-cursor", "bad window", undefined, 400),
      ),
    ).toEqual({ kind: "invalid-cursor", message: "bad window" });
  });

  test("unreadable archives are unavailable and retryable", () => {
    expect(
      classifyHistoryError(
        new ApiError(
          "journal-history-unavailable",
          "no archive",
          undefined,
          503,
        ),
      ),
    ).toEqual({ kind: "unavailable", message: "no archive" });
    // A bare 503 from the platform is the same situation to the operator.
    expect(
      classifyHistoryError(
        new ApiError("http-503", "HTTP 503", undefined, 503),
      ),
    ).toEqual({ kind: "unavailable", message: "HTTP 503" });
  });

  test("anything else is a generic failure carrying its message", () => {
    expect(
      classifyHistoryError(new ApiError("internal", "boom", undefined, 500)),
    ).toEqual({ kind: "failed", message: "boom", code: "internal" });
    expect(classifyHistoryError(new TypeError("offline"))).toEqual({
      kind: "failed",
      message: "offline",
    });
    expect(classifyHistoryError("weird")).toEqual({
      kind: "failed",
      message: "Failed to load older events",
    });
  });
});

describe("liveGap", () => {
  test("is null while the history's top edge meets the live view", () => {
    // History ends at 900; the live view starts at 901.
    expect(liveGap(900, true, 901)).toBeNull();
    // An overlap (the live view reseeded lower) is not a gap either.
    expect(liveGap(900, true, 850)).toBeNull();
  });

  test("names exactly the sequences the live view moved past", () => {
    expect(liveGap(900, true, 1101)).toEqual({ from: 901, through: 1100 });
    expect(liveGap(900, true, 902)).toEqual({ from: 901, through: 901 });
  });

  test("has nothing to compare against before history or a live row exists", () => {
    expect(liveGap(null, true, 1101)).toBeNull();
    expect(liveGap(900, true, null)).toBeNull();
    // The live view was empty when history began: its anchor was a cursor,
    // not a row, so a later first row is not evidence of a hole.
    expect(liveGap(900, false, 1101)).toBeNull();
  });
});

describe("gapWindow", () => {
  test("reads upward from the history's top edge in at most one page", () => {
    expect(gapWindow({ from: 901, through: 1100 })).toEqual({
      after: 900,
      through: 1100,
    });
    expect(gapWindow({ from: 901, through: 5000 })).toEqual({
      after: 900,
      through: 900 + HISTORY_PAGE_SPAN,
    });
  });

  test("windows tile a gap with no overlap and no hole", () => {
    let gap: { from: number; through: number } | null = {
      from: 11,
      through: 11 + 3 * HISTORY_PAGE_SPAN + 49,
    };
    const windows: { after: number; through: number }[] = [];
    while (gap) {
      const w = gapWindow(gap);
      windows.push(w);
      gap = w.through >= gap.through ? null : { ...gap, from: w.through + 1 };
    }
    expect(windows).toHaveLength(4);
    expect(windows[0].after).toBe(10);
    for (let i = 1; i < windows.length; i++)
      expect(windows[i].after).toBe(windows[i - 1].through);
    expect(windows[3].through).toBe(11 + 3 * HISTORY_PAGE_SPAN + 49);
  });

  test("the self-closing threshold is a whole number of pages", () => {
    expect(AUTO_FILL_SPAN % HISTORY_PAGE_SPAN).toBe(0);
    expect(AUTO_FILL_SPAN).toBeGreaterThanOrEqual(HISTORY_PAGE_SPAN);
  });
});
