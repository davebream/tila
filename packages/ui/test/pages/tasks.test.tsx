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
  configuredEntry,
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

describe("TasksPage attention filters", () => {
  test("blocked comes from the URL, is sent with the default scope and can be removed", async () => {
    const user = userEvent.setup();
    const requests = captureListRequests();
    renderTasks("/p/test-project/tasks?blocked=1");

    expect(
      await screen.findByText(
        "3 tasks · excluding archived · waiting on prerequisites",
      ),
    ).toBeInTheDocument();
    expect(requests.at(-1)?.get("blocked")).toBe("1");
    expect(requests.at(-1)?.get("archived")).toBe("0");

    await user.click(
      screen.getByRole("button", { name: "Remove blocked filter" }),
    );
    await waitFor(() => expect(urlParam("blocked")).toBeNull());
    expect(requests.at(-1)?.get("blocked")).toBeNull();
  });

  test("an outcome no type declares says nothing can match", async () => {
    const requests: URLSearchParams[] = [];
    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        requests.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          ok: true,
          entities: [],
          total: 0,
          limit: 100,
          offset: 0,
          has_more: false,
          next_cursor: null,
          scope: { restricted: false, archived: "excluded", outcome_types: [] },
        });
      }),
    );
    renderTasks("/p/test-project/tasks?outcome=failure,abandoned");

    expect(
      await screen.findByText(
        "No task type declares a failure or abandoned outcome, so none can match.",
      ),
    ).toBeInTheDocument();
    expect(requests.at(-1)?.get("outcome")).toBe("failure,abandoned");
  });

  test("searching drops the filters search cannot apply", async () => {
    const user = userEvent.setup();
    captureListRequests();
    renderTasks("/p/test-project/tasks?blocked=1&outcome=failure");
    await screen.findByRole("button", { name: "Remove blocked filter" });

    await user.type(
      screen.getByRole("searchbox", { name: "Search tasks" }),
      "auth",
    );
    await waitFor(() => expect(urlParam("q")).toBe("auth"));
    expect(urlParam("blocked")).toBeNull();
    expect(urlParam("outcome")).toBeNull();
  });
});

