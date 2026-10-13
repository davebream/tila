import { SettingsSignalGroupsPage } from "@/pages/settings-signal-groups";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const NOW = Date.now();

function groupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "oncall",
    name: "On call",
    principal_ids: ["github:github.com:1", "github:github.com:2"],
    revision: 4,
    created_at: NOW - 86_400_000,
    updated_at: NOW - 3_600_000,
    ...overrides,
  };
}

type Sent = { method: string; path: string; body: unknown; key: string | null };

function groupsApi(
  initial: Array<ReturnType<typeof groupRow>>,
  answers: Partial<
    Record<"put" | "delete", Array<(() => Response) | null>>
  > = {},
) {
  const state = { groups: initial };
  const sent: Sent[] = [];
  const counts: Record<string, number> = {};
  const answer = (kind: keyof typeof answers, fallback: () => Response) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    const next = answers[kind]?.[counts[kind] - 1];
    return next ? next() : fallback();
  };
  server.use(
    http.get("*/projects/test-project/signals/groups", () =>
      HttpResponse.json({ ok: true, groups: state.groups }),
    ),
    http.put(
      "*/projects/test-project/signals/groups/:id",
      async ({ request, params }) => {
        const body = (await request.json()) as {
          name: string;
          principal_ids: string[];
          expected_revision: number;
        };
        sent.push({
          method: "PUT",
          path: new URL(request.url).pathname,
          body,
          key: request.headers.get("Idempotency-Key"),
        });
        return answer("put", () => {
          const group = groupRow({
            id: params.id,
            name: body.name,
            principal_ids: body.principal_ids,
            revision: body.expected_revision + 1,
          });
          state.groups = [
            ...state.groups.filter((g) => g.id !== params.id),
            group,
          ];
          return HttpResponse.json({ ok: true, group });
        });
      },
    ),
    http.delete(
      "*/projects/test-project/signals/groups/:id",
      ({ request, params }) => {
        const url = new URL(request.url);
        sent.push({
          method: "DELETE",
          path: `${url.pathname}${url.search}`,
          body: undefined,
          key: request.headers.get("Idempotency-Key"),
        });
        return answer("delete", () => {
          state.groups = state.groups.filter((g) => g.id !== params.id);
          return HttpResponse.json({ ok: true });
        });
      },
    ),
  );
  return { state, sent };
}

function whoamiAs(role: string, capabilities?: string[]) {
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        principal_id: `principal-${role}`,
        token_name: "test-user",
        scopes: "admin",
        role,
        ...(capabilities ? { policy: { role, capabilities } } : {}),
      }),
    ),
  );
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/settings/signal-groups"
        element={<SettingsSignalGroupsPage />}
      />
    </Routes>,
    { route: "/p/test-project/settings/signal-groups" },
  );
}

const conflict = (revision: number) => () =>
  HttpResponse.json(
    {
      ok: false,
      error: {
        code: "revision-conflict",
        message: `signal-group:oncall changed; current revision is ${revision}`,
        revision,
        resource: "signal-group:oncall",
      },
    },
    { status: 412 },
  );

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("capabilities", () => {
  test.each([
    ["viewer", undefined],
    ["participant", undefined],
    ["maintainer", ["signals:read", "signals:send"]],
  ])(
    "a %s without signals:manage reads groups but gets no controls",
    async (role, capabilities) => {
      whoamiAs(role, capabilities);
      const api = groupsApi([groupRow()]);
      renderPage();

      expect(
        await screen.findByText(
          /You can view signal groups but not manage them/,
        ),
      ).toBeInTheDocument();
      const table = await screen.findByRole("table", { name: "Signal groups" });
      expect(within(table).getByText("On call")).toBeInTheDocument();
      for (const name of ["Create group", "Edit oncall", "Delete oncall"])
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(api.sent).toEqual([]);
    },
  );

  test("a maintainer gets the controls", async () => {
    whoamiAs("maintainer");
    groupsApi([groupRow()]);
    renderPage();
    await screen.findByRole("table", { name: "Signal groups" });
    expect(
      screen.getByRole("button", { name: "Create group" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit oncall" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete oncall" }),
    ).toBeInTheDocument();
  });
});

