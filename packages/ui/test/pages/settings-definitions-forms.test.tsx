import { SettingsDefinitionsPage } from "@/pages/settings-definitions";
import { SettingsDefinitionsSourcePage } from "@/pages/settings-definitions-source";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const APPLIED = `schema_version = 1
team_note = "custom top-level key"

[work_units.bug]
owner_hint = "custom key on a type"
fields = [
  { name = "title", type = "string", required = true, ui_width = 40 },
  { name = "status", type = "enum", values = ["open", "closed"] },
]

[work_units.epic.fields.title]
type = "string"
`;

function applied(source = APPLIED) {
  server.use(
    http.get("*/projects/*/schema", () =>
      HttpResponse.json({
        ok: true,
        schema: {
          version: 4,
          definition: source,
          applied_at: Date.now(),
          applied_by: "someone",
        },
        version: 4,
        revision: 4,
      }),
    ),
  );
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/settings/definitions"
        element={<SettingsDefinitionsPage />}
      />
      <Route
        path="/p/:projectId/settings/definitions/source"
        element={<SettingsDefinitionsSourcePage />}
      />
    </Routes>,
    { route: "/p/test-project/settings/definitions" },
  );
}

async function draftText(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("link", { name: "Edit source" }));
  return ((await screen.findByLabelText("Draft (TOML)")) as HTMLTextAreaElement)
    .value;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("definition forms", () => {
  test("an empty work type is added with the keyboard only", async () => {
    const user = userEvent.setup();
    applied();
    renderPage();

    const add = await screen.findByRole("button", { name: "Add work type" });
    add.focus();
    await user.keyboard("{Enter}");
    const name = await screen.findByRole("textbox", { name: /^Name/ });
    expect(name).toHaveFocus();
    await user.keyboard("feature{Enter}");

    const table = await screen.findByRole("table", { name: "Work types" });
    const row = within(table).getByRole("row", { name: /feature/ });
    expect(row).toHaveTextContent("new in draft");
    expect(row).toHaveTextContent("No fields");
    expect(
      screen.getByRole("region", { name: "Unsaved definition draft" }),
    ).toHaveTextContent("1 change");
    expect(await draftText(user)).toContain("[work_units.feature]");
  });

  test("editing a field keeps custom keys and the array shape", async () => {
    const user = userEvent.setup();
    applied();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Edit work type bug" }),
    );
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: /^status/ }));
    await user.click(
      within(drawer).getByRole("checkbox", { name: /Required/ }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save to draft" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const row = within(
      screen.getByRole("table", { name: "Work types" }),
    ).getByRole("row", { name: /bug/ });
    expect(row).toHaveTextContent("changed in draft");
    const text = await draftText(user);
    expect(text).toContain('team_note = "custom top-level key"');
    expect(text).toContain('owner_hint = "custom key on a type"');
    expect(text).toContain("ui_width = 40");
    expect(text).toContain("[[work_units.bug.fields]]");
    expect(text).toMatch(
      /name = "status"\ntype = "enum"[\s\S]*required = true/,
    );
  });

  test("a keyed field table stays keyed when a field is added", async () => {
    const user = userEvent.setup();
    applied();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Edit work type epic" }),
    );
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "Add field" }));
    const name = within(drawer).getAllByRole("textbox", { name: /^Name/ });
    await user.clear(name[name.length - 1]);
    await user.type(name[name.length - 1], "owner");
    await user.click(
      within(drawer).getByRole("button", { name: "Save to draft" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const text = await draftText(user);
    expect(text).toContain("[work_units.epic.fields.title]");
    expect(text).toContain("[work_units.epic.fields.owner]");
  });

  test("duplicate field names block saving and invalid lifecycles are explained", async () => {
    const user = userEvent.setup();
    applied();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Edit work type bug" }),
    );
    const drawer = await screen.findByRole("dialog");
    await user.click(
      within(drawer).getByRole("checkbox", {
        name: "This work type has a lifecycle",
      }),
    );
    await user.selectOptions(
      within(drawer).getByRole("combobox", { name: /Status field/ }),
      "status",
    );
    const startable = within(drawer).getByRole("group", {
      name: "Startable states",
    });
    const finished = within(drawer).getByRole("group", {
      name: "Finished states",
    });
    await user.click(within(startable).getByRole("checkbox", { name: "open" }));
    await user.click(within(finished).getByRole("checkbox", { name: "open" }));
    const unblocking = within(drawer).getByRole("group", {
      name: "States that unblock dependents",
    });
    await user.click(
      within(unblocking).getByRole("checkbox", { name: "open" }),
    );
    expect(
      await within(drawer).findByText(
        /Dispatchable and terminal states must be disjoint/,
      ),
    ).toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "Add field" }));
    const names = within(drawer).getAllByRole("textbox", { name: /^Name/ });
    await user.clear(names[names.length - 1]);
    await user.type(names[names.length - 1], "title");
    expect(
      within(drawer).getAllByText("Another field already has this name.")
        .length,
    ).toBeGreaterThan(0);
    await user.click(
      within(drawer).getByRole("button", { name: "Save to draft" }),
    );
    expect(
      within(drawer).getByText("Fix the highlighted inputs to save."),
    ).toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("region", { name: "Unsaved definition draft" }),
    ).not.toBeInTheDocument();
  });

  test("retiring a type can be undone before applying", async () => {
    const user = userEvent.setup();
    applied();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Retire work type epic" }),
    );
    const table = screen.getByRole("table", { name: "Work types" });
    expect(within(table).getByRole("row", { name: /epic/ })).toHaveTextContent(
      "retired on apply",
    );
    await user.click(
      screen.getByRole("button", { name: "Restore work type epic" }),
    );
    expect(
      within(table).getByRole("row", { name: /epic/ }),
    ).not.toHaveTextContent("retired on apply");
    expect(
      screen.queryByRole("region", { name: "Unsaved definition draft" }),
    ).not.toBeInTheDocument();
  });

  test("a record type is declared with its storage and writer policy", async () => {
    const user = userEvent.setup();
    applied();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Add record type" }),
    );
    const drawer = await screen.findByRole("dialog");
    await user.type(
      within(drawer).getByRole("textbox", { name: /^Name/ }),
      "deploy",
    );
    await user.selectOptions(
      within(drawer).getByRole("combobox", { name: /Value format/ }),
      "yaml",
    );
    await user.click(within(drawer).getByRole("checkbox", { name: "human" }));
    await user.click(within(drawer).getByRole("button", { name: "Add field" }));
    await user.selectOptions(
      within(drawer).getByRole("combobox", { name: /^Type/ }),
      "number",
    );
    await user.type(
      within(drawer).getByRole("textbox", { name: /^Default for existing/ }),
      "abc",
    );
    expect(within(drawer).getByText("Enter a number.")).toBeInTheDocument();
    await user.clear(
      within(drawer).getByRole("textbox", { name: /^Default for existing/ }),
    );
    await user.type(
      within(drawer).getByRole("textbox", { name: /^Default for existing/ }),
      "3",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save to draft" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    const text = await draftText(user);
    expect(text).toContain("[records.deploy]");
    expect(text).toContain('format = "yaml"');
    expect(text).toContain('writers = [ "human" ]');
    expect(text).toContain("default_for_legacy = 3");
  });

  test("a viewer sees the definitions without editing actions", async () => {
    server.use(
      http.get("*/api/whoami", () =>
        HttpResponse.json({
          ok: true,
          project_id: "test-project",
          principal_id: "viewer",
          token_name: "viewer",
          role: "viewer",
        }),
      ),
    );
    applied();
    renderPage();

    const table = await screen.findByRole("table", { name: "Work types" });
    expect(within(table).getByRole("row", { name: /bug/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add work type" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Edit work type/ }),
    ).not.toBeInTheDocument();
  });
});
