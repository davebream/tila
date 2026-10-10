import { RecordDetailPage } from "@/pages/record-detail";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import {
  act,
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "../test-utils";

const ROUTE = "/p/test-project/records/deploy/prod";

function renderRecord() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/records/:type/*"
        element={<RecordDetailPage />}
      />
    </Routes>,
    { route: ROUTE },
  );
}

const record = {
  type: "deploy",
  key: "prod",
  schema_version: 1,
  value: { region: "eu" },
  value_sha256: "a".repeat(64),
  revision: 3,
  archived: 0,
  created_at: Date.now() - 100_000,
  updated_at: Date.now() - 50_000,
  updated_by: "alice-the-updater",
  tags: [],
};

const historyItem = {
  type: "deploy",
  key: "prod",
  revision: 3,
  operation: "set",
  schema_version: 1,
  value_sha256: "a".repeat(64),
  canonical_artifact_key: null,
  source_artifact_key: null,
  actor: "revision-actor",
  created_at: Date.now() - 50_000,
  message: null,
};

const meta = { total: 1, limit: 20, next_cursor: null };

const error = (status: number, code: string, message: string) => () =>
  HttpResponse.json(
    { ok: false, error: { code, message, retryable: status >= 500 } },
    { status },
  );
const forbidden = error(403, "permission-denied", "No access");
const unavailable = error(503, "do-unreachable", "Project unavailable");

function recordOk() {
  return http.get("*/projects/*/records/:type/*", () =>
    HttpResponse.json({ ok: true, record, fence: 7 }),
  );
}

function historyOk(items: unknown[] = [historyItem]) {
  return http.get("*/projects/*/records/:type/~/history/*", () =>
    HttpResponse.json({ ok: true, items, meta }),
  );
}

// The list request only feeds prev/next navigation.
const listOk = http.get("*/projects/*/records/:type", () =>
  HttpResponse.json({
    ok: true,
    items: [],
    meta: { total: 0, limit: 200, next_cursor: null },
  }),
);

describe("RecordDetailPage revision history", () => {
  test("a failed history request is an error with retry, not 'No history available'", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/projects/*/records/:type/~/history/*", unavailable),
      recordOk(),
      listOk,
    );
    renderRecord();

    expect(await screen.findByText("alice-the-updater")).toBeInTheDocument();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load revision history.");
    expect(screen.queryByText("No history available")).not.toBeInTheDocument();

    server.use(historyOk());
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("revision-actor")).toBeInTheDocument();
  });

  test("a forbidden history request is access denied, not empty", async () => {
    server.use(
      http.get("*/projects/*/records/:type/~/history/*", forbidden),
      recordOk(),
      listOk,
    );
    renderRecord();

    expect(
      await screen.findByText("You do not have access to revision history."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No history available")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  test("a pending history request shows loading text", async () => {
    server.use(
      http.get("*/projects/*/records/:type/~/history/*", async () => {
        await delay("infinite");
      }),
      recordOk(),
      listOk,
    );
    renderRecord();

    expect(
      await screen.findByText("Loading revision history…"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No history available")).not.toBeInTheDocument();
  });

  test("a successful empty history is reported as such", async () => {
    server.use(historyOk([]), recordOk(), listOk);
    renderRecord();

    expect(await screen.findByText("No history available")).toBeInTheDocument();
  });
});

describe("RecordDetailPage record", () => {
  test("a failed refresh keeps the record on screen with a stale notice", async () => {
    server.use(historyOk(), recordOk(), listOk);
    const { queryClient } = renderRecord();
    await screen.findByText("alice-the-updater");

    server.use(http.get("*/projects/*/records/:type/*", unavailable));
    await act(() => queryClient.invalidateQueries({ queryKey: ["record"] }));

    expect(
      await screen.findByText(/Showing record from .* Refresh failed/),
    ).toBeInTheDocument();
    expect(screen.getByText("alice-the-updater")).toBeInTheDocument();
  });

  test("losing access on refresh removes the record instead of keeping it as current", async () => {
    server.use(historyOk(), recordOk(), listOk);
    const { queryClient } = renderRecord();
    await screen.findByText("alice-the-updater");

    server.use(http.get("*/projects/*/records/:type/*", forbidden));
    await act(() => queryClient.invalidateQueries({ queryKey: ["record"] }));

    expect(
      await screen.findByText("You do not have access to record."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("alice-the-updater")).not.toBeInTheDocument(),
    );
  });

  test("a missing record is reported as not found", async () => {
    server.use(
      http.get(
        "*/projects/*/records/:type/*",
        error(404, "not-found", "No such record"),
      ),
      http.get("*/projects/*/records/:type/~/history/*", unavailable),
      listOk,
    );
    renderRecord();

    expect(await screen.findByText("Record not found.")).toBeInTheDocument();
  });
});
