import { TaskDetailPage } from "@/pages/task-detail";
import { TasksPage } from "@/pages/tasks";
import userEvent from "@testing-library/user-event";
import type { WorkCatalogEntry } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import {
  type Location,
  type NavigateFunction,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { server } from "../mocks/server";
import {
  catalogHandler,
  cursorFor,
  declaredEntry,
  makeTask,
  manyTasks,
  pagedTasksHandler,
  searchHandler,
} from "../mocks/tasks";
import {
  act,
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "../test-utils";

let currentLocation: Location;
let navigateTo: NavigateFunction;

function LocationProbe() {
  currentLocation = useLocation();
  navigateTo = useNavigate();
  return null;
}

/** The tasks list with its drawer route, as the app mounts it. */
function renderTasks(route = "/p/test-project/tasks") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/tasks"
        element={
          <>
            <TasksPage />
            <LocationProbe />
            <Outlet />
          </>
        }
      >
        <Route path=":id" element={<TaskDetailPage />} />
      </Route>
    </Routes>,
    { route },
  );
}

const urlParam = (name: string) =>
  new URLSearchParams(currentLocation.search).get(name);

function captureListRequests(tasks = manyTasks(3)) {
  const requests: URLSearchParams[] = [];
  server.use(pagedTasksHandler(tasks, { onRequest: (p) => requests.push(p) }));
  return requests;
}

const JOB_LIFECYCLE: NonNullable<WorkCatalogEntry["definition"]> = {
  fields: [
    { name: "headline", type: "string", required: false },
    {
      name: "state",
      type: "enum",
      required: true,
      values: ["queued", "running", "shipped", "failed"],
    },
  ],
  lifecycle: {
    field: "state",
    dispatchable: ["queued"],
    terminal: ["shipped", "failed"],
    dependency_satisfied: ["shipped"],
    on_start: "running",
    outcomes: { success: "shipped", failure: "failed" },
  },
  presentation: { title: "headline" },
};

describe("TasksPage list", () => {
  test("renders table rows from API data", async () => {
    renderTasks();

    expect(await screen.findByText("entity-1")).toBeInTheDocument();
    expect(screen.getByText("entity-2")).toBeInTheDocument();
    expect(screen.getByText("entity-3")).toBeInTheDocument();
    expect(screen.getByText("Test Task 1")).toBeInTheDocument();
    expect(screen.getByText("another-user")).toBeInTheDocument();
  });

  test("requests non-archived tasks by default and can include archived", async () => {
    const user = userEvent.setup();
    const requests = captureListRequests();
    renderTasks();

    expect(
      await screen.findByText("3 tasks · excluding archived"),
    ).toBeInTheDocument();
    expect(requests.at(-1)?.get("archived")).toBe("0");
    expect(requests.at(-1)?.get("limit")).toBe("100");
    expect(requests.at(-1)?.get("sort")).toBe("updated_at");

    await user.click(
      screen.getByRole("checkbox", { name: "Include archived" }),
    );

    expect(
      await screen.findByText("3 tasks · including archived"),
    ).toBeInTheDocument();
    expect(requests.at(-1)?.get("archived")).toBeNull();
    expect(urlParam("archived")).toBe("1");
  });

  test("sorting is sent to the server, including id", async () => {
    const user = userEvent.setup();
    const requests = captureListRequests();
    renderTasks();
    await screen.findByText("task-001");

    await user.click(screen.getByRole("columnheader", { name: /^ID/ }));

    await waitFor(() => expect(requests.at(-1)?.get("sort")).toBe("id"));
    expect(requests.at(-1)?.get("order")).toBe("desc");
    expect(urlParam("sort")).toBe("id:desc");
  });

  test("states the restricted scope of the count", async () => {
    server.use(
      pagedTasksHandler(manyTasks(3), { scope: { restricted: true } }),
    );
    renderTasks();

    expect(
      await screen.findByText(
        "3 tasks · excluding archived · visible to this credential",
      ),
    ).toBeInTheDocument();
  });

  test("does not show paging controls when everything fits on one page", async () => {
    renderTasks();
    await screen.findByText("entity-1");

    expect(
      screen.queryByRole("navigation", { name: "Task pages" }),
    ).not.toBeInTheDocument();
  });

  test("shows the project empty state when the catalog has no tasks", async () => {
    server.use(catalogHandler([]), pagedTasksHandler([]));
    renderTasks();

    expect(
      await screen.findByText(/No tasks in this project/),
    ).toBeInTheDocument();
  });

  test("distinguishes an empty filter result from an empty project", async () => {
    server.use(
      catalogHandler([declaredEntry("task", 3), declaredEntry("spike", 0)]),
      pagedTasksHandler(manyTasks(3)),
    );
    renderTasks("/p/test-project/tasks?type=spike");

    expect(
      await screen.findByText("No tasks match these filters."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No tasks in this project/),
    ).not.toBeInTheDocument();
  });
});