// #525: the State column and the State filter and sort read the same value:
// the field each task's own type declares as its lifecycle, else `status`.
describe("TasksPage state filter and sort", () => {
  const REVIEW_LIFECYCLE: NonNullable<WorkCatalogEntry["definition"]> = {
    fields: [
      {
        name: "phase",
        type: "enum",
        required: true,
        values: ["new", "in-review", "fixed", "wontfix"],
      },
    ],
    lifecycle: {
      field: "phase",
      dispatchable: ["new"],
      terminal: ["fixed"],
      dependency_satisfied: ["fixed"],
      on_start: "in-review",
    },
  };
  const NOTE_DEFINITION: NonNullable<WorkCatalogEntry["definition"]> = {
    fields: [
      {
        name: "status",
        type: "enum",
        required: false,
        values: ["draft", "in-review", "published"],
      },
    ],
  };
  const CATALOG: WorkCatalogEntry[] = [
    declaredEntry("job", 2, JOB_LIFECYCLE),
    declaredEntry("bug", 2, REVIEW_LIFECYCLE),
    declaredEntry("note", 2, NOTE_DEFINITION),
  ];
  const TASKS = [
    makeTask("job-1", { type: "job", data: { state: "running" } }),
    makeTask("job-2", { type: "job", data: { state: "queued" } }),
    makeTask("bug-1", { type: "bug", data: { phase: "in-review" } }),
    makeTask("bug-2", { type: "bug", data: { phase: "new", status: "fixed" } }),
    makeTask("note-1", { type: "note", data: { status: "in-review" } }),
    makeTask("note-2", { type: "note", data: { status: "draft" } }),
  ];
  const FIELDS = { job: "state", bug: "phase" };

  function renderStates(route = "/p/test-project/tasks") {
    const requests: URLSearchParams[] = [];
    server.use(
      catalogHandler(CATALOG),
      pagedTasksHandler(TASKS, {
        stateFields: FIELDS,
        onRequest: (p) => requests.push(p),
      }),
    );
    renderTasks(route);
    return requests;
  }

  test("offers the states every declared type names, once, from the catalog", async () => {
    const user = userEvent.setup();
    renderStates();
    await screen.findByText("job-1");

    await user.click(screen.getByRole("button", { name: "State" }));

    const options = screen
      .getAllByRole("checkbox")
      .map((box) => box.getAttribute("id"))
      .filter(Boolean);
    expect(options.length).toBeGreaterThan(0);
    for (const state of [
      "queued",
      "running",
      "shipped",
      "failed",
      "new",
      "in-review",
      "fixed",
      "wontfix",
      "draft",
      "published",
    ])
      expect(screen.getByRole("checkbox", { name: state })).toBeInTheDocument();
    // `in-review` is named by two types and listed once.
    expect(screen.getAllByRole("checkbox", { name: "in-review" })).toHaveLength(
      1,
    );
  });

  test("filters server-side across types and keeps the column in agreement", async () => {
    const user = userEvent.setup();
    const requests = renderStates();
    await screen.findByText("job-1");

    await user.click(screen.getByRole("button", { name: "State" }));
    await user.click(screen.getByRole("checkbox", { name: "in-review" }));

    await waitFor(() =>
      expect(requests.at(-1)?.get("state")).toBe("in-review"),
    );
    expect(urlParam("state")).toBe("in-review");
    // bug-1 holds it in `phase`, note-1 in `status`: neither is `bug-2`'s
    // decoy `status`, and no job is in review.
    await waitFor(() =>
      expect(screen.queryByText("job-1")).not.toBeInTheDocument(),
    );
    for (const id of ["bug-1", "note-1"]) {
      const row = screen.getByText(id).closest("tr") as HTMLElement;
      expect(within(row).getByText("in-review")).toBeInTheDocument();
    }
    expect(screen.queryByText("bug-2")).not.toBeInTheDocument();
    expect(
      await screen.findByText("2 tasks · excluding archived · state in-review"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove state filter: in-review" }),
    ).toBeInTheDocument();
  });

  test("reads the state filter from the URL and removes it from its chip", async () => {
    const user = userEvent.setup();
    const requests = renderStates("/p/test-project/tasks?state=queued,running");

    expect(await screen.findByText("job-1")).toBeInTheDocument();
    expect(requests.at(-1)?.get("state")).toBe("queued,running");
    expect(
      screen.getByRole("button", { name: "State: 2" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Remove state filter: queued" }),
    );
    await waitFor(() => expect(urlParam("state")).toBe("running"));
    await user.click(
      screen.getByRole("button", { name: "Remove state filter: running" }),
    );
    await waitFor(() => expect(urlParam("state")).toBeNull());
    expect(requests.at(-1)?.get("state")).toBeNull();
  });

  test("a selected state the catalog does not declare stays visible and is sent", async () => {
    const requests = renderStates("/p/test-project/tasks?state=retired");

    expect(await screen.findByText("(not declared)")).toBeInTheDocument();
    expect(screen.getByText("state: retired")).toBeInTheDocument();
    expect(requests.at(-1)?.get("state")).toBe("retired");
    expect(
      await screen.findByText("No tasks match these filters."),
    ).toBeInTheDocument();
  });

  test("the State header sorts on the server and toggles its direction", async () => {
    const user = userEvent.setup();
    const requests = renderStates();
    await screen.findByText("job-1");

    const header = () => screen.getByRole("columnheader", { name: /^State/ });
    expect(header()).toHaveAttribute("aria-sort", "none");
    await user.click(header());

    await waitFor(() => expect(requests.at(-1)?.get("sort")).toBe("state"));
    expect(requests.at(-1)?.get("order")).toBe("desc");
    expect(urlParam("sort")).toBe("state:desc");
    await waitFor(() =>
      expect(header()).toHaveAttribute("aria-sort", "descending"),
    );
    const shown = () =>
      screen
        .getAllByRole("link")
        .map((link) => link.textContent)
        .filter((id) => /^(job|bug|note)-\d$/.test(id ?? ""));
    // running, queued, new, then the two in-review tasks (id descending), draft.
    await waitFor(() =>
      expect(shown()).toEqual([
        "job-1",
        "job-2",
        "bug-2",
        "note-1",
        "bug-1",
        "note-2",
      ]),
    );

    await user.click(header());
    await waitFor(() => expect(urlParam("sort")).toBe("state:asc"));
    await waitFor(() =>
      expect(header()).toHaveAttribute("aria-sort", "ascending"),
    );
    await waitFor(() =>
      expect(shown()).toEqual([
        "note-2",
        "bug-1",
        "note-1",
        "bug-2",
        "job-2",
        "job-1",
      ]),
    );
  });

  test("changing the state filter or sort drops the page cursor", async () => {
    const user = userEvent.setup();
    server.use(
      catalogHandler([declaredEntry("task", 260)]),
      pagedTasksHandler(manyTasks(260)),
    );
    renderTasks();
    await screen.findByText("task-001");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("task-101");
    expect(urlParam("after")).not.toBeNull();

    await user.click(screen.getByRole("columnheader", { name: /^State/ }));
    await waitFor(() => expect(urlParam("sort")).toBe("state:desc"));
    expect(urlParam("after")).toBeNull();
  });

  test("search disables the control with a reason and does not send state", async () => {
    const searches: URLSearchParams[] = [];
    server.use(
      catalogHandler(CATALOG),
      searchHandler(
        [
          {
            entity_id: "bug-1",
            entity_type: "bug",
            name: "A bug",
            snippet: null,
          },
        ],
        { onRequest: (p) => searches.push(p) },
      ),
    );
    renderTasks("/p/test-project/tasks?q=bug&state=in-review");

    expect(await screen.findByText("A bug")).toBeInTheDocument();
    const control = screen.getByRole("button", { name: "State" });
    expect(control).toBeDisabled();
    expect(control).toHaveAccessibleDescription(
      "State filters the task list, not search results.",
    );
    expect(searches.at(-1)?.has("state")).toBe(false);
    // No chip and no count imply the filter applied to these results.
    expect(
      screen.queryByRole("button", { name: /Remove state filter/ }),
    ).not.toBeInTheDocument();
  });

  test("searching drops the state filter like the other filters search cannot apply", async () => {
    const user = userEvent.setup();
    renderStates("/p/test-project/tasks?state=in-review");
    await screen.findByRole("button", {
      name: "Remove state filter: in-review",
    });

    await user.type(
      screen.getByRole("searchbox", { name: "Search tasks" }),
      "auth",
    );
    await waitFor(() => expect(urlParam("q")).toBe("auth"));
    expect(urlParam("state")).toBeNull();
  });

  test("Reset clears the state filter with the others", async () => {
    const user = userEvent.setup();
    renderStates("/p/test-project/tasks?type=bug&state=new");
    await screen.findByText("bug-2");

    await user.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(urlParam("state")).toBeNull());
    expect(urlParam("type")).toBeNull();
  });

  test("is disabled with a reason when no type declares a state", async () => {
    server.use(
      catalogHandler([declaredEntry("plain", 1)]),
      pagedTasksHandler([makeTask("plain-1", { type: "plain" })]),
    );
    renderTasks();
    await screen.findByText("plain-1");

    const control = screen.getByRole("button", { name: "State" });
    expect(control).toBeDisabled();
    expect(control).toHaveAccessibleDescription(
      "No task type declares states to filter by.",
    );
  });

  // The #308 scale harness selects these by role and exact name; a second
  // filter control must not make any of them ambiguous.
  test("keeps the harness selectors unique with a state filter set", async () => {
    const user = userEvent.setup();
    renderStates("/p/test-project/tasks?state=in-review");
    await screen.findByText("bug-1");

    expect(
      screen.queryAllByRole("navigation", { name: "Task pages" }).length,
    ).toBeLessThanOrEqual(1);
    expect(
      screen.getAllByRole("searchbox", { name: "Search tasks" }),
    ).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Type" })).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: "Clear" })).toHaveLength(0);

    // The harness selects a type, closes the menu, then reopens it as
    // "Type: 1" to press Clear.
    await user.click(screen.getByRole("button", { name: "Type" }));
    await user.click(screen.getByRole("checkbox", { name: "bug" }));
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "Type: 1" }));
    // Exactly one Clear: the Type menu's. The State menu is closed.
    expect(screen.getAllByRole("button", { name: "Clear" })).toHaveLength(1);
    // And one page-level Reset, which is a different name.
    expect(screen.getAllByRole("button", { name: "Reset" })).toHaveLength(1);
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

// These walk full 100-row pages of a 260-task project (the #300 acceptance
// size), which is slow under jsdom on CI runners.
describe("TasksPage paging", { timeout: 60_000 }, () => {
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

// #398: a blocked list is the same server readiness the Overview counted, so
// it explains the same legacy fallback, from the catalog and never from rows.
describe("TasksPage lifecycle coverage", () => {
  const coverage = () =>
    screen.findByRole("region", { name: "Lifecycle coverage" });
  const none = () =>
    expect(
      screen.queryByRole("region", { name: "Lifecycle coverage" }),
    ).not.toBeInTheDocument();

  test("a blocked list names legacy types and links to Definitions", async () => {
    server.use(
      catalogHandler([configuredEntry("job", 2), declaredEntry("note", 1)]),
    );
    captureListRequests();
    renderTasks("/p/test-project/tasks?blocked=1");

    const note = await coverage();
    expect(note).toHaveTextContent("No lifecycle is declared for note.");
    expect(within(note).queryByText("job")).not.toBeInTheDocument();
    expect(
      within(note).getByRole("link", {
        name: "Review lifecycles in Definitions",
      }),
    ).toHaveAttribute("href", "/p/test-project/settings/definitions");
  });

  test("is shown for an empty blocked list too", async () => {
    server.use(catalogHandler([declaredEntry("note", 1)]));
    captureListRequests([]);
    renderTasks("/p/test-project/tasks?blocked=1");

    expect(
      await screen.findByText("No open tasks are waiting on prerequisites."),
    ).toBeInTheDocument();
    expect(await coverage()).toHaveTextContent(
      "No lifecycle is declared for note.",
    );
  });

  test("an unfiltered list does not carry the blocked explanation", async () => {
    server.use(catalogHandler([declaredEntry("note", 1)]));
    captureListRequests();
    renderTasks("/p/test-project/tasks");

    await screen.findByText("3 tasks · excluding archived");
    none();
  });

  test("removing the blocked filter removes the explanation", async () => {
    const user = userEvent.setup();
    server.use(catalogHandler([declaredEntry("note", 1)]));
    captureListRequests();
    renderTasks("/p/test-project/tasks?blocked=1");
    await coverage();

    await user.click(
      screen.getByRole("button", { name: "Remove blocked filter" }),
    );
    await waitFor(none);
  });

  test("a failed catalog is unknown coverage and the list still renders", async () => {
    server.use(
      http.get("*/projects/*/tasks/~/types", () =>
        HttpResponse.json(
          { ok: false, error: { code: "internal", message: "down" } },
          { status: 500 },
        ),
      ),
    );
    captureListRequests();
    renderTasks("/p/test-project/tasks?blocked=1");

    const note = await coverage();
    expect(note).toHaveTextContent("Lifecycle coverage is unknown");
    expect(note).not.toHaveTextContent("No lifecycle is declared");
    expect(await screen.findByText("task-001")).toBeInTheDocument();
  });

  test("names come from the catalog, not from the page's rows", async () => {
    // The only row is a configured type; the legacy type has no row on this page.
    server.use(
      catalogHandler([configuredEntry("job", 1), declaredEntry("note", 40)]),
      pagedTasksHandler([makeTask("job-1", { type: "job" })]),
    );
    renderTasks("/p/test-project/tasks?blocked=1");

    expect(await coverage()).toHaveTextContent(
      "No lifecycle is declared for note.",
    );
  });

  test("a records-only restriction masks the schema but hides no task type", async () => {
    server.use(
      http.get("*/api/whoami", () =>
        HttpResponse.json({
          ok: true,
          project_id: "test-project",
          token_name: "limited",
          scopes: "read",
          role: "participant",
          policy: {
            role: "participant",
            capabilities: ["tasks:read"],
            restrictions: { records: [{ type: "note" }] },
          },
        }),
      ),
      catalogHandler([declaredEntry("note", 1)]),
    );
    captureListRequests();
    renderTasks("/p/test-project/tasks?blocked=1");

    const note = await coverage();
    expect(note).toHaveTextContent(
      "This credential sees no lifecycle for note.",
    );
    expect(note).not.toHaveTextContent("only some task types");
  });

  test("a restricted catalog is not presented as complete", async () => {
    server.use(
      catalogHandler([configuredEntry("job", 2)], { restricted: true }),
    );
    captureListRequests();
    renderTasks("/p/test-project/tasks?blocked=1");

    expect(await coverage()).toHaveTextContent(
      "This credential sees only some task types.",
    );
  });
});
