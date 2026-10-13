import { SettingsRepositoriesPage } from "@/pages/settings-repositories";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { sessionStatusWith } from "../mocks/admin-fixtures";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const route = "/p/test-project/settings/repositories";

function link(overrides: Record<string, unknown> = {}) {
  return {
    github_host: "github.com",
    github_owner: "acme",
    github_repo: "widgets",
    github_repo_id: 12345,
    created_at: 1_760_000_000,
    created_by: "octocat",
    access_policy: {
      min_read_permission: "read",
      min_write_permission: "write",
      max_permission: "write",
      membership_enabled: false,
      membership_role_cap: "participant",
    },
    access_policy_revision: 2,
    oidc_policy: {
      enabled: false,
      max_permission: "read",
      subject_pattern: null,
      allowed_events: [],
      allowed_refs: [],
      allowed_environments: [],
      allowed_workflows: [],
    },
    oidc_policy_revision: 1,
    ...overrides,
  };
}

type Sent = { method: string; path: string; body: unknown };

const stepUpRequired = () =>
  HttpResponse.json(
    {
      ok: false,
      error: { code: "step-up-required", message: "Re-authenticate" },
    },
    { status: 403 },
  );

function reposApi(
  answers: Partial<
    Record<
      "access" | "oidc" | "remove" | "register",
      Array<(() => Response) | null>
    >
  > = {},
) {
  const state = { repos: [link()] };
  let lists = 0;
  const sent: Sent[] = [];
  const counts: Record<string, number> = {};
  const answer = (kind: keyof typeof answers, fallback: () => Response) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    const next = answers[kind]?.[counts[kind] - 1];
    return next ? next() : fallback();
  };
  const record = async (request: Request) => {
    const url = new URL(request.url);
    const text = await request.text();
    sent.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      body: text ? JSON.parse(text) : undefined,
    });
    return text ? JSON.parse(text) : undefined;
  };
  server.use(
    http.get("*/api/repos", () => {
      lists++;
      return HttpResponse.json({ ok: true, repos: state.repos });
    }),
    http.put("*/api/repos/:id/access-policy", async ({ request }) => {
      const body = await record(request);
      return answer("access", () => {
        const { expected_revision: _, ...policy } = body;
        state.repos = [
          link({
            ...state.repos[0],
            access_policy: policy,
            access_policy_revision: state.repos[0].access_policy_revision + 1,
          }),
        ];
        return HttpResponse.json({ ok: true, policy, revision: 3 });
      });
    }),
    http.put("*/api/repos/:id/oidc-policy", async ({ request }) => {
      const body = await record(request);
      return answer("oidc", () => {
        const { expected_revision: _, ...policy } = body;
        return HttpResponse.json({ ok: true, policy, revision: 2 });
      });
    }),
    http.delete("*/api/repos/:id", async ({ request }) => {
      await record(request);
      return answer("remove", () => {
        state.repos = [];
        return HttpResponse.json({
          ok: true,
          github_repo_id: 12345,
          removed_at: 1,
        });
      });
    }),
    http.post("*/api/repos", async ({ request }) => {
      await record(request);
      return answer("register", () =>
        HttpResponse.json(
          {
            ok: true,
            github_repo_id: 777,
            full_name: "acme/gadgets",
            registered_at: 1,
          },
          { status: 201 },
        ),
      );
    }),
  );
  return { state, sent, lists: () => lists };
}

