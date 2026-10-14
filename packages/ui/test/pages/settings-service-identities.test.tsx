import { SettingsServiceIdentitiesPage } from "@/pages/settings-service-identities";
import userEvent from "@testing-library/user-event";
import { CREDENTIAL_PRESETS } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { serviceAccounts, sessionStatusWith } from "../mocks/admin-fixtures";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const route = "/p/test-project/settings/service-identities";
const CI = serviceAccounts[0];

const binding = {
  revision: 1,
  binding_id: "b-1",
  principal_id: CI.principal_id,
  project_id: "test-project",
  name: "deploy",
  provider: "github-actions",
  issuer: "https://token.actions.githubusercontent.com",
  subject: "repo:acme/widgets:ref:refs/heads/main",
  policy: CREDENTIAL_PRESETS["read-only"],
  created_at: 1_760_000_000,
  created_by: "github:github.com:1",
  revoked_at: null,
};

type Sent = { method: string; path: string; body: unknown };

function servicesApi(
  answers: Partial<Record<string, Array<(() => Response) | null>>> = {},
) {
  let lists = 0;
  const sent: Sent[] = [];
  const counts: Record<string, number> = {};
  const respond = async (
    kind: string,
    request: Request,
    fallback: () => Response,
  ) => {
    const url = new URL(request.url);
    const text = await request.text();
    sent.push({
      method: request.method,
      path: url.pathname,
      body: text ? JSON.parse(text) : undefined,
    });
    counts[kind] = (counts[kind] ?? 0) + 1;
    const next = answers[kind]?.[counts[kind] - 1];
    return next ? next() : fallback();
  };
  server.use(
    http.get("*/projects/test-project/service-accounts", () => {
      lists++;
      const answer = answers.list?.[lists - 1];
      return answer
        ? answer()
        : HttpResponse.json({ ok: true, service_accounts: serviceAccounts });
    }),
    http.get(
      "*/projects/test-project/service-accounts/:id/workload-bindings",
      ({ request }) =>
        respond("bindings", request, () =>
          HttpResponse.json({ ok: true, bindings: [binding] }),
        ),
    ),
    http.post("*/projects/test-project/service-accounts", ({ request }) =>
      respond("create", request, () =>
        HttpResponse.json(
          {
            ok: true,
            service_account: {
              ...CI,
              principal_id: "service:33333333-3333-4333-8333-333333333333",
              name: "nightly",
              display_name: "Nightly job",
            },
          },
          { status: 201 },
        ),
      ),
    ),
    http.patch("*/projects/test-project/service-accounts/:id", ({ request }) =>
      respond("rename", request, () =>
        HttpResponse.json({
          ok: true,
          service_account: { ...CI, display_name: "CI runner" },
        }),
      ),
    ),
    http.delete("*/projects/test-project/service-accounts/:id", ({ request }) =>
      respond("revoke", request, () => HttpResponse.json({ ok: true })),
    ),
    http.post(
      "*/projects/test-project/service-accounts/:id/workload-bindings",
      ({ request }) =>
        respond("bind", request, () =>
          HttpResponse.json({ ok: true, binding }, { status: 201 }),
        ),
    ),
    http.patch(
      "*/projects/test-project/service-accounts/:id/workload-bindings/:binding",
      ({ request }) =>
        respond("policy", request, () =>
          HttpResponse.json({ ok: true, binding }),
        ),
    ),
  );
  return { sent, lists: () => lists };
}

const writes = (sent: Sent[]) => sent.filter((s) => s.method !== "GET");

function renderPage() {
  return renderWithProviders(<SettingsServiceIdentitiesPage />, { route });
}

test("without either flag nothing is requested and no control renders", async () => {
  server.use(
    sessionStatusWith({
      service_accounts_manage: false,
      workload_bindings_manage: false,
    }),
  );
  const api = servicesApi();
  renderPage();
  expect(await screen.findByText(/Only a project owner/)).toBeInTheDocument();
  expect(screen.queryByRole("table", { name: "Service accounts" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Create service account/ }),
  ).toBeNull();
  expect(api.lists()).toBe(0);
});

