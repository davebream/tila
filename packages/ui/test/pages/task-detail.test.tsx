import { formatDateTime, formatTime } from "@/lib/time";
import {
  TaskDetailPage,
  claimResourceMatchesEntity,
} from "@/pages/task-detail";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import {
  act,
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "../test-utils";

describe("claimResourceMatchesEntity", () => {
  test("canonical task form matches the bare entity id", () => {
    expect(
      claimResourceMatchesEntity(
        "task:task.ingest-worker",
        "task.ingest-worker",
        "task",
      ),
    ).toBe(true);
  });

  test("canonical epic form matches the bare entity id", () => {
    expect(claimResourceMatchesEntity("epic:e1", "e1", "epic")).toBe(true);
  });

  test("bare resource matches the bare entity id", () => {
    expect(
      claimResourceMatchesEntity(
        "task.ingest-worker",
        "task.ingest-worker",
        "task",
      ),
    ).toBe(true);
  });

  test("entity type present with a bare resource matches (OR-4 tolerance)", () => {
    expect(claimResourceMatchesEntity("e1", "e1", "epic")).toBe(true);
  });

  test("a different id does not match", () => {
    expect(
      claimResourceMatchesEntity("task:other", "task.ingest-worker", "task"),
    ).toBe(false);
  });

  test("undefined entity type falls back to bare-only — typed resource does not match", () => {
    expect(claimResourceMatchesEntity("task:x", "x", undefined)).toBe(false);
  });

  test("undefined entity type falls back to bare-only — bare resource matches", () => {
    expect(claimResourceMatchesEntity("x", "x", undefined)).toBe(true);
  });

  test("empty entityId never matches", () => {
    expect(claimResourceMatchesEntity("task:", "", "task")).toBe(false);
  });

  test("empty resource never matches", () => {
    expect(claimResourceMatchesEntity("", "x", "task")).toBe(false);
  });

  test("a record resource sharing the trailing id does not collide", () => {
    expect(
      claimResourceMatchesEntity(
        "record:foo/task.ingest-worker",
        "task.ingest-worker",
        "task",
      ),
    ).toBe(false);
  });
});

// `TaskDetailPage` reads `useParams<{ id }>`, so it must be mounted under a
// matching <Route path>. `renderWithProviders` supplies only <MemoryRouter>, so
// the <Routes>/<Route> wrapper is passed as the `ui` argument.
function renderDrawer(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/tasks/:id" element={<TaskDetailPage />} />
    </Routes>,
    { route },
  );
}

// Mirror packages/ui/test/mocks/handlers.ts entity shape (+ tags), untyped.
// `created_by: "test-user"` is the unambiguous positive post-load signal — it
// renders exactly once in the Fields table, unlike the label "Type".
function entityHandler(id: string, type: string) {
  return http.get("*/projects/*/tasks/:id", () =>
    HttpResponse.json({
      ok: true,
      entity: {
        id,
        type,
        schema_version: 1,
        data: { title: "Test Task" },
        archived: 0,
        created_at: Date.now() - 10_000,
        updated_at: Date.now() - 5_000,
        created_by: "test-user",
        tags: [],
      },
      relationships: [],
    }),
  );
}

function activeClaim(resource: string, expiresAt: number) {
  return {
    resource,
    principal_id: "token:test-token",
    participant_id: "agent-sonnet",
    environment: { machine: "agent-sonnet" },
    mode: "exclusive",
    fence: 1,
    acquired_at: Date.now() - 60_000,
    expires_at: expiresAt,
  };
}

function claimsHandler(claims: unknown[]) {
  return http.get("*/projects/*/claims", () =>
    HttpResponse.json({ ok: true, claims }),
  );
}

