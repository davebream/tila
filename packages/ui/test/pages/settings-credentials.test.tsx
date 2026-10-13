import { SettingsCredentialsPage } from "@/pages/settings-credentials";
import userEvent from "@testing-library/user-event";
import { CREDENTIAL_PRESETS } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import {
  adminHandlers,
  serviceAccounts,
  sessionStatusWith,
  tokens,
} from "../mocks/admin-fixtures";
import { server } from "../mocks/server";
import {
  act,
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "../test-utils";

const route = "/p/test-project/settings/credentials";
const SECRET = "tila_s3cr3t_value_that_must_never_be_persisted";
const ALL = {
  credentials_read: true,
  credentials_issue: true,
  credentials_rotate: true,
  credentials_revoke: true,
};

function renderPage() {
  return renderWithProviders(<SettingsCredentialsPage />, { route });
}

/** Every stored copy of state a secret could leak into. */
function persisted(queryClient: ReturnType<typeof renderPage>["queryClient"]) {
  const storage = Object.keys(window.sessionStorage)
    .map((key) => `${key}=${window.sessionStorage.getItem(key)}`)
    .join("\n");
  const queries = JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  );
  const mutations = JSON.stringify(
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  );
  return `${storage}\n${queries}\n${mutations}`;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

test("without credentials_read nothing is listed or requested", async () => {
  let tokenCalls = 0;
  server.use(
    ...adminHandlers("explicit"),
    sessionStatusWith({ credentials_manage: false, credentials_read: false }),
    http.get("*/api/tokens", () => {
      tokenCalls += 1;
      return HttpResponse.json({ ok: true, tokens });
    }),
  );
  renderPage();
  expect(await screen.findByText(/Only a project owner/)).toBeInTheDocument();
  expect(screen.queryByRole("table", { name: "Credentials" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Issue credential" })).toBeNull();
  expect(tokenCalls).toBe(0);
});

test("read-only access lists credentials with no issue, rotate or revoke control", async () => {
  server.use(
    ...adminHandlers("explicit"),
    sessionStatusWith({ credentials_manage: false, credentials_read: true }),
  );
  renderPage();
  const table = await screen.findByRole("table", { name: "Credentials" });
  await within(table).findByText("ci-token");
  expect(
    within(table).queryByRole("button", { name: /Revoke|Rotate/ }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Issue credential" })).toBeNull();
});

test("status badges, principal join, legacy marker, no secrets", async () => {
  server.use(...adminHandlers("explicit"), sessionStatusWith(ALL));
  renderPage();

  const table = await screen.findByRole("table", { name: "Credentials" });
  const active = (await within(table).findByText("ci-token")).closest("tr");
  const expired = within(table).getByText("old-token").closest("tr");
  const legacy = within(table).getByText("bootstrap").closest("tr");
  expect(active && within(active).getByText("active")).toBeInTheDocument();
  expect(
    active && (await within(active).findByText("CI bot")),
  ).toBeInTheDocument();
  expect(
    active && within(active).getByRole("button", { name: "Rotate ci-token" }),
  ).toBeInTheDocument();
  expect(expired && within(expired).getByText("expired")).toBeInTheDocument();
  expect(
    expired && within(expired).queryByRole("button", { name: /Rotate/ }),
  ).toBeNull();
  expect(legacy && within(legacy).getByText("legacy")).toBeInTheDocument();
  expect(
    legacy && within(legacy).queryByRole("button", { name: "Revoke" }),
  ).toBeNull();
  expect(screen.queryByText(/tila_/)).not.toBeInTheDocument();
});

test("revoking requires typing the name and calls DELETE /api/tokens/:name", async () => {
  const user = userEvent.setup();
  let revoked: string | null = null;
  server.use(
    ...adminHandlers("explicit"),
    sessionStatusWith(ALL),
    http.delete("*/api/tokens/:name", ({ params }) => {
      revoked = String(params.name);
      return HttpResponse.json({ ok: true, name: params.name, revoked_at: 1 });
    }),
  );
  renderPage();
  const table = await screen.findByRole("table", { name: "Credentials" });
  const row = (await within(table).findByText("ci-token")).closest("tr");
  if (!row) throw new Error("row missing");
  await user.click(within(row).getByRole("button", { name: "Revoke" }));
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Revoke" });
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByRole("textbox"), "ci-token");
  await user.click(confirm);
  await waitFor(() => expect(revoked).toBe("ci-token"));
});

test("a failed refresh keeps the table and states it is stale", async () => {
  server.use(...adminHandlers("explicit"), sessionStatusWith(ALL));
  const { queryClient } = renderPage();
  const table = await screen.findByRole("table", { name: "Credentials" });
  await within(table).findByText("ci-token");
  server.use(
    http.get("*/api/tokens", () =>
      HttpResponse.json(
        {
          ok: false,
          error: { code: "credential-unavailable", message: "down" },
        },
        { status: 503 },
      ),
    ),
  );
  await act(() => queryClient.invalidateQueries({ queryKey: ["tokens"] }));
  expect(
    await screen.findByText(/Showing credentials from .* Refresh failed/),
  ).toBeInTheDocument();
  expect(within(table).getByText("ci-token")).toBeInTheDocument();
});

test("issuing shows the secret once and never stores it", async () => {
  const user = userEvent.setup();
  const sent: unknown[] = [];
  server.use(
    ...adminHandlers("explicit"),
    sessionStatusWith(ALL),
    http.post("*/api/tokens", async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json(
        {
          ok: true,
          token: SECRET,
          credential_id: "c-9",
          token_id: "11111111-2222-4333-8444-555555555555",
          principal_id: serviceAccounts[0].principal_id,
          name: "deploy-bot",
          created_at: 1,
          expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
          policy: CREDENTIAL_PRESETS["read-only"],
        },
        { status: 201 },
      );
    }),
  );
  const { queryClient } = renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Issue credential" }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: "Issue credential",
  });
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Name/ }),
    "deploy-bot",
  );
  await user.selectOptions(
    await within(drawer).findByRole("combobox", { name: /^Service account/ }),
    serviceAccounts[0].principal_id,
  );
  await user.selectOptions(
    within(drawer).getByRole("combobox", { name: /^Expires/ }),
    "30",
  );
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Note/ }),
    "deploys",
  );
  await user.click(
    within(drawer).getByRole("button", { name: "Issue credential" }),
  );

  const panel = await screen.findByRole("region", {
    name: "Credential deploy-bot issued",
  });
  expect(within(panel).getByLabelText("Secret")).toHaveTextContent(SECRET);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    name: "deploy-bot",
    note: "deploys",
    principal_id: serviceAccounts[0].principal_id,
    policy: CREDENTIAL_PRESETS["read-only"],
  });
  expect((sent[0] as { expires_at: number }).expires_at).toBeGreaterThan(
    Math.floor(Date.now() / 1000) + 29 * 86_400,
  );
  expect(persisted(queryClient)).not.toContain(SECRET);

  await user.click(within(panel).getByRole("button", { name: /I stored it/ }));
  expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  expect(persisted(queryClient)).not.toContain(SECRET);
});

