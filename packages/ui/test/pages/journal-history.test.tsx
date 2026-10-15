import { useAuth } from "@/hooks/use-auth";
import { JournalPage } from "@/pages/journal";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { afterEach, beforeEach, vi } from "vitest";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";

// Rows are real DOM rows: the larger cases render a couple of thousand.
vi.setConfig({ testTimeout: 90000 });

const range = (from: number, through: number) =>
  Array.from({ length: through - from + 1 }, (_, i) => from + i);

type ReplayFailure = { status: number; code: string; message: string };

/**
 * An in-memory journal behind the two routes the page reads. It follows the
 * real routes' contract: `GET /journal` answers the newest live page newest
 * first without a cursor and an ascending page after one, flags a cursor below
 * the archive watermark as `archived` with no rows, and filters by `kind`;
 * `GET /journal/replay` serves any `(after, through]` window including archived
 * rows, needs the participant header and rejects bounds outside the journal.
 */
function fakeJournal(options: {
  head: number;
  watermark?: number;
  kindOf?: (seq: number) => string;
}) {
  const journal = {
    head: options.head,
    watermark: options.watermark ?? 0,
    kindOf: options.kindOf ?? (() => "entity.created"),
    replayError: null as ReplayFailure | null,
    replayDelayMs: 0,
    list: [] as { after: number | null; kind: string | null }[],
    replay: [] as {
      after: number;
      through: number;
      limit: number;
      participant: string | null;
      params: string[];
    }[],
  };
  const eventAt = (seq: number) => ({
    seq,
    t: Date.now() - 1000,
    kind: journal.kindOf(seq),
    resource: `task-${seq}`,
    principal_id: "test:test-user",
    participant_id: "participant-1",
    environment: { client_name: "cli", client_version: "0.4.2" },
    token_id: null,
    fence: null,
    data: {},
  });

  server.use(
    http.get("*/projects/*/journal/replay", async ({ request }) => {
      const params = new URL(request.url).searchParams;
      const after = Number(params.get("after_seq"));
      const through = params.has("through_seq")
        ? Number(params.get("through_seq"))
        : journal.head;
      const limit = Number(params.get("limit") ?? 100);
      journal.replay.push({
        after,
        through,
        limit,
        participant: request.headers.get("X-Tila-Participant-Id"),
        params: [...params.keys()].sort(),
      });
      if (journal.replayDelayMs) await delay(journal.replayDelayMs);
      if (!request.headers.get("X-Tila-Participant-Id")) {
        return HttpResponse.json(
          {
            ok: false,
            error: {
              code: "participant-required",
              message: "X-Tila-Participant-Id is required",
              retryable: false,
            },
          },
          { status: 400 },
        );
      }
      if (journal.replayError) {
        const { status, code, message } = journal.replayError;
        return HttpResponse.json(
          { ok: false, error: { code, message, retryable: status === 503 } },
          { status },
        );
      }
      if (through > journal.head || after > through) {
        return HttpResponse.json(
          {
            ok: false,
            error: {
              code: "invalid-cursor",
              message: "Replay bounds must satisfy after_seq <= through_seq",
              retryable: false,
            },
          },
          { status: 400 },
        );
      }
      const pageThrough = after + Math.min(limit, through - after);
      return HttpResponse.json({
        ok: true,
        events: range(after + 1, pageThrough).map(eventAt),
        next_after_seq: pageThrough,
        through_seq: through,
        has_more: pageThrough < through,
      });
    }),
    http.get("*/projects/*/journal", ({ request }) => {
      const params = new URL(request.url).searchParams;
      const after = params.has("after_seq")
        ? Number(params.get("after_seq"))
        : null;
      const kinds = params.get("kind")?.split(",") ?? null;
      const limit = Number(params.get("limit") ?? 100);
      journal.list.push({ after, kind: params.get("kind") });
      const matches = (seq: number) =>
        kinds === null || kinds.includes(journal.kindOf(seq));
      const lastArchivedSeq = journal.watermark > 0 ? journal.watermark : null;
      if (after === null) {
        const events = [];
        for (
          let seq = journal.head;
          seq > journal.watermark && events.length < limit;
          seq--
        )
          if (matches(seq)) events.push(eventAt(seq));
        return HttpResponse.json({
          ok: true,
          events,
          archived: false,
          lastArchivedSeq,
        });
      }
      if (after < journal.watermark) {
        return HttpResponse.json({
          ok: true,
          events: [],
          archived: true,
          lastArchivedSeq,
        });
      }
      const events = [];
      for (
        let seq = after + 1;
        seq <= journal.head && events.length < limit;
        seq++
      )
        if (matches(seq)) events.push(eventAt(seq));
      return HttpResponse.json({
        ok: true,
        events,
        archived: false,
        lastArchivedSeq,
      });
    }),
  );
  return journal;
}