describe("TaskDetailPage claim state", () => {
  test("displays the claim for a canonical task:<id> resource (AC-1)", async () => {
    const expiresAt = Date.now() + 3_600_000;
    server.use(
      entityHandler("task.ingest-worker", "task"),
      claimsHandler([activeClaim("task:task.ingest-worker", expiresAt)]),
    );

    renderDrawer("/p/test-project/tasks/task.ingest-worker");

    // Positive post-load signal: created_by renders once in the Fields table.
    await waitFor(() =>
      expect(screen.getByText("test-user")).toBeInTheDocument(),
    );

    const claimTable = await screen.findByRole("table", {
      name: "Claim state",
    });
    expect(within(claimTable).getByText("agent-sonnet")).toBeInTheDocument();
    expect(
      within(claimTable).getByText("token:test-token"),
    ).toBeInTheDocument();
    expect(within(claimTable).getByText("exclusive")).toBeInTheDocument();
    // fence "1" — scoped to the claim table (collides with schema_version: 1)
    expect(within(claimTable).getByText("1")).toBeInTheDocument();
    // expiry cell — formatDateTime computed in-test (timezone-safe)
    expect(
      within(claimTable).getByText(formatDateTime(expiresAt)),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
  });

  test("resolves a claim whose resource is the bare entity id (AC-3)", async () => {
    const expiresAt = Date.now() + 3_600_000;
    server.use(
      entityHandler("task.ingest-worker", "task"),
      claimsHandler([activeClaim("task.ingest-worker", expiresAt)]),
    );

    renderDrawer("/p/test-project/tasks/task.ingest-worker");

    await waitFor(() =>
      expect(screen.getByText("test-user")).toBeInTheDocument(),
    );

    const claimTable = await screen.findByRole("table", {
      name: "Claim state",
    });
    expect(within(claimTable).getByText("agent-sonnet")).toBeInTheDocument();
  });

  test("resolves a canonical epic:<id> resource via the shared drawer", async () => {
    const expiresAt = Date.now() + 3_600_000;
    server.use(
      entityHandler("e1", "epic"),
      claimsHandler([activeClaim("epic:e1", expiresAt)]),
    );

    renderDrawer("/p/test-project/tasks/e1");

    await waitFor(() =>
      expect(screen.getByText("test-user")).toBeInTheDocument(),
    );

    const claimTable = await screen.findByRole("table", {
      name: "Claim state",
    });
    expect(within(claimTable).getByText("agent-sonnet")).toBeInTheDocument();
  });

  test("resolves a canonical milestone:<id> resource via the shared drawer", async () => {
    const expiresAt = Date.now() + 3_600_000;
    server.use(
      entityHandler("m1", "milestone"),
      claimsHandler([activeClaim("milestone:m1", expiresAt)]),
    );

    renderDrawer("/p/test-project/tasks/m1");

    await waitFor(() =>
      expect(screen.getByText("test-user")).toBeInTheDocument(),
    );

    const claimTable = await screen.findByRole("table", {
      name: "Claim state",
    });
    expect(within(claimTable).getByText("agent-sonnet")).toBeInTheDocument();
  });

  test("shows 'Not claimed.' when there is no active claim (AC-2)", async () => {
    server.use(entityHandler("task.ingest-worker", "task"), claimsHandler([]));

    renderDrawer("/p/test-project/tasks/task.ingest-worker");

    // "Not claimed." only appears once the claims request has succeeded empty.
    expect(await screen.findByText("Not claimed.")).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Claim state" }),
    ).not.toBeInTheDocument();
  });
});

const forbiddenResponse = () =>
  HttpResponse.json(
    {
      ok: false,
      error: {
        code: "permission-denied",
        message: "Credential cannot read this",
        retryable: false,
      },
    },
    { status: 403 },
  );

const unavailableResponse = () =>
  HttpResponse.json(
    {
      ok: false,
      error: {
        code: "do-unreachable",
        message: "Project unavailable",
        retryable: true,
      },
    },
    { status: 503 },
  );

const notFoundResponse = () =>
  HttpResponse.json(
    { ok: false, error: { code: "not-found", message: "No such task" } },
    { status: 404 },
  );

function refsHandler(references: unknown[]) {
  return http.get("*/projects/*/tasks/:id/artifact-refs", () =>
    HttpResponse.json({ ok: true, references }),
  );
}

function artifactRef(slot: string, key: string) {
  return {
    entity_id: "task.ingest-worker",
    artifact_key: key,
    slot,
    metadata: {},
    created_at: Date.now() - 1000,
  };
}

const TASK = "/p/test-project/tasks/task.ingest-worker";

function region(name: string) {
  return screen.getByRole("region", { name });
}

async function fieldsLoaded() {
  await waitFor(() =>
    expect(screen.getByText("test-user")).toBeInTheDocument(),
  );
}