test("an unconfirmed issue is not retried and says to check the list", async () => {
  const user = userEvent.setup();
  let posts = 0;
  server.use(
    ...adminHandlers("explicit"),
    sessionStatusWith(ALL),
    http.post("*/api/tokens", () => {
      posts += 1;
      return HttpResponse.error();
    }),
  );
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Issue credential" }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: "Issue credential",
  });
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Name/ }),
    "deploy-bot",
  );
  await user.selectOptions(
    await within(drawer).findByRole("combobox", { name: /^Service account/ }),
    serviceAccounts[0].principal_id,
  );
  await user.click(
    within(drawer).getByRole("button", { name: "Issue credential" }),
  );
  expect(
    await within(drawer).findByText(
      /It was not retried.*if deploy-bot appears there/,
    ),
  ).toBeInTheDocument();
  expect(posts).toBe(1);
});

test("rotation sends the listed version and shows the new secret once", async () => {
  const user = userEvent.setup();
  const sent: Array<{ name: string; body: unknown }> = [];
  server.use(
    ...adminHandlers("explicit"),
    sessionStatusWith(ALL),
    http.post("*/api/tokens/:name/rotate", async ({ params, request }) => {
      sent.push({ name: String(params.name), body: await request.json() });
      return HttpResponse.json(
        {
          ok: true,
          token: SECRET,
          credential_id: "c-1",
          token_id: "22222222-2222-4333-8444-555555555555",
          principal_id: serviceAccounts[0].principal_id,
          name: "ci-token",
          created_at: 1,
          expires_at: null,
        },
        { status: 201 },
      );
    }),
  );
  const { queryClient } = renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Rotate ci-token" }),
  );
  const drawer = await screen.findByRole("dialog", { name: "Rotate ci-token" });
  await user.selectOptions(
    within(drawer).getByRole("combobox", {
      name: /Previous secret stops working/,
    }),
    "3600",
  );
  await user.click(
    within(drawer).getByRole("button", { name: "Rotate credential" }),
  );

  const panel = await screen.findByRole("region", {
    name: "New secret for ci-token",
  });
  expect(within(panel).getByLabelText("Secret")).toHaveTextContent(SECRET);
  expect(panel).toHaveTextContent(/previous secret keeps working until/);
  expect(sent).toEqual([
    {
      name: "ci-token",
      body: { expected_token_id: "t-1", overlap_seconds: 3600 },
    },
  ]);
  expect(persisted(queryClient)).not.toContain(SECRET);
});

test("step-up on issue closes the drawer and shows the banner", async () => {
  const user = userEvent.setup();
  server.use(
    ...adminHandlers("explicit"),
    sessionStatusWith(ALL),
    http.post("*/api/tokens", () =>
      HttpResponse.json(
        {
          ok: false,
          error: { code: "step-up-required", message: "Re-authenticate" },
        },
        { status: 403 },
      ),
    ),
  );
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Issue credential" }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: "Issue credential",
  });
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Name/ }),
    "deploy-bot",
  );
  await user.selectOptions(
    await within(drawer).findByRole("combobox", { name: /^Service account/ }),
    serviceAccounts[0].principal_id,
  );
  await user.click(
    within(drawer).getByRole("button", { name: "Issue credential" }),
  );
  expect(
    await screen.findByText(/Owner changes require a sign-in newer than/),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
