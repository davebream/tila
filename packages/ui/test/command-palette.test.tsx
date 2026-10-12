import { CommandPalette } from "@/components/ui/command-palette";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { type Location, useLocation } from "react-router";
import { server } from "./mocks/server";
import { makeTask, pagedTasksHandler, searchHandler } from "./mocks/tasks";
import { renderWithProviders, screen, waitFor, within } from "./test-utils";

let currentLocation: Location;

function LocationProbe() {
  currentLocation = useLocation();
  return null;
}

// Harness that drives open/close state so onOpenChange works
function PaletteHarness({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <CommandPalette open={open} onClose={() => setOpen(false)} />
      <LocationProbe />
    </>
  );
}

function captureTaskLists() {
  const requests: URLSearchParams[] = [];
  server.use(
    pagedTasksHandler(
      [
        makeTask("recent-1", { data: { title: "Most recent task" } }),
        makeTask("recent-2"),
      ],
      { onRequest: (p) => requests.push(p) },
    ),
  );
  return requests;
}

function captureSearches(
  hits = [
    {
      entity_id: "task-999",
      entity_type: "epic",
      name: "Deploy pipeline",
      snippet: null,
    },
  ],
) {
  const searches: URLSearchParams[] = [];
  server.use(searchHandler(hits, { onRequest: (p) => searches.push(p) }));
  return searches;
}

describe("CommandPalette", () => {
  test("an empty query lists recently updated tasks from the full list", async () => {
    const requests = captureTaskLists();
    renderWithProviders(<PaletteHarness />);

    expect(await screen.findByText("Most recent task")).toBeInTheDocument();
    expect(screen.getByText("recent-2")).toBeInTheDocument();
    const request = requests.at(-1);
    expect(request?.get("limit")).toBe("10");
    expect(request?.get("sort")).toBe("updated_at");
    expect(request?.get("order")).toBe("desc");
    expect(request?.get("archived")).toBe("0");
    expect(requests.some((p) => p.has("compact"))).toBe(false);
  });

  test("searches the server after a debounce and offers a full search", async () => {
    const user = userEvent.setup();
    const searches = captureSearches();
    renderWithProviders(<PaletteHarness />);

    await user.type(await screen.findByRole("combobox"), "dep");

    expect(await screen.findByText("Deploy pipeline")).toBeInTheDocument();
    // One debounced request for the settled query, not one per keystroke.
    expect(searches.map((p) => p.get("q"))).toEqual(["dep"]);
    const request = searches[0];
    expect(request.get("kind")).toBe("task");
    expect(request.get("syntax")).toBe("literal");
    expect(request.get("limit")).toBe("20");

    const option = screen.getByRole("option", { name: /Deploy pipeline/ });
    expect(within(option).getByText("task-999")).toBeInTheDocument();
    expect(within(option).getByText("epic")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Search all tasks for “dep”/ }),
    ).toBeInTheDocument();
  });

  test("Enter opens a matching task that is not on the first list page", async () => {
    const user = userEvent.setup();
    captureSearches();
    renderWithProviders(<PaletteHarness />, { route: "/p/test-project/rooms" });

    await user.type(await screen.findByRole("combobox"), "deploy");
    await screen.findByText("Deploy pipeline");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(currentLocation.pathname).toBe("/p/test-project/tasks/task-999"),
    );
  });

  test("Search all tasks opens the tasks page with the query", async () => {
    const user = userEvent.setup();
    captureSearches();
    renderWithProviders(<PaletteHarness />);

    await user.type(await screen.findByRole("combobox"), "deploy");
    await user.click(
      await screen.findByRole("option", { name: /Search all tasks/ }),
    );

    await waitFor(() =>
      expect(currentLocation.pathname).toBe("/p/test-project/tasks"),
    );
    expect(currentLocation.search).toBe("?q=deploy");
  });

  test("works for a namespace-restricted credential without compact listing", async () => {
    const user = userEvent.setup();
    const requests: URLSearchParams[] = [];
    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        const params = new URL(request.url).searchParams;
        requests.push(params);
        if (params.has("compact")) {
          return HttpResponse.json(
            { ok: false, error: { code: "forbidden", message: "denied" } },
            { status: 403 },
          );
        }
        return HttpResponse.json({
          ok: true,
          entities: [makeTask("scoped-1")],
          total: 1,
          limit: 10,
          offset: 0,
          has_more: false,
          next_cursor: null,
          scope: { restricted: true, archived: "excluded" },
        });
      }),
    );
    captureSearches();
    renderWithProviders(<PaletteHarness />);

    expect(await screen.findByText("scoped-1")).toBeInTheDocument();
    await user.type(screen.getByRole("combobox"), "deploy");
    expect(await screen.findByText("Deploy pipeline")).toBeInTheDocument();
    expect(requests.some((p) => p.has("compact"))).toBe(false);
  });

  test("a failed search offers Retry", async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(
      http.get("*/projects/*/search", () =>
        fail
          ? HttpResponse.json(
              { ok: false, error: { code: "internal", message: "boom" } },
              { status: 500 },
            )
          : HttpResponse.json({
              ok: true,
              results: [
                {
                  type: "entity",
                  entity_id: "task-1",
                  entity_type: "task",
                  name: "Recovered",
                  snippet: null,
                  indexed_at: 1,
                },
              ],
              total: 1,
              next_cursor: null,
            }),
      ),
    );
    renderWithProviders(<PaletteHarness />);

    await user.type(await screen.findByRole("combobox"), "rec");
    expect(await screen.findByText("Search unavailable")).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Recovered")).toBeInTheDocument();
    expect(screen.queryByText("Search unavailable")).not.toBeInTheDocument();
  });

  test("a forbidden search omits task results silently", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/projects/*/search", () =>
        HttpResponse.json(
          { ok: false, error: { code: "forbidden", message: "denied" } },
          { status: 403 },
        ),
      ),
    );
    renderWithProviders(<PaletteHarness />);

    await user.type(await screen.findByRole("combobox"), "go to");
    expect(await screen.findByText("Go to Rooms")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/Search all tasks/)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Search unavailable")).not.toBeInTheDocument();
  });

  test("focus moves to the search input when palette opens", async () => {
    renderWithProviders(<PaletteHarness initialOpen />);

    await waitFor(() => {
      const input = screen.getByRole("combobox");
      expect(document.activeElement).toBe(input);
    });
  });

  test("Escape calls onClose", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaletteHarness initialOpen />);

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
  });

  test("Tab keeps focus within the dialog content (focus-trap)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaletteHarness initialOpen />);

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    // Radix Dialog.Content exposes role="dialog" with the aria-label we set —
    // query it by role so the containment assertion actually executes.
    const dialog = screen.getByRole("dialog", { name: "Command palette" });

    // Radix FocusScope keeps focus inside the dialog content; without the
    // Dialog wrap focus would escape to an element outside `dialog`.
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});
