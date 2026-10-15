import { useTask } from "@/hooks/use-api";
import { QueuePage } from "@/pages/queue";
import userEvent from "@testing-library/user-event";
import type { QueueInspection, WorkAttempt } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { Route, Routes, useParams } from "react-router";
import { server } from "../mocks/server";
import {
  act,
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "../test-utils";

const policy = {
  enabled: true,
  paused: false,
  execution_limit: 20,
  wip_limit: 30,
  lease_ms: 60_000,
  revision: 1,
};
const attempt = (over: Partial<WorkAttempt> = {}): WorkAttempt => ({
  id: "attempt-one",
  entry_id: "entry-0",
  task_id: "task-0",
  resource: "task:task-0",
  principal_id: "coding-worker",
  participant_id: "wrapper",
  state: "running",
  revision: 1,
  fence: 2,
  lease_expires_at: Date.now() + 60_000,
  accepted_at: Date.now(),
  session: {
    provider: "fixture",
    id: "session",
    worktree: "/repo/worktree",
    url: "https://runtime.example/session",
  },
  checkpoint: null,
  cancellation_requested: false,
  suspension_requested: false,
  predecessor_id: null,
  outcome: null,
  created_at: Date.now(),
  updated_at: Date.now(),
  finished_at: null,
  revisions: null,
  ...over,
});
function entries(count: number): QueueInspection["entries"] {
  return Array.from({ length: count }, (_, index) => ({
    entry: {
      id: `entry-${index}`,
      task_id: `task-${index}`,
      state: "queued",
      priority: 0,
      enqueue_order: index,
      required_capabilities: [],
      target_principal: null,
      retry_policy: {
        retry_safe: false,
        max_attempts: 3,
        initial_backoff_ms: 5_000,
        max_backoff_ms: 300_000,
      },
      revision: 1,
      available_at: 0,
      created_at: 0,
      updated_at: 0,
      enrolled_by_principal: null,
      enrolled_by_participant: null,
    },
    task: {
      id: `task-${index}`,
      type: "task",
      data: { title: `Work ${index}` },
    },
    attempt: null,
    block_reasons: [],
  }));
}
let data: QueueInspection;
let current: WorkAttempt;
beforeEach(() => {
  data = {
    policy: { ...policy },
    counts: {
      backlog: 260,
      active: 0,
      suspended: 0,
      uncertain: 0,
      terminal: 0,
      execution: 0,
      wip: 0,
      oldest_waiting_age_ms: 90_000,
    },
    entries: entries(260),
    total: 260,
    limit: 100,
    offset: 0,
    effective_capabilities: [],
  };
  current = attempt();
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        role: "maintainer",
        principal_id: "human",
        scopes: "*",
        token_name: "browser",
      }),
    ),
    http.get("*/projects/test-project/queue", ({ request }) => {
      const query = new URL(request.url).searchParams;
      const filtered = query.get("task_id")
        ? data.entries.filter(
            (row) => row.entry.task_id === query.get("task_id"),
          )
        : data.entries;
      const offset = Number(query.get("offset") ?? 0);
      return HttpResponse.json({
        result: {
          ...data,
          total: filtered.length,
          offset,
          entries: filtered.slice(offset, offset + 100),
        },
      });
    }),
    http.get("*/projects/test-project/attempts/attempt-one", () =>
      HttpResponse.json({ result: { attempt: current, grant_valid: false } }),
    ),
  );
});
function renderQueue(search = "") {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/queue" element={<QueuePage />} />
    </Routes>,
    { route: `/p/test-project/queue${search}` },
  );
}

