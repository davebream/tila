import { SettingsDefinitionsPage } from "@/pages/settings-definitions";
import { SettingsDefinitionsImportPage } from "@/pages/settings-definitions-import";
import { SettingsDefinitionsReviewPage } from "@/pages/settings-definitions-review";
import userEvent from "@testing-library/user-event";
import { parseSchemaToml } from "@tila/core";
import { canonicalJson } from "@tila/schemas";
import { HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { appliedAt, applyWith, ok, previewAt } from "../fixtures/definitions";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const BASE = "/p/test-project/settings/definitions";

function render(path = "") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/settings/definitions"
        element={<SettingsDefinitionsPage />}
      />
      <Route
        path="/p/:projectId/settings/definitions/review"
        element={<SettingsDefinitionsReviewPage />}
      />
      <Route
        path="/p/:projectId/settings/definitions/import"
        element={<SettingsDefinitionsImportPage />}
      />
    </Routes>,
    { route: `${BASE}${path}` },
  );
}

const TASK = `schema_version = 1

[work_units.task]
fields = [{ name = "title", type = "string", required = true }]
`;

const TASK_AND_BUG = `${TASK}
[work_units.bug]
fields = [{ name = "title", type = "string", required = true }]

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 30
`;

const YAML = `schema_version: 1
work_units:
  task:
    fields:
      - name: title
        type: string
        required: true
`;

function semantic(source: unknown) {
  const parsed = parseSchemaToml(String(source));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return canonicalJson(parsed.schema);
}

async function paste(user: ReturnType<typeof userEvent.setup>, text: string) {
  const box = await screen.findByLabelText("Or paste the definition");
  await user.click(box);
  await user.paste(text);
}

