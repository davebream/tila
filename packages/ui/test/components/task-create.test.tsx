import { TaskCreateDrawer } from "@/components/work/task-create";
import { TasksPage } from "@/pages/tasks";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes, useParams } from "react-router";
import { server } from "../mocks/server";
import { catalogHandler, declaredEntry } from "../mocks/tasks";
import { renderWithProviders, screen, waitFor } from "../test-utils";

const bug = declaredEntry("bug", 0, {
  fields: [
    { name: "title", type: "string", required: true },
    {
      name: "status",
      type: "enum",
      required: false,
      values: ["open", "done"],
      default: "open",
    },
  ],
  presentation: { title: "title" },
});

function whoami(overrides: Record<string, unknown> = {}) {
  return http.get("*/api/whoami", () =>
    HttpResponse.json({
      ok: true,
      project_id: "test-project",
      token_name: "dev",
      scopes: "write",
      role: "participant",
      principal_id: "github:example:1",
      ...overrides,
    }),
  );
}

function Created() {
  const { id } = useParams();
  return <p>Opened {id}</p>;
}

function renderCreate(route = "/p/test-project/tasks?create=task") {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/tasks" element={<TaskCreateDrawer />} />
      <Route path="/p/:projectId/tasks/:id" element={<Created />} />
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  server.use(
    whoami(),
    catalogHandler([
      bug,
      {
        type: "legacy",
        declaration: "undeclared",
        count: 3,
        archived_count: 0,
      },
    ]),
    http.get("*/projects/*/templates", () =>
      HttpResponse.json({
        ok: true,
        templates: [
          {
            name: "hotfix",
            type: "bug",
            description: "Regression fix",
            entity_count: 1,
            entity_types: ["bug"],
            variables: ["area"],
            entities: [{ key: "root", type: "bug", id_suffix: "" }],
          },
        ],
      }),
    ),
  );
});

test("creates a declared task with declared defaults and an idempotency key", async () => {
  const user = userEvent.setup();
  const sent: Array<{ body: unknown; key: string | null }> = [];
  server.use(
    http.post("*/projects/test-project/tasks", async ({ request }) => {
      sent.push({
        body: await request.json(),
        key: request.headers.get("Idempotency-Key"),
      });
      return HttpResponse.json({ ok: true, entity: {} });
    }),
  );
  renderCreate();
  const type = await screen.findByRole("combobox", { name: /type/i });
  // Undeclared types cannot get new tasks.
  expect(
    screen.queryByRole("option", { name: "legacy" }),
  ).not.toBeInTheDocument();
  await user.selectOptions(type, "bug");
  await user.type(
    screen.getByRole("textbox", { name: /title/i }),
    "Login fails",
  );
  await user.click(screen.getByRole("button", { name: "Create task" }));
  const opened = await screen.findByText(/^Opened T-/);
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({
    type: "bug",
    data: { title: "Login fails", status: "open" },
  });
  expect(sent[0].key).toMatch(/[0-9a-f-]{36}/);
  expect(opened.textContent).toBe(
    `Opened ${(sent[0].body as { id: string }).id}`,
  );
});

test("a lost response is retried with the same request and recognised as created", async () => {
  const user = userEvent.setup();
  const sent: Array<{
    body: { id: string; data: unknown };
    key: string | null;
  }> = [];
  let stored: { id: string; data: unknown } | null = null;
  server.use(
    http.post("*/projects/test-project/tasks", async ({ request }) => {
      const body = (await request.json()) as { id: string; data: unknown };
      sent.push({ body, key: request.headers.get("Idempotency-Key") });
      if (!stored) {
        stored = body;
        return HttpResponse.error(); // Applied, but the response was lost.
      }
      return HttpResponse.json(
        { ok: false, error: { code: "already-exists", message: "exists" } },
        { status: 409 },
      );
    }),
    http.get("*/projects/test-project/tasks/:id", ({ params }) =>
      HttpResponse.json({
        ok: true,
        entity: {
          id: params.id,
          type: "bug",
          schema_version: 1,
          data: stored?.data ?? {},
          archived: 0,
          created_at: 1,
          updated_at: 1,
          created_by: "dev",
          tags: [],
        },
        relationships: [],
      }),
    ),
  );
  renderCreate();
  await user.selectOptions(
    await screen.findByRole("combobox", { name: /type/i }),
    "bug",
  );
  await user.type(screen.getByRole("textbox", { name: /title/i }), "Retry me");
  await user.click(screen.getByRole("button", { name: "Create task" }));
  expect(await screen.findByText(/did not confirm/i)).toBeInTheDocument();
  // Inputs are locked so the retry cannot drop later edits.
  expect(screen.getByRole("textbox", { name: /title/i })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(/^Opened T-/);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
});

test("a different task holding the ID keeps the input and asks for another ID", async () => {
  const user = userEvent.setup();
  server.use(
    http.post("*/projects/test-project/tasks", () =>
      HttpResponse.json(
        { ok: false, error: { code: "already-exists", message: "exists" } },
        { status: 409 },
      ),
    ),
    http.get("*/projects/test-project/tasks/:id", ({ params }) =>
      HttpResponse.json({
        ok: true,
        entity: {
          id: params.id,
          type: "bug",
          schema_version: 1,
          data: { title: "Someone else's" },
          archived: 0,
          created_at: 1,
          updated_at: 1,
          created_by: "other",
          tags: [],
        },
        relationships: [],
      }),
    ),
  );
  renderCreate();
  await user.selectOptions(
    await screen.findByRole("combobox", { name: /type/i }),
    "bug",
  );
  await user.type(screen.getByRole("textbox", { name: /title/i }), "Mine");
  await user.click(screen.getByRole("button", { name: "Create task" }));
  expect(
    await screen.findByText(/different task already uses this ID/i),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: /title/i })).toHaveValue("Mine");
  expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
});