it("paginates beyond 250 entries and opens task-filtered work beyond the first page", async () => {
  const user = userEvent.setup();
  const rendered = renderQueue();
  expect(await screen.findByText("Work 0")).toBeInTheDocument();
  expect(screen.queryByText("Work 100")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("Work 100")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("Work 259")).toBeInTheDocument();
  expect(screen.getByText("201–260 of 260")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  rendered.unmount();
  renderQueue("?task_id=task-259");
  expect(await screen.findByText("Work 259")).toBeInTheDocument();
  expect(screen.getByLabelText("Task ID")).toHaveValue("task-259");
});

it("enrolls explicitly through the shared queue operation without launching", async () => {
  const user = userEvent.setup();
  let body: Record<string, unknown> | undefined;
  server.use(
    http.post("*/projects/test-project/queue/enroll", async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ result: data.entries[0].entry });
    }),
  );
  renderQueue("?task_id=task-0");
  await screen.findByText("Work 0");
  await user.type(
    screen.getByLabelText("Required capabilities (comma separated)"),
    "coding, linux",
  );
  await user.type(
    screen.getByLabelText("Target principal (optional)"),
    "worker-one",
  );
  await user.click(screen.getByRole("button", { name: "Enroll task" }));
  expect(await screen.findByText(/Work enrolled/)).toBeInTheDocument();
  expect(body).toMatchObject({
    task_id: "task-0",
    target_principal: "worker-one",
    required_capabilities: ["coding", "linux"],
    retry_policy: { retry_safe: false },
  });
  expect(body?.idempotency_key).toEqual(expect.any(String));
});

it("preserves edited limits on a revision conflict and retries only after revision review", async () => {
  const user = userEvent.setup();
  const commands: Array<Record<string, unknown>> = [];
  server.use(
    http.post(
      "*/projects/test-project/queue/configure",
      async ({ request }) => {
        commands.push((await request.json()) as Record<string, unknown>);
        if (commands.length === 1) {
          data.policy.revision = 2;
          return HttpResponse.json(
            { error: { code: "queue-precondition", message: "stale" } },
            { status: 412 },
          );
        }
        return HttpResponse.json({
          result: { ...data.policy, execution_limit: 25, revision: 3 },
        });
      },
    ),
  );
  renderQueue();
  await screen.findByText("Work 0");
  await user.click(screen.getByText("Queue settings"));
  const limit = screen.getByLabelText("Execution limit");
  await user.clear(limit);
  await user.type(limit, "25");
  await user.click(
    screen.getByRole("button", { name: "Save limits and enable queue" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your input is preserved",
  );
  expect(limit).toHaveValue(25);
  await user.click(
    await screen.findByRole("button", { name: "Use latest revision (2)" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Save limits and enable queue" }),
  );
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[1]).toMatchObject({
    expected_revision: 2,
    execution_limit: 25,
    wip_limit: 30,
  });
});

it("keeps the queue visible when permissions or attempt details are unavailable", async () => {
  server.use(
    http.get("*/api/whoami", () => HttpResponse.json({}, { status: 503 })),
    http.get("*/projects/test-project/attempts/attempt-one", () =>
      HttpResponse.json({}, { status: 503 }),
    ),
  );
  renderQueue("?attempt=attempt-one");
  expect(await screen.findByText("Work 0")).toBeInTheDocument();
  expect(
    await screen.findByText(/Permissions unavailable/),
  ).toBeInTheDocument();
  expect(
    screen.getAllByRole("button", { name: "Edit", hidden: true })[0],
  ).toBeDisabled();
  expect(
    await screen.findByText(/Could not load attempt/i),
  ).toBeInTheDocument();
});

it("requests cancellation without claiming the running process stopped", async () => {
  const user = userEvent.setup();
  let command: unknown;
  server.use(
    http.post(
      "*/projects/test-project/attempts/attempt-one/request-cancellation",
      async ({ request }) => {
        command = await request.json();
        current = { ...current, revision: 2, cancellation_requested: true };
        return HttpResponse.json({
          result: { attempt: current, grant_valid: false },
        });
      },
    ),
  );
  renderQueue("?attempt=attempt-one");
  await screen.findByRole("link", { name: "Open runtime session" });
  await user.click(
    await screen.findByRole("button", { name: "Request cancellation" }),
  );
  expect(
    await screen.findByText("Requested; stop not yet confirmed"),
  ).toBeInTheDocument();
  expect(screen.getByText("running", { exact: true })).toBeInTheDocument();
  expect(command).toMatchObject({
    expected_revision: 1,
    idempotency_key: expect.any(String),
  });
});

it("makes viewer actions unavailable and disables writes on stale queue data", async () => {
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        role: "viewer",
        scopes: "read",
        token_name: "viewer",
      }),
    ),
  );
  const { queryClient } = renderQueue();
  await screen.findByText("Work 0");
  expect(screen.getAllByRole("button", { name: "Edit" })[0]).toBeDisabled();
  server.use(
    http.get("*/projects/test-project/queue", () =>
      HttpResponse.json({}, { status: 503 }),
    ),
  );
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: ["queue", "test-project"],
    });
  });
  expect(screen.getByText("Work 0")).toBeInTheDocument();
  expect(
    await screen.findByText(/Refresh failed: server unavailable/),
  ).toBeInTheDocument();
});

