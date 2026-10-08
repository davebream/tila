import { SignalsPage } from "@/pages/signals";
import { http, HttpResponse, delay } from "msw";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";

const historyUrl = "*/projects/*/signals/history";
const groupsUrl = "*/projects/*/signals/groups";

describe("SignalsPage", () => {
  test("transitions from loading tables to independent empty states", async () => {
    server.use(
      http.get(historyUrl, async () => {
        await delay(300);
        return HttpResponse.json({ ok: true, signals: [], next_cursor: null });
      }),
      http.get(groupsUrl, async () => {
        await delay(300);
        return HttpResponse.json({ ok: true, groups: [] });
      }),
    );

    renderWithProviders(<SignalsPage />);
    expect(
      await screen.findByRole("table", { name: "Signal history" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: "Signal groups" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("No unexpired signals."),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("No signal groups configured."),
    ).toBeInTheDocument();
  });

  test("renders targets, audit identities, acknowledgement progress, and groups", async () => {
    const now = Date.now();
    server.use(
      http.get(historyUrl, () =>
        HttpResponse.json({
          ok: true,
          next_cursor: null,
          signals: [
            {
              id: "sig-1",
              target: { type: "group", group_id: "reviewers" },
              kind: "request",
              resource: "task:T-1",
              payload: {},
              sender: {
                principal_id: "principal-a",
                participant_id: "participant-a",
                display_name: "Alice",
                environment: { client_name: "cli", machine: "mac-a" },
              },
              created_at: now - 1_000,
              expires_at: now + 60_000,
              deliveries: [
                {
                  recipient: {
                    principal_id: "principal-b",
                    participant_id: "participant-b",
                    display_name: "Bob",
                    environment: { client_name: "mcp", machine: "linux-b" },
                  },
                  acknowledged_at: now,
                  acknowledged_by: {
                    principal_id: "principal-b",
                    participant_id: "participant-b",
                    display_name: "Bob",
                    environment: { client_name: "mcp", machine: "linux-b" },
                  },
                },
              ],
            },
          ],
        }),
      ),
      http.get(groupsUrl, () =>
        HttpResponse.json({
          ok: true,
          groups: [
            {
              id: "reviewers",
              name: "Reviewers",
              principal_ids: ["principal-b"],
              created_at: now - 10_000,
              updated_at: now - 5_000,
            },
          ],
        }),
      ),
    );

    renderWithProviders(<SignalsPage />);
    expect(await screen.findByText("sig-1")).toBeInTheDocument();
    expect(screen.getByText("group reviewers")).toBeInTheDocument();
    expect(screen.getByText(/Alice · cli · mac-a/)).toBeInTheDocument();
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByText(/acked: Bob · mcp · linux-b/)).toBeInTheDocument();
    expect(screen.getByText("principal-b")).toBeInTheDocument();
  });

  test("shows the admin authorization error returned by history", async () => {
    server.use(
      http.get(historyUrl, () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "permission-denied",
              message: "Requires maintainer role",
            },
          },
          { status: 403 },
        ),
      ),
      http.get(groupsUrl, () => HttpResponse.json({ ok: true, groups: [] })),
    );

    renderWithProviders(<SignalsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Requires maintainer role",
    );
  });
});
