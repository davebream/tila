import { SettingsDefinitionsPage } from "@/pages/settings-definitions";
import { SettingsDefinitionsSourcePage } from "@/pages/settings-definitions-source";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const APPLIED = `schema_version = 1

[work_units.task]
fields = [
  { name = "title", type = "string", required = true },
  { name = "status", type = "enum", values = ["open", "review", "done"] },
]

[work_units.task.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done"]
dependency_satisfied = ["done"]

[work_units.epic]

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 30
searchable = true
search_mode = "full_text"
storage_class = "custom key on an artifact kind"

[artifacts.design]
mime_types = ["text/markdown"]

[templates.release]
description = "Release checklist"

[templates.release.entities.root]
id_suffix = ""
type = "epic"

[templates.release.entities.notes]
id_suffix = "-notes"
type = "task"
data = { title = "Write notes" }

[[templates.release.relationships]]
from = "root"
to = "notes"
type = "parent-child"
`;

function renderPage() {
  server.use(
    http.get("*/projects/*/schema", () =>
      HttpResponse.json({
        ok: true,
        schema: {
          version: 9,
          definition: APPLIED,
          applied_at: Date.now(),
          applied_by: "someone",
        },
        version: 9,
        revision: 9,
      }),
    ),
  );
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

async function save(user: ReturnType<typeof userEvent.setup>) {
  const drawer = screen.getByRole("dialog");
  await user.click(
    within(drawer).getByRole("button", { name: "Save to draft" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
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

describe("artifact, template and structure editors", () => {
  test("shortening retention explains the effect and keeps custom keys", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Edit artifact kind plan" }),
    );
    const drawer = await screen.findByRole("dialog");
    const retention = within(drawer).getByRole("textbox", {
      name: /Retention/,
    });
    await user.clear(retention);
    await user.type(retention, "7");
    expect(
      within(drawer).getByText(/Existing artifacts keep the expiry/),
    ).toHaveTextContent("Applied value: 30 days");
    await user.clear(retention);
    await user.type(retention, "-1");
    await user.click(
      within(drawer).getByRole("button", { name: "Save to draft" }),
    );
    expect(
      within(drawer).getByText("Fix the highlighted inputs to save."),
    ).toBeInTheDocument();
    await user.clear(retention);
    await user.type(retention, "7");
    await save(user);

    const row = within(
      screen.getByRole("table", { name: "Artifact kinds" }),
    ).getByRole("row", { name: /plan/ });
    expect(row).toHaveTextContent("7 days");
    expect(row).toHaveTextContent("changed in draft");
    const text = await draftText(user);
    expect(text).toContain("retention_days = 7");
    expect(text).toContain('storage_class = "custom key on an artifact kind"');
  });

  test("a template is duplicated and edited; invalid data blocks saving", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Duplicate template release" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Edit template release_copy",
    });
    await user.clear(
      within(drawer).getByRole("textbox", { name: "Description" }),
    );
    await user.type(
      within(drawer).getByRole("textbox", { name: "Description" }),
      "Hotfix",
    );
    const data = within(drawer).getAllByRole("textbox", {
      name: "Initial data (JSON object)",
    });
    await user.clear(data[1]);
    await user.click(data[1]);
    await user.paste("{ not json");
    expect(
      within(drawer).getByText('Data for "notes" is not valid JSON.'),
    ).toBeInTheDocument();
    await user.click(
      within(drawer).getByRole("button", { name: "Save to draft" }),
    );
    expect(
      within(drawer).getByText("Fix the highlighted inputs to save."),
    ).toBeInTheDocument();
    await user.clear(data[1]);
    await user.click(data[1]);
    await user.paste('{ "title": "Patch notes" }');
    await save(user);

    const text = await draftText(user);
    expect(text).toContain("[templates.release_copy]");
    expect(text).toContain('description = "Hotfix"');
    expect(text).toContain('title = "Patch notes"');
    expect(text).toContain('description = "Release checklist"');
  });

  test("retiring a work type a template uses is reported by the template", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Retire work type epic" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit template release" }),
    );
    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).getByText(/references unknown work-unit type "epic"/),
    ).toBeInTheDocument();
    // The open drawer hides the page from assistive technology.
    expect(
      screen.getByRole("region", {
        name: "Unsaved definition draft",
        hidden: true,
      }),
    ).toHaveTextContent("1 problem to fix");
  });

  test("reference slots and the hierarchy are edited without a file", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Edit work type task" }),
    );
    let drawer = await screen.findByRole("dialog");
    await user.click(
      within(drawer).getByRole("button", { name: "Add reference slot" }),
    );
    const slot = within(drawer).getByRole("textbox", { name: /Slot name/ });
    await user.clear(slot);
    await user.type(slot, "designs");
    await user.click(
      within(
        within(drawer).getByRole("group", { name: "Artifact kinds" }),
      ).getByRole("checkbox", { name: "design" }),
    );
    await user.click(
      within(
        within(drawer).getByRole("group", {
          name: "Needs a trusted review before these states",
        }),
      ).getByRole("checkbox", { name: "done" }),
    );
    await save(user);

    await user.click(
      screen.getByRole("button", { name: "Edit hierarchy and relationships" }),
    );
    drawer = await screen.findByRole("dialog", {
      name: "Hierarchy and relationships",
    });
    const levels = within(drawer).getByRole("textbox", { name: "Levels" });
    await user.click(levels);
    await user.paste("epic\ntask");
    await user.type(
      within(drawer).getByRole("textbox", { name: "Maximum depth" }),
      "3",
    );
    await save(user);

    const summary = screen.getByRole("table", {
      name: "Hierarchy and relationships",
    });
    expect(summary).toHaveTextContent("epic → task");
    const text = await draftText(user);
    expect(text).toContain('name = "designs"');
    expect(text).toContain('kinds = [ "design" ]');
    expect(text).toContain('require_trusted_for_statuses = [ "done" ]');
    expect(text).toMatch(
      /\[hierarchy\]\nlevels = \[ "epic", "task" \]\nmax_depth = 3/,
    );
  });
});
