import { dashboardParticipantId } from "@/lib/api";
import { TaskDetailPage } from "@/pages/task-detail";
import userEvent from "@testing-library/user-event";
import type { WorkAttempt } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { Route, Routes, useParams } from "react-router";
import { attempt } from "../mocks/attempts";
import { server } from "../mocks/server";
import { catalogHandler, declaredEntry } from "../mocks/tasks";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const bug = declaredEntry("bug", 1, {
  fields: [
    { name: "title", type: "string", required: true },
    { name: "status", type: "enum", required: true, values: ["open", "done"] },
  ],
  lifecycle: {
    field: "status",
    dispatchable: ["open"],
    terminal: ["done"],
    dependency_satisfied: ["done"],
  },
  presentation: { title: "title" },
});

const ME = "github:example:1";
let attempts: WorkAttempt[] = [];
let role = "maintainer";

function question(id: string, attemptId: string, text: string) {
  return {
    answer_applicable: false,
    question: {
      id,
      text,
      task_id: "BUG-1",
      attempt_id: attemptId,
      attempt_revision: 3,
      attempt_fence: 2,
      requester: { principal_id: "github:example:9", participant_id: "w" },
      session: null,
      requester_binding: null,
      responder_principal_id: ME,
      escalated: false,
      state: "open",
      revision: 1,
      answer: null,
      routing: [],
      discussion: [],
      predecessor_id: null,
      invalidation_reason: null,
      created_at: 1,
      updated_at: 1,
    },
  };
}

/** The original task's drawer, or a marker once navigation reaches another task. */
function TaskOrOpened() {
  const { id } = useParams();
  return id === "BUG-1" ? <TaskDetailPage /> : <p>Opened {id}</p>;
}

function renderTask(route = "/p/test-project/tasks/BUG-1") {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/tasks/:id" element={<TaskDetailPage />} />
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  role = "maintainer";
  attempts = [];
  server.use(
    catalogHandler([bug]),
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        token_name: "dev",
        scopes: "write",
        role,
        principal_id: ME,
      }),
    ),
    http.get("*/projects/test-project/tasks/:id", ({ params }) =>
      HttpResponse.json({
        ok: true,
        entity: {
          id: params.id,
          type: "bug",
          schema_version: 1,
          data: { title: "Login fails", status: "open" },
          archived: 0,
          created_at: 1,
          updated_at: 1,
          created_by: "dev",
          tags: [],
        },
        relationships: [],
      }),
    ),
    http.get("*/projects/test-project/attempts", () =>
      HttpResponse.json({ ok: true, result: attempts }),
    ),
  );
});

test("task state, attempt state and result are shown separately", async () => {
  attempts = [attempt({ cancellation_requested: true })];
  renderTask();
  const execution = await screen.findByRole("region", { name: "Execution" });
  expect(
    await within(execution).findByText(
      /Running · cancellation requested, stop not yet confirmed/,
    ),
  ).toBeInTheDocument();
  expect(
    within(execution).getByText("open (the task's own lifecycle value)"),
  ).toBeInTheDocument();
  expect(
    within(execution).getByText("No result recorded yet"),
  ).toBeInTheDocument();
  expect(
    within(execution).getByRole("button", { name: "Cancellation requested" }),
  ).toBeDisabled();
});

