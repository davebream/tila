import { QueuePage } from "@/pages/queue";
import userEvent from "@testing-library/user-event";
import type { QueueInspection, WorkAttempt } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { act, renderWithProviders, screen, waitFor } from "../test-utils";

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
