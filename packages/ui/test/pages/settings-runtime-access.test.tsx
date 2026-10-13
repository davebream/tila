import { SettingsRuntimeAccessPage } from "@/pages/settings-runtime-access";
import userEvent from "@testing-library/user-event";
import { CREDENTIAL_PRESETS } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { sessionStatusWith } from "../mocks/admin-fixtures";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const route = "/p/test-project/settings/runtime-access";
const SECRET = "tila_invite_secret_that_must_never_be_persisted";
const NOW = Math.floor(Date.now() / 1000);
const ME = "github:github.com:7";

function enrollment(overrides: Record<string, unknown> = {}) {
  return {
    enrollment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    project_id: "test-project",
    installation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "laptop",
    kind: "personal",
    principal_id: "runtime:laptop",
    sponsor_id: ME,
    policy: CREDENTIAL_PRESETS.worker,
    created_at: NOW - 3600,
    revoked_at: null,
    ...overrides,
  };
}

const invitation = {
  invitation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "ci-runner",
  policy: CREDENTIAL_PRESETS.worker,
  created_by: "github:github.com:1",
  created_at: NOW - 60,
  expires_at: NOW + 540,
  revoked_at: null,
  revoked_by: null,
  state: "pending",
  enrollments: 0,
};

function whoami(principal: string, role = "owner") {
  return http.get("*/api/whoami", () =>
    HttpResponse.json({
      ok: true,
      project_id: "test-project",
      principal_id: principal,
      token_name: "me",
      scopes: "admin",
      role,
    }),
  );
}

function runtimeApi(enrollments = [enrollment()]) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  let invitationReads = 0;
  server.use(
    http.get("*/projects/test-project/runtime/enrollments", () =>
      HttpResponse.json({ ok: true, enrollments }),
    ),
    http.get("*/projects/test-project/runtime/invitations", () => {
      invitationReads += 1;
      return HttpResponse.json({ ok: true, invitations: [invitation] });
    }),
    http.post("*/projects/test-project/runtime/*", async ({ request }) => {
      const url = new URL(request.url);
      const text = await request.text();
      sent.push({
        method: "POST",
        path: url.pathname,
        body: text ? JSON.parse(text) : undefined,
      });
      if (url.pathname.endsWith("/runtime/invitations"))
        return HttpResponse.json({
          ok: true,
          invitation: SECRET,
          expires_at: NOW + 600,
          invitation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        });
      if (url.pathname.includes("/invitations/"))
        return HttpResponse.json({ ok: true, revoked: true });
      return HttpResponse.json({ ok: true });
    }),
  );
  return { sent, invitationReads: () => invitationReads };
}

function renderPage() {
  return renderWithProviders(<SettingsRuntimeAccessPage />, { route });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

test("a sponsor sees their installations, can revoke them, and never sees invitations", async () => {
  server.use(
    sessionStatusWith({ runtime_access_manage: false }),
    whoami(ME, "participant"),
  );
  const api = runtimeApi([
    enrollment(),
    enrollment({
      enrollment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      name: "old-box",
      revoked_at: NOW - 10,
    }),
  ]);
  renderPage();

  const table = await screen.findByRole("table", { name: "Installations" });
  expect(
    await within(table).findByRole("button", { name: "Revoke laptop" }),
  ).toBeInTheDocument();
  expect(
    within(table).queryByRole("button", { name: "Revoke old-box" }),
  ).toBeNull();
  expect(
    screen.getByText(/You see the installations you sponsor/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Shared invitations" }),
  ).toBeNull();
  expect(api.invitationReads()).toBe(0);
});

test("an email-account sponsor is told to ask an owner and gets no revoke control", async () => {
  server.use(
    sessionStatusWith({ runtime_access_manage: false }),
    whoami("user:42", "participant"),
  );
  runtimeApi([enrollment({ sponsor_id: "user:42" })]);
  renderPage();
  const table = await screen.findByRole("table", { name: "Installations" });
  expect(
    await screen.findByText(/with an email account, ask a project owner/),
  ).toBeInTheDocument();
  expect(within(table).queryByRole("button", { name: /Revoke/ })).toBeNull();
});

test("revoking an installation needs its name typed and explains the effect", async () => {
  const user = userEvent.setup();
  server.use(
    sessionStatusWith({ runtime_access_manage: true }),
    whoami("github:github.com:1"),
  );
  const api = runtimeApi();
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Revoke laptop" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Revoke installation laptop",
  });
  expect(dialog).toHaveTextContent(
    "agent bindings held by its sessions are released",
  );
  expect(dialog).toHaveTextContent("enroll it again with tila machine enroll");
  const confirm = within(dialog).getByRole("button", {
    name: "Revoke installation",
  });
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByRole("textbox"), "laptop");
  await user.click(confirm);
  expect(await screen.findByText(/Revoked laptop\./)).toBeInTheDocument();
  expect(api.sent).toEqual([
    {
      method: "POST",
      path: "/projects/test-project/runtime/enrollments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/revoke",
      body: undefined,
    },
  ]);
});

test("an owner lists invitations with state and enrollments, and revokes one", async () => {
  const user = userEvent.setup();
  server.use(
    sessionStatusWith({ runtime_access_manage: true }),
    whoami("github:github.com:1"),
  );
  const api = runtimeApi();
  renderPage();
  const table = await screen.findByRole("table", { name: "Invitations" });
  const row = within(table).getByText("ci-runner").closest("tr");
  if (!row) throw new Error("row missing");
  expect(within(row).getByText("pending")).toBeInTheDocument();
  expect(row).toHaveTextContent("0");

  await user.click(
    within(row).getByRole("button", { name: "Revoke invitation ci-runner" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Revoke invitation ci-runner",
  });
  expect(dialog).toHaveTextContent(
    "Installations it already enrolled (0) keep working",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Revoke invitation" }),
  );
  expect(
    await screen.findByText(/it can no longer be redeemed/),
  ).toBeInTheDocument();
  expect(api.sent).toEqual([
    {
      method: "POST",
      path: "/projects/test-project/runtime/invitations/cccccccc-cccc-4ccc-8ccc-cccccccccccc/revoke",
      body: undefined,
    },
  ]);
});

test("a new invitation's secret is shown once and never stored", async () => {
  const user = userEvent.setup();
  server.use(
    sessionStatusWith({ runtime_access_manage: true }),
    whoami("github:github.com:1"),
  );
  const api = runtimeApi();
  const { queryClient } = renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Create invitation" }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: "Create invitation",
  });
  await user.type(
    within(drawer).getByRole("textbox", { name: /Installation name/ }),
    "ci-runner-2",
  );
  await user.click(
    within(drawer).getByRole("button", { name: "Create invitation" }),
  );

  const panel = await screen.findByRole("region", {
    name: "Invitation for ci-runner-2",
  });
  expect(within(panel).getByLabelText("Secret")).toHaveTextContent(SECRET);
  expect(panel).toHaveTextContent("tila machine enroll --invitation-stdin");
  expect(api.sent[0]).toEqual({
    method: "POST",
    path: "/projects/test-project/runtime/invitations",
    body: { name: "ci-runner-2" },
  });
  const stored = [
    ...Object.keys(window.sessionStorage).map((key) =>
      window.sessionStorage.getItem(key),
    ),
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
    JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    ),
  ].join("\n");
  expect(stored).not.toContain(SECRET);

  await user.click(within(panel).getByRole("button", { name: /I stored it/ }));
  await waitFor(() =>
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument(),
  );
});