test("workload_bindings_manage alone offers bindings but not account changes", async () => {
  server.use(
    sessionStatusWith({
      service_accounts_manage: false,
      workload_bindings_manage: true,
    }),
  );
  servicesApi();
  renderPage();
  const table = await screen.findByRole("table", { name: "Service accounts" });
  expect(
    within(table).getByRole("button", { name: "Workload bindings of ci-bot" }),
  ).toBeInTheDocument();
  expect(
    within(table).queryByRole("button", { name: "Rename ci-bot" }),
  ).toBeNull();
  expect(
    within(table).queryByRole("button", { name: "Revoke ci-bot" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Create service account" }),
  ).toBeNull();
  expect(
    screen.getByText(/manage workload bindings but not the accounts/),
  ).toBeInTheDocument();
});

test("creating an account sends its name, display name and role", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ service_accounts_manage: true }));
  const api = servicesApi();
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Create service account" }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: "Create service account",
  });
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Name/ }),
    "nightly",
  );
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Display name/ }),
    "Nightly job",
  );
  await user.selectOptions(
    within(drawer).getByRole("combobox", { name: /Membership role/ }),
    "participant",
  );
  await user.click(
    within(drawer).getByRole("button", { name: "Create service account" }),
  );
  expect(
    await screen.findByText(/Created nightly \(service:3333/),
  ).toBeInTheDocument();
  expect(writes(api.sent)).toEqual([
    {
      method: "POST",
      path: "/projects/test-project/service-accounts",
      body: {
        name: "nightly",
        display_name: "Nightly job",
        role: "participant",
      },
    },
  ]);
});

test("revoking an account explains kept attribution and needs its name typed", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ service_accounts_manage: true }));
  const api = servicesApi();
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Revoke ci-bot" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Revoke ci-bot" });
  expect(dialog).toHaveTextContent(
    "every credential issued to it stops working",
  );
  expect(dialog).toHaveTextContent("past actions remain attributed to ci-bot");
  const confirm = within(dialog).getByRole("button", {
    name: "Revoke account",
  });
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByRole("textbox"), "ci-bot");
  await user.click(confirm);
  expect(await screen.findByText(/Revoked ci-bot\./)).toBeInTheDocument();
  expect(writes(api.sent)).toEqual([
    {
      method: "DELETE",
      path: `/projects/test-project/service-accounts/${encodeURIComponent(CI.principal_id)}`,
      body: undefined,
    },
  ]);
});

test("a binding policy is replaced from a preset", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ workload_bindings_manage: true }));
  const api = servicesApi();
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Workload bindings of ci-bot" }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: /Workload bindings · CI bot/,
  });
  await user.click(
    await within(drawer).findByRole("button", {
      name: "Edit policy of deploy",
    }),
  );
  const form = within(drawer).getByRole("form", { name: "Policy of deploy" });
  expect(within(form).getByRole("combobox", { name: /Preset/ })).toHaveValue(
    "read-only",
  );
  await user.selectOptions(
    within(form).getByRole("combobox", { name: /Preset/ }),
    "worker",
  );
  await user.type(
    within(form).getByRole("textbox", { name: /Limit to task types/ }),
    "bug",
  );
  await user.click(within(form).getByRole("button", { name: "Save policy" }));

  expect(
    await within(drawer).findByText(/Saved the policy of deploy/),
  ).toBeInTheDocument();
  expect(writes(api.sent)).toEqual([
    {
      method: "PATCH",
      path: `/projects/test-project/service-accounts/${encodeURIComponent(CI.principal_id)}/workload-bindings/b-1`,
      body: {
        expected_revision: 1,
        policy: {
          role: "participant",
          capabilities: CREDENTIAL_PRESETS.worker.capabilities,
          restrictions: { task_types: ["bug"] },
        },
      },
    },
  ]);
});