describe("TaskDetailPage section states", () => {
  test("pending claims and artifacts show loading text, never absence", async () => {
    server.use(
      entityHandler("task.ingest-worker", "task"),
      http.get("*/projects/*/claims", async () => {
        await delay("infinite");
      }),
      http.get("*/projects/*/tasks/:id/artifact-refs", async () => {
        await delay("infinite");
      }),
    );

    renderDrawer(TASK);
    await fieldsLoaded();

    expect(
      within(region("Claim State")).getByText("Loading claim state…"),
    ).toBeInTheDocument();
    expect(
      within(region("Artifacts")).getByText("Loading artifacts…"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No artifacts attached."),
    ).not.toBeInTheDocument();
  });

  test("a successful empty response is shown as true absence", async () => {
    server.use(
      entityHandler("task.ingest-worker", "task"),
      claimsHandler([]),
      refsHandler([]),
    );

    renderDrawer(TASK);

    expect(await screen.findByText("Not claimed.")).toBeInTheDocument();
    expect(
      await screen.findByText("No artifacts attached."),
    ).toBeInTheDocument();
    expect(screen.getByText("No relationships.")).toBeInTheDocument();
  });

  test("a claim is not reported absent while the task type is still unknown", async () => {
    server.use(
      http.get("*/projects/*/tasks/:id", async () => {
        await delay("infinite");
      }),
      claimsHandler([
        activeClaim("task:task.ingest-worker", Date.now() + 3_600_000),
      ]),
    );

    renderDrawer(TASK);

    expect(
      await within(region("Claim State")).findByText("Loading claim state…"),
    ).toBeInTheDocument();
    // Let the claims response land; the section must still not claim absence.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
    expect(screen.queryByText("No relationships.")).not.toBeInTheDocument();
  });

  test("a 403 on claims and artifact refs is access denied, not empty", async () => {
    server.use(
      entityHandler("task.ingest-worker", "task"),
      http.get("*/projects/*/claims", forbiddenResponse),
      http.get("*/projects/*/tasks/:id/artifact-refs", forbiddenResponse),
    );

    renderDrawer(TASK);
    await fieldsLoaded();

    expect(
      await within(region("Claim State")).findByText(
        "You do not have access to claim state.",
      ),
    ).toBeInTheDocument();
    expect(
      await within(region("Artifacts")).findByText(
        "You do not have access to artifacts.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No artifacts attached."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  test("a 5xx on one section leaves the others intact and offers retry", async () => {
    server.use(
      entityHandler("task.ingest-worker", "task"),
      claimsHandler([
        activeClaim("task:task.ingest-worker", Date.now() + 3_600_000),
      ]),
      http.get("*/projects/*/tasks/:id/artifact-refs", unavailableResponse),
    );

    renderDrawer(TASK);
    await fieldsLoaded();

    const artifacts = region("Artifacts");
    expect(await within(artifacts).findByRole("alert")).toHaveTextContent(
      "Could not load artifacts.",
    );
    expect(within(artifacts).getByText("do-unreachable")).toBeInTheDocument();
    expect(
      within(artifacts).getByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No artifacts attached."),
    ).not.toBeInTheDocument();
    // The other sections are untouched.
    expect(
      await within(region("Claim State")).findByRole("table", {
        name: "Claim state",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("test-user")).toBeInTheDocument();
  });

  test("retry recovers a failed section", async () => {
    const user = userEvent.setup();
    server.use(
      entityHandler("task.ingest-worker", "task"),
      claimsHandler([]),
      http.get("*/projects/*/tasks/:id/artifact-refs", unavailableResponse),
    );

    renderDrawer(TASK);
    await fieldsLoaded();
    const artifacts = region("Artifacts");
    await within(artifacts).findByRole("alert");

    server.use(refsHandler([artifactRef("report", "reports/run-1")]));
    await user.click(within(artifacts).getByRole("button", { name: "Retry" }));

    expect(
      await within(artifacts).findByRole("link", { name: "reports/run-1" }),
    ).toBeInTheDocument();
    expect(within(artifacts).queryByRole("alert")).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
  });

  test("a failed refresh keeps cached rows with the last-success time and the failure", async () => {
    const user = userEvent.setup();
    server.use(
      entityHandler("task.ingest-worker", "task"),
      claimsHandler([
        activeClaim("task:task.ingest-worker", Date.now() + 3_600_000),
      ]),
      refsHandler([]),
    );

    const { queryClient } = renderDrawer(TASK);
    const claim = region("Claim State");
    await within(claim).findByRole("table", { name: "Claim state" });
    const lastSuccess = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["claims"] })[0]?.state.dataUpdatedAt;
    expect(lastSuccess).toBeGreaterThan(0);

    server.use(http.get("*/projects/*/claims", unavailableResponse));
    await act(() => queryClient.invalidateQueries({ queryKey: ["claims"] }));

    const notice = await within(claim).findByRole("status");
    expect(notice).toHaveTextContent(
      `Showing claim state from ${formatTime(lastSuccess as number)}. Refresh failed: server unavailable.`,
    );
    expect(
      within(claim).getByRole("table", { name: "Claim state" }),
    ).toBeInTheDocument();
    expect(within(claim).getByText("agent-sonnet")).toBeInTheDocument();
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();

    // Recovery clears the notice and keeps the rows.
    server.use(
      claimsHandler([
        activeClaim("task:task.ingest-worker", Date.now() + 3_600_000),
      ]),
    );
    await user.click(within(notice).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(within(claim).queryByRole("status")).not.toBeInTheDocument(),
    );
    expect(
      within(claim).getByRole("table", { name: "Claim state" }),
    ).toBeInTheDocument();
  });

  test("a claim that was released shows as last known, not as a fresh absence, when refresh fails", async () => {
    server.use(
      entityHandler("task.ingest-worker", "task"),
      claimsHandler([]),
      refsHandler([]),
    );

    const { queryClient } = renderDrawer(TASK);
    expect(await screen.findByText("Not claimed.")).toBeInTheDocument();

    server.use(http.get("*/projects/*/claims", unavailableResponse));
    await act(() => queryClient.invalidateQueries({ queryKey: ["claims"] }));

    const claim = region("Claim State");
    await within(claim).findByRole("status");
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
    expect(
      within(claim).getByText("Last known: Not claimed."),
    ).toBeInTheDocument();
  });

  test("a task outage does not report no relationships or no claim", async () => {
    server.use(
      http.get("*/projects/*/tasks/:id", unavailableResponse),
      claimsHandler([]),
      refsHandler([]),
    );

    renderDrawer(TASK);

    expect(
      await within(region("Fields")).findByRole("alert"),
    ).toHaveTextContent("Could not load task data.");
    expect(
      await within(region("Claim State")).findByRole("alert"),
    ).toHaveTextContent("Could not load claim state.");
    expect(
      await within(region("Relationships")).findByRole("alert"),
    ).toHaveTextContent("Could not load relationships.");
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
    expect(screen.queryByText("No relationships.")).not.toBeInTheDocument();
    // Artifacts come from their own request and are still shown.
    expect(
      await screen.findByText("No artifacts attached."),
    ).toBeInTheDocument();
  });

  test("a missing task shows only 'Task not found.'", async () => {
    server.use(
      http.get("*/projects/*/tasks/:id", notFoundResponse),
      claimsHandler([]),
      refsHandler([]),
    );

    renderDrawer(TASK);

    expect(await screen.findByText("Task not found.")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Claim State" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Artifacts" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Relationships" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
  });

  test("a forbidden task shows access denied and hides the other sections", async () => {
    server.use(
      http.get("*/projects/*/tasks/:id", forbiddenResponse),
      claimsHandler([]),
      refsHandler([]),
    );

    renderDrawer(TASK);

    expect(
      await within(region("Fields")).findByText(
        "You do not have access to task data.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Claim State" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Task not found.")).not.toBeInTheDocument();
  });

  test("without a session the task is loading, not 'not found'", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/p/:projectId/tasks/:id" element={<TaskDetailPage />} />
      </Routes>,
      { route: TASK, authenticated: false },
    );

    expect(await screen.findByText("Loading task data…")).toBeInTheDocument();
    expect(screen.queryByText("Task not found.")).not.toBeInTheDocument();
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
  });
});

describe("TaskDetailPage user state across refetch failures", () => {
  test("expanded drawer, open data panel and focus survive a failed task refresh and recovery", async () => {
    const user = userEvent.setup();
    server.use(
      entityHandler("task.ingest-worker", "task"),
      claimsHandler([]),
      refsHandler([]),
    );

    const { queryClient } = renderDrawer(TASK);
    await fieldsLoaded();

    await user.click(
      screen.getByRole("button", { name: "Show data (1 keys)" }),
    );
    expect(screen.getByText(/"title": "Test Task"/)).toBeInTheDocument();
    const expand = screen.getByRole("button", { name: "Expand" });
    await user.click(expand);
    const collapse = screen.getByRole("button", { name: "Collapse" });
    collapse.focus();

    server.use(http.get("*/projects/*/tasks/:id", unavailableResponse));
    await act(() => queryClient.invalidateQueries({ queryKey: ["task"] }));
    await within(region("Fields")).findByRole("status");

    // Last-good fields stay visible, with the data panel still open.
    expect(screen.getByText("test-user")).toBeInTheDocument();
    expect(screen.getByText(/"title": "Test Task"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse" })).toBe(collapse);
    expect(collapse).toHaveFocus();

    server.use(entityHandler("task.ingest-worker", "task"));
    await user.click(
      within(region("Fields")).getByRole("button", { name: "Retry" }),
    );
    await waitFor(() =>
      expect(
        within(region("Fields")).queryByRole("status"),
      ).not.toBeInTheDocument(),
    );

    expect(screen.getByText(/"title": "Test Task"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse" })).toBe(collapse);
  });
});
