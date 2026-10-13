import { SettingsRoomsPage } from "@/pages/settings-rooms";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const NOW = Date.now();

function roomRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "general",
    name: "General",
    history_policy: "members",
    delivery_ttl_seconds: 604_800,
    budgets: {
      max_hops: 8,
      pair_exchanges: 10,
      agent_wakes: 20,
      room_wakes: 60,
    },
    archived: false,
    revision: 5,
    created_at: NOW - 86_400_000,
    updated_at: NOW - 3_600_000,
    ...overrides,
  };
}

type Room = ReturnType<typeof roomRow>;
type Sent = { method: string; path: string; body: unknown; key: string | null };

/**
 * Serve the rooms API from mutable state and record every request. Writes
 * answer from `answers` in order; `null` or a missing answer is a success.
 * Reads serve `state.rooms`, which a test may leave behind the writes to
 * check that the editor uses the revision a write returned.
 */
function roomsApi(
  initial: Room[],
  answers: Partial<
    Record<"patch" | "member" | "archive", Array<(() => Response) | null>>
  > = {},
) {
  const state = {
    rooms: initial,
    members: [
      {
        room_id: "general",
        member: "principal:alice",
        wake: false,
        joined_at: NOW,
      },
    ],
  };
  const lists: string[] = [];
  const sent: Sent[] = [];
  const counts: Record<string, number> = {};
  const answer = (kind: keyof typeof answers, fallback: () => Response) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    const next = answers[kind]?.[counts[kind] - 1];
    return next ? next() : fallback();
  };
  const record = async (request: Request) => {
    const url = new URL(request.url);
    const text = await request.text();
    sent.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      body: text ? JSON.parse(text) : undefined,
      key: request.headers.get("Idempotency-Key"),
    });
  };
  const current = () => state.rooms[0];
  server.use(
    http.get("*/projects/test-project/rooms", ({ request }) => {
      lists.push(new URL(request.url).search);
      return HttpResponse.json({ ok: true, rooms: state.rooms });
    }),
    http.get("*/projects/test-project/rooms/:room", () =>
      HttpResponse.json({ ok: true, room: current(), members: state.members }),
    ),
    http.get(
      "*/projects/test-project/rooms/:room/archive-preview",
      async ({ request }) => {
        await record(request);
        return HttpResponse.json({
          ok: true,
          preview: {
            room_id: current().id,
            revision: current().revision,
            archived: current().archived,
            members: 3,
            pending_deliveries: 2,
            messages: 12,
          },
        });
      },
    ),
    http.patch("*/projects/test-project/rooms/:room", async ({ request }) => {
      await record(request);
      return answer("patch", () => {
        const body = sent[sent.length - 1].body as Record<string, unknown>;
        const { expected_revision: _, ...changes } = body;
        const room = {
          ...current(),
          ...changes,
          revision: current().revision + 1,
        };
        state.rooms = [room];
        return HttpResponse.json({ ok: true, room });
      });
    }),
    http.put(
      "*/projects/test-project/rooms/:room/members/:member",
      async ({ request }) => {
        await record(request);
        return answer("member", () => {
          const body = sent[sent.length - 1].body as {
            expected_revision: number;
            wake: boolean;
          };
          const member = decodeURIComponent(
            new URL(request.url).pathname.split("/").pop() ?? "",
          );
          state.members = [
            ...state.members.filter((m) => m.member !== member),
            { room_id: "general", member, wake: body.wake, joined_at: NOW },
          ];
          // Answer with the next revision but leave the reads behind it.
          return HttpResponse.json({
            ok: true,
            room: { ...current(), revision: body.expected_revision + 1 },
          });
        });
      },
    ),
    http.delete(
      "*/projects/test-project/rooms/:room/members/:member",
      async ({ request }) => {
        await record(request);
        return answer("member", () => {
          const url = new URL(request.url);
          const member = decodeURIComponent(
            url.pathname.split("/").pop() ?? "",
          );
          state.members = state.members.filter((m) => m.member !== member);
          return HttpResponse.json({
            ok: true,
            room: {
              ...current(),
              revision: Number(url.searchParams.get("expected_revision")) + 1,
            },
          });
        });
      },
    ),
    http.post(
      "*/projects/test-project/rooms/:room/archive",
      async ({ request }) => {
        await record(request);
        return answer("archive", () => {
          const room = {
            ...current(),
            archived: true,
            revision: current().revision + 1,
          };
          state.rooms = [room];
          return HttpResponse.json({ ok: true, room });
        });
      },
    ),
    http.post(
      "*/projects/test-project/rooms/:room/unarchive",
      async ({ request }) => {
        await record(request);
        const room = {
          ...current(),
          archived: false,
          revision: current().revision + 1,
        };
        state.rooms = [room];
        return HttpResponse.json({ ok: true, room });
      },
    ),
    http.post("*/projects/test-project/rooms", async ({ request }) => {
      await record(request);
      const body = sent[sent.length - 1].body as Record<string, unknown>;
      return HttpResponse.json({
        ok: true,
        room: roomRow({ ...body, revision: 9 }),
      });
    }),
  );
  return { state, lists, sent };
}