describe("TasksPage presentation", () => {
  test("titles come from presentation metadata; a missing title is a dash", async () => {
    server.use(
      catalogHandler([declaredEntry("job", 2, JOB_LIFECYCLE)]),
      pagedTasksHandler([
        makeTask("job-1", {
          type: "job",
          data: { headline: "Ship the catalog", state: "queued" },
        }),
        // presentation.title wins: data.title is not borrowed.
        makeTask("job-2", {
          type: "job",
          data: { title: "Borrowed title", state: "queued" },
        }),
      ]),
    );
    renderTasks();

    const shipped = await screen.findByText("Ship the catalog");
    expect(shipped).toBeInTheDocument();
    const row = screen.getByText("job-2").closest("tr") as HTMLElement;
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Borrowed title")).not.toBeInTheDocument();
    expect(screen.queryByText(/Untitled/)).not.toBeInTheDocument();
  });

  test("state comes from the declared lifecycle field with lifecycle colours", async () => {
    server.use(
      catalogHandler([declaredEntry("job", 5, JOB_LIFECYCLE)]),
      pagedTasksHandler(
        ["queued", "running", "shipped", "failed", "parked"].map((state) =>
          makeTask(`job-${state}`, {
            type: "job",
            // `status` is not this type's lifecycle field and must be ignored.
            data: { state, status: "done" },
          }),
        ),
      ),
    );
    renderTasks();
    await screen.findByText("job-queued");

    const variantOf = (state: string) =>
      within(screen.getByText(`job-${state}`).closest("tr") as HTMLElement)
        .getByText(state)
        .getAttribute("data-variant");
    expect(variantOf("queued")).toBe("default");
    expect(variantOf("running")).toBe("amber");
    expect(variantOf("shipped")).toBe("green");
    expect(variantOf("failed")).toBe("red");
    expect(variantOf("parked")).toBe("gray");
    expect(screen.queryByText("done")).not.toBeInTheDocument();
  });

  test("a type without a lifecycle shows a plain status neutrally", async () => {
    renderTasks();

    const badge = await screen.findByText("active");
    expect(badge.getAttribute("data-variant")).toBe("gray");
  });

  test("an undeclared type is marked Not in schema", async () => {
    server.use(
      catalogHandler([
        declaredEntry("task", 1),
        {
          type: "legacy",
          declaration: "undeclared",
          count: 1,
          archived_count: 0,
        },
      ]),
      pagedTasksHandler([
        makeTask("old-1", { type: "legacy" }),
        makeTask("new-1"),
      ]),
    );
    renderTasks();

    const oldRow = (await screen.findByText("old-1")).closest(
      "tr",
    ) as HTMLElement;
    const badge = within(oldRow).getByText("Not in schema");
    expect(badge.getAttribute("data-variant")).toBe("amber");
    const newRow = screen.getByText("new-1").closest("tr") as HTMLElement;
    expect(within(newRow).queryByText("Not in schema")).not.toBeInTheDocument();
  });
});