test("a cancellation request previews superseded questions and fabricates nothing", async () => {
  const user = userEvent.setup();
  attempts = [attempt()];
  let sent: unknown;
  server.use(
    http.get("*/projects/test-project/questions", ({ request }) => {
      const params = new URL(request.url).searchParams;
      return HttpResponse.json({
        ok: true,
        result: {
          questions:
            params.get("attempt_id") === "att-1" || params.get("task_id")
              ? [
                  question(
                    "00000000-0000-4000-8000-000000000001",
                    "att-1",
                    "Which DB?",
                  ),
                  question(
                    "00000000-0000-4000-8000-000000000002",
                    "att-1",
                    "Keep flag?",
                  ),
                ]
              : [],
          next_after_id: null,
        },
      });
    }),
    http.post(
      "*/projects/test-project/attempts/att-1/request-cancellation",
      async ({ request }) => {
        sent = await request.json();
        attempts = [attempt({ cancellation_requested: true, revision: 4 })];
        return HttpResponse.json({
          ok: true,
          result: { attempt: attempts[0], grant_valid: false },
        });
      },
    ),
  );
  renderTask();
  const execution = await screen.findByRole("region", { name: "Execution" });
  expect(await within(execution).findByText("Which DB?")).toBeInTheDocument();
  await user.click(
    await within(execution).findByRole("button", {
      name: "Request cancellation",
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Request cancellation",
  });
  expect(
    within(dialog).getByText(/does not stop the process/),
  ).toBeInTheDocument();
  expect(
    await within(dialog).findByText(
      /2 open questions on this attempt will be superseded/,
    ),
  ).toBeInTheDocument();
  await user.click(
    within(dialog).getByRole("button", { name: "Request cancellation" }),
  );
  await waitFor(() => expect(sent).toMatchObject({ expected_revision: 3 }));
  expect(
    await within(execution).findByText(
      /cancellation requested, stop not yet confirmed/,
    ),
  ).toBeInTheDocument();
  // The request is not a result.
  expect(
    within(execution).getByText("No result recorded yet"),
  ).toBeInTheDocument();
});

test("a failed result shows its evidence, history and a reasoned retry", async () => {
  const user = userEvent.setup();
  attempts = [
    attempt({
      id: "att-2",
      state: "terminal",
      finished_at: Date.now() - 1000,
      outcome: {
        status: "failure",
        reason: "Tests failed",
        evidence: [
          "https://github.com/acme/app/pull/12",
          "artifact:logs/run.txt",
        ],
        execution_stopped: true,
        unresolved_external_execution: false,
      },
    }),
    attempt({
      id: "att-1",
      state: "terminal",
      finished_at: Date.now() - 5000,
      outcome: {
        status: "abandoned",
        evidence: [],
        execution_stopped: true,
        unresolved_external_execution: false,
      },
    }),
  ];
  let sent: { reason?: string; idempotency_key?: string } | undefined;
  server.use(
    http.post(
      "*/projects/test-project/attempts/att-2/retry",
      async ({ request }) => {
        sent = (await request.json()) as typeof sent;
        return HttpResponse.json({
          ok: true,
          result: { attempt: attempts[0] },
        });
      },
    ),
  );
  renderTask();
  const execution = await screen.findByRole("region", { name: "Execution" });
  expect(
    await within(execution).findByRole("link", { name: "PR #12 · acme/app" }),
  ).toHaveAttribute("href", "https://github.com/acme/app/pull/12");
  expect(
    within(execution).getByRole("link", { name: "Artifact logs/run.txt" }),
  ).toHaveAttribute("href", "/p/test-project/artifacts/logs/run.txt");
  expect(within(execution).getByText("Tests failed")).toBeInTheDocument();
  const history = within(execution).getByRole("table", {
    name: "Attempt history",
  });
  expect(within(history).getAllByRole("row")).toHaveLength(3);

  await user.click(within(execution).getByRole("button", { name: "Retry" }));
  const dialog = await screen.findByRole("dialog", { name: "Retry this work" });
  expect(
    within(dialog).getByText(/keeps its failed result and evidence/),
  ).toBeInTheDocument();
  await user.click(
    within(dialog).getByRole("button", { name: "Start a new attempt" }),
  );
  expect(
    within(dialog).getByText("Enter a reason for the retry."),
  ).toBeInTheDocument();
  await user.type(
    within(dialog).getByRole("textbox", { name: /reason/i }),
    "Flaky CI",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Start a new attempt" }),
  );
  await waitFor(() => expect(sent?.reason).toBe("Flaky CI"));
});

test("viewers and non-controllers can inspect but not steer an attempt", async () => {
  role = "viewer";
  attempts = [attempt()];
  const view = renderTask();
  const execution = await screen.findByRole("region", { name: "Execution" });
  await within(execution).findByText(/^Running$/);
  expect(
    within(execution).queryByRole("button", { name: "Request cancellation" }),
  ).not.toBeInTheDocument();
  view.unmount();

  role = "participant";
  server.use(
    http.get("*/projects/test-project/queue", () =>
      HttpResponse.json({
        ok: true,
        result: {
          policy: {
            enabled: true,
            paused: false,
            execution_limit: null,
            wip_limit: null,
            lease_ms: 1,
            revision: 1,
          },
          counts: {
            backlog: 0,
            active: 1,
            suspended: 0,
            uncertain: 0,
            terminal: 0,
            execution: 1,
            wip: 1,
            oldest_waiting_age_ms: null,
          },
          entries: [
            {
              entry: {
                id: "q1",
                task_id: "BUG-1",
                state: "admitted",
                priority: 0,
                enqueue_order: 1,
                required_capabilities: [],
                target_principal: null,
                retry_policy: { retry_safe: false },
                revision: 1,
                available_at: 0,
                created_at: 0,
                updated_at: 0,
                enrolled_by_principal: "github:example:5",
                enrolled_by_participant: "x",
              },
              task: null,
              attempt: null,
              block_reasons: [],
            },
          ],
          total: 1,
          limit: 10,
          offset: 0,
          effective_capabilities: [],
        },
      }),
    ),
  );
  renderTask();
  const again = await screen.findByRole("region", { name: "Execution" });
  expect(
    await within(again).findByText(
      /Only the attempt owner, the principal that enrolled/,
    ),
  ).toBeInTheDocument();
  expect(
    within(again).queryByRole("button", { name: "Request cancellation" }),
  ).not.toBeInTheDocument();
  expect(dashboardParticipantId()).not.toBe("worker-mac");
});

test("a follow-up task links back to the attempt and survives an interrupted link", async () => {
  const user = userEvent.setup();
  attempts = [
    attempt({
      id: "att-2",
      state: "terminal",
      finished_at: 10,
      outcome: {
        status: "success",
        evidence: ["https://github.com/acme/app/pull/12"],
        execution_stopped: true,
        unresolved_external_execution: false,
      },
    }),
  ];
  const creates: unknown[] = [];
  const relationships: unknown[] = [];
  const corrections: Array<{
    idempotency_key: string;
    task_id: string;
    reason: string;
  }> = [];
  let created: { id: string; data: Record<string, unknown> } | null = null;
  let correctFailures = 1;
  server.use(
    http.post("*/projects/test-project/tasks", async ({ request }) => {
      const body = (await request.json()) as {
        id: string;
        data: Record<string, unknown>;
      };
      creates.push(body);
      if (created)
        return HttpResponse.json(
          { ok: false, error: { code: "already-exists", message: "exists" } },
          { status: 409 },
        );
      created = body;
      return HttpResponse.json({ ok: true, entity: body });
    }),
    http.get("*/projects/test-project/tasks/:id", ({ params }) =>
      HttpResponse.json({
        ok: true,
        entity: {
          id: params.id,
          type: "bug",
          schema_version: 1,
          data:
            created && params.id === created.id
              ? created.data
              : { title: "Login fails", status: "open" },
          archived: 0,
          created_at: 1,
          updated_at: 1,
          created_by: "dev",
          tags: [],
        },
        relationships: [],
      }),
    ),
    http.post(
      "*/projects/test-project/tasks/relationships",
      async ({ request }) => {
        relationships.push(await request.json());
        return HttpResponse.json({
          ok: true,
          created: relationships.length === 1,
        });
      },
    ),
    http.post(
      "*/projects/test-project/attempts/att-2/correct",
      async ({ request }) => {
        const body = (await request.json()) as (typeof corrections)[number];
        corrections.push(body);
        if (correctFailures-- > 0) return HttpResponse.error();
        return HttpResponse.json({
          ok: true,
          result: { attempt: attempts[0] },
        });
      },
    ),
  );
  renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/tasks/:id" element={<TaskOrOpened />} />
    </Routes>,
    { route: "/p/test-project/tasks/BUG-1" },
  );
  const execution = await screen.findByRole("region", { name: "Execution" });
  await user.click(
    await within(execution).findByRole("link", {
      name: "Create follow-up task",
    }),
  );
  const drawer = await screen.findByRole("dialog", { name: "Follow-up task" });
  expect(
    await within(drawer).findByRole("textbox", { name: /title/i }),
  ).toHaveValue("Follow-up: Login fails");
  await user.click(within(drawer).getByRole("button", { name: "Create task" }));
  expect(
    within(drawer).getByText("Explain why follow-up work is needed."),
  ).toBeInTheDocument();
  expect(creates).toHaveLength(0);
  await user.type(
    within(drawer).getByRole("textbox", { name: /why is follow-up needed/i }),
    "Regression in login",
  );
  await user.click(within(drawer).getByRole("button", { name: "Create task" }));
  expect(
    await within(drawer).findByText(/follow-up step failed/i),
  ).toBeInTheDocument();
  await user.click(within(drawer).getByRole("button", { name: "Retry" }));
  await screen.findByText(/^Opened T-/);

  const id = (creates[0] as { id: string }).id;
  expect(creates).toHaveLength(2); // the retry recognised the created task
  expect(relationships[0]).toEqual({
    from_id: id,
    to_id: "BUG-1",
    type: "discovered-from",
  });
  expect(corrections).toHaveLength(2);
  expect(corrections[1]).toEqual(corrections[0]);
  expect(corrections[0]).toMatchObject({
    task_id: id,
    reason: "Regression in login",
  });
});
