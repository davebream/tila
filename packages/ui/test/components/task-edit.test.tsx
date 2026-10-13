import { TaskDetailPage } from "@/pages/task-detail";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { emptyQueue } from "../mocks/handlers";
import { server } from "../mocks/server";
import { catalogHandler, declaredEntry } from "../mocks/tasks";
import { renderWithProviders, screen, waitFor } from "../test-utils";

const bug = declaredEntry("bug", 1, {
  fields: [
    { name: "title", type: "string", required: true },
    { name: "notes", type: "text", required: false },
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

let task: {
  id: string;
  type: string;
  data: Record<string, unknown>;
  updated_at: number;
  archived: number;
};

function taskHandler() {
  return http.get("*/projects/test-project/tasks/:id", () =>
    HttpResponse.json({
      ok: true,
      entity: {
        ...task,
        schema_version: 1,
        created_at: 1,
        created_by: "dev",
        tags: [],
      },
      relationships: [],
    }),
  );
}

function renderTask() {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/tasks/:id" element={<TaskDetailPage />} />
    </Routes>,
    { route: "/p/test-project/tasks/BUG-1" },
  );
}

const claimCalls: unknown[] = [];
const releases: unknown[] = [];
const patches: Array<{ body: unknown; key: string | null }> = [];

beforeEach(() => {
  window.sessionStorage.clear();
  claimCalls.length = 0;
  releases.length = 0;
  patches.length = 0;
  task = {
    id: "BUG-1",
    type: "bug",
    data: { title: "Login fails", status: "open", notes: "old", custom: 7 },
    updated_at: 100,
    archived: 0,
  };
  server.use(
    catalogHandler([bug]),
    taskHandler(),
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        token_name: "dev",
        scopes: "write",
        role: "participant",
        principal_id: "github:example:1",
      }),
    ),
    http.post("*/projects/test-project/claims/acquire", async ({ request }) => {
      claimCalls.push(await request.json());
      return HttpResponse.json({
        ok: true,
        fence: 4,
        expires_at: Date.now() + 600_000,
        participant_id: "dashboard-x",
      });
    }),
    http.post("*/projects/test-project/claims/release", async ({ request }) => {
      releases.push(await request.json());
      return HttpResponse.json({ ok: true });
    }),
    http.patch("*/projects/test-project/tasks/BUG-1", async ({ request }) => {
      const body = (await request.json()) as { data: Record<string, unknown> };
      patches.push({ body, key: request.headers.get("Idempotency-Key") });
      task = { ...task, data: { ...task.data, ...body.data }, updated_at: 200 };
      return HttpResponse.json({ ok: true, entity: task });
    }),
  );
});