describe("TasksPage type filter", () => {
  const CATALOG: WorkCatalogEntry[] = [
    {
      type: "legacy",
      declaration: "undeclared",
      count: 2,
      archived_count: 0,
    },
    declaredEntry("spike", 0),
    declaredEntry("task", 3),
  ];

  test("offers every catalog type, grouped, with counts including empty types", async () => {
    const user = userEvent.setup();
    const requests = captureListRequests();
    server.use(catalogHandler(CATALOG));
    renderTasks();
    await screen.findByText("task-001");

    await user.click(screen.getByRole("button", { name: /Type/ }));

    expect(screen.getByText("Declared")).toBeInTheDocument();
    expect(screen.getByText("Not in schema")).toBeInTheDocument();
    const spikeRow = screen
      .getByRole("checkbox", { name: "spike" })
      .closest("div") as HTMLElement;
    expect(within(spikeRow).getByText("0")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "task" }));

    await waitFor(() => expect(requests.at(-1)?.get("type")).toBe("task"));
    // Selecting a type never narrows the options to the loaded rows.
    for (const type of ["legacy", "spike", "task"]) {
      expect(screen.getByRole("checkbox", { name: type })).toBeInTheDocument();
    }
    expect(screen.getByRole("checkbox", { name: "task" })).toBeChecked();
  });

  test("a selected type missing from the catalog stays visible and is still sent", async () => {
    const requests = captureListRequests();
    server.use(catalogHandler(CATALOG));
    renderTasks("/p/test-project/tasks?type=retired");

    expect(await screen.findByText("(not available)")).toBeInTheDocument();
    expect(screen.getByText("type: retired")).toBeInTheDocument();
    expect(requests.at(-1)?.get("type")).toBe("retired");
  });

  test("type filter chip remove button has svg child (not ASCII x)", async () => {
    const user = userEvent.setup();
    renderTasks("/p/test-project/tasks?type=task");
    await screen.findByText("entity-1");

    const removeBtn = screen.getByRole("button", {
      name: /remove type filter/i,
    });
    expect(removeBtn.querySelector("svg")).not.toBeNull();
    expect(removeBtn.textContent).not.toBe("x");

    await user.click(removeBtn);
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /remove type filter/i }),
      ).not.toBeInTheDocument();
    });
    expect(urlParam("type")).toBeNull();
  });

  test("a failed catalog shows a notice and the list keeps working", async () => {
    server.use(
      http.get("*/projects/*/tasks/~/types", () =>
        HttpResponse.json(
          { ok: false, error: { code: "internal", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    renderTasks();

    expect(
      await screen.findByText("Could not load task types."),
    ).toBeInTheDocument();
    expect(await screen.findByText("entity-1")).toBeInTheDocument();
  });
});

describe("TasksPage paging", () => {
  beforeEach(() => {
    server.use(
      catalogHandler([declaredEntry("task", 260), declaredEntry("doc", 0)]),
      pagedTasksHandler(manyTasks(260)),
    );
  });

  test("Next walks keyset pages and browser Back returns to the previous page", async () => {
    const user = userEvent.setup();
    renderTasks();

    expect(await screen.findByText("task-001")).toBeInTheDocument();
    expect(screen.getByText("1–100 of 260")).toBeInTheDocument();
    expect(urlParam("after")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("task-101")).toBeInTheDocument();
    expect(screen.getByText("101–200 of 260")).toBeInTheDocument();
    expect(urlParam("after")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("task-251")).toBeInTheDocument();
    expect(screen.getByText("201–260 of 260")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Next" }),
    ).not.toBeInTheDocument();

    act(() => navigateTo(-1));
    expect(await screen.findByText("task-101")).toBeInTheDocument();
    expect(screen.getByText("101–200 of 260")).toBeInTheDocument();
    expect(screen.queryByText("task-251")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("task-001")).toBeInTheDocument();
    expect(urlParam("after")).toBeNull();
  });

  test("changing the type filter drops the page cursor", async () => {
    const user = userEvent.setup();
    renderTasks();
    await screen.findByText("task-001");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("task-101");
    expect(urlParam("after")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /Type/ }));
    await user.click(screen.getByRole("checkbox", { name: "task" }));

    await waitFor(() => expect(urlParam("type")).toBe("task"));
    expect(urlParam("after")).toBeNull();
    expect(await screen.findByText("task-001")).toBeInTheDocument();
  });

  test("a deep link to a later page renders it with First page", async () => {
    const user = userEvent.setup();
    const after = cursorFor(100, "task|0|updated_at:desc");
    renderTasks(`/p/test-project/tasks?type=task&after=${after}`);

    expect(await screen.findByText("task-101")).toBeInTheDocument();
    expect(screen.getByText("Showing 100 of 260")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Previous" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "First page" }));
    expect(await screen.findByText("task-001")).toBeInTheDocument();
    expect(urlParam("after")).toBeNull();
    expect(urlParam("type")).toBe("task");
  });

  test("an invalid cursor resets to the first page with a notice", async () => {
    renderTasks("/p/test-project/tasks?after=not-a-cursor");

    expect(
      await screen.findByText(
        "That page link is no longer valid; showing the first page.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("task-001")).toBeInTheDocument();
    expect(urlParam("after")).toBeNull();
  });

  test("closing the drawer keeps the list's query string", async () => {
    const user = userEvent.setup();
    renderTasks("/p/test-project/tasks?type=task&sort=id:asc");
    await user.click(await screen.findByRole("link", { name: "task-001" }));

    await waitFor(() =>
      expect(currentLocation.pathname).toBe("/p/test-project/tasks/task-001"),
    );
    expect(currentLocation.search).toBe("?type=task&sort=id:asc");

    await user.click(await screen.findByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(currentLocation.pathname).toBe("/p/test-project/tasks"),
    );
    expect(currentLocation.search).toBe("?type=task&sort=id:asc");
  });
});

describe("TasksPage search", () => {
  test("searches the server with the type filter and shows ranked matches", async () => {
    const user = userEvent.setup();
    const searches: URLSearchParams[] = [];
    server.use(
      searchHandler(
        [
          {
            entity_id: "task-042",
            entity_type: "task",
            name: "Ingest worker",
            snippet: "the <mark>ingest</mark> worker",
          },
          {
            entity_id: "task-077",
            entity_type: "task",
            name: null,
            snippet: null,
          },
        ],
        { onRequest: (p) => searches.push(p) },
      ),
    );
    renderTasks("/p/test-project/tasks?type=task");
    await screen.findByText("entity-1");

    await user.type(screen.getByLabelText("Search tasks"), "ingest");

    expect(await screen.findByText("Ingest worker")).toBeInTheDocument();
    const request = searches.at(-1);
    expect(request?.get("q")).toBe("ingest");
    expect(request?.get("kind")).toBe("task");
    expect(request?.get("syntax")).toBe("literal");
    expect(request?.get("type")).toBe("task");
    expect(
      screen.getByText("2 results · ranked by relevance · non-archived tasks"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ingest", { selector: "mark" }),
    ).toBeInTheDocument();
    const untitled = screen.getByText("task-077").closest("tr") as HTMLElement;
    expect(within(untitled).getAllByText("—").length).toBeGreaterThan(0);
    expect(urlParam("q")).toBe("ingest");
  });

  test("search pages through next_cursor and states restricted scope", async () => {
    const user = userEvent.setup();
    const searches: URLSearchParams[] = [];
    server.use(
      searchHandler(
        [{ entity_id: "t-1", entity_type: "task", name: "One", snippet: null }],
        {
          restricted: true,
          next_cursor: "s2",
          onRequest: (p) => searches.push(p),
        },
      ),
    );
    renderTasks("/p/test-project/tasks?q=one");

    expect(
      await screen.findByText(
        "1 result · ranked by relevance · non-archived tasks visible to this credential",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More results" }));

    await waitFor(() => expect(searches.at(-1)?.get("cursor")).toBe("s2"));
    expect(urlParam("after")).toBe("s2");
  });

  test("a one-character query keeps the list and asks for more", async () => {
    const user = userEvent.setup();
    const searches: URLSearchParams[] = [];
    server.use(searchHandler([], { onRequest: (p) => searches.push(p) }));
    renderTasks();
    await screen.findByText("entity-1");

    await user.type(screen.getByLabelText("Search tasks"), "e");

    expect(
      await screen.findByText("Type at least 2 characters to search."),
    ).toBeInTheDocument();
    expect(screen.getByText("entity-1")).toBeInTheDocument();
    expect(searches).toHaveLength(0);
  });
});
