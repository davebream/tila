import { SettingsPage } from "@/pages/settings";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import {
  adminHandlers,
  memberships,
  repos,
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

const route = "/p/test-project/settings";

function renderSettings() {
  return renderWithProviders(<SettingsPage />, { route });
}

describe("SettingsPage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test("explicit mode: lists members, offers the grant form, explains mirroring is off", async () => {
    server.use(...adminHandlers("explicit"));
    renderSettings();

    const table = await screen.findByRole("table", { name: "Members" });
    expect(await within(table).findByText("octocat")).toBeInTheDocument();
    expect(within(table).getByText("hubot")).toBeInTheDocument();
    // Service principal rows are labelled from the service account
    expect(within(table).getByText("CI bot")).toBeInTheDocument();
    expect(within(table).getByText("you")).toBeInTheDocument();
    // Revoked rows are hidden by default
    expect(within(table).queryByText("alice")).not.toBeInTheDocument();

    expect(
      screen.getByRole("form", { name: "Grant membership" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Mirroring is off/)).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Linked repositories" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/explicit owner granted by/)).toBeInTheDocument();
  });

  test("github-mirrored mode: shows the source repository policy and role cap", async () => {
    server.use(...adminHandlers("github-mirrored"));
    renderSettings();

    const repoTable = await screen.findByRole("table", {
      name: "Linked repositories",
    });
    expect(within(repoTable).getByText("acme/widgets")).toBeInTheDocument();
    expect(within(repoTable).getByText("maintainer")).toBeInTheDocument();
    expect(within(repoTable).getByText("on")).toBeInTheDocument();
    expect(screen.getByText(/GitHub never grants owner/)).toBeInTheDocument();
    expect(
      screen.getByText(/Explicit rows are honored only for owner/),
    ).toBeInTheDocument();
  });

  test("hybrid mode: explains both sources and that the stronger role wins", async () => {
    server.use(...adminHandlers("hybrid"));
    renderSettings();

    expect(
      await screen.findByText(
        /mirrored from acme\/widgets capped at maintainer/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/explicit owner granted by/)).toBeInTheDocument();
    expect(
      screen.getByText(/effective role is the stronger of the sources/),
    ).toBeInTheDocument();
  });

  test("service-only mode: lists service principals and notes humans cannot sign in", async () => {
    server.use(...adminHandlers("service-only"));
    renderSettings();

    const table = await screen.findByRole("table", { name: "Members" });
    expect(await within(table).findByText("CI bot")).toBeInTheDocument();
    expect(within(table).queryByText("hubot")).not.toBeInTheDocument();
    expect(screen.getByText(/Humans cannot sign in/)).toBeInTheDocument();
  });

  test("revoked memberships appear only after opting in", async () => {
    const user = userEvent.setup();
    server.use(...adminHandlers("explicit"));
    renderSettings();

    const table = await screen.findByRole("table", { name: "Members" });
    await within(table).findByText("octocat");
    expect(within(table).queryByText("alice")).not.toBeInTheDocument();
    await user.click(await screen.findByLabelText(/Show revoked/));
    expect(await within(table).findByText("alice")).toBeInTheDocument();
    expect(within(table).getByText("revoked")).toBeInTheDocument();
  });

  test("credentials: status badges, principal join, legacy marker, no secrets", async () => {
    server.use(...adminHandlers("explicit"));
    renderSettings();

    const table = await screen.findByRole("table", { name: "Credentials" });
    const active = (await within(table).findByText("ci-token")).closest("tr");
    const expired = within(table).getByText("old-token").closest("tr");
    const legacy = within(table).getByText("bootstrap").closest("tr");
    expect(active && within(active).getByText("active")).toBeInTheDocument();
    expect(active && within(active).getByText("CI bot")).toBeInTheDocument();
    expect(expired && within(expired).getByText("expired")).toBeInTheDocument();
    expect(legacy && within(legacy).getByText("legacy")).toBeInTheDocument();
    expect(legacy && within(legacy).getByText("revoked")).toBeInTheDocument();
    // A revoked credential has no revoke action
    expect(
      legacy && within(legacy).queryByRole("button", { name: "Revoke" }),
    ).toBeNull();
    expect(screen.getByText(/tila token issue/)).toBeInTheDocument();
    expect(screen.queryByText(/tila_/)).not.toBeInTheDocument();
  });

  test("unavailable policy store: renders the fail-closed state with no controls", async () => {
    let membershipCalls = 0;
    server.use(
      sessionStatusWith({
        memberships_manage: false,
        credentials_manage: false,
        membership_available: false,
      }),
      http.get("*/projects/*/memberships", () => {
        membershipCalls += 1;
        return HttpResponse.json({ ok: true, memberships: [] });
      }),
    );
    renderSettings();

    expect(
      await screen.findByText("Membership policy store unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.queryByRole("form")).toBeNull();
    expect(membershipCalls).toBe(0);
  });

  test("without credentials_manage no credential request is made and no revoke control renders", async () => {
    let tokenCalls = 0;
    server.use(
      sessionStatusWith({ credentials_manage: false }),
      http.get("*/api/tokens", () => {
        tokenCalls += 1;
        return HttpResponse.json({ ok: true, tokens });
      }),
      ...adminHandlers("explicit"),
    );
    renderSettings();

    await screen.findByRole("table", { name: "Members" });
    expect(
      screen.getByText(/cannot manage its credentials/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Credentials" }),
    ).not.toBeInTheDocument();
    expect(tokenCalls).toBe(0);
  });

  test("without memberships_manage the grant form and member actions are absent", async () => {
    let membershipCalls = 0;
    server.use(
      sessionStatusWith({ memberships_manage: false }),
      http.get("*/projects/*/memberships", () => {
        membershipCalls += 1;
        return HttpResponse.json({ ok: true, memberships: [] });
      }),
      ...adminHandlers("explicit"),
    );
    renderSettings();

    await screen.findByRole("table", { name: "Credentials" });
    expect(screen.getByText(/cannot manage its members/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Grant membership" })).toBeNull();
    expect(membershipCalls).toBe(0);
  });

  test("revoking a membership confirms, calls DELETE and refetches the list", async () => {
    const user = userEvent.setup();
    let listCalls = 0;
    let deleted: string | null = null;
    server.use(
      http.get("*/projects/*/memberships", () => {
        listCalls += 1;
        return HttpResponse.json({
          ok: true,
          memberships:
            deleted === null
              ? [memberships.owner, memberships.participant]
              : [memberships.owner],
        });
      }),
      http.delete("*/projects/*/memberships/:id", ({ params }) => {
        deleted = String(params.id);
        return HttpResponse.json({
          ok: true,
          membership: { ...memberships.participant, revoked_at: Date.now() },
          revokedSessions: 1,
        });
      }),
      ...adminHandlers("explicit"),
    );
    renderSettings();

    const table = await screen.findByRole("table", { name: "Members" });
    const row = (await within(table).findByText("hubot")).closest("tr");
    if (!row) throw new Error("row missing");
    await user.click(within(row).getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(deleted).toBe("m-hubot"));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(within(table).queryByText("hubot")).not.toBeInTheDocument(),
    );
  });

  test("last-owner conflict surfaces the server message in the dialog", async () => {
    const user = userEvent.setup();
    server.use(
      ...adminHandlers("explicit", {
        memberships: [memberships.owner, memberships.participant],
      }),
      http.delete("*/projects/*/memberships/:id", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "last-owner",
              message: "Cannot revoke the last owner",
              retryable: false,
            },
          },
          { status: 409 },
        ),
      ),
    );
    renderSettings();

    const table = await screen.findByRole("table", { name: "Members" });
    const row = (await within(table).findByText("hubot")).closest("tr");
    if (!row) throw new Error("row missing");
    await user.click(within(row).getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Cannot revoke the last owner",
    );
  });

  test("the sole active owner cannot revoke or demote themselves", async () => {
    server.use(
      ...adminHandlers("explicit", {
        memberships: [memberships.owner, memberships.participant],
      }),
    );
    renderSettings();

    const table = await screen.findByRole("table", { name: "Members" });
    const row = (await within(table).findByText("octocat")).closest("tr");
    if (!row) throw new Error("row missing");
    expect(within(row).getByRole("button", { name: "Revoke" })).toBeDisabled();
    expect(within(row).getByRole("combobox")).toBeDisabled();
  });

  test("revoking a credential requires typing its name and calls DELETE /api/tokens/:name", async () => {
    const user = userEvent.setup();
    let revoked: string | null = null;
    server.use(
      ...adminHandlers("explicit"),
      http.delete("*/api/tokens/:name", ({ params }) => {
        revoked = String(params.name);
        return HttpResponse.json({
          ok: true,
          name: params.name,
          revoked_at: Math.floor(Date.now() / 1000),
        });
      }),
    );
    renderSettings();

    const table = await screen.findByRole("table", { name: "Credentials" });
    const row = (await within(table).findByText("ci-token")).closest("tr");
    if (!row) throw new Error("row missing");
    await user.click(within(row).getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Revoke" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "ci-token");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(revoked).toBe("ci-token"));
  });

  test("step-up-required shows the banner and stashes a resume target on sign-in", async () => {
    const user = userEvent.setup();
    server.use(
      ...adminHandlers("explicit", {
        memberships: [memberships.owner, memberships.participant],
      }),
      sessionStatusWith({ auth_method: "token", authenticated_at: 0 }),
      http.delete("*/projects/*/memberships/:id", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "step-up-required",
              message: "Re-authenticate to continue",
              retryable: false,
              details: { max_age_seconds: 600, authenticated_at: 0 },
            },
          },
          { status: 403 },
        ),
      ),
    );
    renderSettings();

    const table = await screen.findByRole("table", { name: "Members" });
    const row = (await within(table).findByText("hubot")).closest("tr");
    if (!row) throw new Error("row missing");
    await user.click(within(row).getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));

    expect(
      await screen.findByText("Re-authenticate to continue"),
    ).toBeInTheDocument();
    expect(screen.getByText(/10 minutes/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(
      JSON.parse(window.sessionStorage.getItem("tila.stepUp") ?? "null"),
    ).toEqual({ projectId: "test-project", returnTo: route });
  });

  test("changing the policy away from explicit asks for confirmation then PUTs the mode", async () => {
    const user = userEvent.setup();
    let putMode: string | null = null;
    server.use(
      ...adminHandlers("explicit"),
      http.put("*/projects/*/membership-policy", async ({ request }) => {
        putMode = ((await request.json()) as { mode: string }).mode;
        return HttpResponse.json({ ok: true, mode: putMode });
      }),
    );
    renderSettings();

    const modeSelect = await screen.findByLabelText(/Policy mode/);
    await waitFor(() => expect(modeSelect).toBeEnabled());
    await user.selectOptions(modeSelect, "hybrid");
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Change policy" }),
    );
    await waitFor(() => expect(putMode).toBe("hybrid"));
  });
});