it.each([
  ["request-suspension", "running", "Request suspension"],
  ["request-resume", "suspended", "Request resume"],
  ["force-recovery", "uncertain", "Abandon and allow replacement"],
] as const)(
  "sends %s as durable intent through the attempt API",
  async (operation, state, label) => {
    const user = userEvent.setup();
    current = attempt({ state });
    let command: unknown;
    server.use(
      http.post(
        `*/projects/test-project/attempts/attempt-one/${operation}`,
        async ({ request }) => {
          command = await request.json();
          return HttpResponse.json({
            result: { attempt: current, grant_valid: false },
          });
        },
      ),
    );
    renderQueue("?attempt=attempt-one");
    await screen.findByRole("link", { name: "Open runtime session" });
    if (operation === "force-recovery")
      await user.type(
        screen.getByLabelText("Recovery or retry reason"),
        "Verified unreachable runtime; accept unresolved execution",
      );
    await user.click(await screen.findByRole("button", { name: label }));
    await waitFor(() =>
      expect(command).toMatchObject({
        expected_revision: 1,
        idempotency_key: expect.any(String),
      }),
    );
    expect(current.state).toBe(state);
  },
);

it("requires a recovery reason and keeps session identity when rebinding ownership", async () => {
  const user = userEvent.setup();
  let command: unknown;
  server.use(
    http.post(
      "*/projects/test-project/attempts/attempt-one/rebind",
      async ({ request }) => {
        command = await request.json();
        return HttpResponse.json({
          result: { attempt: current, grant_valid: false },
        });
      },
    ),
  );
  renderQueue("?attempt=attempt-one");
  await screen.findByRole("link", { name: "Open runtime session" });
  await user.click(screen.getByText("Rebind the recorded execution"));
  expect(
    screen.getByRole("button", { name: "Rebind ownership" }),
  ).toBeDisabled();
  await user.type(
    screen.getByLabelText("Recovery or retry reason"),
    "Verified the same session on its host",
  );
  await user.type(
    screen.getByLabelText("New principal ID"),
    "replacement-worker",
  );
  await user.type(screen.getByLabelText("New participant ID"), "new-wrapper");
  await user.click(screen.getByRole("button", { name: "Rebind ownership" }));
  await waitFor(() =>
    expect(command).toMatchObject({
      principal_id: "replacement-worker",
      participant_id: "new-wrapper",
      session: current.session,
    }),
  );
});

const participantIdentity = (principal: string) =>
  http.get("*/api/whoami", () =>
    HttpResponse.json({
      ok: true,
      project_id: "test-project",
      role: "participant",
      principal_id: principal,
      scopes: "*",
      token_name: "browser",
    }),
  );

