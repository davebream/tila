import { RoomStream, RoomsPage } from "@/pages/rooms";
import userEvent from "@testing-library/user-event";
import type { Message } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { traceItem } from "../mocks/delivery-fixtures";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

function message(seq: number): Message {
  return {
    id: crypto.randomUUID(),
    room_id: "general",
    seq,
    client_op_id: `op-${seq}`,
    thread_id: null,
    body: `<script>peer ${seq}</script>`,
    artifact_refs: [],
    reply_expected: false,
    authority: "peer-content",
    provenance: {
      author_kind: "agent",
      agent_id: "worker",
      principal_id: "owner",
      participant_id: "session",
      consumer_binding_id: null,
      binding_epoch: null,
    },
    chain_id: crypto.randomUUID(),
    hop: 0,
    created_at: 100000,
  };
}
const rows = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => message(start + i));
test("polls the tail separately, deduplicates overlapping sequences and bounds rendered messages", async () => {
  let initialReads = 0;
  server.use(
    http.get(
      "*/projects/test-project/rooms/general/messages",
      ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (query.get("direction") === "backward") {
          if (!query.has("cursor")) {
            initialReads++;
            return HttpResponse.json({
              ok: true,
              messages: rows(151, 200),
              cursor: "older",
              tail_cursor: "200",
              has_more: true,
            });
          }
          return HttpResponse.json({
            ok: true,
            messages: rows(101, 150),
            cursor: "oldest",
            tail_cursor: "150",
            has_more: false,
          });
        }
        const after = Number(query.get("cursor"));
        return HttpResponse.json({
          ok: true,
          messages: after < 500 ? rows(after, after + 50) : [],
          cursor: String(Math.min(500, after + 50)),
          has_more: after < 450,
        });
      },
    ),
  );
  renderWithProviders(
    <RoomStream
      project="test-project"
      room="general"
      thread={null}
      writable={false}
    />,
  );
  const list = await screen.findByRole("list", { name: "Room messages" });
  await within(list).findByText(
    "<script>peer 500</script>",
    { selector: "p" },
    { timeout: 30000 },
  );
  // Count semantic rows without 200 repeated visibility/style traversals in jsdom.
  expect(within(list).getAllByRole("listitem", { hidden: true })).toHaveLength(
    200,
  );
  expect(
    within(list).queryByText("<script>peer 300</script>"),
  ).not.toBeInTheDocument();
  expect(list.querySelector("script")).toBeNull();
  expect(initialReads).toBe(1);
  await userEvent.click(screen.getByRole("button", { name: "Older messages" }));
  await screen.findByText("<script>peer 101</script>");
  expect(
    within(list).queryByText("<script>peer 500</script>"),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/Reading older history/)).toBeInTheDocument();
  // Multiple 200-row renders compete with the monorepo suite on CI runners.
}, 40000);

test("opens a deep-linkable thread panel and restores keyboard focus on Escape", async () => {
  const thread = crypto.randomUUID();
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        principal_id: "person",
        project_id: "test-project",
      }),
    ),
    http.get("*/projects/test-project/rooms", () =>
      HttpResponse.json({
        ok: true,
        rooms: [{ id: "general", name: "General" }],
      }),
    ),
    http.get("*/projects/test-project/rooms/general", () =>
      HttpResponse.json({
        ok: true,
        room: { id: "general", name: "General", archived: false },
      }),
    ),
    http.get("*/projects/test-project/rooms/general/threads", () =>
      HttpResponse.json({
        ok: true,
        threads: [{ id: thread, title: "Review changes" }],
      }),
    ),
    http.get("*/projects/test-project/rooms/general/messages", () =>
      HttpResponse.json({
        ok: true,
        messages: [],
        cursor: "history",
        tail_cursor: "tail",
        has_more: false,
      }),
    ),
  );
  renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/rooms/:roomId" element={<RoomsPage />} />
    </Routes>,
    { route: "/p/test-project/rooms/general" },
  );
  const button = await screen.findByRole("button", { name: "Review changes" });
  await userEvent.click(button);
  expect(
    await screen.findByRole("dialog", { name: "Review changes" }),
  ).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(button).toHaveFocus());
});

