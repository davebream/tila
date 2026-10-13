import { OverviewPage } from "@/pages/overview";
import { CAPABILITIES } from "@tila/schemas";
import { http, HttpResponse, delay } from "msw";
import { Route, Routes } from "react-router";
import {
  type OverviewScenario,
  SCENARIOS,
} from "../fixtures/overview-scenarios";
import { emptyQueue } from "../mocks/handlers";
import { recordTypesHandler } from "../mocks/records";
import { server } from "../mocks/server";
import { catalogHandler } from "../mocks/tasks";
import { renderWithProviders, screen, within } from "../test-utils";

function renderOverview() {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/overview" element={<OverviewPage />} />
    </Routes>,
    { route: "/p/test-project/overview" },
  );
}

function queueHandler(
  body: () => Response | Promise<Response>,
  onRequest?: (params: URLSearchParams) => void,
) {
  return http.get("*/projects/*/queue", async ({ request }) => {
    onRequest?.(new URL(request.url).searchParams);
    return body();
  });
}

const queueUnavailable = () =>
  HttpResponse.json(
    { ok: false, error: { code: "do-unreachable", message: "down" } },
    { status: 503 },
  );

function useScenario(scenario: OverviewScenario) {
  server.use(
    http.get("*/projects/*/schema", () => HttpResponse.json(scenario.schema)),
    catalogHandler(scenario.work),
    recordTypesHandler(scenario.records),
    queueHandler(() =>
      scenario.queue
        ? HttpResponse.json({ ok: true, result: scenario.queue })
        : queueUnavailable(),
    ),
  );
}

const scenario = (name: string) => {
  const found = SCENARIOS.find((s) => s.name.startsWith(name));
  if (!found) throw new Error(`no scenario ${name}`);
  return found;
};

describe("OverviewPage", () => {
  test("a new project guides the user into settings", async () => {
    useScenario(scenario("S1 new project"));
    renderOverview();

    const setup = await screen.findByRole("region", {
      name: "Set up this project",
    });
    expect(
      within(setup).getByRole("link", { name: "Review definitions" }),
    ).toHaveAttribute("href", "/p/test-project/settings/definitions");
    expect(
      within(setup).getByRole("link", {
        name: "Invite members and manage credentials",
      }),
    ).toHaveAttribute("href", "/p/test-project/settings");
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
  });

  test("a configured project with nothing to do says so and shows what was checked", async () => {
    useScenario(scenario("S1 configured"));
    renderOverview();

    expect(
      await screen.findByText("Nothing needs attention."),
    ).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Attention checks" });
    expect(
      within(table).getByText("No executions with an uncertain outcome"),
    ).toBeInTheDocument();
    expect(
      within(table).getByText("No suspended executions"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Set up this project" }),
    ).not.toBeInTheDocument();
  });

  test("the next action links to the matching filtered list", async () => {
    useScenario(scenario("S2"));
    renderOverview();

    const next = await screen.findByRole("region", { name: "Next action" });
    expect(
      within(next).getByRole("link", {
        name: "View 2 executions with an uncertain outcome",
      }),
    ).toHaveAttribute("href", "/p/test-project/queue?state=uncertain");

    const table = screen.getByRole("table", { name: "Attention checks" });
    const links = within(table).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/p/test-project/queue?state=uncertain",
      "/p/test-project/queue?state=suspended",
    ]);
  });

  test("an outage is an unknown state, never a reassuring zero", async () => {
    useScenario(scenario("S3"));
    renderOverview();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Current state unknown.");
    expect(
      screen.getAllByText(/Could not load the execution queue/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/^No .*executions/)).not.toBeInTheDocument();
  });

  test("counts come from one bounded request, however large", async () => {
    const requests: URLSearchParams[] = [];
    useScenario(scenario("S1 configured"));
    server.use(
      queueHandler(
        () =>
          HttpResponse.json({
            ok: true,
            result: emptyQueue({ uncertain: 10_000 }),
          }),
        (params) => requests.push(params),
      ),
    );
    renderOverview();

    expect(
      await screen.findByRole("link", {
        name: "View 10,000 executions with an uncertain outcome",
      }),
    ).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0].get("limit")).toBe("1");
    expect(requests[0].get("state")).toBeNull();
  });

  test("while loading it never shows a count", async () => {
    useScenario(scenario("S1 configured"));
    server.use(
      queueHandler(async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    renderOverview();

    expect(
      await screen.findByText("Checking what needs attention…"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^No .*executions/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
  });

  test("a source the credential cannot read is listed as not checked", async () => {
    useScenario(scenario("S1 configured"));
    server.use(
      queueHandler(() =>
        HttpResponse.json(
          { ok: false, error: { code: "permission-denied", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderOverview();

    expect(
      await screen.findByText(
        "Your access does not include any attention checks.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Not checked with your access: the execution queue."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
  });

  test("a restricted credential is told what its counts cover", async () => {
    useScenario(scenario("S2"));
    server.use(
      http.get("*/api/whoami", () =>
        HttpResponse.json({
          ok: true,
          project_id: "test-project",
          token_name: "bug-bot",
          scopes: "write",
          role: "participant",
          policy: {
            role: "participant",
            capabilities: [...CAPABILITIES],
            restrictions: { task_types: ["bug"] },
          },
        }),
      ),
    );
    renderOverview();

    expect(
      await screen.findByText(/only sees some task and record types/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Next action" }),
    ).toBeInTheDocument();
    // Definitions are not a surface restricted credentials may read.
    expect(screen.queryByText("Definitions")).not.toBeInTheDocument();
  });

  test("project facts show definitions and visible counts", async () => {
    useScenario(scenario("S2"));
    renderOverview();

    const facts = await screen.findByRole("region", { name: "Project" });
    expect(
      await within(facts).findByText(
        /Revision 3, applied .* by owner@example.test/,
      ),
    ).toBeInTheDocument();
    expect(
      within(facts).getByText(/4 tasks in 1 type · excluding archived/),
    ).toBeInTheDocument();
  });
});
