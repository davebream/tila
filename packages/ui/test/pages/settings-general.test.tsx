import { SettingsGeneralPage } from "@/pages/settings-general";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { sessionStatusWith } from "../mocks/admin-fixtures";
import { server } from "../mocks/server";
import { renderWithProviders, screen, within } from "../test-utils";

const route = "/p/test-project/settings/general";

function settingsApi(answers: Array<(() => Response) | null> = []) {
  const state = {
    settings: {
      project_id: "test-project",
      display_name: "Widgets" as string | null,
      created_at: Date.UTC(2026, 0, 2),
      created_by: "github:github.com:1",
      revision: 3,
    },
  };
  const sent: unknown[] = [];
  server.use(
    http.get("*/projects/test-project/project-settings", () =>
      HttpResponse.json({ ok: true, settings: state.settings }),
    ),
    http.patch(
      "*/projects/test-project/project-settings",
      async ({ request }) => {
        const body = (await request.json()) as {
          display_name: string | null;
          expected_revision: number;
        };
        sent.push(body);
        const answer = answers[sent.length - 1];
        if (answer) return answer();
        state.settings = {
          ...state.settings,
          display_name: body.display_name,
          revision: state.settings.revision + 1,
        };
        return HttpResponse.json({ ok: true, settings: state.settings });
      },
    ),
  );
  return { state, sent };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

test("without project_configure the settings are read-only and nothing is written", async () => {
  server.use(sessionStatusWith({ project_configure: false }));
  const api = settingsApi();
  renderWithProviders(<SettingsGeneralPage />, { route });

  const facts = await screen.findByLabelText("Project");
  expect(facts).toHaveTextContent("test-project");
  expect(facts).toHaveTextContent("Widgets");
  expect(screen.getByText(/Only a project owner/)).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Rename project" })).toBeNull();
  expect(api.sent).toEqual([]);
});

test("an owner renames against the revision on screen; clearing sends null", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ project_configure: true }));
  const api = settingsApi();
  renderWithProviders(<SettingsGeneralPage />, { route });

  const form = await screen.findByRole("form", { name: "Rename project" });
  // Nothing was sent yet, so there is no unconfirmed rename to report.
  expect(within(form).queryByText(/did not confirm/)).toBeNull();
  const name = within(form).getByRole("textbox", { name: /Display name/ });
  await user.clear(name);
  await user.type(name, "Gadgets");
  await user.click(within(form).getByRole("button", { name: "Save name" }));
  expect(
    await screen.findByText("Renamed to Gadgets (revision 4)."),
  ).toBeInTheDocument();

  await user.clear(name);
  await user.click(within(form).getByRole("button", { name: "Save name" }));
  expect(
    await screen.findByText("Display name cleared (revision 5)."),
  ).toBeInTheDocument();
  expect(api.sent).toEqual([
    { expected_revision: 3, display_name: "Gadgets" },
    { expected_revision: 4, display_name: null },
  ]);
});

test("a concurrent rename keeps the edit and the next save names the new revision", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ project_configure: true }));
  const api = settingsApi([
    () => {
      api.state.settings = {
        ...api.state.settings,
        display_name: "Sprockets",
        revision: 4,
      };
      return HttpResponse.json(
        {
          ok: false,
          error: {
            code: "revision-conflict",
            message: "Project settings changed; current revision is 4",
            revision: 4,
          },
        },
        { status: 412 },
      );
    },
    null,
  ]);
  renderWithProviders(<SettingsGeneralPage />, { route });

  const form = await screen.findByRole("form", { name: "Rename project" });
  const name = within(form).getByRole("textbox", { name: /Display name/ });
  await user.clear(name);
  await user.type(name, "Gadgets");
  await user.click(within(form).getByRole("button", { name: "Save name" }));

  expect(
    await within(form).findByText(/Another change landed \(revision 4\)/),
  ).toHaveTextContent("It changed the display name.");
  expect(name).toHaveValue("Gadgets");
  await user.click(
    within(form).getByRole("button", { name: "Keep my edits on revision 4" }),
  );
  await user.click(within(form).getByRole("button", { name: "Save name" }));
  expect(
    await screen.findByText("Renamed to Gadgets (revision 5)."),
  ).toBeInTheDocument();
  expect(api.sent[1]).toEqual({
    expected_revision: 4,
    display_name: "Gadgets",
  });
});

test("a stale session is asked to sign in again and the edit is kept", async () => {
  const user = userEvent.setup();
  server.use(sessionStatusWith({ project_configure: true }));
  settingsApi([
    () =>
      HttpResponse.json(
        {
          ok: false,
          error: {
            code: "step-up-required",
            message: "Re-authenticate to continue",
          },
        },
        { status: 403 },
      ),
  ]);
  renderWithProviders(<SettingsGeneralPage />, { route });

  const form = await screen.findByRole("form", { name: "Rename project" });
  const name = within(form).getByRole("textbox", { name: /Display name/ });
  await user.clear(name);
  await user.type(name, "Gadgets");
  await user.click(within(form).getByRole("button", { name: "Save name" }));

  expect(
    await screen.findByText(
      /Owner changes require a sign-in newer than 10 minutes/,
    ),
  ).toBeInTheDocument();
  expect(name).toHaveValue("Gadgets");
  expect(screen.queryByText(/Your access changed/)).not.toBeInTheDocument();
});