const writes = (sent: Sent[]) => sent.filter((s) => s.method !== "GET");

function whoamiAs(role: string, capabilities?: string[]) {
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        principal_id: `principal-${role}`,
        token_name: "test-user",
        scopes: "admin",
        role,
        ...(capabilities ? { policy: { role, capabilities } } : {}),
      }),
    ),
  );
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/settings/rooms"
        element={<SettingsRoomsPage />}
      />
    </Routes>,
    { route: "/p/test-project/settings/rooms" },
  );
}

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Edit general" }));
  return screen.findByRole("dialog", { name: "Room general" });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("capabilities", () => {
  test.each([
    ["viewer", undefined],
    ["participant", undefined],
    ["maintainer", ["conversations:read", "agents:manage"]],
  ])(
    "a %s without conversations:manage reads rooms but gets no controls",
    async (role, capabilities) => {
      whoamiAs(role, capabilities);
      const api = roomsApi([
        roomRow(),
        roomRow({ id: "old", name: "Old", archived: true }),
      ]);
      renderPage();

      expect(
        await screen.findByText(/You can view rooms but not manage them/),
      ).toBeInTheDocument();
      const table = await screen.findByRole("table", { name: "Rooms" });
      expect(within(table).getByText("Archived")).toBeInTheDocument();
      for (const name of [
        "Create room",
        "Edit general",
        "Archive general",
        /Unarchive/,
      ])
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(api.lists).toContain("?include_archived=true");
      expect(api.sent).toEqual([]);
    },
  );

  test("a maintainer creates, edits, archives and unarchives rooms", async () => {
    whoamiAs("maintainer");
    roomsApi([roomRow(), roomRow({ id: "old", name: "Old", archived: true })]);
    renderPage();

    await screen.findByRole("table", { name: "Rooms" });
    expect(
      screen.getByRole("button", { name: "Create room" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit general" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Archive general" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unarchive old" }),
    ).toHaveAccessibleDescription(
      /Deliveries that expired while the room was archived do not come back/,
    );
  });

  test("shows the configuration fix instead of controls when conversations are off", async () => {
    server.use(
      http.get("*/projects/test-project/rooms", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "config-unavailable",
              message:
                "Conversations require the CONVERSATION_CURSOR_KEY Worker secret",
              details: { reason: "missing" },
            },
          },
          { status: 503 },
        ),
      ),
    );
    renderPage();
    expect(
      await screen.findByRole("heading", {
        name: "Conversations are not configured",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create room" }),
    ).not.toBeInTheDocument();
  });
});

describe("room settings", () => {
  test("a conflicting save keeps the edits and the next save names the new revision", async () => {
    const user = userEvent.setup();
    const api = roomsApi([roomRow()], {
      patch: [
        () => {
          api.state.rooms = [roomRow({ name: "Town square", revision: 8 })];
          return HttpResponse.json(
            {
              ok: false,
              error: {
                code: "revision-conflict",
                message: "room:general changed; current revision is 8",
                revision: 8,
                resource: "room:general",
              },
            },
            { status: 412 },
          );
        },
        null,
      ],
    });
    renderPage();
    const drawer = await openEditor(user);
    const ttl = within(drawer).getByRole("spinbutton", {
      name: /^Delivery TTL/,
    });
    await user.clear(ttl);
    await user.type(ttl, "3600");
    await user.click(
      within(drawer).getByRole("button", { name: "Save settings" }),
    );

    expect(
      await within(drawer).findByText(/Another change landed \(revision 8\)/),
    ).toHaveTextContent("It changed the name.");
    expect(ttl).toHaveValue(3600);
    await user.click(
      within(drawer).getByRole("button", {
        name: "Keep my edits on revision 8",
      }),
    );
    expect(within(drawer).getByRole("textbox", { name: /^Name/ })).toHaveValue(
      "Town square",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save settings" }),
    );

    expect(
      await screen.findByText("Saved general as revision 9."),
    ).toBeInTheDocument();
    const [first, second] = writes(api.sent);
    expect(first.body).toEqual({
      expected_revision: 5,
      delivery_ttl_seconds: 3600,
    });
    expect(second.body).toEqual({
      expected_revision: 8,
      delivery_ttl_seconds: 3600,
    });
    expect(second.key).not.toBe(first.key);
  });

  test("widening history to every project reader asks first, inline", async () => {
    const user = userEvent.setup();
    const api = roomsApi([roomRow()]);
    renderPage();
    const drawer = await openEditor(user);
    await user.selectOptions(
      within(drawer).getByRole("combobox", {
        name: /Who can read the history/,
      }),
      "project",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save settings" }),
    );

    expect(
      within(drawer).getByText(
        /Every project reader will be able to read this room's past messages immediately/,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(writes(api.sent)).toEqual([]);

    await user.click(
      within(drawer).getByRole("button", { name: "Widen and save" }),
    );
    expect(
      await screen.findByText("Saved general as revision 6."),
    ).toBeInTheDocument();
    expect(writes(api.sent)[0].body).toEqual({
      expected_revision: 5,
      history_policy: "project",
    });
  });

  test("keeping members only cancels the widening without a request", async () => {
    const user = userEvent.setup();
    const api = roomsApi([roomRow()]);
    renderPage();
    const drawer = await openEditor(user);
    const policy = within(drawer).getByRole("combobox", {
      name: /Who can read the history/,
    });
    await user.selectOptions(policy, "project");
    await user.click(
      within(drawer).getByRole("button", { name: "Save settings" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Keep members only" }),
    );
    expect(policy).toHaveValue("members");
    expect(
      within(drawer).getByRole("button", { name: "Save settings" }),
    ).toBeDisabled();
    expect(writes(api.sent)).toEqual([]);
  });
});

describe("members", () => {
  test("each change sends the room revision, and the next one uses the revision the last returned", async () => {
    const user = userEvent.setup();
    const api = roomsApi([roomRow()]);
    renderPage();
    const drawer = await openEditor(user);
    const members = await within(drawer).findByRole("list", {
      name: "Room members",
    });
    expect(
      within(members).getByRole("checkbox", { name: "Wake principal:alice" }),
    ).not.toBeChecked();

    await user.type(
      within(drawer).getByRole("textbox", { name: "Agent ID" }),
      "worker",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Add member" }),
    );
    expect(
      await within(drawer).findByRole("checkbox", {
        name: "Wake agent:worker",
      }),
    ).toBeChecked();

    // The reads still say revision 5; the write answered 6.
    await user.click(
      within(drawer).getByRole("button", { name: "Remove principal:alice" }),
    );
    await waitFor(() => expect(writes(api.sent)).toHaveLength(2));
    const [add, remove] = writes(api.sent);
    expect(add).toMatchObject({
      method: "PUT",
      path: "/projects/test-project/rooms/general/members/agent%3Aworker",
      body: { wake: true, expected_revision: 5 },
    });
    expect(remove).toMatchObject({
      method: "DELETE",
      path: "/projects/test-project/rooms/general/members/principal%3Aalice?expected_revision=6",
    });
    expect(remove.key).not.toBe(add.key);
    await waitFor(() =>
      expect(
        within(drawer).queryByText("principal:alice"),
      ).not.toBeInTheDocument(),
    );

    // A settings save after the member changes names the latest revision too.
    const name = within(drawer).getByRole("textbox", { name: /^Name/ });
    await user.clear(name);
    await user.type(name, "Lobby");
    await user.click(
      within(drawer).getByRole("button", { name: "Save settings" }),
    );
    await waitFor(() => expect(writes(api.sent)).toHaveLength(3));
    expect(writes(api.sent)[2].body).toEqual({
      expected_revision: 7,
      name: "Lobby",
    });
  });

  test("an archived agent cannot join and the reason is shown", async () => {
    const user = userEvent.setup();
    roomsApi([roomRow()], {
      member: [
        () =>
          HttpResponse.json(
            {
              ok: false,
              error: {
                code: "agent-archived",
                message: "Archived agents cannot join rooms",
              },
            },
            { status: 409 },
          ),
      ],
    });
    renderPage();
    const drawer = await openEditor(user);
    await within(drawer).findByRole("list", { name: "Room members" });
    await user.type(
      within(drawer).getByRole("textbox", { name: "Agent ID" }),
      "old",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Add member" }),
    );
    expect(
      await within(drawer).findByText(/Unarchive the agent first/),
    ).toBeInTheDocument();
  });
});

describe("archive", () => {
  test("the dialog shows the preview counts and sends the reviewed revision", async () => {
    const user = userEvent.setup();
    const api = roomsApi([roomRow()]);
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Archive general" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Archive room general",
    });
    const effects = await within(dialog).findByRole("list", {
      name: "Archive effects",
    });
    expect(effects).toHaveTextContent(
      "Messages: 12. The history stays readable",
    );
    expect(effects).toHaveTextContent("Members: 3. Membership is kept.");
    expect(effects).toHaveTextContent(
      "Pending deliveries: 2. Recipients can still fetch and acknowledge them",
    );
    expect(dialog).toHaveTextContent(
      "Publication and new threads stop now; wakes stop at the next dispatch.",
    );

    await user.type(within(dialog).getByRole("textbox"), "general");
    await user.click(
      within(dialog).getByRole("button", { name: "Archive room" }),
    );
    expect(
      await screen.findByText(/Archived general\. Its history stays readable/),
    ).toBeInTheDocument();
    const [archive] = writes(api.sent);
    expect(archive).toMatchObject({
      path: "/projects/test-project/rooms/general/archive",
      body: { expected_revision: 5 },
    });
    expect(archive.key).toMatch(/[0-9a-f-]{36}/);
  });

  test("unarchive is inline and sends the listed revision", async () => {
    const user = userEvent.setup();
    const api = roomsApi([roomRow({ archived: true, revision: 12 })]);
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Unarchive general" }),
    );
    expect(await screen.findByText(/Unarchived general\./)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writes(api.sent)[0]).toMatchObject({
      path: "/projects/test-project/rooms/general/unarchive",
      body: { expected_revision: 12 },
    });
  });
});

test("creating a room sends its settings with an idempotency key", async () => {
  const user = userEvent.setup();
  const api = roomsApi([]);
  renderPage();
  expect(await screen.findByText("No rooms you can read.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Create room" }));
  const drawer = await screen.findByRole("dialog", { name: "Create room" });
  await user.type(within(drawer).getByRole("textbox", { name: /^ID/ }), "ops");
  await user.type(
    within(drawer).getByRole("textbox", { name: /^Name/ }),
    "Ops",
  );
  const hops = within(drawer).getByRole("spinbutton", {
    name: /^Hops per chain/,
  });
  await user.clear(hops);
  await user.type(hops, "9");
  await user.click(within(drawer).getByRole("button", { name: "Create room" }));
  expect(
    within(drawer).getByText("Enter a whole number from 0 to 8."),
  ).toBeInTheDocument();
  expect(writes(api.sent)).toEqual([]);

  await user.clear(hops);
  await user.type(hops, "4");
  await user.click(within(drawer).getByRole("button", { name: "Create room" }));
  expect(
    await screen.findByText("Created ops. Edit it to add members."),
  ).toBeInTheDocument();
  const [create] = writes(api.sent);
  expect(create.body).toEqual({
    id: "ops",
    name: "Ops",
    history_policy: "members",
    delivery_ttl_seconds: 604_800,
    budgets: {
      max_hops: 4,
      pair_exchanges: 10,
      agent_wakes: 20,
      room_wakes: 60,
    },
  });
  expect(create.key).toMatch(/[0-9a-f-]{36}/);
});
