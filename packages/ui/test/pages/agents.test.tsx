import { AgentsPage } from "@/pages/agents";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { act, renderWithProviders, screen } from "../test-utils";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

function renderAgents() {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/agents" element={<AgentsPage />} />
    </Routes>,
    { route: "/p/test-project/agents" },
  );
}

const bindingSummary = (state: string, leaseSeconds: number) => ({
  consumer_binding_id: crypto.randomUUID(),
  agent_id: "worker",
  binding_epoch: 3,
  state,
  mechanism: "native-peer",
  lease_expires_at: leaseSeconds,
});

const agentsHandler = (binding: unknown) =>
  http.get("*/projects/test-project/agents", () =>
    HttpResponse.json({
      ok: true,
      agents: [
        {
          agent: { id: "worker", name: "Reviewer", binding_epoch: 3 },
          binding,
        },
      ],
    }),
  );

describe("lease presentation", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval"],
      now: NOW,
    });
  });
  afterEach(() => vi.useRealTimers());

  test("a binding expiring in five minutes is attached with the right date, then expires at its deadline", async () => {
    const lease = NOW / 1000 + 300;
    server.use(agentsHandler(bindingSummary("active", lease)));
    renderAgents();
    expect(await screen.findByText("Attached")).toBeInTheDocument();
    expect(
      screen.getByText(new Date(lease * 1000).toLocaleString()),
    ).toBeInTheDocument();
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument();
    expect(screen.getByText("Expires in 5m")).toBeInTheDocument();

    await act(async () => {
      vi.setSystemTime(NOW + 300_000);
      vi.advanceTimersByTime(1000);
    });
    expect(await screen.findByText("Expired")).toBeInTheDocument();
    expect(screen.queryByText("Attached")).not.toBeInTheDocument();
  });

  test.each([
    ["replaced", "Replaced"],
    ["released", "Released"],
  ])("shows a %s binding as %s, not attached", async (state, label) => {
    server.use(agentsHandler(bindingSummary(state, NOW / 1000 + 300)));
    renderAgents();
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByText("Attached")).not.toBeInTheDocument();
  });

  test("shows no binding distinctly", async () => {
    server.use(agentsHandler(null));
    renderAgents();
    expect(await screen.findByText("No binding")).toBeInTheDocument();
  });

  test("marks a permission-redacted binding but keeps its attach state", async () => {
    server.use(agentsHandler(bindingSummary("active", NOW / 1000 + 300)));
    renderAgents();
    expect(await screen.findByText("Attached")).toBeInTheDocument();
    expect(screen.getByText("Details hidden")).toBeInTheDocument();
  });

  test("keeps recomputing expiry after a poll failure and says when data was last observed", async () => {
    server.use(agentsHandler(bindingSummary("active", NOW / 1000 + 10)));
    renderAgents();
    expect(await screen.findByText("Attached")).toBeInTheDocument();

    server.use(
      http.get("*/projects/test-project/agents", () =>
        HttpResponse.json(
          { ok: false, error: { message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    await act(async () => {
      vi.setSystemTime(NOW + 20_000);
      vi.advanceTimersByTime(6000);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /last observed at/,
    );
    expect(await screen.findByText("Expired")).toBeInTheDocument();
  });
});

test("opens delivery inspection directly without fetching or acknowledging a mailbox", async () => {
  const requests: string[] = [];
  const delivery = crypto.randomUUID();
  server.use(
    http.get("*/projects/test-project/agents", () =>
      HttpResponse.json({
        ok: true,
        agents: [
          {
            agent: { id: "worker", name: "Reviewer", binding_epoch: 3 },
            binding: null,
          },
        ],
      }),
    ),
    http.all("*/projects/test-project/inbox/*", ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({
        ok: true,
        reason: "fetched-not-acked",
        delivery: {
          id: delivery,
          agent_id: "worker",
          state: "pending",
          disposition: null,
          target_epoch: null,
          fetched_epoch: 3,
          acked_epoch: null,
          wake_suppressed: null,
          expires_at: Date.now() + 100000,
        },
        attempts: [],
      });
    }),
  );
  renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/agents/:agentId/deliveries/:deliveryId"
        element={<AgentsPage />}
      />
    </Routes>,
    { route: `/p/test-project/agents/worker/deliveries/${delivery}` },
  );
  expect(await screen.findByText("fetched not acked")).toBeInTheDocument();
  expect(screen.getByText(/never means task completion/)).toBeInTheDocument();
  expect(requests).toEqual([
    `GET /projects/test-project/inbox/worker/deliveries/${delivery}`,
  ]);
});