test("instantiates a template with its declared variables", async () => {
  const user = userEvent.setup();
  let body: unknown;
  server.use(
    http.post(
      "*/projects/test-project/templates/instantiate",
      async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          ok: true,
          created_entities: ["HF-1"],
          created_relationships: 0,
          journal_seq: 3,
        });
      },
    ),
  );
  renderCreate();
  await user.click(await screen.findByRole("radio", { name: "From template" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: /template/i }),
    "hotfix",
  );
  const root = screen.getByRole("textbox", { name: /root task id/i });
  await user.clear(root);
  await user.type(root, "HF-1");
  await user.click(
    screen.getByRole("button", { name: "Create from template" }),
  );
  expect(await screen.findByText("Required.")).toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: /area/i }), "login");
  expect(screen.getByText("HF-1")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Create from template" }),
  );
  await screen.findByText("Opened HF-1");
  expect(body).toEqual({
    template_name: "hotfix",
    root_id: "HF-1",
    vars: { area: "login" },
  });
});

test("keeps the draft in this tab after closing and reopening", async () => {
  const user = userEvent.setup();
  const view = renderCreate();
  await user.selectOptions(
    await screen.findByRole("combobox", { name: /type/i }),
    "bug",
  );
  await user.type(screen.getByRole("textbox", { name: /title/i }), "Draft");
  await waitFor(() =>
    expect(JSON.stringify(window.sessionStorage)).toContain("Draft"),
  );
  view.unmount();
  renderCreate();
  expect(await screen.findByRole("textbox", { name: /title/i })).toHaveValue(
    "Draft",
  );
});

test("the task list offers creation only to credentials that may create a type", async () => {
  server.use(whoami({ role: "viewer" }));
  const { unmount } = renderWithProviders(<TasksPage />, {
    route: "/p/test-project/tasks",
  });
  await screen.findByRole("heading", { name: "Tasks" });
  await waitFor(() =>
    expect(
      screen.queryByRole("link", { name: /new task/i }),
    ).not.toBeInTheDocument(),
  );
  unmount();
  server.use(
    whoami({
      policy: {
        role: "participant",
        capabilities: ["tasks:read", "tasks:write"],
        restrictions: { task_types: ["bug"] },
      },
    }),
  );
  renderWithProviders(<TasksPage />, { route: "/p/test-project/tasks" });
  expect(
    await screen.findByRole("link", { name: /new task/i }),
  ).toHaveAttribute("href", "/p/test-project/tasks?create=task");
});

test("a first template send that finds the root taken is not reported as created", async () => {
  const user = userEvent.setup();
  server.use(
    http.post("*/projects/test-project/templates/instantiate", () =>
      HttpResponse.json(
        { ok: false, error: { code: "already-exists", message: "exists" } },
        { status: 409 },
      ),
    ),
    // An earlier, unrelated instantiation left a task of the same type there.
    http.get("*/projects/test-project/tasks/:id", ({ params }) =>
      HttpResponse.json({
        ok: true,
        entity: {
          id: params.id,
          type: "bug",
          schema_version: 1,
          data: { title: "Fix billing" },
          archived: 0,
          created_at: 1,
          updated_at: 1,
          created_by: "other",
          tags: [],
        },
        relationships: [],
      }),
    ),
  );
  renderCreate();
  await user.click(await screen.findByRole("radio", { name: "From template" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: /template/i }),
    "hotfix",
  );
  const root = screen.getByRole("textbox", { name: /root task id/i });
  await user.clear(root);
  await user.type(root, "HF-1");
  await user.type(screen.getByRole("textbox", { name: /area/i }), "login");
  await user.click(
    screen.getByRole("button", { name: "Create from template" }),
  );
  expect(
    await screen.findByText(/A task with one of these IDs already exists/),
  ).toBeInTheDocument();
  expect(screen.queryByText(/^Opened/)).not.toBeInTheDocument();
});
