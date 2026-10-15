import { ProjectReportDetails } from "@/components/journal-report";
import { JournalPage } from "@/pages/journal";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, test, vi } from "vitest";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";

vi.setConfig({ testTimeout: 20000 });

const LIVE = 118;
const REPLAYED = 5;
const PLAIN = 119;

const reportData = (payload: unknown, outer: Record<string, unknown> = {}) => ({
  event_name: "pipeline.tests_passed",
  event_version: 1,
  target: { kind: "project" },
  correlation_id: "run-1",
  occurred_at: "2026-10-15T12:00:00Z",
  ...outer,
  data: payload,
});

const MARKDOWN_PAYLOAD = {
  summary:
    "# Build ok\n\n- unit **passed**\n- see [the run](https://ci.example/run/1)\n\n```sh\npnpm test\n```",
  attempts: 3,
  ok: true,
  nested: { notes: "<script>alert(1)</script>", steps: ["build", "test"] },
};

const HOSTILE_PAYLOAD = {
  a: '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned=1">',
  b: "[click](javascript:window.__pwned=1) [data](data:text/html;base64,PHNjcmlwdD4=)",
  c: '<svg onload="window.__pwned=1"></svg>\n\n<div style="position:fixed;inset:0">overlay</div>\n\n<style>body{display:none}</style>\n\n<form action="https://evil.example"><input name=t></form>',
  d: "![pixel](https://tracker.example/p.png)",
  e: '```x"onmouseover="window.__pwned=1\ncode\n```',
};

/**
 * A journal with `head` events. `reports` maps a sequence to the report data
 * it carries; every other event is an `entity.created`. Live reads answer the
 * newest page (newest first, then ascending after a cursor); replay serves any
 * `(after, through]` window, which is how older history reaches the table.
 */
function fakeJournal(head: number, reports: Record<number, unknown>) {
  const log = {
    list: [] as URLSearchParams[],
    replay: [] as { after: number; through: number }[],
  };
  const eventAt = (seq: number) => ({
    seq,
    t: Date.now() - 1000,
    kind: seq in reports ? "custom.reported" : "entity.created",
    resource: seq in reports ? "project:test" : `entity:e-${seq}`,
    principal_id: "test:test-user",
    participant_id: "participant-1",
    environment: { client_name: "cli", client_version: "0.4.2" },
    token_id: null,
    fence: null,
    data: seq in reports ? reports[seq] : { type: "task" },
  });
  server.use(
    http.get("*/projects/*/journal/replay", ({ request }) => {
      const params = new URL(request.url).searchParams;
      const after = Number(params.get("after_seq"));
      const through = Number(params.get("through_seq") ?? head);
      const limit = Number(params.get("limit") ?? 100);
      log.replay.push({ after, through });
      const last = after + Math.min(limit, through - after);
      const events = [];
      for (let seq = after + 1; seq <= last; seq++) events.push(eventAt(seq));
      return HttpResponse.json({
        ok: true,
        events,
        next_after_seq: last,
        through_seq: through,
        has_more: last < through,
      });
    }),
    http.get("*/projects/*/journal", ({ request }) => {
      const params = new URL(request.url).searchParams;
      log.list.push(params);
      const limit = Number(params.get("limit") ?? 100);
      const events = [];
      if (params.has("after_seq")) {
        for (
          let seq = Number(params.get("after_seq")) + 1;
          seq <= head && events.length < limit;
          seq++
        )
          events.push(eventAt(seq));
      } else {
        for (let seq = head; seq > 0 && events.length < limit; seq--)
          events.push(eventAt(seq));
      }
      return HttpResponse.json({
        ok: true,
        events,
        archived: false,
        lastArchivedSeq: null,
      });
    }),
  );
  return log;
}

const reportText = (seq: number) =>
  screen.getByRole("region", { name: `Report text for event #${seq}` });

/** The raw-data rows: `<pre>` blocks that are not inside report text. */
const rawJson = () =>
  [...document.querySelectorAll("tbody pre")]
    .filter((pre) => !pre.closest("section"))
    .map((pre) => pre.textContent);

async function loadOlder(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Load older" }));
  await screen.findByText(`#${REPLAYED}`);
}