const unavailable = () =>
  HttpResponse.json(
    {
      ok: false,
      error: {
        code: "membership-unavailable",
        message: "Membership store unavailable",
        retryable: true,
      },
    },
    { status: 503 },
  );

describe("SettingsPage failure states", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test("a failed repositories request is an error, not 'no repositories linked'", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/projects/*/membership-repos", unavailable),
      ...adminHandlers("github-mirrored"),
    );
    renderSettings();

    const panel = await screen.findByRole("region", { name: "Access sources" });
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("Could not load linked repositories.");
    expect(
      within(panel).queryByText(/No repositories are linked/),
    ).not.toBeInTheDocument();

    server.use(
      http.get("*/projects/*/membership-repos", () =>
        HttpResponse.json({ ok: true, repos }),
      ),
    );
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(
      await within(panel).findByRole("table", { name: "Linked repositories" }),
    ).toBeInTheDocument();
  });

  test("a pending repositories request shows loading, not absence", async () => {
    server.use(
      http.get("*/projects/*/membership-repos", async () => {
        await delay("infinite");
      }),
      ...adminHandlers("hybrid"),
    );
    renderSettings();

    const panel = await screen.findByRole("region", { name: "Access sources" });
    expect(
      await within(panel).findByText("Loading linked repositories…"),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByText(/No repositories are linked/),
    ).not.toBeInTheDocument();
  });

  test("a successful empty repositories list is reported as such", async () => {
    server.use(
      http.get("*/projects/*/membership-repos", () =>
        HttpResponse.json({ ok: true, repos: [] }),
      ),
      ...adminHandlers("hybrid"),
    );
    renderSettings();

    expect(
      await screen.findByText(/No repositories are linked to this project/),
    ).toBeInTheDocument();
  });

  test("a failed events request is an error, not 'no changes recorded'", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/projects/*/membership-events", unavailable),
      ...adminHandlers("explicit"),
    );
    renderSettings();

    const section = await screen.findByRole("region", {
      name: "Recent membership changes",
    });
    const alert = await within(section).findByRole("alert");
    expect(alert).toHaveTextContent("Could not load membership changes.");
    expect(screen.queryByText("No changes recorded.")).not.toBeInTheDocument();

    server.use(
      http.get("*/projects/*/membership-events", () =>
        HttpResponse.json({ ok: true, events: [], next_cursor: null }),
      ),
    );
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No changes recorded.")).toBeInTheDocument();
  });

  test("a failed 'load more' keeps the button so the page can be retried", async () => {
    const user = userEvent.setup();
    const event = (id: string) => ({
      event_id: id,
      project_id: "test-project",
      principal_id: "github:github.com:2",
      actor_principal_id: "github:github.com:1",
      action: "grant",
      source: "explicit",
      role: "participant",
      github_repo_id: null,
      details: {},
      occurred_at: Date.now() - 1000,
    });
    server.use(
      http.get("*/projects/*/membership-events", ({ request }) =>
        new URL(request.url).searchParams.has("cursor")
          ? unavailable()
          : HttpResponse.json({
              ok: true,
              events: [event("e-1")],
              next_cursor: 7,
            }),
      ),
      ...adminHandlers("explicit"),
    );
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Load more" }));

    expect(
      await screen.findByText("Could not load more changes."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  test("the policy select never shows 'explicit' before the policy is known", async () => {
    server.use(
      http.get("*/projects/*/membership-policy", async () => {
        await delay("infinite");
      }),
      ...adminHandlers("hybrid"),
    );
    renderSettings();

    const select = await screen.findByLabelText(/Policy mode/);
    expect(select).toHaveValue("");
    expect(select).toBeDisabled();
    expect(
      within(select).getByRole("option", { name: "Loading…" }),
    ).toBeDisabled();
  });

  test("a failed policy request leaves the select unavailable and the members visible", async () => {
    server.use(
      http.get("*/projects/*/membership-policy", unavailable),
      ...adminHandlers("hybrid"),
    );
    renderSettings();

    const select = await screen.findByLabelText(/Policy mode/);
    await waitFor(() => expect(select).toHaveValue(""));
    expect(select).toBeDisabled();
    expect(
      within(select).getByRole("option", { name: "Unavailable" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Could not load membership policy."),
    ).toBeInTheDocument();
    // The members table does not depend on the policy and stays.
    const table = await screen.findByRole("table", { name: "Members" });
    expect(await within(table).findByText("octocat")).toBeInTheDocument();
  });

  test("a failed members refresh keeps the table, the grant draft and an open revoke dialog", async () => {
    const user = userEvent.setup();
    server.use(...adminHandlers("explicit"));
    const { queryClient } = renderSettings();

    const table = await screen.findByRole("table", { name: "Members" });
    const row = (await within(table).findByText("hubot")).closest("tr");
    if (!row) throw new Error("row missing");
    await user.type(await screen.findByLabelText("GitHub login"), "new-person");
    await user.click(within(row).getByRole("button", { name: "Revoke" }));
    await screen.findByRole("dialog");

    server.use(http.get("*/projects/*/memberships", unavailable));
    await act(() =>
      queryClient.invalidateQueries({ queryKey: ["memberships"] }),
    );

    expect(
      await screen.findByText(/Showing members from .* Refresh failed/),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub login")).toHaveValue("new-person");
    // The open dialog hides the page from the a11y tree, so assert on the node.
    expect(table).toBeInTheDocument();
    expect(within(table).getByText("hubot")).toBeInTheDocument();
  });

  test("a members request that fails before any data shows an error, not an empty table", async () => {
    server.use(
      http.get("*/projects/*/memberships", unavailable),
      ...adminHandlers("explicit"),
    );
    renderSettings();

    expect(
      await screen.findByText("Could not load members."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No explicit members. Grant one below."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Members" }),
    ).not.toBeInTheDocument();
  });

  test("a failed credentials refresh keeps the table and states it is stale", async () => {
    server.use(...adminHandlers("explicit"));
    const { queryClient } = renderSettings();

    const table = await screen.findByRole("table", { name: "Credentials" });
    await within(table).findByText("ci-token");

    server.use(http.get("*/api/tokens", unavailable));
    await act(() => queryClient.invalidateQueries({ queryKey: ["tokens"] }));

    expect(
      await screen.findByText(/Showing credentials from .* Refresh failed/),
    ).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Credentials" })).toBe(table);
    expect(within(table).getByText("ci-token")).toBeInTheDocument();
  });
});
