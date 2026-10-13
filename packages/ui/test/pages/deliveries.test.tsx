import { DeliveriesPage } from "@/pages/deliveries";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { acknowledgedTrace, traceItem } from "../mocks/delivery-fixtures";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const deliveriesUrl = "*/projects/test-project/deliveries";

function setup({
  agents = [{ agent: { id: "worker", name: "Reviewer" }, binding: null }],
  rooms = [{ id: "general", name: "General" }],
}: { agents?: unknown[]; rooms?: unknown[] } = {}) {
  server.use(
    http.get("*/projects/test-project/agents", () =>
      HttpResponse.json({ ok: true, agents }),
    ),
    http.get("*/projects/test-project/rooms", () =>
      HttpResponse.json({ ok: true, rooms }),
    ),
  );
}

function renderPage(route = "/p/test-project/deliveries") {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/deliveries" element={<DeliveriesPage />} />
      <Route
        path="/p/:projectId/deliveries/:agentId/:deliveryId"
        element={<DeliveriesPage />}
      />
    </Routes>,
    { route },
  );
}

test("keeps wake, fetch, acknowledgement and work result separate per delivery", async () => {
  setup();
  server.use(
    http.get(deliveriesUrl, () =>
      HttpResponse.json({
        ok: true,
        deliveries: [traceItem(2, { trace: acknowledgedTrace }), traceItem(1)],
        has_more: false,
        cursor: null,
      }),
    ),
  );
  renderPage();
  const table = await screen.findByRole("table", { name: "Deliveries" });
  const [, acked, pending] = within(table).getAllByRole("row");
  expect(within(acked).getByText("Accepted by connector")).toBeInTheDocument();
  expect(within(acked).getByText("Fetched")).toBeInTheDocument();
  expect(
    within(acked).getByText("Accepted for processing"),
  ).toBeInTheDocument();
  // Acknowledgement alone never produces a completed work result.
  expect(within(acked).getByText("Not reported")).toBeInTheDocument();
  expect(within(pending).getByText("Not requested")).toBeInTheDocument();
  expect(within(pending).getByText("Not acknowledged")).toBeInTheDocument();
  expect(within(pending).getByText("Not reported")).toBeInTheDocument();
});

test("shows the explicit attempt result, never one inferred from acknowledgement", async () => {
  setup();
  server.use(
    http.get(deliveriesUrl, () =>
      HttpResponse.json({
        ok: true,
        deliveries: [
          traceItem(6, {
            trace: {
              ...acknowledgedTrace,
              work_result: {
                status: "reported",
                attempt_id: "attempt-ok",
                task_id: "task-1",
                outcome: "success",
                finished_at: 2_000,
                corrected: true,
              },
            },
          }),
          traceItem(5, {
            trace: {
              work_result: {
                status: "reported",
                attempt_id: "attempt-failed",
                task_id: "task-1",
                outcome: "failure",
                finished_at: 2_000,
                corrected: false,
              },
            },
          }),
          traceItem(4, {
            trace: {
              ...acknowledgedTrace,
              work_result: {
                status: "pending",
                attempt_id: "attempt-run",
                task_id: "task-1",
                attempt_state: "resume_pending",
              },
            },
          }),
          traceItem(3, {
            trace: {
              work_result: {
                status: "unlinked",
                attempt_id: "attempt-gone",
                reason: "task-mismatch",
              },
            },
          }),
          traceItem(2, { trace: { work_result: { status: "hidden" } } }),
        ],
        has_more: false,
        cursor: null,
      }),
    ),
  );
  renderPage();
  const table = await screen.findByRole("table", { name: "Deliveries" });
  const [, succeeded, failed, pending, unlinked, hidden] =
    within(table).getAllByRole("row");
  expect(within(succeeded).getByText("Succeeded")).toBeInTheDocument();
  expect(
    within(succeeded).getByText("Corrective work linked"),
  ).toBeInTheDocument();
  expect(within(failed).getByText("Failed")).toBeInTheDocument();
  expect(within(failed).queryByText("Corrective work linked")).toBeNull();
  // Acknowledged but unfinished work stays pending.
  expect(
    within(pending).getByText("Attempt resume pending"),
  ).toBeInTheDocument();
  expect(within(unlinked).getByText("Unlinked attempt")).toBeInTheDocument();
  expect(
    within(unlinked).getByText("Attempt belongs to another task"),
  ).toBeInTheDocument();
  expect(within(hidden).getByText("Hidden")).toBeInTheDocument();
  expect(within(table).queryByText("Not reported")).toBeNull();
});

