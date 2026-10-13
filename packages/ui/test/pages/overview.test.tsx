import { OverviewPage } from "@/pages/overview";
import { CAPABILITIES } from "@tila/schemas";
import { http, HttpResponse, delay } from "msw";
import { Route, Routes } from "react-router";
import {
  ME,
  type OverviewScenario,
  QUIET,
  SCENARIOS,
  type ScenarioSources,
  sourceHandlers,
} from "../fixtures/overview-scenarios";
import { recordTypesHandler } from "../mocks/records";
import { server } from "../mocks/server";
import { catalogHandler } from "../mocks/tasks";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

function renderOverview() {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/overview" element={<OverviewPage />} />
    </Routes>,
    { route: "/p/test-project/overview" },
  );
}

type Seen = { path: string; params: URLSearchParams };

function useScenario(
  scenario: OverviewScenario,
  sources: ScenarioSources = scenario.sources,
) {
  const seen: Seen[] = [];
  server.use(
    // An owner signed in as a principal questions can be routed to.
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        token_name: "test-user",
        scopes: "admin",
        role: "owner",
        principal_id: ME,
      }),
    ),
    http.get("*/projects/*/schema", () => HttpResponse.json(scenario.schema)),
    catalogHandler(scenario.work),
    recordTypesHandler(scenario.records),
    ...sourceHandlers(sources, (path, params) => seen.push({ path, params })),
  );
  return seen;
}

const scenario = (name: string) => {
  const found = SCENARIOS.find((s) => s.name.startsWith(name));
  if (!found) throw new Error(`no scenario ${name}`);
  return found;
};

function identity(capabilities: readonly string[], restricted = false) {
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        token_name: "limited",
        scopes: "read",
        role: "participant",
        principal_id: ME,
        policy: {
          role: "participant",
          capabilities,
          ...(restricted ? { restrictions: { task_types: ["bug"] } } : {}),
        },
      }),
    ),
  );
}