it.each([
  ["a participant who enrolled the work", "assigner", true],
  ["a participant with no control authority", "bystander", false],
] as const)("request controls for %s", async (_name, principal, allowed) => {
  server.use(
    participantIdentity(principal),
    http.get("*/projects/test-project/attempts/attempt-one", () =>
      HttpResponse.json({
        result: {
          attempt: current,
          grant_valid: true,
          assigner_principal_id: "assigner",
        },
      }),
    ),
  );
  renderQueue("?attempt=attempt-one");
  expect(await screen.findByText("Enrolled by")).toBeInTheDocument();
  const refusal = /Only the attempt owner, the principal that enrolled/;
  if (allowed) {
    const button = await screen.findByRole("button", {
      name: "Request cancellation",
    });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByText(refusal)).toBeNull();
  } else {
    // Controls the viewer may not use are absent, not disabled.
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Request cancellation" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Retry stopped work" }),
    ).toBeNull();
  }
});

it("shows the server's refusal when authority cannot be checked locally", async () => {
  const user = userEvent.setup();
  server.use(
    http.post(
      "*/projects/test-project/attempts/attempt-one/request-cancellation",
      () =>
        HttpResponse.json(
          {
            error: {
              code: "queue-authority-lost",
              message:
                "Only the attempt owner, the principal that enrolled the work, or a maintainer can request this",
            },
          },
          { status: 403 },
        ),
    ),
  );
  renderQueue("?attempt=attempt-one");
  await screen.findByRole("link", { name: "Open runtime session" });
  await user.click(
    await screen.findByRole("button", { name: "Request cancellation" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Only the attempt owner, the principal that enrolled the work, or a maintainer",
  );
});

it("shows captured revisions and flags a definition change since authorization", async () => {
  const at = Date.UTC(2026, 9, 1);
  current = attempt({
    revisions: {
      reserved: { definition_version: 2, policy_revision: 1, at },
      authorized: { definition_version: 2, policy_revision: 4, at },
    },
  });
  server.use(
    http.get("*/projects/test-project/attempts/attempt-one", () =>
      HttpResponse.json({
        result: {
          attempt: current,
          grant_valid: true,
          current_revisions: { definition_version: 3, policy_revision: 4 },
        },
      }),
    ),
  );
  renderQueue("?attempt=attempt-one");
  const table = await screen.findByRole("table", {
    name: "Governing revisions",
  });
  const [, reserved, authorized, finished] = within(table).getAllByRole("row");
  expect(reserved).toHaveTextContent(/Reservedv2r1/);
  expect(authorized).toHaveTextContent(/Authorizedv2r4/);
  expect(finished).toHaveTextContent("Finished—");
  expect(
    screen.getByText(/Current: definition v3 · policy\s+r4/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Definition changed since authorization/),
  ).toHaveTextContent("v2 → v3");
});

it("marks revisions as not recorded for legacy attempts", async () => {
  renderQueue("?attempt=attempt-one");
  expect(
    await screen.findByText(/Not recorded\. This attempt predates/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("table", { name: "Governing revisions" }),
  ).toBeNull();
  expect(screen.queryByText(/Definition changed/)).toBeNull();
});

it("links corrective work to a finished attempt with a retry-safe key", async () => {
  const user = userEvent.setup();
  const outcome = {
    status: "failure" as const,
    reason: "Tests failed on main",
    evidence: [],
    execution_stopped: true,
    unresolved_external_execution: false,
  };
  current = attempt({ state: "terminal", outcome, finished_at: Date.now() });
  const corrections = [
    {
      id: "correction-1",
      attempt_id: "attempt-one",
      task_id: "task-fix-1",
      reason: "Flaky fixture repaired",
      principal_id: "human",
      participant_id: "dashboard-a",
      created_at: Date.UTC(2026, 9, 2),
    },
  ];
  const commands: Array<Record<string, unknown>> = [];
  server.use(
    http.get("*/projects/test-project/attempts/attempt-one", () =>
      HttpResponse.json({
        result: { attempt: current, grant_valid: false, corrections },
      }),
    ),
    http.post(
      "*/projects/test-project/attempts/attempt-one/correct",
      async ({ request }) => {
        const command = (await request.json()) as Record<string, unknown>;
        commands.push(command);
        if (commands.length === 1)
          return HttpResponse.json({}, { status: 503 });
        corrections.push({
          id: "correction-2",
          attempt_id: "attempt-one",
          task_id: String(command.task_id),
          reason: String(command.reason),
          principal_id: "human",
          participant_id: "dashboard-b",
          created_at: Date.UTC(2026, 9, 3),
        });
        return HttpResponse.json({
          result: { attempt: current, grant_valid: false, corrections },
        });
      },
    ),
  );
  renderQueue("?attempt=attempt-one");
  const list = await screen.findByRole("list", { name: "Corrective work" });
  expect(
    within(list).getByRole("link", { name: "task-fix-1" }),
  ).toHaveAttribute("href", "/p/test-project/tasks/task-fix-1");
  expect(within(list).getByText("Flaky fixture repaired")).toBeInTheDocument();
  expect(
    screen.getByText(/original result stays unchanged/),
  ).toBeInTheDocument();
  const submit = screen.getByRole("button", { name: "Link corrective task" });
  expect(submit).toBeDisabled();
  await user.type(screen.getByLabelText("Corrective task ID"), "task-fix-2");
  await user.type(
    screen.getByLabelText("Correction reason"),
    "Re-run with the repaired fixture",
  );
  await user.click(submit);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  await user.click(submit);
  expect(
    await screen.findByText("Corrective task linked."),
  ).toBeInTheDocument();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({
    task_id: "task-fix-2",
    reason: "Re-run with the repaired fixture",
    idempotency_key: expect.any(String),
  });
  expect(commands[1].idempotency_key).toBe(commands[0].idempotency_key);
  expect(
    await within(list).findByRole("link", { name: "task-fix-2" }),
  ).toBeInTheDocument();
  // The original result is never rewritten.
  expect(screen.getByText("Result: failure")).toBeInTheDocument();
  expect(screen.getByLabelText("Corrective task ID")).toHaveValue("");
});

it("warns about expired execution authority while retaining occupied capacity", async () => {
  current = attempt({ lease_expires_at: Date.now() - 1 });
  data.entries[0].attempt = current;
  data.entries[0].entry.state = "admitted";
  data.counts.execution = 1;
  data.diagnostics = {
    since: 0,
    until: Date.now(),
    source: "retained_journal",
    grant_denials: {},
    expired_reservations: 0,
    uncertainty_events: 0,
    reconciliations: 0,
    retries: 0,
    forced_abandonments: 0,
    expired_execution_leases: 1,
  };
  renderQueue();
  expect(
    await screen.findByText(/execution leases have expired/),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Authority expired — reconciliation required"),
  ).toBeInTheDocument();
  expect(screen.getByText("1 / 20")).toBeInTheDocument();
});

describe("compact listing", () => {
  /** What the server returns for `compact=true`: `task.data` narrowed. */
  const narrowed = (view: QueueInspection["entries"][number]) => ({
    ...view,
    task: view.task && {
      id: view.task.id,
      type: view.task.type,
      data: { title: view.task.data.title },
    },
  });
  const heavy = (rows: QueueInspection["entries"]) =>
    rows.map((view) => ({
      ...view,
      task: view.task && {
        ...view.task,
        data: {
          ...view.task.data,
          description: "A long brief. ".repeat(200),
          acceptance: "All callers compile. ".repeat(40),
        },
      },
    }));

  it("requests the compact listing, once per refresh, with the page's filters", async () => {
    const requests: URLSearchParams[] = [];
    server.use(
      http.get("*/projects/test-project/queue", ({ request }) => {
        const query = new URL(request.url).searchParams;
        requests.push(query);
        return HttpResponse.json({
          result: {
            ...data,
            total: 3,
            entries: entries(3).map(narrowed),
          },
        });
      }),
    );
    renderQueue("?state=backlog&priority=2&offset=0");
    expect(await screen.findByText("Work 0")).toBeInTheDocument();
    expect(requests[0].get("compact")).toBe("true");
    expect(requests[0].get("state")).toBe("backlog");
    expect(requests[0].get("priority")).toBe("2");
    expect(requests[0].get("limit")).toBe("100");
  });

  it("renders exactly the same rows from compact data as from full data", async () => {
    const rowsOf = () =>
      screen.getAllByRole("row").map((row) => row.textContent);
    const render = async (rows: QueueInspection["entries"]) => {
      server.use(
        http.get("*/projects/test-project/queue", () =>
          HttpResponse.json({
            result: { ...data, total: rows.length, entries: rows },
          }),
        ),
      );
      const rendered = renderQueue();
      await screen.findByText("Work 0");
      const text = rowsOf();
      rendered.unmount();
      return text;
    };
    const full = heavy(entries(4));
    const fromFull = await render(full);
    const fromCompact = await render(full.map(narrowed));
    expect(fromCompact).toEqual(fromFull);
    expect(fromCompact.length).toBe(5);
  });

  it("opens a row on the full task, not the compact view", async () => {
    const user = userEvent.setup();
    const taskRequests: URL[] = [];
    const queueRequests: URLSearchParams[] = [];
    function Opened() {
      const { entityId = "" } = useParams();
      const task = useTask(entityId);
      return (
        <p>
          {task.data
            ? `Opened ${String(task.data.entity.data.description)}`
            : "Loading task"}
        </p>
      );
    }
    server.use(
      http.get("*/projects/test-project/queue", ({ request }) => {
        queueRequests.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          result: {
            ...data,
            total: 2,
            entries: entries(2).map(narrowed),
          },
        });
      }),
      http.get("*/projects/test-project/tasks/:id", ({ request, params }) => {
        taskRequests.push(new URL(request.url));
        return HttpResponse.json({
          ok: true,
          entity: {
            id: params.id,
            type: "task",
            schema_version: 1,
            data: { title: "Work 0", description: "the complete brief" },
            archived: 0,
            created_at: 0,
            updated_at: 0,
            created_by: "test",
            tags: [],
          },
          relationships: [],
        });
      }),
    );
    renderWithProviders(
      <Routes>
        <Route path="/p/:projectId/queue" element={<QueuePage />} />
        <Route path="/p/:projectId/tasks/:entityId" element={<Opened />} />
      </Routes>,
      { route: "/p/test-project/queue" },
    );
    await user.click(await screen.findByRole("link", { name: "Work 0" }));
    expect(
      await screen.findByText("Opened the complete brief"),
    ).toBeInTheDocument();
    expect(queueRequests.every((q) => q.get("compact") === "true")).toBe(true);
    expect(taskRequests.length).toBeGreaterThan(0);
    for (const url of taskRequests) {
      expect(url.pathname.endsWith("/tasks/task-0")).toBe(true);
      expect(url.searchParams.has("compact")).toBe(false);
      expect(url.searchParams.has("fields")).toBe(false);
    }
  });
});

it("the lapsed-lease filter reaches the server and can be cleared", async () => {
  const user = userEvent.setup();
  const requests: URLSearchParams[] = [];
  server.use(
    http.get("*/projects/test-project/queue", ({ request }) => {
      const query = new URL(request.url).searchParams;
      requests.push(query);
      return HttpResponse.json({
        result: { ...data, total: 0, offset: 0, entries: [] },
      });
    }),
  );
  renderQueue("?lease=expired");

  expect(
    await screen.findByText(
      /Showing executions still starting or running past their lease/,
    ),
  ).toBeInTheDocument();
  await waitFor(() => expect(requests.at(-1)?.get("lease")).toBe("expired"));

  await user.click(screen.getByRole("button", { name: "Show all work" }));
  await waitFor(() => expect(requests.at(-1)?.get("lease")).toBeNull());
});

describe("blockers", () => {
  const blockerList = () =>
    screen.findByRole("list", { name: "Blockers for task-0" });

  it("names each visible blocker with its state and a link to its task", async () => {
    data.entries = entries(1);
    data.entries[0].block_reasons = [
      {
        code: "dependency-unsatisfied",
        resource: "task-b",
        state: "in_review",
      },
      {
        code: "dependency-unsatisfied",
        resource: "task c/2",
        state: "draft",
      },
      {
        code: "dependency-cycle",
        resource: "task-0",
        path: ["task-0", "task-b", "task-0"],
      },
    ];
    renderQueue();
    const list = await blockerList();
    const links = within(list).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "task-b",
      "task c/2",
      "task-0",
    ]);
    // The visible ID is URL-encoded into the task page path.
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/p/test-project/tasks/task-b",
      "/p/test-project/tasks/task%20c%2F2",
      "/p/test-project/tasks/task-0",
    ]);
    const [review, draft, cycle] = within(list).getAllByRole("listitem");
    expect(review).toHaveTextContent(
      "dependency-unsatisfied task-b · in_review",
    );
    expect(draft).toHaveTextContent("dependency-unsatisfied task c/2 · draft");
    expect(cycle).toHaveTextContent(
      "dependency-cycle task-0 · task-0 → task-b → task-0",
    );
  });

  it("shows a withheld predecessor generically, with no self-blocker and no extra fetch", async () => {
    data.entries = entries(1);
    // What the server sends in place of a predecessor the caller may not read.
    data.entries[0].block_reasons = [
      { code: "dependency-unsatisfied", resource: "task-0" },
      { code: "dependency-unsatisfied", resource: "task-b", state: "draft" },
    ];
    const requested: string[] = [];
    const record = ({ request }: { request: Request }) => {
      requested.push(new URL(request.url).pathname);
    };
    server.events.on("request:start", record);
    try {
      renderQueue();
      const list = await blockerList();
      const [restricted, visible] = within(list).getAllByRole("listitem");
      expect(restricted).toHaveTextContent(
        /^Waiting on a restricted predecessor$/,
      );
      expect(within(restricted).queryByRole("link")).toBeNull();
      expect(within(list).queryByText("task-0")).toBeNull();
      expect(
        within(visible).getByRole("link", { name: "task-b" }),
      ).toBeInTheDocument();
      await screen.findByText("Work 0");
      // The queue and identity reads only: no task or relationship lookups.
      expect(
        requested.filter((path) => /\/tasks|\/relationships/.test(path)),
      ).toEqual([]);
    } finally {
      server.events.removeListener("request:start", record);
    }
  });

  it("keeps the entry's own conditions, gates and missing predecessors readable without false links", async () => {
    data.entries = entries(1);
    data.entries[0].block_reasons = [
      { code: "not-dispatchable", resource: "task-0", state: "draft" },
      { code: "retry-backoff", resource: "task-0" },
      { code: "gate-pending", resource: "gate-77" },
      { code: "dependency-missing", resource: "task-gone" },
    ];
    renderQueue();
    const list = await blockerList();
    const [dispatch, backoff, gate, missing] =
      within(list).getAllByRole("listitem");
    expect(dispatch).toHaveTextContent(/^not-dispatchable · draft$/);
    expect(backoff).toHaveTextContent(/^retry-backoff$/);
    expect(gate).toHaveTextContent(/^gate-pending gate-77$/);
    expect(missing).toHaveTextContent(/^dependency-missing task-gone$/);
    expect(within(list).queryAllByRole("link")).toHaveLength(0);
  });

  it("renders no blocker list for work that nothing blocks", async () => {
    renderQueue();
    expect(await screen.findByText("Work 0")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /Blockers for/ })).toBeNull();
  });

  it("shows a blocker's new state when the queue refetches", async () => {
    data.entries = entries(1);
    data.entries[0].block_reasons = [
      {
        code: "dependency-unsatisfied",
        resource: "task-b",
        state: "in_review",
      },
    ];
    const { queryClient } = renderQueue();
    const list = await blockerList();
    expect(within(list).getByText("in_review")).toBeInTheDocument();
    data.entries[0].block_reasons = [
      {
        code: "dependency-unsatisfied",
        resource: "task-b",
        state: "in_progress",
      },
    ];
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["queue", "test-project"],
      });
    });
    expect(await screen.findByText("in_progress")).toBeInTheDocument();
    expect(screen.queryByText("in_review")).toBeNull();
  });
});