test("traces a reported result and links the work attempt", async () => {
  setup();
  const item = traceItem(7, {
    message: { task_id: "task-9", attempt_id: "attempt-9" },
    trace: {
      ...acknowledgedTrace,
      work_result: {
        status: "reported",
        attempt_id: "attempt-9",
        task_id: "task-9",
        outcome: "cancelled",
        finished_at: 2_000,
        corrected: true,
      },
    },
  });
  server.use(
    http.get(deliveriesUrl, () =>
      HttpResponse.json({
        ok: true,
        deliveries: [item],
        has_more: false,
        cursor: null,
      }),
    ),
    http.get("*/projects/test-project/inbox/*", () =>
      HttpResponse.json({
        ok: true,
        reason: "acknowledged",
        delivery: item.delivery,
        message: item.message,
        trace: item.trace,
        attempts: [],
      }),
    ),
  );
  renderPage(`/p/test-project/deliveries/worker/${item.delivery.id}`);
  const stages = await screen.findByRole("list", { name: "Delivery stages" });
  expect(within(stages).getByText("Cancelled")).toBeInTheDocument();
  expect(
    within(stages).getByText(/Acknowledgment is not completion/),
  ).toHaveTextContent(/original result is unchanged/);
  const links = screen.getByRole("list", { name: "Related evidence" });
  expect(
    within(links).getByRole("link", { name: "Work attempt attempt-9" }),
  ).toHaveAttribute("href", "/p/test-project/queue?attempt=attempt-9");
});

test("paginates with the server cursor and sends filters", async () => {
  setup();
  const queries: Record<string, string>[] = [];
  server.use(
    http.get(deliveriesUrl, ({ request }) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      queries.push(query);
      return HttpResponse.json(
        query.cursor
          ? {
              ok: true,
              deliveries: [traceItem(1)],
              has_more: false,
              cursor: null,
            }
          : {
              ok: true,
              deliveries: [traceItem(3), traceItem(2)],
              has_more: true,
              cursor: "next-page",
            },
      );
    }),
  );
  renderPage();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Load more" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("table", { name: "Deliveries" })).getAllByRole(
        "row",
      ),
    ).toHaveLength(4),
  );
  expect(queries[1]).toMatchObject({ cursor: "next-page", limit: "50" });
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  await user.selectOptions(screen.getByLabelText("State"), "expired");
  await waitFor(() =>
    expect(queries.at(-1)).toEqual({ state: "expired", limit: "50" }),
  );
});

test("marks expired, offline, replaced and repeatedly woken deliveries", async () => {
  setup();
  server.use(
    http.get(deliveriesUrl, () =>
      HttpResponse.json({
        ok: true,
        deliveries: [
          traceItem(3, {
            trace: {
              state: "pending",
              recipient: { status: "offline", binding_epoch: 2 },
              wake: {
                status: "rejected",
                suppressed: null,
                attempts: 3,
                rewakes: 2,
                last_at: 1_500,
              },
            },
          }),
          traceItem(2, {
            trace: { recipient: { status: "replaced", binding_epoch: 1 } },
          }),
          traceItem(1, { trace: { state: "expired" } }),
        ],
        has_more: false,
        cursor: null,
      }),
    ),
  );
  renderPage();
  const table = await screen.findByRole("table", { name: "Deliveries" });
  const [, offline, replaced, expired] = within(table).getAllByRole("row");
  expect(within(offline).getByText("Recipient offline")).toBeInTheDocument();
  expect(
    within(offline).getByText("Rejected by connector"),
  ).toBeInTheDocument();
  expect(within(offline).getByText("3 attempts")).toBeInTheDocument();
  expect(within(replaced).getByText("Binding replaced")).toBeInTheDocument();
  expect(within(expired).getByText("Expired")).toBeInTheDocument();
});

