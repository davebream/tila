import { OverviewPage } from "@/pages/overview";
import { TasksPage } from "@/pages/tasks";
import userEvent from "@testing-library/user-event";
import { CAPABILITIES, type NamespaceRestrictions } from "@tila/schemas";
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
import { catalogHandler, configuredEntry, declaredEntry } from "../mocks/tasks";
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

function identity(
  capabilities: readonly string[],
  restrictions: boolean | NamespaceRestrictions = false,
) {
  const narrowed =
    restrictions === true ? { task_types: ["bug"] } : restrictions || undefined;
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
          ...(narrowed ? { restrictions: narrowed } : {}),
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
  test("S1 keeps large custom and empty catalogs usable when a secondary source fails", async () => {
    useScenario(scenario("S1 large custom"));
    renderOverview();
    expect(
      await screen.findByText(/Could not load runtime/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/302 tasks in 2 types/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open tasks" }),
    ).toBeInTheDocument();
  });

  test("S3 a quiet runtime does not erase an unresolved execution", async () => {
    useScenario(scenario("S3 stopped runtime"));
    renderOverview();
    const next = await screen.findByRole("region", { name: "Next action" });
    expect(
      within(next).getByRole("link", { name: /uncertain outcome/ }),
    ).toHaveAttribute("href", "/p/test-project/queue?state=uncertain");
    expect(
      screen.queryByText("Nothing needs attention."),
    ).not.toBeInTheDocument();
  });

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

// #398: the blocked count follows the shared readiness rules, under which a
// type without a lifecycle treats only `closed` as finished. The Overview says
// which visible types that applies to and never changes the count itself.
describe("OverviewPage lifecycle coverage", () => {
  const coverage = () =>
    screen.findByRole("region", { name: "Lifecycle coverage" });
  const noCoverage = () =>
    expect(
      screen.queryByRole("region", { name: "Lifecycle coverage" }),
    ).not.toBeInTheDocument();
  const outage = http.get("*/projects/*/tasks/~/types", () =>
    HttpResponse.json(
      { ok: false, error: { code: "internal", message: "down" } },
      { status: 500 },
    ),
  );

  test("names a legacy type beside the count and links to Definitions", async () => {
    useScenario({
      ...scenario("S3 failed hotfix"),
      work: [declaredEntry("bug", 6)],
    });
    renderOverview();

    const note = await coverage();
    expect(within(note).getByText("bug")).toBeInTheDocument();
    expect(note).toHaveTextContent(
      /No lifecycle is declared for bug\. Without one only status “closed” counts as finished/,
    );
    expect(
      within(note).getByRole("link", {
        name: "Review lifecycles in Definitions",
      }),
    ).toHaveAttribute("href", "/p/test-project/settings/definitions");
    // The note sits in the blocked row, beside the count it explains, and
    // the count still opens exactly the list it was taken from.
    const row = note.closest("tr");
    expect(
      within(row as HTMLElement).getByRole("link", {
        name: "3 open tasks waiting on prerequisites",
      }),
    ).toHaveAttribute("href", "/p/test-project/tasks?blocked=1");
  });

  test("explains a legacy type even when the count is zero", async () => {
    useScenario({
      ...scenario("S1 configured"),
      work: [declaredEntry("task", 0)],
    });
    renderOverview();

    const note = await coverage();
    expect(note).toHaveTextContent("No lifecycle is declared for task.");
    expect(
      screen.getByText("No open tasks waiting on prerequisites"),
    ).toBeInTheDocument();
  });

  test("a mixed project names only the types without a lifecycle", async () => {
    useScenario({
      ...scenario("S3 failed hotfix"),
      work: [
        configuredEntry("bug", 4),
        declaredEntry("note", 1),
        {
          type: "legacy",
          declaration: "undeclared",
          count: 1,
          archived_count: 0,
        },
      ],
    });
    renderOverview();

    const note = await coverage();
    expect(note).toHaveTextContent(
      "No lifecycle is declared for legacy, note.",
    );
    expect(within(note).queryByText("bug")).not.toBeInTheDocument();
  });

  test("a project where every type declares one has nothing to explain", async () => {
    useScenario({
      ...scenario("S3 failed hotfix"),
      work: [configuredEntry("bug", 6), configuredEntry("job", 0)],
    });
    renderOverview();

    await screen.findByRole("link", {
      name: "3 open tasks waiting on prerequisites",
    });
    noCoverage();
  });

  test("the count's link opens a list that carries the same explanation and filter", async () => {
    const user = userEvent.setup();
    const seen = useScenario({
      ...scenario("S3 failed hotfix"),
      work: [configuredEntry("bug", 2), declaredEntry("note", 4)],
    });
    renderWithProviders(
      <Routes>
        <Route path="/p/:projectId/overview" element={<OverviewPage />} />
        <Route path="/p/:projectId/tasks" element={<TasksPage />} />
      </Routes>,
      { route: "/p/test-project/overview" },
    );
    const overviewNote = (await coverage()).textContent;

    await user.click(
      screen.getByRole("link", {
        name: "3 open tasks waiting on prerequisites",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Tasks" }),
    ).toBeInTheDocument();
    const listNote = (await coverage()).textContent;

    expect(listNote).toBe(overviewNote);
    expect(listNote).toContain("No lifecycle is declared for note.");
    // The count and the list ask the server the same question; only paging
    // differs, and neither filters rows in the client.
    const filter = (params: URLSearchParams) =>
      ["blocked", "archived", "type", "outcome"].map((k) => params.get(k));
    const taskCalls = seen.filter(({ path }) => path.endsWith("/tasks"));
    const blockedCall = (limit: string) =>
      taskCalls.find(
        ({ params }) =>
          params.get("blocked") === "1" && params.get("limit") === limit,
      );
    const count = blockedCall("1");
    const list = blockedCall("100");
    expect(count && list).toBeTruthy();
    expect(filter(list?.params as URLSearchParams)).toEqual(
      filter(count?.params as URLSearchParams),
    );
    expect(list?.params.get("blocked")).toBe("1");
  });

  test("a failed type catalog is unknown coverage, not an all-clear", async () => {
    useScenario({
      ...scenario("S3 failed hotfix"),
      work: [configuredEntry("bug", 6)],
    });
    server.use(outage);
    renderOverview();

    const note = await coverage();
    expect(note).toHaveTextContent("Lifecycle coverage is unknown");
    expect(note).not.toHaveTextContent("No lifecycle is declared");
    // The count is read from a different list; the outage does not alter it.
    expect(
      screen.getByRole("link", {
        name: "3 open tasks waiting on prerequisites",
      }),
    ).toBeInTheDocument();
  });

  test("an unreadable schema says declarations are unknown, not undeclared", async () => {
    useScenario({
      ...scenario("S3 failed hotfix"),
      work: [
        { type: "bug", declaration: "unknown", count: 6, archived_count: 0 },
      ],
    });
    server.use(
      http.get("*/projects/*/tasks/~/types", () =>
        HttpResponse.json({
          ok: true,
          types: [
            {
              type: "bug",
              declaration: "unknown",
              count: 6,
              archived_count: 0,
            },
          ],
          scope: { restricted: false },
          incomplete: { declared_types: "unavailable" },
        }),
      ),
    );
    renderOverview();

    const note = await coverage();
    expect(note).toHaveTextContent(
      "Definitions could not be read, so it is unknown which task types declare a lifecycle.",
    );
    expect(note).not.toHaveTextContent("No lifecycle is declared");
  });

  test("without Definitions access the note explains but does not link", async () => {
    useScenario({
      ...scenario("S3 failed hotfix"),
      work: [declaredEntry("bug", 6)],
    });
    identity(CAPABILITIES.filter((cap) => cap !== "schema:read"));
    renderOverview();

    const note = await coverage();
    expect(note).toHaveTextContent("No lifecycle is declared for bug.");
    expect(within(note).queryByRole("link")).not.toBeInTheDocument();
    expect(note).toHaveTextContent("Your access does not include Definitions.");
  });

  test("a restricted credential gets a caveat and only the types it can see", async () => {
    useScenario({
      ...scenario("S3 failed hotfix"),
      work: [declaredEntry("bug", 6)],
    });
    // Another type exists on the server; the restricted catalog omits it.
    server.use(catalogHandler([declaredEntry("bug", 6)], { restricted: true }));
    identity([...CAPABILITIES], true);
    renderOverview();

    const note = await coverage();
    expect(note).toHaveTextContent(
      "This credential sees no lifecycle for bug.",
    );
    expect(note).toHaveTextContent(
      "Prerequisites of types it cannot see are counted but not named",
    );
    // Restricted credentials may not read definitions at all.
    expect(note).not.toHaveTextContent("No lifecycle is declared");
  });

  test("a records-only restriction does not claim task types are hidden", async () => {
    useScenario({
      ...scenario("S3 failed hotfix"),
      work: [declaredEntry("task", 6)],
    });
    identity([...CAPABILITIES], { records: [{ type: "note" }] });
    renderOverview();

    const note = await coverage();
    // The schema's read state is hidden from any restricted credential, so
    // the type is stated as unconfirmed, not as declared-absent...
    expect(note).toHaveTextContent(
      "This credential sees no lifecycle for task.",
    );
    // ...but every task type is visible, so nothing is said about hidden ones.
    expect(note).not.toHaveTextContent("only some task types");
    expect(note).not.toHaveTextContent("cannot see are counted but not named");
  });

  test("a records-only restriction with every type declared has nothing to explain", async () => {
    useScenario({
      ...scenario("S3 failed hotfix"),
      work: [configuredEntry("bug", 6)],
    });
    identity([...CAPABILITIES], { records: [{ type: "note" }] });
    renderOverview();

    await screen.findByRole("link", {
      name: "3 open tasks waiting on prerequisites",
    });
    noCoverage();
  });

  test("a restricted credential seeing only declared types is still not told coverage is complete", async () => {
    useScenario({
      ...scenario("S3 failed hotfix"),
      work: [configuredEntry("bug", 6)],
    });
    server.use(
      catalogHandler([configuredEntry("bug", 6)], { restricted: true }),
    );
    identity([...CAPABILITIES], true);
    renderOverview();

    const note = await coverage();
    expect(note).toHaveTextContent(
      "This credential sees only some task types.",
    );
    expect(note).not.toHaveTextContent("Review lifecycles in Definitions");
  });
});
