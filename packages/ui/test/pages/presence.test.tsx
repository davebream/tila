import { PresencePage } from "@/pages/presence";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { renderWithProviders, screen } from "../test-utils";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const participant = (id: string, active: boolean, lastSeen: number) => ({
  principal_id: "p1",
  participant_id: id,
  environment: {},
  last_seen: lastSeen,
  info: {},
  active,
});

describe("PresencePage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });
  afterEach(() => vi.useRealTimers());

  test("labels heartbeat freshness and never infers idle or completed", async () => {
    server.use(
      http.get("*/projects/test-project/presence/all", () =>
        HttpResponse.json({
          ok: true,
          participants: [
            participant("fresh-one", true, NOW - 5_000),
            participant("stale-one", false, NOW - 300_000),
          ],
        }),
      ),
    );
    renderWithProviders(
      <Routes>
        <Route path="/p/:projectId/presence" element={<PresencePage />} />
      </Routes>,
      { route: "/p/test-project/presence" },
    );
    expect(await screen.findByText("fresh-one")).toBeInTheDocument();
    expect(screen.getAllByText("Heartbeat fresh").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Heartbeat stale").length).toBeGreaterThan(0);
    expect(screen.queryByText(/idle|completed|working/i)).toBeNull();
    expect(screen.queryByRole("img", { name: "idle" })).toBeNull();
  });
});