test("edits under a claim and sends only changed fields with its fence", async () => {
  const user = userEvent.setup();
  renderTask();
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByText(/You hold the edit claim/);
  expect(claimCalls[0]).toMatchObject({
    resource: "bug:BUG-1",
    mode: "exclusive",
  });
  const notes = screen.getByRole("textbox", { name: /notes/i });
  await user.clear(notes);
  await user.type(notes, "new");
  await user.selectOptions(
    screen.getByRole("combobox", { name: /status/i }),
    "done",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(patches).toHaveLength(1));
  // Undeclared `custom` and unchanged `title` are left alone (merge update).
  expect(patches[0].body).toEqual({
    data: { notes: "new", status: "done" },
    fence: 4,
  });
  expect(patches[0].key).toBeTruthy();
  await waitFor(() =>
    expect(releases).toEqual([{ resource: "bug:BUG-1", fence: 4 }]),
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
});

test("a change made elsewhere while editing is a conflict that keeps the draft", async () => {
  const user = userEvent.setup();
  renderTask();
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByText(/You hold the edit claim/);
  const notes = screen.getByRole("textbox", { name: /notes/i });
  await user.clear(notes);
  await user.type(notes, "mine");
  // Someone else saved a different value before our save.
  task = { ...task, data: { ...task.data, notes: "theirs" }, updated_at: 150 };
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText(/changed after you started editing/i),
  ).toBeInTheDocument();
  expect(patches).toHaveLength(0);
  expect(screen.getByRole("textbox", { name: /notes/i })).toHaveValue("mine");
  // Saving needs an explicit decision to apply the draft on the latest version.
  await user.click(
    await screen.findByRole("button", {
      name: "Keep my draft on the latest version",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].body).toMatchObject({ data: { notes: "mine" } });
});

test("someone else's claim blocks editing without losing the draft", async () => {
  const user = userEvent.setup();
  server.use(
    http.post("*/projects/test-project/claims/acquire", () =>
      HttpResponse.json(
        {
          ok: false,
          error: { code: "already-held", message: "Resource already held" },
        },
        { status: 409 },
      ),
    ),
  );
  renderTask();
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  expect(
    await screen.findByText(/Someone else holds this task's claim/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("queue-managed work edits content without a claim and hides its lifecycle", async () => {
  const user = userEvent.setup();
  server.use(
    http.get("*/projects/test-project/queue", () =>
      HttpResponse.json({
        ok: true,
        result: {
          ...emptyQueue(),
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
                retry_policy: { max_attempts: 1 },
                revision: 1,
                available_at: 0,
                created_at: 0,
                updated_at: 0,
                enrolled_by_principal: null,
                enrolled_by_participant: null,
              },
              task: null,
              attempt: null,
              block_reasons: [],
            },
          ],
          total: 1,
        },
      }),
    ),
  );
  renderTask();
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  expect(
    await screen.findByText(/changes only through its attempt/i),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: /status/i }),
  ).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: /notes/i }), "!");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].body).toEqual({ data: { notes: "old!" }, fence: 0 });
  expect(claimCalls).toHaveLength(0);
});

test("undeclared legacy types stay readable but not editable", async () => {
  task = { ...task, type: "legacy" };
  renderTask();
  const edit = await screen.findByRole("button", { name: "Edit" });
  expect(edit).toBeDisabled();
  expect(
    screen.getByText(
      /is not in the current schema, so its tasks are read-only/,
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Open definitions" }),
  ).toHaveAttribute("href", "/p/test-project/settings/definitions");
});

test("viewers see why editing is unavailable", async () => {
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        token_name: "dev",
        scopes: "read",
        role: "viewer",
        principal_id: "github:example:2",
      }),
    ),
  );
  renderTask();
  expect(await screen.findByRole("button", { name: "Edit" })).toBeDisabled();
  expect(
    screen.getByText("This credential cannot edit tasks of this type."),
  ).toBeInTheDocument();
});

test("closing the editor before the claim arrives releases it", async () => {
  const user = userEvent.setup();
  let answer: () => void = () => undefined;
  server.use(
    http.post("*/projects/test-project/claims/acquire", async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return HttpResponse.json({
        ok: true,
        fence: 9,
        expires_at: Date.now() + 600_000,
        participant_id: "dashboard-x",
      });
    }),
  );
  renderTask();
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByText(/Claiming this task for editing/);
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  answer();
  await waitFor(() =>
    expect(releases).toEqual([{ resource: "bug:BUG-1", fence: 9 }]),
  );
});

test("a lost save that was applied is not sent again after the claim changed", async () => {
  const user = userEvent.setup();
  let fence = 4;
  server.use(
    http.post("*/projects/test-project/claims/acquire", () =>
      HttpResponse.json({
        ok: true,
        fence: fence++,
        expires_at: Date.now() + 600_000,
        participant_id: "dashboard-x",
      }),
    ),
    http.patch("*/projects/test-project/tasks/BUG-1", async ({ request }) => {
      const body = (await request.json()) as { data: Record<string, unknown> };
      patches.push({ body, key: request.headers.get("Idempotency-Key") });
      task = { ...task, data: { ...task.data, ...body.data }, updated_at: 300 };
      return HttpResponse.error(); // Applied, but the response was lost.
    }),
  );
  renderTask();
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByText(/You hold the edit claim/);
  const notes = screen.getByRole("textbox", { name: /notes/i });
  await user.clear(notes);
  await user.type(notes, "saved");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText(/did not confirm the save/),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument(),
  );
  expect(patches).toHaveLength(1);
});