const load = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(
    screen.getByRole("button", { name: /Load into draft|Replace my draft/ }),
  );

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("definition import", () => {
  test("bootstraps a project from a pasted file", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 0, source: null });
    previewAt(() => 0);
    const applies = applyWith(ok(1));
    render();

    await user.click(
      await screen.findByRole("link", { name: "Import a file" }),
    );
    await paste(user, TASK);
    await load(user);

    const summary = await screen.findByRole("region", {
      name: "Imported file",
    });
    expect(summary).toHaveTextContent("This draft imports pasted text (TOML");
    expect(summary).toHaveTextContent("Added (2)");
    await user.click(
      await screen.findByRole("button", { name: "Apply as revision 1" }),
    );
    await screen.findByText("Applied as revision 1.");
    expect(applies[0].body.expected_revision).toBe(0);
    expect(semantic(applies[0].body.definition)).toBe(semantic(TASK));
  });

  test("an uploaded YAML file applies the same definition as TOML", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 0, source: null });
    previewAt(() => 0);
    const applies = applyWith(ok(1));
    render("/import");

    await user.upload(
      await screen.findByLabelText("File (.toml, .yaml or .yml)"),
      new File([YAML], "defs.yaml", { type: "application/yaml" }),
    );
    await load(user);
    expect(
      await screen.findByRole("region", { name: "Imported file" }),
    ).toHaveTextContent("defs.yaml (YAML");
    await user.click(
      await screen.findByRole("button", { name: "Apply as revision 1" }),
    );
    await screen.findByText("Applied as revision 1.");
    expect(semantic(applies[0].body.definition)).toBe(semantic(TASK));
  });

  test("merge replaces the file's declarations and keeps the rest", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 3, source: TASK_AND_BUG });
    previewAt(() => 3);
    const applies = applyWith(ok(4));
    render("/import");

    await paste(
      user,
      `[work_units.task]\nfields = [{ name = "title", type = "string" }]\n`,
    );
    await load(user);
    const summary = await screen.findByRole("region", {
      name: "Imported file",
    });
    expect(summary).toHaveTextContent("Changed (1)work_units.task");
    expect(summary).not.toHaveTextContent("Removed");
    expect(
      screen.queryByText(/declarations? the imported file doesn't contain/),
    ).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole("button", { name: "Apply as revision 4" }),
    );
    await screen.findByText("Applied as revision 4.");
    const applied = String(applies[0].body.definition);
    expect(applied).toContain("work_units.bug");
    expect(applied).toContain("[artifacts.plan]");
    expect(applies[0].body.expected_revision).toBe(3);
  });

  test("replace lists removals and blocks apply until they are confirmed", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 3, source: TASK_AND_BUG });
    // The server treats these removals as reviewable; the import gate applies
    // regardless, so isolate it with an auto-applicable preview.
    previewAt(() => 3);
    const applies = applyWith(ok(4));
    render("/import");

    await paste(user, TASK);
    await user.click(screen.getByRole("radio", { name: /Replace/ }));
    await load(user);

    expect(
      await screen.findByRole("region", { name: "Imported file" }),
    ).toHaveTextContent("Removed (2)work_units.bug, artifacts.plan");
    const apply = await screen.findByRole("button", {
      name: "Apply as revision 4",
    });
    expect(apply).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /Remove 2 declarations/ }),
    );
    expect(apply).toBeEnabled();
    await user.click(apply);
    await screen.findByText("Applied as revision 4.");
    expect(String(applies[0].body.definition)).not.toContain("bug");
  });

  test("a concurrent change makes the import conflict and keeps the draft", async () => {
    const user = userEvent.setup();
    const state = { revision: 3, source: TASK };
    appliedAt(state);
    previewAt(() => state.revision);
    applyWith(() => {
      // Someone else applies revision 4 just before this import lands.
      state.revision = 4;
      state.source = `${TASK}\n[artifacts.log]\nmime_types = ["text/plain"]\n`;
      return HttpResponse.json(
        {
          ok: false,
          error: {
            code: "schema-revision-conflict",
            message: "Schema revision changed",
            retryable: false,
            revision: 4,
          },
        },
        { status: 412 },
      );
    });
    render("/import");

    await paste(user, TASK_AND_BUG);
    await load(user);
    await user.click(
      await screen.findByRole("button", { name: "Apply as revision 4" }),
    );
    expect(
      await screen.findByRole("region", {
        name: "Revision 4 was applied after your draft started",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Imported file" }),
    ).toHaveTextContent("pasted text");
  });

  test.each([
    [
      "a credential",
      'schema_version = 1\n[extra]\napi_key = "abc"\n',
      /extra\.api_key/,
    ],
    [
      "a client connection file",
      'project_id = "p"\nbackend = "local"\nschema_version = 1\n',
      /client connection file/,
    ],
    [
      "newer export metadata",
      'schema_version = 1\n[tila_export]\nformat = "tila-definitions"\nformat_version = 9\n',
      /newer tila/,
    ],
  ])("rejects %s and creates no draft", async (_name, text, message) => {
    const user = userEvent.setup();
    appliedAt({ revision: 2, source: TASK });
    render("/import");
    await paste(user, text);
    await load(user);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(
      screen.getByRole("heading", { name: "Import definitions" }),
    ).toBeInTheDocument();
    const stored = Object.keys(window.sessionStorage).map(
      (key) => window.sessionStorage.getItem(key) ?? "",
    );
    expect(stored.some((value) => value.includes("importedFrom"))).toBe(false);
  });

  test("rejects unsupported and oversize files", async () => {
    const user = userEvent.setup({ applyAccept: false });
    appliedAt({ revision: 2, source: TASK });
    render("/import");
    const input = await screen.findByLabelText("File (.toml, .yaml or .yml)");

    await user.upload(input, new File(["{}"], "defs.json"));
    await load(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("not .json");

    await user.upload(input, new File(["x".repeat(300 * 1024)], "big.toml"));
    await load(user);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/256 KiB/),
    );
  });

  test("a file that matches the applied revision is not loaded", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 2, source: TASK });
    render("/import");
    await paste(user, TASK);
    await load(user);
    expect(
      await screen.findByText(/matches revision 2; there is nothing to import/),
    ).toBeInTheDocument();
  });
});

describe("definition export", () => {
  let blobs: Blob[];
  let names: string[];

  beforeEach(() => {
    blobs = [];
    names = [];
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return "blob:test";
      },
      revokeObjectURL: () => {},
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  test("downloads TOML and YAML with export metadata", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 5, source: TASK_AND_BUG });
    render();

    const exporter = (await screen.findByText("Export revision 5"))
      .parentElement as HTMLElement;
    await user.click(
      within(exporter).getByRole("button", { name: "Download TOML" }),
    );
    await waitFor(() => expect(blobs).toHaveLength(1));
    const toml = await blobs[0].text();
    expect(names[0]).toBe("test-project-definitions-r5.toml");
    expect(toml).toContain("[tila_export]");
    expect(toml).toContain('project_id = "test-project"');
    expect(toml).toContain("revision = 5");

    await user.click(
      within(exporter).getByRole("button", { name: "Download YAML" }),
    );
    await waitFor(() => expect(blobs).toHaveLength(2));
    expect(names[1]).toBe("test-project-definitions-r5.yaml");
    const yaml = await blobs[1].text();
    expect(yaml).toContain("tila_export:");
    expect(yaml).toContain("# tila definitions export");
  });

  test("refuses to export a stored definition with credentials", async () => {
    const user = userEvent.setup();
    appliedAt({
      revision: 5,
      source: 'schema_version = 1\n[extra]\npassword = "hunter2"\n',
    });
    render();
    await user.click(
      await screen.findByRole("button", { name: "Download TOML" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "extra.password",
    );
    expect(blobs).toHaveLength(0);
  });
});