test("a new GitHub Actions binding defaults the issuer", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ workload_bindings_manage: true }));
  const api = servicesApi();
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Workload bindings of ci-bot" }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: /Workload bindings/,
  });
  await user.click(
    await within(drawer).findByRole("button", { name: "Add workload binding" }),
  );
  const form = within(drawer).getByRole("form", {
    name: "New workload binding",
  });
  await user.type(
    within(form).getByRole("textbox", { name: /^Name/ }),
    "release",
  );
  await user.type(
    within(form).getByRole("textbox", { name: /^Subject/ }),
    "repo:acme/widgets:environment:production",
  );
  await user.click(within(form).getByRole("button", { name: "Add binding" }));
  expect(await within(drawer).findByText("Added release.")).toBeInTheDocument();
  expect(writes(api.sent)[0].body).toEqual({
    name: "release",
    provider: "github-actions",
    issuer: "https://token.actions.githubusercontent.com",
    subject: "repo:acme/widgets:environment:production",
    policy: CREDENTIAL_PRESETS["read-only"],
  });
});

test("step-up on rename closes the drawer and shows the banner", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ service_accounts_manage: true }));
  servicesApi({
    rename: [
      () =>
        HttpResponse.json(
          {
            ok: false,
            error: { code: "step-up-required", message: "Re-authenticate" },
          },
          { status: 403 },
        ),
    ],
  });
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Rename ci-bot" }),
  );
  const drawer = await screen.findByRole("dialog", { name: "Rename ci-bot" });
  const name = within(drawer).getByRole("textbox", { name: /Display name/ });
  await user.clear(name);
  await user.type(name, "CI runner");
  await user.click(within(drawer).getByRole("button", { name: "Save name" }));
  expect(
    await screen.findByText(/Owner changes require a sign-in newer than/),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

test("a rename conflict keeps the opened revision and draft until explicit rebase", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ service_accounts_manage: true }));
  const api = servicesApi({
    list: [
      null,
      () =>
        HttpResponse.json({
          ok: true,
          service_accounts: [
            { ...CI, display_name: "Other owner", revision: 2 },
          ],
        }),
    ],
    rename: [
      () =>
        HttpResponse.json(
          {
            error: {
              code: "revision-conflict",
              message: "Reload",
              revision: 2,
              resource: "service-account",
            },
          },
          { status: 412 },
        ),
    ],
  });
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Rename ci-bot" }),
  );
  const drawer = screen.getByRole("dialog", { name: "Rename ci-bot" });
  const field = within(drawer).getByRole("textbox", { name: /Display name/ });
  await user.clear(field);
  await user.type(field, "My name");
  await user.click(within(drawer).getByRole("button", { name: "Save name" }));
  expect(
    await within(drawer).findByText(
      /Nothing was saved and your edits are kept/,
    ),
  ).toBeInTheDocument();
  expect(field).toHaveValue("My name");
  expect(writes(api.sent)).toHaveLength(1);
  expect(writes(api.sent)[0].body).toEqual({
    display_name: "My name",
    expected_revision: 1,
  });
  expect(
    within(drawer).getByRole("button", { name: "Save name" }),
  ).toBeDisabled();
  await user.click(
    await within(drawer).findByRole("button", {
      name: "Keep my edits on revision 2",
    }),
  );
  expect(field).toHaveValue("My name");
  await user.click(within(drawer).getByRole("button", { name: "Save name" }));
  await screen.findByText(/Renamed ci-bot/);
  expect(writes(api.sent)[1].body).toEqual({
    display_name: "My name",
    expected_revision: 2,
  });
});

