import { SettingsDefinitionsPage } from "@/pages/settings-definitions";
import { SettingsDefinitionsReviewPage } from "@/pages/settings-definitions-review";
import { SettingsDefinitionsRevisionPage } from "@/pages/settings-definitions-revision";
import { SettingsDefinitionsSourcePage } from "@/pages/settings-definitions-source";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import {
  type Sent,
  appliedAt,
  applyWith,
  ok,
  previewAt,
  whoamiAs,
} from "../fixtures/definitions";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const BASE = "/p/test-project/settings/definitions";

function renderEditor(path = "") {
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
        path="/p/:projectId/settings/definitions/source"
        element={<SettingsDefinitionsSourcePage />}
      />
      <Route
        path="/p/:projectId/settings/definitions/history/:version"
        element={<SettingsDefinitionsRevisionPage />}
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
`;

async function draftSource(
  user: ReturnType<typeof userEvent.setup>,
  source: string,
) {
  const editor = await screen.findByLabelText("Draft (TOML)");
  await user.clear(editor);
  await user.click(editor);
  await user.paste(source);
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("definition editor", () => {
  test("a first project is started, reviewed and applied as revision 1", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 0, source: null });
    previewAt(() => 0);
    const applies = applyWith(ok(1));
    renderEditor();

    await user.click(
      await screen.findByRole("button", { name: "Start definitions" }),
    );
    await draftSource(user, TASK);
    await user.click(screen.getByRole("link", { name: "Review changes" }));

    expect(
      await screen.findByRole("heading", { name: "Will be created" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Add work type/)).toHaveTextContent(
      "Add work type task",
    );
    await user.click(
      screen.getByRole("button", { name: "Apply as revision 1" }),
    );

    expect(
      await screen.findByText("Applied as revision 1."),
    ).toBeInTheDocument();
    expect(applies).toHaveLength(1);
    expect(applies[0].body).toEqual({
      definition: TASK,
      expected_revision: 0,
      reviewed_definition: TASK,
    });
    expect(applies[0].key).toMatch(/[0-9a-f-]{36}/);
  });

  test("a concurrent apply keeps the draft and rebases it onto the latest revision", async () => {
    const user = userEvent.setup();
    const state = { revision: 3, source: TASK };
    appliedAt(state);
    previewAt(() => state.revision);
    const applies = applyWith(() => {
      // Someone else applied revision 4 between preview and apply.
      state.revision = 4;
      state.source = `${TASK}\n[artifacts.plan]\nmime_types = ["text/markdown"]\nretention_days = 30\n`;
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
    }, ok(5));
    renderEditor("/source");

    await draftSource(user, TASK_AND_BUG);
    await user.click(screen.getByRole("link", { name: "Review changes" }));
    await user.click(
      await screen.findByRole("button", { name: "Apply as revision 4" }),
    );

    const panel = await screen.findByRole("region", {
      name: "Revision 4 was applied after your draft started",
    });
    expect(within(panel).getByText(/Add artifact kind/)).toBeInTheDocument();
    await user.click(
      within(panel).getByRole("button", {
        name: "Move my draft onto revision 4",
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Apply as revision 5" }),
    );

    await screen.findByText("Applied as revision 5.");
    expect(applies[1].body.expected_revision).toBe(4);
    const merged = applies[1].body.definition as string;
    expect(merged).toContain("[artifacts.plan]");
    expect(merged).toContain("[[work_units.bug.fields]]");
    expect(applies[1].key).not.toBe(applies[0].key);
  });

  test("a participant previews but cannot apply; a viewer cannot draft", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 2, source: TASK });
    previewAt(() => 2);
    whoamiAs("participant");
    const { unmount } = renderEditor("/source");

    await draftSource(user, TASK_AND_BUG);
    await user.click(screen.getByRole("link", { name: "Review changes" }));
    expect(
      await screen.findByText(/A maintainer applies definition changes/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Apply as revision/ }),
    ).not.toBeInTheDocument();
    unmount();

    window.sessionStorage.clear();
    whoamiAs("viewer");
    renderEditor();
    expect(
      await screen.findByText(
        "Your access can read definitions but not change them.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Edit source" }),
    ).not.toBeInTheDocument();
  });

  test("a refused apply keeps the draft and refreshes access", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 2, source: TASK });
    previewAt(() => 2);
    applyWith(() =>
      HttpResponse.json(
        { ok: false, error: { code: "permission-denied", message: "no" } },
        { status: 403 },
      ),
    );
    renderEditor("/source");

    await draftSource(user, TASK_AND_BUG);
    await user.click(screen.getByRole("link", { name: "Review changes" }));
    await user.click(
      await screen.findByRole("button", { name: "Apply as revision 3" }),
    );
    expect(
      await screen.findByText(/Your access changed and the apply was refused/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Keep editing" }));
    expect(
      await screen.findByRole("region", { name: "Unsaved definition draft" }),
    ).toHaveTextContent("on revision 2 · 1 change");
  });

  test("a destructive preview shows its impact and cancel sends nothing", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 7, source: TASK_AND_BUG });
    previewAt(
      () => 7,
      () => ({
        changes: [
          {
            kind: "work-unit-removed",
            unitType: "bug",
            entityCount: 3,
            archivedCount: 1,
          },
        ],
        autoApplicable: false,
      }),
    );
    const applies = applyWith(ok(8));
    renderEditor("/source");

    await draftSource(user, TASK);
    await user.click(screen.getByRole("link", { name: "Review changes" }));
    expect(
      await screen.findByText(
        "3 tasks and 1 archived task stay readable as legacy data; nothing is deleted.",
      ),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Apply as revision 8" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Retire work type/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(applies).toHaveLength(0);

    await user.click(
      screen.getByRole("button", { name: "Apply as revision 8" }),
    );
    const again = await screen.findByRole("dialog");
    await user.type(within(again).getByRole("textbox"), "test-project");
    await user.click(
      within(again).getByRole("button", { name: "Apply changes" }),
    );
    await screen.findByText("Applied as revision 8.");
    expect(applies[0].body).toMatchObject({
      expected_revision: 7,
      strategy: "relax",
      reviewed_definition: TASK,
    });
  });

  test("an unconfirmed apply retries with the same idempotency key", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 1, source: TASK });
    previewAt(() => 1);
    const applies = applyWith(
      () =>
        HttpResponse.json(
          { ok: false, error: { code: "do-unreachable", message: "down" } },
          { status: 503 },
        ),
      ok(2),
    );
    renderEditor("/source");

    await draftSource(user, TASK_AND_BUG);
    await user.click(screen.getByRole("link", { name: "Review changes" }));
    await user.click(
      await screen.findByRole("button", { name: "Apply as revision 2" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Retry apply" }),
    );

    await screen.findByText("Applied as revision 2.");
    expect(applies).toHaveLength(2);
    expect(applies[1].key).toBe(applies[0].key);
    expect(applies[1].body).toEqual(applies[0].body);
  });

  test("definition problems from preview are listed with their path and focused", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 1, source: TASK });
    server.use(
      http.post("*/projects/*/schema/preview", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "schema-parse-error",
              message: "Schema parse failed",
              errors: [
                {
                  message: 'references unknown work-unit type "missing"',
                  path: "templates.release.entities.root.type",
                },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );
    renderEditor("/source");

    await draftSource(user, TASK_AND_BUG);
    await user.click(screen.getByRole("link", { name: "Review changes" }));
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent(
      'templates.release.entities.root.type: references unknown work-unit type "missing"',
    );
    await waitFor(() => expect(summary).toHaveFocus());
    expect(
      screen.getByRole("button", { name: "Apply as revision 2" }),
    ).toBeDisabled();
  });

  test("a historical revision is restored as a new revision after review", async () => {
    const user = userEvent.setup();
    appliedAt({ revision: 3, source: TASK_AND_BUG });
    server.use(
      http.get("*/projects/*/schema/history", () =>
        HttpResponse.json({
          ok: true,
          entries: [
            {
              version: 2,
              definition: TASK,
              applied_at: Date.now(),
              applied_by: "someone",
              change_summary: null,
              strategy: null,
            },
            {
              version: 1,
              definition: "schema_version = 1\n",
              applied_at: Date.now(),
              applied_by: "someone",
              change_summary: null,
              strategy: null,
            },
          ],
        }),
      ),
    );
    const previews = previewAt(() => 3);
    const applies = applyWith(ok(4));
    renderEditor("/history/2");

    expect(
      await screen.findByRole("heading", { name: "Changes from revision 1" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Restore as a new revision" }),
    );
    expect(
      await screen.findByText(/This draft restores revision 2/),
    ).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: "Apply as revision 4" }),
    );
    await screen.findByText("Applied as revision 4.");
    expect(previews).toContain(TASK);
    expect(applies[0].body).toMatchObject({
      definition: TASK,
      expected_revision: 3,
    });
  });
});