test("explains that browsing needs management instead of showing an empty list", async () => {
  setup();
  server.use(
    http.get(deliveriesUrl, () =>
      HttpResponse.json(
        {
          ok: false,
          error: { code: "token-authz-denied", message: "denied" },
        },
        { status: 403 },
      ),
    ),
  );
  renderPage();
  expect(
    await screen.findByText(/requires conversation management/),
  ).toBeInTheDocument();
  expect(screen.queryByText("No deliveries recorded yet.")).toBeNull();
});

test("shows an actionable unavailable state when conversations are not set up", async () => {
  setup({ agents: [], rooms: [] });
  server.use(
    http.get(deliveriesUrl, () =>
      HttpResponse.json({
        ok: true,
        deliveries: [],
        has_more: false,
        cursor: null,
      }),
    ),
  );
  renderPage();
  expect(
    await screen.findByText(
      "Conversations are not set up in this project yet.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("tila agent register")).toBeInTheDocument();
});

test("opens a delivery trace without fetching or acknowledging the mailbox", async () => {
  setup();
  const item = traceItem(4, {
    message: { task_id: "task-9" },
    trace: { ...acknowledgedTrace, state: "expired" },
  });
  const requests: string[] = [];
  server.use(
    http.get(deliveriesUrl, () =>
      HttpResponse.json({
        ok: true,
        deliveries: [item],
        has_more: false,
        cursor: null,
      }),
    ),
    http.all("*/projects/test-project/inbox/*", ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({
        ok: true,
        reason: "acknowledged",
        delivery: item.delivery,
        message: item.message,
        trace: item.trace,
        attempts: [],
      });
    }),
  );
  renderPage(`/p/test-project/deliveries/worker/${item.delivery.id}`);
  const stages = await screen.findByRole("list", { name: "Delivery stages" });
  expect(
    within(stages).getByText("Accepted for processing"),
  ).toBeInTheDocument();
  expect(within(stages).getByText("Not reported")).toBeInTheDocument();
  expect(
    screen.getByText(
      /Delivery metadata expired\. The message is still in room/,
    ),
  ).toBeInTheDocument();
  const links = screen.getByRole("list", { name: "Related evidence" });
  expect(
    within(links).getByRole("link", { name: "Delivery journal" }),
  ).toHaveAttribute(
    "href",
    `/p/test-project/journal?resource=${encodeURIComponent(`delivery:${item.delivery.id}`)}`,
  );
  expect(
    within(links).getByRole("link", { name: "Task task-9" }),
  ).toHaveAttribute("href", "/p/test-project/tasks/task-9");
  expect(
    within(links).getByRole("link", { name: /Open message #4/ }),
  ).toHaveAttribute("href", "/p/test-project/rooms/general");
  expect(requests).toEqual([
    `GET /projects/test-project/inbox/worker/deliveries/${item.delivery.id}`,
  ]);
});

test("attention filters from the Overview reach the server and can be removed", async () => {
  setup();
  const user = userEvent.setup();
  const requests: URLSearchParams[] = [];
  server.use(
    http.get(deliveriesUrl, ({ request }) => {
      requests.push(new URL(request.url).searchParams);
      return HttpResponse.json({
        ok: true,
        deliveries: [traceItem(1)],
        has_more: false,
        cursor: null,
        total: 5,
      });
    }),
  );
  renderPage(
    "/p/test-project/deliveries?state=expired&expires_after=1700000000000&wake=suppressed",
  );

  expect(await screen.findByText("5 deliveries match")).toBeInTheDocument();
  expect(requests[0].get("expires_after")).toBe("1700000000000");
  expect(requests[0].get("wake")).toBe("suppressed");
  expect(requests[0].get("state")).toBe("expired");

  await user.click(screen.getByRole("button", { name: "Remove wake filter" }));
  await waitFor(() => expect(requests.at(-1)?.get("wake")).toBeNull());
  expect(requests.at(-1)?.get("expires_after")).toBe("1700000000000");
});