test("binding conflict keeps policy edits and Load latest explicitly replaces them", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ workload_bindings_manage: true }));
  const api = servicesApi({
    bindings: [
      null,
      () =>
        HttpResponse.json({
          ok: true,
          bindings: [
            {
              ...binding,
              revision: 2,
              policy: CREDENTIAL_PRESETS["artifact-writer"],
            },
          ],
        }),
    ],
    policy: [
      () =>
        HttpResponse.json(
          {
            error: {
              code: "revision-conflict",
              message: "Reload",
              revision: 2,
              resource: "workload-binding",
            },
          },
          { status: 412 },
        ),
    ],
  });
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Workload bindings of ci-bot" }),
  );
  const drawer = screen.getByRole("dialog", { name: /Workload bindings/ });
  await user.click(
    await within(drawer).findByRole("button", {
      name: "Edit policy of deploy",
    }),
  );
  const form = within(drawer).getByRole("form", { name: "Policy of deploy" });
  const preset = within(form).getByRole("combobox", { name: /Preset/ });
  await user.selectOptions(preset, "worker");
  await user.click(within(form).getByRole("button", { name: "Save policy" }));
  expect(
    await within(form).findByText(/Nothing was saved and your edits are kept/),
  ).toBeInTheDocument();
  expect(preset).toHaveValue("worker");
  expect(writes(api.sent)).toHaveLength(1);
  expect(writes(api.sent)[0].body).toMatchObject({ expected_revision: 1 });
  expect(
    within(form).getByRole("button", { name: "Save policy" }),
  ).toBeDisabled();
  await user.click(
    await within(form).findByRole("button", { name: "Load latest" }),
  );
  expect(preset).toHaveValue("artifact-writer");
  expect(writes(api.sent)).toHaveLength(1);
});

test("a conflict whose refresh fails retains the draft and cannot rebase from the error alone", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ service_accounts_manage: true }));
  const api = servicesApi({
    list: [
      null,
      () =>
        HttpResponse.json(
          { error: { code: "unavailable", message: "Offline" } },
          { status: 503 },
        ),
    ],
    rename: [
      () =>
        HttpResponse.json(
          {
            error: {
              code: "revision-conflict",
              message: "Reload",
              revision: 2,
            },
          },
          { status: 412 },
        ),
    ],
  });
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Rename ci-bot" }),
  );
  const drawer = screen.getByRole("dialog", { name: "Rename ci-bot" });
  const field = within(drawer).getByRole("textbox", { name: /Display name/ });
  await user.clear(field);
  await user.type(field, "Draft");
  await user.click(within(drawer).getByRole("button", { name: "Save name" }));
  await within(drawer).findByText(/Nothing was saved and your edits are kept/);
  await waitFor(() => expect(api.lists()).toBeGreaterThan(1));
  expect(field).toHaveValue("Draft");
  expect(
    within(drawer).queryByRole("button", { name: /Keep my edits/ }),
  ).toBeNull();
  expect(
    within(drawer).getByRole("button", { name: "Save name" }),
  ).toBeDisabled();
  expect(writes(api.sent)).toHaveLength(1);
});

test("an Actions binding accepts an explicit Enterprise issuer without adding deployment trust", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ workload_bindings_manage: true }));
  const api = servicesApi();
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Workload bindings of ci-bot" }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: /Workload bindings/,
  });
  await user.click(
    await within(drawer).findByRole("button", { name: "Add workload binding" }),
  );
  const form = within(drawer).getByRole("form", {
    name: "New workload binding",
  });
  expect(
    within(form).getByText(/A binding does not add issuer trust/),
  ).toBeInTheDocument();
  await user.type(
    within(form).getByRole("textbox", { name: /^Name/ }),
    "enterprise-ci",
  );
  const issuer = within(form).getByRole("textbox", { name: /^Issuer/ });
  await user.clear(issuer);
  await user.type(issuer, "http://github--enterprise.example/token");
  await user.type(
    within(form).getByRole("textbox", { name: /^Subject/ }),
    "repo:acme/widgets:ref:refs/heads/main",
  );
  await user.click(within(form).getByRole("button", { name: "Add binding" }));
  expect(writes(api.sent)).toEqual([]);
  await user.clear(issuer);
  await user.type(issuer, "https://github--enterprise.example/_services/token");
  await user.click(within(form).getByRole("button", { name: "Add binding" }));
  expect(
    await within(drawer).findByText("Added enterprise-ci."),
  ).toBeInTheDocument();
  expect(writes(api.sent)[0].body).toMatchObject({
    provider: "github-actions",
    issuer: "https://github--enterprise.example/_services/token",
  });
});