function renderPage() {
  return renderWithProviders(<SettingsRepositoriesPage />, { route });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

test("without repository_policy_manage the list is never requested and no control renders", async () => {
  server.use(sessionStatusWith({ repository_policy_manage: false }));
  const api = reposApi();
  renderPage();

  expect(await screen.findByText(/Only a project owner/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Link repository" })).toBeNull();
  expect(screen.queryByRole("table", { name: "Repositories" })).toBeNull();
  expect(api.lists()).toBe(0);
  expect(api.sent).toEqual([]);
});

test("an owner sees each link with both policies and their revisions", async () => {
  server.use(sessionStatusWith({ repository_policy_manage: true }));
  reposApi();
  renderPage();

  const table = await screen.findByRole("table", { name: "Repositories" });
  const row = within(table).getByText("acme/widgets").closest("tr");
  if (!row) throw new Error("row missing");
  expect(row).toHaveTextContent("read ≥ read · write ≥ write · max write");
  expect(row).toHaveTextContent("mirroring off · revision 2");
  expect(row).toHaveTextContent("off");
  expect(
    within(row).getByRole("button", { name: "Remove acme/widgets" }),
  ).toBeInTheDocument();
});

test("a conflicting access-policy save keeps the edits and keeps the other change", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ repository_policy_manage: true }));
  const api = reposApi({
    access: [
      () => {
        // Someone raised the ceiling to admin meanwhile.
        api.state.repos = [
          link({
            access_policy: { ...link().access_policy, max_permission: "admin" },
            access_policy_revision: 3,
          }),
        ];
        return HttpResponse.json(
          {
            ok: false,
            error: {
              code: "revision-conflict",
              message: "changed; current revision is 3",
              revision: 3,
              resource: "repo:github.com/12345:access-policy",
            },
          },
          { status: 412 },
        );
      },
      null,
    ],
  });
  renderPage();
  await user.click(
    await screen.findByRole("button", {
      name: "Access policy for acme/widgets",
    }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: /Access policy · acme\/widgets/,
  });
  await user.selectOptions(
    within(drawer).getByRole("combobox", { name: "To write" }),
    "maintain",
  );
  await user.click(within(drawer).getByRole("button", { name: "Save policy" }));

  expect(
    await within(drawer).findByText(/Another change landed \(revision 3\)/),
  ).toHaveTextContent("It changed the highest permission.");
  await user.click(
    within(drawer).getByRole("button", { name: "Keep my edits on revision 3" }),
  );
  expect(
    within(drawer).getByRole("combobox", { name: "To write" }),
  ).toHaveValue("maintain");
  expect(
    within(drawer).getByRole("combobox", { name: /Highest tila permission/ }),
  ).toHaveValue("admin");
  await user.click(within(drawer).getByRole("button", { name: "Save policy" }));
  expect(
    await screen.findByText("Saved the access policy of acme/widgets."),
  ).toBeInTheDocument();

  expect(api.sent.map((s) => s.path)).toEqual([
    "/api/repos/12345/access-policy?host=github.com",
    "/api/repos/12345/access-policy?host=github.com",
  ]);
  expect(api.sent[0].body).toMatchObject({
    expected_revision: 2,
    min_write_permission: "maintain",
    max_permission: "write",
  });
  expect(api.sent[1].body).toEqual({
    min_read_permission: "read",
    min_write_permission: "maintain",
    max_permission: "admin",
    membership_enabled: false,
    membership_role_cap: "participant",
    expected_revision: 3,
  });
});

test("a read threshold above the write threshold is refused before sending", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ repository_policy_manage: true }));
  const api = reposApi();
  renderPage();
  await user.click(
    await screen.findByRole("button", {
      name: "Access policy for acme/widgets",
    }),
  );
  const drawer = await screen.findByRole("dialog", { name: /Access policy/ });
  await user.selectOptions(
    within(drawer).getByRole("combobox", { name: "To read" }),
    "admin",
  );
  await user.click(within(drawer).getByRole("button", { name: "Save policy" }));
  expect(
    within(drawer).getByText(
      "The write threshold must be at least the read threshold.",
    ),
  ).toBeInTheDocument();
  expect(api.sent).toEqual([]);
});