/** Sequence numbers of every rendered row, in document order. */
const seqsShown = () =>
  Array.from(document.querySelectorAll("tbody tr > td:first-child"))
    .map((cell) => cell.textContent ?? "")
    .filter((text) => /^#\d+$/.test(text))
    .map((text) => Number(text.slice(1)));

// A replay page can take longer than Testing Library's one-second default to
// render when the full package suite runs in parallel. Wait for the completed
// row count, then verify every sequence once so a real hole still fails.
async function expectRenderedRange(from: number, through: number) {
  await waitFor(() => expect(seqsShown()).toHaveLength(through - from + 1), {
    timeout: 15_000,
  });
  expect(seqsShown()).toEqual(range(from, through));
}

const loadOlderButton = () =>
  screen.getByRole("button", { name: "Load older" });
const noLoadOlder = () =>
  expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
const tailPolls = (journal: ReturnType<typeof fakeJournal>) =>
  journal.list.filter((call) => call.after !== null);

/** One scheduled tail poll. Only the poll timer is faked. */
const pollOnce = () => vi.advanceTimersByTime(3000);

/** Fire one poll and wait until the server has answered it. */
async function settlePoll(journal: ReturnType<typeof fakeJournal>) {
  const before = journal.list.length;
  pollOnce();
  await vi.waitFor(() => expect(journal.list.length).toBeGreaterThan(before));
  // Let the answer be applied: anything a poll could trigger has had its turn.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
  // Own the 3s tail poll: it fires only when a test advances it, so every
  // read in a test is either the mount read, a followed full page, or ours.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("JournalPage older history", () => {
  describe("reaching the start", () => {
    test("repeated Load older reaches the first event of a >1000 event journal, leaving the tail cursor alone", async () => {
      const journal = fakeJournal({ head: 1250 });
      const user = userEvent.setup();
      renderWithProviders(<JournalPage />);
      await waitFor(() => expect(seqsShown()).toEqual(range(1151, 1250)));

      for (const first of [951, 751, 551, 351, 151, 1]) {
        await user.click(loadOlderButton());
        await waitFor(() => expect(seqsShown()[0]).toBe(first));
      }

      // 1250 rows: more than the live tail's 500-row cap could ever hold.
      expect(seqsShown()).toEqual(range(1, 1250));
      noLoadOlder();
      expect(screen.getByText(/Reached the first event/)).toBeInTheDocument();
      expect(
        screen.getByText(/Scanned 1,150 sequences back to #1\b/),
      ).toBeInTheDocument();
      // Whole replay windows, newest first, no gap and no overlap, each one
      // carrying the participant header replay requires.
      expect(journal.replay.map((r) => [r.after, r.through])).toEqual([
        [950, 1150],
        [750, 950],
        [550, 750],
        [350, 550],
        [150, 350],
        [0, 150],
      ]);
      expect(journal.replay.every((r) => r.participant)).toBe(true);

      // The tail keeps polling from where it was: older loads moved nothing,
      // and a poll neither re-adds nor prunes what history holds.
      await settlePoll(journal);
      expect(new Set(tailPolls(journal).map((call) => call.after))).toEqual(
        new Set([1250]),
      );
      expect(seqsShown()).toEqual(range(1, 1250));
    });

    test("archived events load through replay, in sequence order", async () => {
      // 1-300 live in cold storage: the list answers "archived", no rows.
      const journal = fakeJournal({ head: 450, watermark: 300 });
      const user = userEvent.setup();
      renderWithProviders(<JournalPage />);
      await waitFor(() => expect(seqsShown()).toEqual(range(351, 450)));

      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(151));
      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(1));

      expect(seqsShown()).toEqual(range(1, 450));
      // History never went through the list, which would have said "archived".
      expect(
        journal.list.every((call) => call.after === null || call.after >= 300),
      ).toBe(true);
      expect(journal.replay.map((r) => [r.after, r.through])).toEqual([
        [150, 350],
        [0, 150],
      ]);
    });

    test("an entirely archived journal still opens: the live view is empty", async () => {
      const journal = fakeJournal({ head: 500, watermark: 500 });
      const user = userEvent.setup();
      renderWithProviders(<JournalPage />);
      // The tail skips past the archive and settles on its watermark.
      await vi.waitFor(() =>
        expect(journal.list.some((call) => call.after === 500)).toBe(true),
      );
      await user.click(
        await screen.findByRole("button", { name: "Load older" }),
      );
      await waitFor(() => expect(seqsShown()).toEqual(range(301, 500)));
      expect(journal.replay.map((r) => [r.after, r.through])).toEqual([
        [300, 500],
      ]);

      // The first live row continues straight on from history: no false gap.
      journal.head = 501;
      pollOnce();
      await waitFor(() => expect(seqsShown()).toEqual(range(301, 501)));
      expect(screen.queryByText(/sit between this history/)).toBeNull();
    });
  });

  describe("filters", () => {
    const claimEvery5th = (seq: number) =>
      seq % 5 === 0 ? "claim.acquired" : "entity.created";

    test("filters apply to loaded older rows and the control states what was scanned", async () => {
      const journal = fakeJournal({ head: 1000, kindOf: claimEvery5th });
      const user = userEvent.setup();
      renderWithProviders(<JournalPage />, {
        route: "/?kind=claim.acquired",
      });
      // The tail is filtered server-side: the newest 100 claims, 505..1000.
      await waitFor(() => expect(seqsShown()[0]).toBe(505));
      expect(seqsShown()).toHaveLength(100);

      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(305));
      // 200 sequences scanned (305..504); only the 40 claims among them kept.
      expect(seqsShown().slice(0, 40)).toEqual(
        range(305, 500).filter((seq) => seq % 5 === 0),
      );
      expect(screen.queryByText("entity.created")).toBeNull();
      expect(
        screen.getByText(
          /Scanned 200 sequences back to #305 · 40 match the active filters/,
        ),
      ).toBeInTheDocument();
      // Replay itself was asked for nothing but the window.
      expect(journal.replay[0].params).toEqual([
        "after_seq",
        "limit",
        "through_seq",
      ]);

      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(105));
      expect(
        screen.getByText(
          /Scanned 400 sequences back to #105 · 80 match the active filters/,
        ),
      ).toBeInTheDocument();
    });

    test("changing a filter starts a fresh history instead of reinterpreting old rows", async () => {
      fakeJournal({ head: 1000, kindOf: claimEvery5th });
      const user = userEvent.setup();
      renderWithProviders(<JournalPage />, {
        route: "/?kind=claim.acquired",
      });
      await waitFor(() => expect(seqsShown()[0]).toBe(505));
      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(305));

      await user.click(
        screen.getByRole("button", {
          name: "Remove kind filter: claim.acquired",
        }),
      );

      // The tail reseeds unfiltered; nothing of the filtered history lingers.
      await waitFor(() => expect(seqsShown()).toEqual(range(901, 1000)));
      expect(
        screen.getByText(/Reads events older than the live view/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Clear history" }),
      ).toBeNull();
    });
  });

  describe("the live tail's moving boundary", () => {
    test("repeated polls that prune the tail never open a hole under it or lose a row", async () => {
      const journal = fakeJournal({ head: 1000 });
      const user = userEvent.setup();
      renderWithProviders(<JournalPage />);
      await waitFor(() => expect(seqsShown()).toEqual(range(901, 1000)));
      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()).toEqual(range(701, 1000)));

      // +400 events: the tail grows to its cap (500), nothing pruned yet.
      journal.head = 1400;
      pollOnce();
      await expectRenderedRange(701, 1400);

      // +400 more: the tail prunes 100 rows at a time, its first row climbing
      // from 901 to 1301. Those rows must move to history, not vanish.
      journal.head = 1800;
      pollOnce();
      await expectRenderedRange(701, 1800);

      // And again, from the new boundary.
      journal.head = 2200;
      pollOnce();
      await expectRenderedRange(701, 2200);

      expect(screen.queryByText(/sit between this history/)).toBeNull();
      // Every request after the first older page only extended the top edge
      // upward from where the history ended, window by window.
      const windows = journal.replay
        .map((r) => [r.after, r.through])
        .sort((a, b) => a[0] - b[0]);
      expect(windows[0]).toEqual([700, 900]);
      for (let i = 1; i < windows.length; i++)
        expect(windows[i][0]).toBe(windows[i - 1][1]);
      expect(windows.at(-1)?.[1]).toBeGreaterThanOrEqual(1700);

      // The tail cursor only ever moved forward, from where the tail was
      // seeded to the head: no older load or fill ever pulled it back.
      const cursors = tailPolls(journal).map((call) => call.after as number);
      expect([...cursors].sort((a, b) => a - b)).toEqual(cursors);
      expect(Math.min(...cursors)).toBe(1000);
      expect(Math.max(...cursors)).toBeGreaterThanOrEqual(2100);

      // The bottom edge is untouched by all of it: Load older continues
      // exactly below what was loaded first.
      await user.click(loadOlderButton());
      await expectRenderedRange(501, 2200);
      expect(journal.replay.at(-1)).toMatchObject({ after: 500, through: 700 });
    });

    test("a gap too large to close unasked is named and closed on request, then finishes itself", async () => {
      const journal = fakeJournal({ head: 1000 });
      const user = userEvent.setup();
      const { queryClient } = renderWithProviders(<JournalPage />);
      await waitFor(() => expect(seqsShown()).toEqual(range(901, 1000)));
      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()).toEqual(range(701, 1000)));

      // Reseeding the live view jumps its first row 1500 sequences at once:
      // more than is read without being asked.
      journal.head = 2500;
      await queryClient.invalidateQueries({ queryKey: ["journal-initial"] });
      await waitFor(() =>
        expect(seqsShown()).toEqual([...range(701, 900), ...range(2401, 2500)]),
      );
      expect(
        screen.getByText(/Sequences #901 to #2,400 sit between this history/),
      ).toBeInTheDocument();
      expect(journal.replay).toHaveLength(1); // Nothing read for it unasked.

      const loadTrimmed = () =>
        user.click(screen.getByRole("button", { name: "Load trimmed events" }));
      await loadTrimmed(); // 1500 left -> 1300
      await waitFor(() => expect(seqsShown()[200]).toBe(901));
      expect(
        screen.getByText(/Sequences #1,101 to #2,400 sit between/),
      ).toBeInTheDocument();
      await loadTrimmed(); // 1300 -> 1100: still more than is read unasked
      expect(
        await screen.findByText(/Sequences #1,301 to #2,400 sit between/),
      ).toBeInTheDocument();
      expect(journal.replay).toHaveLength(3);

      // 1100 -> 900: now within what closes on its own, so the rest does.
      await loadTrimmed();
      await expectRenderedRange(701, 2500);
      expect(screen.queryByText(/sit between this history/)).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Load trimmed events" }),
      ).toBeNull();

      // Every window picked up exactly where the previous one ended.
      const windows = journal.replay
        .map((r) => [r.after, r.through])
        .sort((a, b) => a[0] - b[0]);
      expect(windows[0]).toEqual([700, 900]);
      for (let i = 1; i < windows.length; i++)
        expect(windows[i][0]).toBe(windows[i - 1][1]);
      expect(windows.at(-1)?.[1]).toBe(2400);
    });
  });

  describe("failures stay inline and leave the tail alone", () => {
    async function openWithFailure(failure: ReplayFailure) {
      const journal = fakeJournal({ head: 1000 });
      journal.replayError = failure;
      const user = userEvent.setup();
      const view = renderWithProviders(<JournalPage />);
      await waitFor(() => expect(seqsShown()).toEqual(range(901, 1000)));
      await user.click(loadOlderButton());
      return { journal, user, ...view };
    }

    async function tailStillLive(journal: ReturnType<typeof fakeJournal>) {
      journal.head += 1;
      await settlePoll(journal);
      await waitFor(() => expect(seqsShown().at(-1)).toBe(journal.head));
    }

    test("history unavailable (503) explains itself, keeps the tail live and retries on request", async () => {
      const { journal, user } = await openWithFailure({
        status: 503,
        code: "journal-history-unavailable",
        message: "Unable to read complete journal archives",
      });

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/Older history is unavailable/);
      expect(alert).toHaveTextContent(/live tail is unaffected/);
      await tailStillLive(journal);
      expect(screen.getByRole("alert")).toBeInTheDocument();
      // No retry loop: one request, however long it sits there.
      await settlePoll(journal);
      expect(journal.replay).toHaveLength(1);

      journal.replayError = null;
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(seqsShown()[0]).toBe(701));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(journal.replay).toHaveLength(2);
      expect(journal.replay[1]).toMatchObject({ after: 700, through: 900 });
    });

    test("an invalid cursor is never retried: restarting history is the only way on", async () => {
      const { journal, user } = await openWithFailure({
        status: 400,
        code: "invalid-cursor",
        message: "Replay bounds must satisfy after_seq <= through_seq",
      });

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /no longer valid/,
      );
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      await tailStillLive(journal);
      await settlePoll(journal);
      expect(journal.replay).toHaveLength(1);

      journal.replayError = null;
      await user.click(screen.getByRole("button", { name: "Restart history" }));
      expect(screen.queryByRole("alert")).toBeNull();
      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(701));
    });

    test("a credential without journal read degrades to a notice, not a retry loop", async () => {
      const { journal } = await openWithFailure({
        status: 403,
        code: "permission-denied",
        message: "Credential does not permit this operation or resource",
      });

      expect(
        await screen.findByTestId("journal-history-restricted"),
      ).toHaveTextContent(/needs journal read access/);
      noLoadOlder();
      expect(screen.queryByRole("alert")).toBeNull();
      await tailStillLive(journal);
      await settlePoll(journal);
      await settlePoll(journal);
      expect(journal.replay).toHaveLength(1);
    });

    test("the restricted finding can be re-checked by hand, and no remount is needed", async () => {
      const { journal, user } = await openWithFailure({
        status: 403,
        code: "permission-denied",
        message: "Credential does not permit this operation or resource",
      });
      await screen.findByTestId("journal-history-restricted");
      const tailRow = screen.getByText("#1000");

      // Access was granted meanwhile (new role, rotated token).
      journal.replayError = null;
      await user.click(
        screen.getByRole("button", { name: "Check access again" }),
      );

      await waitFor(() => expect(seqsShown()[0]).toBe(701));
      expect(screen.queryByTestId("journal-history-restricted")).toBeNull();
      expect(screen.getByText("#1000")).toBe(tailRow);
    });

    test("a fresh session snapshot clears the restricted finding for the same project", async () => {
      const journal = fakeJournal({ head: 1000 });
      journal.replayError = {
        status: 403,
        code: "permission-denied",
        message: "Credential does not permit this operation or resource",
      };
      const user = userEvent.setup();
      // Step-up and project re-selection re-read the session in place: the
      // page stays mounted and the project id is unchanged.
      function RefreshSession() {
        const { refreshStatus } = useAuth();
        return (
          <button type="button" onClick={() => void refreshStatus()}>
            Refresh session
          </button>
        );
      }
      renderWithProviders(
        <>
          <RefreshSession />
          <JournalPage />
        </>,
      );
      await waitFor(() => expect(seqsShown()).toEqual(range(901, 1000)));
      await user.click(loadOlderButton());
      await screen.findByTestId("journal-history-restricted");
      const tailRow = screen.getByText("#1000");

      journal.replayError = null;
      await user.click(screen.getByRole("button", { name: "Refresh session" }));

      // Back to "unknown": the button is offered again, nothing was asked yet.
      await screen.findByRole("button", { name: "Load older" });
      expect(screen.queryByTestId("journal-history-restricted")).toBeNull();
      expect(journal.replay).toHaveLength(1);
      expect(screen.getByText("#1000")).toBe(tailRow);
      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(701));
    });
  });

  describe("the bounded buffer", () => {
    test("clearing drops only history and the next load starts again from the live view", async () => {
      const journal = fakeJournal({ head: 1000 });
      const user = userEvent.setup();
      renderWithProviders(<JournalPage />);
      await waitFor(() => expect(seqsShown()).toEqual(range(901, 1000)));
      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(701));
      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(501));

      await user.click(screen.getByRole("button", { name: "Clear history" }));

      expect(seqsShown()).toEqual(range(901, 1000));
      expect(
        screen.getByText(/Reads events older than the live view/),
      ).toBeInTheDocument();
      await user.click(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(701));
      expect(journal.replay.at(-1)).toMatchObject({ after: 700, through: 900 });
    });

    test("at capacity loading stops visibly instead of evicting rows, and clearing makes room", async () => {
      const journal = fakeJournal({ head: 2300 });
      const user = userEvent.setup();
      renderWithProviders(<JournalPage />);
      await waitFor(() => expect(seqsShown()).toEqual(range(2201, 2300)));

      for (let page = 1; page <= 10; page++) {
        await user.click(loadOlderButton());
        await waitFor(() => expect(seqsShown()[0]).toBe(2201 - 200 * page));
      }

      // 2000 rows held, none lost, and no way to load past the cap by accident.
      expect(seqsShown()).toEqual(range(201, 2300));
      noLoadOlder();
      expect(
        screen.getByText(/Buffer full at 2,000 events/),
      ).toBeInTheDocument();
      expect(journal.replay).toHaveLength(10);

      await user.click(screen.getByRole("button", { name: "Clear history" }));
      expect(seqsShown()).toEqual(range(2201, 2300));
      expect(loadOlderButton()).toBeEnabled();
    });

    test("a second click while a read is in flight does not issue a second read", async () => {
      const journal = fakeJournal({ head: 1000 });
      journal.replayDelayMs = 150;
      const user = userEvent.setup();
      renderWithProviders(<JournalPage />);
      await waitFor(() => expect(seqsShown()).toEqual(range(901, 1000)));

      await user.dblClick(loadOlderButton());
      await waitFor(() => expect(seqsShown()[0]).toBe(701));

      expect(journal.replay).toHaveLength(1);
    });
  });
});
