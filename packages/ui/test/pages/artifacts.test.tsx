import { ArtifactsPage } from "@/pages/artifacts";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { renderWithProviders, screen, within } from "../test-utils";

function renderSearch(query = "report") {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/artifacts" element={<ArtifactsPage />} />
    </Routes>,
    { route: `/p/test-project/artifacts?q=${query}` },
  );
}

const unavailable = () =>
  HttpResponse.json(
    {
      ok: false,
      error: {
        code: "do-unreachable",
        message: "Index unavailable",
        retryable: true,
      },
    },
    { status: 503 },
  );

const forbidden = () =>
  HttpResponse.json(
    { ok: false, error: { code: "permission-denied", message: "No access" } },
    { status: 403 },
  );

describe("ArtifactsPage search", () => {
  test("a pending search says it is searching, not that nothing matched", async () => {
    server.use(
      http.get("*/projects/*/artifacts/search", async () => {
        await delay("infinite");
      }),
    );
    renderSearch();

    expect(
      await screen.findByText("Loading search results…"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });

  test("a failed search is an error with retry instead of searching forever", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/projects/*/artifacts/search", unavailable));
    renderSearch();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load search results.");
    expect(
      screen.queryByText(/Loading search results/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();

    server.use(
      http.get("*/projects/*/artifacts/search", () =>
        HttpResponse.json({
          ok: true,
          results: [
            {
              r2_key: "reports/run-1/abc.txt",
              kind: "report",
              resource: null,
              produced_at: Date.now() - 1000,
              snippet: null,
            },
          ],
        }),
      ),
    );
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("link", { name: "reports/run-1/abc.txt" }),
    ).toBeInTheDocument();
  });

  test("a forbidden search is access denied, not 'no results'", async () => {
    server.use(http.get("*/projects/*/artifacts/search", forbidden));
    renderSearch();

    expect(
      await screen.findByText("You do not have access to search results."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });

  test("a successful empty search keeps its explanation", async () => {
    renderSearch("nomatch");

    expect(
      await screen.findByText(/No results for 'nomatch'/),
    ).toBeInTheDocument();
  });

  test("a failed list request still reports its error outside search mode", async () => {
    server.use(http.get("*/projects/*/artifacts", unavailable));
    renderWithProviders(
      <Routes>
        <Route path="/p/:projectId/artifacts" element={<ArtifactsPage />} />
      </Routes>,
      { route: "/p/test-project/artifacts" },
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