test("creating is create-only: an existing ID is reported, not overwritten", async () => {
  const user = userEvent.setup();
  const api = groupsApi([], { put: [conflict(3), null] });
  renderPage();
  expect(await screen.findByText("No signal groups.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Create group" }));
  const drawer = await screen.findByRole("dialog", {
    name: "Create signal group",
  });
  await user.type(
    within(drawer).getByRole("textbox", { name: /^ID/ }),
    "oncall",
  );
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Name/ }),
    "On call",
  );
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Members/ }),
    "github:github.com:1{enter}github:github.com:1{enter}github:github.com:3",
  );
  await user.click(
    within(drawer).getByRole("button", { name: "Create group" }),
  );

  expect(
    await within(drawer).findByText(
      /A group with this ID already exists \(revision 3\)/,
    ),
  ).toBeInTheDocument();
  const [first] = api.sent;
  expect(first).toMatchObject({
    path: "/projects/test-project/signals/groups/oncall",
    body: {
      name: "On call",
      principal_ids: ["github:github.com:1", "github:github.com:3"],
      expected_revision: 0,
    },
  });

  const id = within(drawer).getByRole("textbox", { name: /^ID/ });
  await user.clear(id);
  await user.type(id, "oncall-2");
  await user.click(
    within(drawer).getByRole("button", { name: "Create group" }),
  );
  expect(await screen.findByText("Created oncall-2.")).toBeInTheDocument();
  expect(api.sent[1].path).toBe(
    "/projects/test-project/signals/groups/oncall-2",
  );
  expect(api.sent[1].key).not.toBe(first.key);
});

test("an edit replaces the group at the revision it opened on and reports a conflict", async () => {
  const user = userEvent.setup();
  const api = groupsApi([groupRow()], {
    put: [
      () => {
        api.state.groups = [groupRow({ name: "Pager", revision: 6 })];
        return conflict(6)();
      },
      null,
    ],
  });
  renderPage();
  await user.click(await screen.findByRole("button", { name: "Edit oncall" }));
  const drawer = await screen.findByRole("dialog", {
    name: "Signal group oncall",
  });
  const members = within(drawer).getByRole("textbox", { name: /^Members/ });
  await user.type(members, "{enter}github:github.com:3");
  await user.click(
    within(drawer).getByRole("button", { name: "Save changes" }),
  );

  expect(
    await within(drawer).findByText(/Another change landed \(revision 6\)/),
  ).toHaveTextContent("It changed the name.");
  await user.click(
    within(drawer).getByRole("button", { name: "Keep my edits on revision 6" }),
  );
  await user.click(
    within(drawer).getByRole("button", { name: "Save changes" }),
  );
  expect(
    await screen.findByText("Saved oncall as revision 7."),
  ).toBeInTheDocument();
  expect(api.sent.map((s) => s.body)).toEqual([
    {
      name: "On call",
      principal_ids: [
        "github:github.com:1",
        "github:github.com:2",
        "github:github.com:3",
      ],
      expected_revision: 4,
    },
    {
      name: "Pager",
      principal_ids: [
        "github:github.com:1",
        "github:github.com:2",
        "github:github.com:3",
      ],
      expected_revision: 6,
    },
  ]);
});

test("delete names the revision on screen and says past deliveries are unchanged", async () => {
  const user = userEvent.setup();
  const api = groupsApi([groupRow()], {
    delete: [
      () => {
        api.state.groups = [groupRow({ revision: 5 })];
        return conflict(5)();
      },
      null,
    ],
  });
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Delete oncall" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Delete signal group oncall",
  });
  expect(dialog).toHaveTextContent(
    "Signals already sent to it are not changed or cancelled",
  );
  await user.type(within(dialog).getByRole("textbox"), "oncall");
  await user.click(
    within(dialog).getByRole("button", { name: "Delete group" }),
  );

  expect(
    await within(dialog).findByText(/The group changed \(revision 5\)/),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(dialog).toHaveTextContent("Revision 5 · 2 members"),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Delete group" }),
  );
  expect(
    await screen.findByText(
      /Deleted oncall\. Signals already sent to it keep their recipients/,
    ),
  ).toBeInTheDocument();
  expect(api.sent.map((s) => s.path)).toEqual([
    "/projects/test-project/signals/groups/oncall?expected_revision=4",
    "/projects/test-project/signals/groups/oncall?expected_revision=5",
  ]);
  expect(api.sent[1].key).not.toBe(api.sent[0].key);
});
