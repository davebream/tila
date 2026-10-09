import { RoomStream, RoomsPage } from "@/pages/rooms";
import userEvent from "@testing-library/user-event";
import type { Message } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
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
  await screen.findByText("<script>peer 500</script>", {}, { timeout: 15000 });
  expect(within(list).getAllByRole("listitem")).toHaveLength(200);
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
});

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
