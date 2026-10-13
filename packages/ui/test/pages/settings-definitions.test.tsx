import { SettingsDefinitionsPage } from "@/pages/settings-definitions";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { recordEntry, recordTypesHandler } from "../mocks/records";
import { server } from "../mocks/server";
import { catalogHandler, declaredEntry } from "../mocks/tasks";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

function renderDefinitions() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/settings/definitions"
        element={<SettingsDefinitionsPage />}
      />
    </Routes>,
    { route: "/p/test-project/settings/definitions" },
  );
}

const revision = (version: number) => ({
  version,
  definition: `[work_units.bug]\n# revision ${version}\n`,
  applied_at: Date.now() - version * 60_000,
  applied_by: `user-${version}`,
  change_summary: JSON.stringify([`Change ${version}`]),
  strategy: null,
});

describe("SettingsDefinitionsPage", () => {
  test("a project without definitions shows the CLI fallback", async () => {
    renderDefinitions();

    expect(
      await screen.findByText(
        "No definitions have been applied to this project.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/tila schema apply --expected-revision 0/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("No revisions applied yet."),
    ).toBeInTheDocument();
  });

  test("shows the applied revision, types and paged history", async () => {
    const user = userEvent.setup();
    const before: (string | null)[] = [];
    server.use(
      http.get("*/projects/*/schema", () =>
        HttpResponse.json({
          ok: true,
          schema: revision(25),
          version: 25,
          revision: 25,
        }),
      ),
      http.get("*/projects/*/schema/history", ({ request }) => {
        const params = new URL(request.url).searchParams;
        before.push(params.get("before"));
        const top = Number(params.get("before") ?? 26) - 1;
        const versions = Array.from(
          { length: Math.min(20, top) },
          (_, i) => top - i,
        );
        return HttpResponse.json({ ok: true, entries: versions.map(revision) });
      }),
      catalogHandler([
        declaredEntry("bug", 3, {
          fields: [{ name: "title", type: "string", required: true }],
          lifecycle: {
            field: "status",
            dispatchable: ["open"],
            terminal: ["closed"],
            dependency_satisfied: ["closed"],
          },
        }),
      ]),
      recordTypesHandler([recordEntry("config", 2)]),
    );
    renderDefinitions();

    expect(
      await screen.findByText(
        (_, el) =>
          el?.tagName === "P" &&
          /^Revision 25 · applied .+ by user-25$/.test(el.textContent ?? ""),
      ),
    ).toBeInTheDocument();
    const work = await screen.findByRole("table", { name: "Work types" });
    expect(within(work).getByText("title: string")).toBeInTheDocument();
    expect(within(work).getByText("status: open → closed")).toBeInTheDocument();
    expect(
      await screen.findByRole("table", { name: "Record types" }),
    ).toHaveTextContent("config");

    const history = await screen.findByRole("table", {
      name: "Definition history",
    });
    expect(within(history).getAllByRole("row")).toHaveLength(21);
    await user.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() =>
      expect(within(history).getAllByRole("row")).toHaveLength(26),
    );
    expect(before).toEqual([null, "6"]);
    expect(
      screen.queryByRole("button", { name: "Load older" }),
    ).not.toBeInTheDocument();
  });

  test("a forbidden read is access denied, not 'none applied'", async () => {
    server.use(
      http.get("*/projects/*/schema", () =>
        HttpResponse.json(
          { ok: false, error: { code: "permission-denied", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderDefinitions();

    expect(
      await screen.findByText(
        "Your access does not include project definitions.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No definitions have been applied to this project."),
    ).not.toBeInTheDocument();
  });

  test("an outage is an unknown state with retry", async () => {
    server.use(
      http.get("*/projects/*/schema", () =>
        HttpResponse.json(
          { ok: false, error: { code: "do-unreachable", message: "down" } },
          { status: 503 },
        ),
      ),
    );
    renderDefinitions();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load definitions.");
    expect(
      within(alert).getByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No definitions have been applied to this project."),
    ).not.toBeInTheDocument();
  });
});
