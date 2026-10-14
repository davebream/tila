import { SignalsPage } from "@/pages/signals";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";

const historyUrl = "*/projects/*/signals/history";
const groupsUrl = "*/projects/*/signals/groups";

describe("SignalsPage", () => {
  test("transitions from loading tables to independent empty states", async () => {
    let releaseHistory: () => void = () => {};
    let releaseGroups: () => void = () => {};
    const historyResponse = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const groupsResponse = new Promise<void>((resolve) => {
      releaseGroups = resolve;
    });
    server.use(
      http.get(historyUrl, async () => {
        await historyResponse;
        return HttpResponse.json({ ok: true, signals: [], next_cursor: null });
      }),
      http.get(groupsUrl, async () => {
        await groupsResponse;
        return HttpResponse.json({ ok: true, groups: [] });
      }),
    );

    renderWithProviders(<SignalsPage />);
    expect(
      await screen.findByRole("table", { name: "Signal history" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("table", { name: "Signal groups" }),
    ).toBeInTheDocument();

    releaseHistory();
    expect(
      await screen.findByText("No unexpired signals."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: "Signal groups" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No signal groups configured.")).toBeNull();

    releaseGroups();
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
    expect(screen.getByText("1/1 acknowledged")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "task:T-1" })).toHaveAttribute(
      "href",
      "/p/test-project/tasks/T-1",
    );
    // Expiry is a live countdown; a few milliseconds may pass before render.
    expect(screen.getByText(/^in (1m|5\ds)$/)).toBeInTheDocument();
    expect(screen.getByText(/acked: Bob · mcp · linux-b/)).toBeInTheDocument();
    expect(screen.getByText("principal-b")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Settings › Signal groups" }),
    ).toHaveAttribute("href", "/p/test-project/settings/signal-groups");
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
    expect(
      await screen.findByText(/Signal history requires admin access/),
    ).toBeInTheDocument();
    expect(screen.queryByText("No unexpired signals.")).toBeNull();
  });

  test("shows payloads and pages through history with the server cursor", async () => {
    const now = Date.now();
    const identity = {
      principal_id: "principal-a",
      participant_id: "participant-a",
      display_name: null,
      environment: {},
    };
    const signal = (id: string, payload?: unknown) => ({
      id,
      target: { type: "broadcast" },
      kind: "info",
      ...(payload === undefined ? {} : { payload }),
      sender: identity,
      created_at: now - 1_000,
      expires_at: now + 3_600_000,
      deliveries: [
        { recipient: identity, acknowledged_at: null, acknowledged_by: null },
      ],
    });
    const cursors: (string | null)[] = [];
    server.use(
      http.get(historyUrl, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        return HttpResponse.json(
          cursor
            ? { ok: true, signals: [signal("sig-old")], next_cursor: null }
            : {
                ok: true,
                signals: [signal("sig-new", { branch: "hotfix" })],
                next_cursor: "page-2",
              },
        );
      }),
      http.get(groupsUrl, () => HttpResponse.json({ ok: true, groups: [] })),
    );

    renderWithProviders(<SignalsPage />);
    expect(await screen.findByText("sig-new")).toBeInTheDocument();
    expect(screen.getByText(/"branch": "hotfix"/)).toBeInTheDocument();
    expect(screen.getByText(/stored, pending/)).toBeInTheDocument();
    expect(screen.getByText(/absence is not evidence/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("sig-old")).toBeInTheDocument();
    expect(screen.getByText("No payload")).toBeInTheDocument();
    expect(cursors).toContain("page-2");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});