test.each([
  ["a reader sees counts only", true],
  ["a manager sees each recipient's trace", false],
])("message deliveries: %s", async (_name, restricted) => {
  const row = message(1);
  const item = traceItem(1, { message: { id: row.id } });
  const summary = { recipients: 1, pending: 1, acknowledged: 0, expired: 0 };
  const requests: string[] = [];
  server.use(
    http.get("*/projects/test-project/rooms/general/messages", () =>
      HttpResponse.json({
        ok: true,
        messages: [row],
        cursor: "c",
        tail_cursor: "1",
        has_more: false,
      }),
    ),
    http.get(
      "*/projects/test-project/rooms/general/messages/:message/deliveries",
      ({ request }) => {
        requests.push(new URL(request.url).pathname);
        return HttpResponse.json(
          restricted
            ? { ok: true, restricted: true, summary }
            : {
                ok: true,
                restricted: false,
                summary,
                deliveries: [item],
                has_more: false,
              },
        );
      },
    ),
  );
  renderWithProviders(
    <RoomStream
      project="test-project"
      room="general"
      thread={null}
      writable={false}
    />,
  );
  const toggle = await screen.findByRole("button", { name: "Deliveries" });
  // Outcomes load only when asked for, not once per rendered message.
  expect(requests).toEqual([]);
  await userEvent.click(toggle);
  expect(
    await screen.findByText(/Stored for 1 recipient · 1 pending/),
  ).toBeInTheDocument();
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  if (restricted) {
    expect(
      screen.getByText(/require conversation management/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Trace" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Recipients" })).toBeNull();
  } else {
    expect(screen.getByRole("link", { name: "Trace" })).toHaveAttribute(
      "href",
      `/p/test-project/deliveries/worker/${item.delivery.id}`,
    );
    expect(screen.getByText("Work result: not reported")).toBeInTheDocument();
  }
  expect(requests).toEqual([
    `/projects/test-project/rooms/general/messages/${row.id}/deliveries`,
  ]);
});

describe("conversation prerequisites", () => {
  function renderRooms() {
    renderWithProviders(
      <Routes>
        <Route path="/p/:projectId/rooms" element={<RoomsPage />} />
      </Routes>,
      { route: "/p/test-project/rooms" },
    );
  }
  const notConfigured = (details?: { reason: string }) =>
    http.get("*/projects/test-project/rooms", () =>
      HttpResponse.json(
        {
          ok: false,
          error: {
            code: "config-unavailable",
            message: details
              ? "Conversations require the CONVERSATION_CURSOR_KEY Worker secret"
              : "Conversations are not configured on this deployment",
            retryable: false,
            ...(details ? { details } : {}),
          },
        },
        { status: 503 },
      ),
    );

  test("shows managers how to enable conversations", async () => {
    server.use(notConfigured({ reason: "missing" }));
    renderRooms();
    expect(
      await screen.findByRole("heading", {
        name: "Conversations are not configured",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/wrangler secret put CONVERSATION_CURSOR_KEY/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No accessible rooms/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("names a too-short key", async () => {
    server.use(notConfigured({ reason: "cursor-key-too-short" }));
    renderRooms();
    expect(
      await screen.findByText(/shorter than 32 characters/),
    ).toBeInTheDocument();
  });

  test("tells other callers to ask a maintainer without operator detail", async () => {
    server.use(notConfigured());
    renderRooms();
    expect(
      await screen.findByText(/Ask a project maintainer/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/wrangler/)).not.toBeInTheDocument();
  });

  test("keeps an empty room list distinct", async () => {
    server.use(
      http.get("*/projects/test-project/rooms", () =>
        HttpResponse.json({ ok: true, rooms: [] }),
      ),
    );
    renderRooms();
    expect(await screen.findByText(/No accessible rooms/)).toBeInTheDocument();
    expect(
      screen.queryByText("Conversations are not configured"),
    ).not.toBeInTheDocument();
  });

  test("keeps a network failure distinct", async () => {
    server.use(
      http.get("*/projects/test-project/rooms", () => HttpResponse.error()),
    );
    renderRooms();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.queryByText("Conversations are not configured"),
    ).not.toBeInTheDocument();
  });
});