const hrefs = (table: HTMLElement) =>
  within(table)
    .getAllByRole("link")
    .map((link) => link.getAttribute("href"));

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
    for (const text of [
      "No executions with an uncertain outcome",
      "No open tasks waiting on prerequisites",
      "No questions waiting on you",
      "No pending deliveries no longer being woken",
      "No agents whose mailbox occupant needs a check",
    ])
      expect(within(table).getByText(text)).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Set up this project" }),
    ).not.toBeInTheDocument();
  });

  test("unconfigured conversations make a quiet project partial, not idle", async () => {
    useScenario(scenario("S1 quiet project with conversations"));
    renderOverview();

    expect(
      await screen.findByText(/Nothing found in the checks that completed/),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Deliveries: not configured on this deployment."),
    ).toHaveLength(2);
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
  });

  test("the next action and every finding link to the matching filtered list", async () => {
    useScenario(scenario("S2"));
    renderOverview();

    const next = await screen.findByRole("region", { name: "Next action" });
    expect(
      within(next).getByRole("link", {
        name: "View 2 executions with an uncertain outcome",
      }),
    ).toHaveAttribute("href", "/p/test-project/queue?state=uncertain");
    await waitFor(() =>
      expect(
        hrefs(screen.getByRole("table", { name: "Attention checks" })),
      ).toEqual([
        "/p/test-project/queue?state=uncertain",
        "/p/test-project/queue?lease=expired",
        "/p/test-project/decisions",
        "/p/test-project/runtime?filter=attention",
      ]),
    );
  });

  test("a finding during an outage leads, with the outage called out", async () => {
    useScenario(scenario("S3 failed hotfix"));
    renderOverview();

    const next = await screen.findByRole("region", { name: "Next action" });
    expect(
      within(next).getByRole("link", {
        name: "View 3 open tasks waiting on prerequisites",
      }),
    ).toHaveAttribute("href", "/p/test-project/tasks?blocked=1");
    expect(
      screen.getByRole("link", { name: "1 task that failed or was abandoned" }),
    ).toHaveAttribute(
      "href",
      "/p/test-project/tasks?outcome=failure,abandoned",
    );
    expect(
      await screen.findByText(/Some checks did not complete/),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/Could not load the execution queue/).length,
    ).toBe(3);
  });

  test("a total outage is an unknown state, never a reassuring zero", async () => {
    useScenario(scenario("S3 total outage"));
    renderOverview();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Current state unknown.");
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Attention checks" });
    expect(within(table).queryByText(/^No /)).not.toBeInTheDocument();
    expect(within(table).getAllByText(/Current state unknown/)).toHaveLength(9);
  });

  test("every count is one bounded request, however large", async () => {
    const seen = useScenario(scenario("S1 configured"), {
      ...QUIET,
      queue: { uncertain: 10_000 },
    });
    renderOverview();

    expect(
      await screen.findByRole("link", {
        name: "View 10,000 executions with an uncertain outcome",
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(seen).toHaveLength(8));
    for (const { params } of seen) expect(params.get("limit")).toBe("1");
    const paths = seen.map(({ path }) => path.split("/").at(-1)).sort();
    expect(paths).toEqual([
      "deliveries",
      "deliveries",
      "questions",
      "queue",
      "queue",
      "runtime-view",
      "tasks",
      "tasks",
    ]);
  });

  test("each count uses the same filters as the list it links to", async () => {
    const seen = useScenario(scenario("S1 configured"), {
      ...QUIET,
      blocked: 4,
      expired: 2,
      questions: 3,
    });
    renderOverview();

    const table = await screen.findByRole("table", {
      name: "Attention checks",
    });
    const expiredLink = await within(table).findByRole("link", {
      name: /deliveries expired unacknowledged/,
    });
    const linked = new URL(expiredLink.getAttribute("href") ?? "", "http://x")
      .searchParams;
    const expiredRequest = seen.find(
      ({ params }) => params.get("state") === "expired",
    );
    expect(expiredRequest?.params.get("expires_after")).toBe(
      linked.get("expires_after"),
    );

    const blockedRequest = seen.find(({ params }) => params.has("blocked"));
    expect(blockedRequest?.params.get("blocked")).toBe("1");
    expect(blockedRequest?.params.get("archived")).toBe("0");
    expect(
      within(table).getByRole("link", {
        name: "4 open tasks waiting on prerequisites",
      }),
    ).toHaveAttribute("href", "/p/test-project/tasks?blocked=1");

    // The inbox's default view is "Waiting on me": open and routed to me.
    const questionsRequest = seen.find(({ path }) =>
      path.endsWith("/questions"),
    );
    expect(Object.fromEntries(questionsRequest?.params ?? [])).toEqual({
      state: "open",
      responder_principal_id: ME,
      limit: "1",
    });
    expect(
      within(table).getByRole("link", {
        name: "3 questions waiting on you",
      }),
    ).toHaveAttribute("href", "/p/test-project/decisions");
  });

  test("a worker waiting on an answer is the next action", async () => {
    useScenario(scenario("S4 worker waiting"));
    renderOverview();

    const next = await screen.findByRole("region", { name: "Next action" });
    expect(
      within(next).getByRole("link", {
        name: "View 2 questions waiting on you",
      }),
    ).toHaveAttribute("href", "/p/test-project/decisions");
  });

  test("a failed questions request is unknown, never zero", async () => {
    useScenario(scenario("S4 decisions request failed"));
    renderOverview();

    expect(
      await screen.findByText(/Could not load decisions/),
    ).toHaveTextContent("Could not load decisions. Current state unknown.");
    expect(
      screen.queryByText("No questions waiting on you"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
  });

  test("a credential without a principal is not asked about questions", async () => {
    const seen = useScenario(scenario("S1 configured"));
    server.use(
      http.get("*/api/whoami", () =>
        HttpResponse.json({
          ok: true,
          project_id: "test-project",
          token_name: "test-user",
          scopes: "admin",
          role: "owner",
        }),
      ),
    );
    renderOverview();

    expect(
      await screen.findByText("This credential has no principal to wait on."),
    ).toBeInTheDocument();
    expect(seen.some(({ path }) => path.endsWith("/questions"))).toBe(false);
  });

  test("while loading it never shows a count", async () => {
    useScenario(scenario("S1 configured"));
    server.use(
      http.get("*/projects/*/queue", async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    renderOverview();

    expect(
      await screen.findByText("Checking what needs attention…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
  });

  test("checks the credential cannot use are skipped and listed", async () => {
    const seen = useScenario(scenario("S1 configured"));
    identity(CAPABILITIES.filter((cap) => cap.endsWith(":read")));
    renderOverview();

    expect(
      await screen.findByText("Not checked with your access: deliveries."),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Nothing needs attention."),
    ).toBeInTheDocument();
    expect(seen.some(({ path }) => path.endsWith("/deliveries"))).toBe(false);
  });

  test("a credential that can check nothing is told so", async () => {
    useScenario(scenario("S1 configured"));
    identity([]);
    renderOverview();

    expect(
      await screen.findByText(
        "Your access does not include any attention checks.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
  });

  test("a restricted credential is told what its counts cover", async () => {
    const seen = useScenario(scenario("S2"));
    identity([...CAPABILITIES], true);
    renderOverview();

    expect(
      await screen.findByText(/only sees some task and record types/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Next action" }),
    ).toBeInTheDocument();
    // Restricted credentials may not call these surfaces at all.
    expect(
      seen.some(({ path }) => /\/(deliveries|runtime-view)$/.test(path)),
    ).toBe(false);
    // Questions are filtered by task type on the server, so they stay checked.
    expect(seen.some(({ path }) => path.endsWith("/questions"))).toBe(true);
    expect(
      screen.getByRole("link", { name: "1 question waiting on you" }),
    ).toHaveAttribute("href", "/p/test-project/decisions");
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