describe("journal report text", () => {
  test("renders headings, lists, links and code from report string fields", async () => {
    fakeJournal(120, { [LIVE]: reportData(MARKDOWN_PAYLOAD) });
    renderWithProviders(<JournalPage />);
    await screen.findByText(`#${LIVE}`);

    const text = reportText(LIVE);
    expect(within(text).getByText("summary")).toBeInTheDocument();
    expect(
      within(text).getByRole("heading", { level: 1, name: "Build ok" }),
    ).toBeInTheDocument();
    expect(within(text).getAllByRole("listitem")).toHaveLength(2);
    expect(within(text).getByText("passed").tagName).toBe("STRONG");
    const link = within(text).getByRole("link", { name: "the run" });
    expect(link).toHaveAttribute("href", "https://ci.example/run/1");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    const code = text.querySelector("pre code");
    expect(code?.textContent?.trim()).toBe("pnpm test");
  });

  test("shows non-string and nested fields as literal text instead of dropping them", async () => {
    fakeJournal(120, { [LIVE]: reportData(MARKDOWN_PAYLOAD) });
    renderWithProviders(<JournalPage />);
    await screen.findByText(`#${LIVE}`);

    const text = reportText(LIVE);
    for (const label of ["attempts", "ok", "nested"])
      expect(within(text).getByText(label)).toBeInTheDocument();
    const literals = [...text.querySelectorAll("pre")].map(
      (pre) => pre.textContent ?? "",
    );
    // The markdown field is a code block too; the literals are the JSON ones.
    expect(literals).toContain("3");
    expect(literals).toContain("true");
    const nested = literals.find((value) => value.includes("notes"));
    expect(JSON.parse(nested ?? "{}")).toEqual(MARKDOWN_PAYLOAD.nested);
    // A string nested inside a value is shown, but is never markup.
    expect(text.querySelector("script")).toBeNull();
    expect(text.textContent).toContain("<script>alert(1)</script>");
  });

  test("presents replay-loaded rows exactly as live rows", async () => {
    const user = userEvent.setup();
    fakeJournal(120, {
      [LIVE]: reportData(MARKDOWN_PAYLOAD),
      [REPLAYED]: reportData(MARKDOWN_PAYLOAD),
    });
    renderWithProviders(<JournalPage />);
    await screen.findByText(`#${LIVE}`);
    expect(screen.queryByText(`#${REPLAYED}`)).toBeNull();

    await loadOlder(user);

    const live = reportText(LIVE);
    const replayed = reportText(REPLAYED);
    expect(replayed).not.toBe(live);
    expect(replayed.innerHTML).toBe(live.innerHTML);
    expect(replayed.innerHTML).toContain("<h1>Build ok</h1>");
    // The report metadata cell is the same too: only seq and time differ.
    const kindCell = (seq: number) =>
      (screen.getByText(`#${seq}`).closest("tr") as HTMLTableRowElement)
        .cells[2];
    expect(kindCell(REPLAYED).innerHTML).toBe(kindCell(LIVE).innerHTML);
    expect(kindCell(LIVE).textContent).toContain("Project report");
  });

  test("keeps raw JSON available on request, escaped and unrendered", async () => {
    const user = userEvent.setup();
    const data = reportData(MARKDOWN_PAYLOAD);
    fakeJournal(120, { [LIVE]: data, [REPLAYED]: data });
    renderWithProviders(<JournalPage />);
    await screen.findByText(`#${LIVE}`);
    await loadOlder(user);

    for (const seq of [LIVE, REPLAYED]) {
      const toggle = screen.getByRole("button", {
        name: `Toggle data for event #${seq}`,
      });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
    }

    // Both raw views are the full event data, verbatim: markdown source and
    // markup characters stay characters, nothing is interpreted.
    const raw = rawJson();
    expect(raw).toEqual([
      JSON.stringify(data, null, 2),
      JSON.stringify(data, null, 2),
    ]);
    expect(raw[0]).toContain("# Build ok");
    expect(raw[0]).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: `Toggle data for event #${LIVE}` }),
    );
    expect(rawJson()).toHaveLength(1);
  });

  test("never builds unsafe DOM from hostile report text, live or replayed", async () => {
    const user = userEvent.setup();
    fakeJournal(120, {
      [LIVE]: reportData(HOSTILE_PAYLOAD),
      [REPLAYED]: reportData(HOSTILE_PAYLOAD),
    });
    renderWithProviders(<JournalPage />);
    await screen.findByText(`#${LIVE}`);
    await loadOlder(user);

    for (const seq of [LIVE, REPLAYED]) {
      const region = reportText(seq);
      expect(
        region.querySelectorAll(
          "script, style, img, svg, iframe, form, input, button, object, embed, link, meta",
        ),
      ).toHaveLength(0);
      for (const el of region.querySelectorAll("*")) {
        for (const name of el.getAttributeNames()) {
          expect(name.startsWith("on")).toBe(false);
          expect(name).not.toBe("style");
        }
      }
      for (const anchor of region.querySelectorAll("a[href]")) {
        const href = anchor.getAttribute("href") ?? "";
        expect(["https:", "mailto:"]).toContain(
          new URL(href, "https://app.example/").protocol,
        );
      }
      // The caller's markup is still there for the reader: as text.
      expect(region.textContent).toContain(
        "<script>window.__pwned = 1</script>",
      );
      expect(region.textContent).toContain('<svg onload="window.__pwned=1">');
      expect(region.textContent).toContain("[image: pixel]");
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  test("leaves other events, report metadata and the data toggle alone", async () => {
    const user = userEvent.setup();
    fakeJournal(120, { [LIVE]: reportData(MARKDOWN_PAYLOAD) });
    renderWithProviders(<JournalPage />);
    await screen.findByText(`#${LIVE}`);

    // Report metadata still renders in the kind cell, from the outer fields.
    const reportRow = screen.getByText(`#${LIVE}`).closest("tr") as HTMLElement;
    expect(within(reportRow).getByText("Project report")).toBeInTheDocument();
    expect(within(reportRow).getByText("pipeline.tests_passed")).toBeVisible();
    expect(within(reportRow).getByText("v1")).toBeInTheDocument();
    expect(
      within(reportRow).getByText("Correlation: run-1"),
    ).toBeInTheDocument();
    expect(within(reportRow).getByText(/Reporter:/)).toBeInTheDocument();
    // The outer metadata is not repeated as prose in the report text.
    expect(reportText(LIVE).textContent).not.toContain("Correlation");
    expect(reportText(LIVE).textContent).not.toContain("event_name");

    // A non-report event keeps its badge, link and raw toggle, and gains no
    // report text region.
    const plainRow = screen.getByText(`#${PLAIN}`).closest("tr") as HTMLElement;
    expect(within(plainRow).getByText("entity.created")).toBeInTheDocument();
    expect(
      within(plainRow).getByRole("link", { name: `entity:e-${PLAIN}` }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", {
        name: `Report text for event #${PLAIN}`,
      }),
    ).toBeNull();
    expect(screen.getAllByRole("region")).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: `Toggle data for event #${PLAIN}` }),
    );
    expect(rawJson()).toEqual([JSON.stringify({ type: "task" }, null, 2)]);
  });

  test("keeps filters and older-history paging working around report rows", async () => {
    const user = userEvent.setup();
    const log = fakeJournal(120, {
      [LIVE]: reportData(MARKDOWN_PAYLOAD),
      [REPLAYED]: reportData(MARKDOWN_PAYLOAD),
    });
    renderWithProviders(<JournalPage />);
    await screen.findByText(`#${LIVE}`);
    await loadOlder(user);

    // History below the live view, reports and plain rows in sequence order.
    const seqs = [...document.querySelectorAll("tbody tr > td:first-child")]
      .map((cell) => cell.textContent ?? "")
      .filter((text) => /^#\d+$/.test(text))
      .map((text) => Number(text.slice(1)));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(1);
    expect(seqs.at(-1)).toBe(120);
    expect(log.replay).toEqual([{ after: 0, through: 20 }]);

    await user.type(
      screen.getByLabelText("Filter journal by event name"),
      "pipeline.tests_passed",
    );
    await waitFor(() =>
      expect(
        log.list.some((q) => q.get("event_name") === "pipeline.tests_passed"),
      ).toBe(true),
    );
  });

  test("keeps the shared report details metadata-only for task history", () => {
    renderWithProviders(
      <ProjectReportDetails
        data={reportData(MARKDOWN_PAYLOAD)}
        projectId="test"
      />,
    );
    expect(screen.getByText("Project report")).toBeInTheDocument();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByText("Build ok")).toBeNull();
    expect(screen.queryByText("summary")).toBeNull();
  });
});
