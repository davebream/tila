import { AgentsPage } from "@/pages/agents";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { renderWithProviders, screen } from "../test-utils";

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