test("an enabled OIDC policy needs an event and sends lists and the revision", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ repository_policy_manage: true }));
  const api = reposApi();
  renderPage();
  await user.click(
    await screen.findByRole("button", {
      name: "Actions OIDC policy for acme/widgets",
    }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: /Actions OIDC · acme\/widgets/,
  });
  await user.click(
    within(drawer).getByRole("checkbox", { name: /Allow Actions runs/ }),
  );
  await user.click(within(drawer).getByRole("button", { name: "Save policy" }));
  expect(
    within(drawer).getByText(
      "An enabled policy must allow at least one event.",
    ),
  ).toBeInTheDocument();
  expect(api.sent).toEqual([]);

  await user.type(
    within(drawer).getByRole("textbox", { name: /^Events/ }),
    "push{enter}push{enter}workflow_dispatch",
  );
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Refs/ }),
    "refs/heads/main",
  );
  await user.click(within(drawer).getByRole("button", { name: "Save policy" }));
  expect(
    await screen.findByText("Saved the Actions OIDC policy of acme/widgets."),
  ).toBeInTheDocument();
  expect(api.sent[0]).toEqual({
    method: "PUT",
    path: "/api/repos/12345/oidc-policy?host=github.com",
    body: {
      enabled: true,
      max_permission: "read",
      subject_pattern: null,
      allowed_events: ["push", "workflow_dispatch"],
      allowed_refs: ["refs/heads/main"],
      allowed_environments: [],
      allowed_workflows: [],
      expected_revision: 1,
    },
  });
});

test("step-up closes the drawer, shows the banner and keeps the draft for later", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ repository_policy_manage: true }));
  reposApi({ access: [stepUpRequired] });
  renderPage();
  await user.click(
    await screen.findByRole("button", {
      name: "Access policy for acme/widgets",
    }),
  );
  let drawer = await screen.findByRole("dialog", { name: /Access policy/ });
  await user.selectOptions(
    within(drawer).getByRole("combobox", { name: "To write" }),
    "admin",
  );
  await user.click(within(drawer).getByRole("button", { name: "Save policy" }));

  expect(
    await screen.findByText(/Owner changes require a sign-in newer than/),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await user.click(
    screen.getByRole("button", { name: "Access policy for acme/widgets" }),
  );
  drawer = await screen.findByRole("dialog", { name: /Access policy/ });
  expect(
    within(drawer).getByRole("combobox", { name: "To write" }),
  ).toHaveValue("admin");
});

test("removing a link is confirmed by typing owner/repo and keeps explicit memberships", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ repository_policy_manage: true }));
  const api = reposApi();
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Remove acme/widgets" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Remove acme/widgets",
  });
  expect(dialog).toHaveTextContent("Explicit memberships are not removed");
  const confirm = within(dialog).getByRole("button", { name: "Remove link" });
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByRole("textbox"), "acme/widgets");
  await user.click(confirm);

  expect(
    await screen.findByText(
      /Removed the link to acme\/widgets\. Explicit memberships were kept\./,
    ),
  ).toBeInTheDocument();
  expect(api.sent).toEqual([
    {
      method: "DELETE",
      path: "/api/repos/12345?host=github.com&expected_revision=2",
      body: undefined,
    },
  ]);
});

test("linking reports a repository GitHub cannot find", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ repository_policy_manage: true }));
  const api = reposApi({
    register: [
      () =>
        HttpResponse.json(
          {
            ok: false,
            error: { code: "repo-not-found", message: "not found" },
          },
          { status: 404 },
        ),
      null,
    ],
  });
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Link repository" }),
  );
  const drawer = await screen.findByRole("dialog", { name: "Link repository" });
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Owner/ }),
    "acme",
  );
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Repository/ }),
    "gadgets",
  );
  await user.click(
    within(drawer).getByRole("button", { name: "Link repository" }),
  );
  expect(
    await within(drawer).findByText(/GitHub has no repository acme\/gadgets/),
  ).toBeInTheDocument();

  await user.click(
    within(drawer).getByRole("button", { name: "Link repository" }),
  );
  expect(await screen.findByText(/Linked acme\/gadgets\./)).toBeInTheDocument();
  expect(api.sent[0].body).toEqual({
    owner: "acme",
    repo: "gadgets",
    github_host: "github.com",
  });
});
