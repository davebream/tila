import { SettingsAgentsPage } from "@/pages/settings-agents";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const NOW = Date.now();
const OWNER = "github:github.com:1";

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "worker",
    name: "Reviewer",
    owner_principal_id: OWNER,
    bind_policy: [{ principal_id: "github:github.com:2", agent_id: "worker" }],
    binding_epoch: 4,
    archived: false,
    revision: 5,
    profile_selection: null,
    created_at: NOW - 86_400_000,
    updated_at: NOW - 3_600_000,
    ...overrides,
  };
}

const binding = (epoch = 4) => ({
  consumer_binding_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "worker",
  binding_epoch: epoch,
  holder: {
    kind: "run",
    run_id: "22222222-2222-4222-8222-222222222222",
    enrollment_id: "33333333-3333-4333-8333-333333333333",
    workload_binding_id: null,
  },
  principal_id: "github:github.com:2",
  participant_id: "session-1",
  host_ref: "host-1",
  harness: "claude-code",
  native_session_ref: null,
  profile: {
    profile_id: "work",
    profile_revision: 2,
    account_ref: "acct-1",
    verification: "declared",
  },
  capability_report: { protocol: 1, adapter_version: "1", capabilities: {} },
  mechanism: "native-peer",
  attended: true,
  allow_idle_start: false,
  state: "active",
  lease_expires_at: Math.floor(NOW / 1000) + 300,
  created_at: NOW - 60_000,
  updated_at: NOW - 60_000,
});

type View = { agent: ReturnType<typeof agentRow>; binding: unknown };
type Sent = {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
};

/**
 * Serve the agents API from mutable state and record every request. Writes
 * answer from `answers` in order; `null` or a missing answer is a success.
 */
function agentsApi(
  initial: View[],
  answers: Partial<
    Record<
      "patch" | "archive" | "unarchive" | "register",
      Array<(() => Response) | null>
    >
  > = {},
) {
  const state = { views: initial, previews: 0 };
  const lists: string[] = [];
  const sent: Sent[] = [];
  const counts: Record<string, number> = {};
  const answer = (kind: keyof typeof answers, fallback: () => Response) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    // `null`, or no answer left, means the default success.
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
  server.use(
    http.get("*/projects/test-project/agents", ({ request }) => {
      const archived =
        new URL(request.url).searchParams.get("include_archived") === "true";
      lists.push(new URL(request.url).search);
      return HttpResponse.json({
        ok: true,
        agents: state.views.filter((v) => archived || !v.agent.archived),
      });
    }),
    http.get(
      "*/projects/test-project/agents/:id/archive-preview",
      async ({ request }) => {
        await record(request);
        state.previews++;
        const view = state.views[0];
        const active = view.binding as { binding_epoch: number } | null;
        return HttpResponse.json({
          ok: true,
          preview: {
            agent_id: view.agent.id,
            revision: view.agent.revision,
            archived: view.agent.archived,
            binding: active && {
              consumer_binding_id: "11111111-1111-4111-8111-111111111111",
              agent_id: view.agent.id,
              binding_epoch: active.binding_epoch,
              state: "active",
              mechanism: "native-peer",
              lease_expires_at: Math.floor(NOW / 1000) + 300,
            },
            pending_deliveries: 3,
            rooms: ["general", "ops"],
            open_questions: 1,
            unfinished_attempts: 2,
          },
        });
      },
    ),
    http.patch("*/projects/test-project/agents/:id", async ({ request }) => {
      await record(request);
      return answer("patch", () => {
        const body = sent[sent.length - 1].body as Record<string, unknown>;
        const agent = {
          ...state.views[0].agent,
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          revision: state.views[0].agent.revision + 1,
        };
        state.views = [{ ...state.views[0], agent }];
        return HttpResponse.json({ ok: true, agent });
      });
    }),
    http.post(
      "*/projects/test-project/agents/:id/archive",
      async ({ request }) => {
        await record(request);
        return answer("archive", () => {
          const agent = { ...state.views[0].agent, archived: true };
          state.views = [{ agent, binding: null }];
          return HttpResponse.json({
            ok: true,
            agent,
            released: {
              consumer_binding_id: "11111111-1111-4111-8111-111111111111",
              binding_epoch: 4,
            },
            pending_deliveries: 3,
          });
        });
      },
    ),
    http.post(
      "*/projects/test-project/agents/:id/unarchive",
      async ({ request }) => {
        await record(request);
        return answer("unarchive", () => {
          const agent = { ...state.views[0].agent, archived: false };
          state.views = [{ ...state.views[0], agent }];
          return HttpResponse.json({ ok: true, agent });
        });
      },
    ),
    http.post("*/projects/test-project/agents", async ({ request }) => {
      await record(request);
      return answer("register", () =>
        HttpResponse.json({
          ok: true,
          agent: agentRow({ id: "planner", name: "Planner", revision: 9 }),
        }),
      );
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
        path="/p/:projectId/settings/agents"
        element={<SettingsAgentsPage />}
      />
    </Routes>,
    { route: "/p/test-project/settings/agents" },
  );
}

const conflict = (revision: number) => () =>
  HttpResponse.json(
    {
      ok: false,
      error: {
        code: "revision-conflict",
        message: `agent:worker changed; current revision is ${revision}`,
        retryable: false,
        revision,
        resource: "agent:worker",
      },
    },
    { status: 412 },
  );

const unavailable = () =>
  HttpResponse.json(
    { ok: false, error: { code: "do-unreachable", message: "down" } },
    { status: 503 },
  );

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Edit worker" }));
  return screen.findByRole("dialog", { name: "Agent worker" });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("capabilities", () => {
  test.each([
    ["viewer", undefined],
    ["participant", undefined],
    ["maintainer", ["agents:read", "conversations:manage"]],
  ])(
    "a %s without agents:manage reads agents but gets no controls or writes",
    async (role, capabilities) => {
      whoamiAs(role, capabilities);
      const api = agentsApi([
        { agent: agentRow(), binding: binding() },
        { agent: agentRow({ id: "old", archived: true }), binding: null },
      ]);
      renderPage();

      expect(
        await screen.findByText(/You can view agents but not manage them/),
      ).toBeInTheDocument();
      const table = await screen.findByRole("table", { name: "Agents" });
      expect(within(table).getByText("Reviewer")).toBeInTheDocument();
      expect(within(table).queryByText("old")).not.toBeInTheDocument();
      for (const name of [
        "Register agent",
        "Edit worker",
        "Archive worker",
        /Unarchive/,
      ])
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(api.lists.every((search) => search === "")).toBe(true);
      expect(api.sent).toEqual([]);
    },
  );

  test.each([["maintainer"], ["owner"]])(
    "a %s manages agents, archived ones included",
    async (role) => {
      whoamiAs(role);
      const api = agentsApi([
        { agent: agentRow(), binding: binding() },
        { agent: agentRow({ id: "old", archived: true }), binding: null },
      ]);
      renderPage();

      const table = await screen.findByRole("table", { name: "Agents" });
      expect(within(table).getByText("old")).toBeInTheDocument();
      expect(within(table).getByText("Archived")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Register agent" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Edit worker" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Archive worker" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Unarchive old" }),
      ).toHaveAccessibleDescription(/restores the identity only/);
      expect(
        screen.queryByText(/You can view agents but not manage them/),
      ).not.toBeInTheDocument();
      expect(api.lists).toContain("?include_archived=true");
      expect(api.lists).not.toContain("");
      expect(api.sent).toEqual([]);
    },
  );
});

describe("editing", () => {
  test("a conflicting save keeps the edits, shows what changed, and the next save uses a new key", async () => {
    const user = userEvent.setup();
    const api = agentsApi([{ agent: agentRow(), binding: null }], {
      patch: [
        () => {
          // Someone else renamed the agent meanwhile.
          api.state.views = [
            {
              agent: agentRow({ name: "Senior reviewer", revision: 7 }),
              binding: null,
            },
          ];
          return conflict(7)();
        },
      ],
    });
    renderPage();
    const drawer = await openEditor(user);
    const name = within(drawer).getByRole("textbox", { name: /^Name/ });
    await user.clear(name);
    await user.type(name, "Code reviewer");
    await user.click(
      within(drawer).getByRole("button", { name: "Save changes" }),
    );

    expect(
      await within(drawer).findByText(/Another change landed \(revision 7\)/),
    ).toHaveTextContent("It changed the name.");
    expect(name).toHaveValue("Code reviewer");

    // The next attempt is a new request: the default handler accepts it.
    api.sent.length = 0;
    await user.click(
      within(drawer).getByRole("button", {
        name: "Keep my edits on revision 7",
      }),
    );
    expect(name).toHaveValue("Code reviewer");
    await user.click(
      within(drawer).getByRole("button", { name: "Save changes" }),
    );
    expect(
      await screen.findByText("Saved worker as revision 8."),
    ).toBeInTheDocument();
    const [retry] = writes(api.sent);
    expect(retry.body).toEqual({ expected_revision: 7, name: "Code reviewer" });
  });

  test("the key changes after a conflict and Load latest discards the edits", async () => {
    const user = userEvent.setup();
    const api = agentsApi([{ agent: agentRow(), binding: null }], {
      patch: [
        () => {
          api.state.views = [
            {
              agent: agentRow({ name: "Senior reviewer", revision: 7 }),
              binding: null,
            },
          ];
          return conflict(7)();
        },
        () => {
          api.state.views = [
            {
              agent: agentRow({ name: "Lead reviewer", revision: 8 }),
              binding: null,
            },
          ];
          return conflict(8)();
        },
      ],
    });
    renderPage();
    const drawer = await openEditor(user);
    const name = within(drawer).getByRole("textbox", { name: /^Name/ });
    await user.clear(name);
    await user.type(name, "Code reviewer");
    await user.click(
      within(drawer).getByRole("button", { name: "Save changes" }),
    );
    await within(drawer).findByRole("button", {
      name: "Keep my edits on revision 7",
    });
    await user.click(
      within(drawer).getByRole("button", {
        name: "Keep my edits on revision 7",
      }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => expect(writes(api.sent)).toHaveLength(2));
    const [first, second] = writes(api.sent);
    expect(first.body).toEqual({ expected_revision: 5, name: "Code reviewer" });
    expect(second.key).not.toBe(first.key);

    await within(drawer).findByText(/Another change landed \(revision 8\)/);
    await user.click(
      within(drawer).getByRole("button", { name: "Load latest" }),
    );
    expect(name).toHaveValue("Lead reviewer");
    expect(
      within(drawer).getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
  });

  test("an unconfirmed save retries the same request with the same key", async () => {
    const user = userEvent.setup();
    const api = agentsApi([{ agent: agentRow(), binding: null }], {
      patch: [unavailable, null],
    });
    renderPage();
    const drawer = await openEditor(user);
    await user.selectOptions(
      within(drawer).getByRole("combobox", {
        name: "A new attach must report",
      }),
      "profile",
    );
    await user.type(
      within(drawer).getByRole("textbox", { name: /^Profile ID/ }),
      "work",
    );
    await user.type(
      within(drawer).getByRole("textbox", { name: /^Host/ }),
      "host-1",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save changes" }),
    );
    expect(
      await within(drawer).findByText(/The server did not confirm this save/),
    ).toBeInTheDocument();
    // The frozen request cannot be edited until the server answers it.
    expect(
      within(drawer).getByRole("textbox", { name: /^Profile ID/ }),
    ).toBeDisabled();

    await user.click(
      within(drawer).getByRole("button", { name: "Retry save" }),
    );
    expect(
      await screen.findByText("Saved worker as revision 6."),
    ).toBeInTheDocument();
    const [first, retry] = writes(api.sent);
    expect(first.body).toEqual({
      expected_revision: 5,
      profile_selection: {
        profile_id: "work",
        host_ref: "host-1",
        account_ref: null,
      },
    });
    expect(first.key).toMatch(/[0-9a-f-]{36}/);
    expect(retry.key).toBe(first.key);
    expect(retry.body).toEqual(first.body);
  });
});

describe("observed binding and host profile", () => {
  test("the binding is read-only evidence and host profile changes are unsupported", async () => {
    const user = userEvent.setup();
    const api = agentsApi([
      {
        agent: agentRow({
          profile_selection: {
            profile_id: "personal",
            host_ref: null,
            account_ref: null,
          },
        }),
        binding: binding(),
      },
    ]);
    renderPage();
    const drawer = await openEditor(user);

    const evidence = within(drawer).getByLabelText("Observed binding");
    expect(evidence).toHaveTextContent("Attached");
    expect(evidence).toHaveTextContent("host-1");
    expect(evidence).toHaveTextContent("work (revision 2) · acct-1 · declared");
    expect(
      within(drawer).getByText(/reports profile work; the selection/),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByRole("link", { name: "Open in Runtime" }),
    ).toHaveAttribute("href", "/p/test-project/runtime/worker");
    // Nothing in the evidence is an input.
    expect(within(evidence).queryByRole("textbox")).not.toBeInTheDocument();

    expect(
      within(drawer).getByText("Change the host's local profile"),
    ).toBeInTheDocument();
    expect(within(drawer).getByText("Unsupported")).toBeInTheDocument();
    expect(
      within(drawer).getByText(
        /Not available: the host has no supported command for this yet\. Changing the selection above affects the next attach only\./,
      ),
    ).toBeInTheDocument();
    expect(
      within(drawer).queryByRole("button", { name: /host|profile/i }),
    ).not.toBeInTheDocument();
    expect(api.sent).toEqual([]);
  });
});

describe("archive and unarchive", () => {
  test("the dialog describes the preview and sends the reviewed revision and epoch", async () => {
    const user = userEvent.setup();
    const api = agentsApi([{ agent: agentRow(), binding: binding() }]);
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Archive worker" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Archive agent worker",
    });
    const effects = await within(dialog).findByRole("list", {
      name: "Archive effects",
    });
    expect(effects).toHaveTextContent(
      "Releases the active binding (epoch 4 on host host-1)",
    );
    expect(effects).toHaveTextContent("Pending deliveries: 3");
    expect(effects).toHaveTextContent("rooms general and ops");
    expect(effects).toHaveTextContent("Open questions it asked: 1");
    expect(effects).toHaveTextContent("Unfinished attempts: 2");
    expect(within(dialog).getByRole("link", { name: "Queue" })).toHaveAttribute(
      "href",
      "/p/test-project/queue",
    );

    const confirm = within(dialog).getByRole("button", {
      name: "Archive agent",
    });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "worker");
    await user.click(confirm);

    expect(
      await screen.findByText(/Archived worker\. Released binding epoch 4/),
    ).toBeInTheDocument();
    const [archive] = writes(api.sent);
    expect(archive.path).toBe("/projects/test-project/agents/worker/archive");
    expect(archive.body).toEqual({ expected_revision: 5, expected_epoch: 4 });
    expect(archive.key).toMatch(/[0-9a-f-]{36}/);
  });

  test("a changed occupant reloads the preview and keeps the dialog open", async () => {
    const user = userEvent.setup();
    const api = agentsApi([{ agent: agentRow(), binding: binding() }], {
      archive: [
        () => {
          // Another session attached between preview and confirm.
          api.state.views = [
            { agent: agentRow({ binding_epoch: 5 }), binding: binding(5) },
          ];
          return HttpResponse.json(
            {
              ok: false,
              error: {
                code: "stale-binding",
                message: "The active binding changed",
              },
            },
            { status: 409 },
          );
        },
        null,
      ],
    });
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Archive worker" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Archive agent worker",
    });
    await within(dialog).findByRole("list", { name: "Archive effects" });
    await user.type(within(dialog).getByRole("textbox"), "worker");
    await user.click(
      within(dialog).getByRole("button", { name: "Archive agent" }),
    );

    expect(
      await within(dialog).findByText(/The binding changed while you reviewed/),
    ).toBeInTheDocument();
    expect(
      await within(dialog).findByText(/Releases the active binding \(epoch 5/),
    ).toBeInTheDocument();
    expect(api.state.previews).toBe(2);
    await user.click(
      within(dialog).getByRole("button", { name: "Archive agent" }),
    );
    await screen.findByText(/Archived worker\./);
    const [first, second] = writes(api.sent);
    expect(first.body).toEqual({ expected_revision: 5, expected_epoch: 4 });
    expect(second.body).toEqual({ expected_revision: 5, expected_epoch: 5 });
    expect(second.key).not.toBe(first.key);
  });

  test("unarchive is inline, sends the listed revision and promises no revival", async () => {
    const user = userEvent.setup();
    const api = agentsApi([
      { agent: agentRow({ archived: true, revision: 11 }), binding: null },
    ]);
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Unarchive worker" }),
    );
    expect(
      await screen.findByText(/Unarchived worker\. No binding or lease/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writes(api.sent)[0]).toMatchObject({
      path: "/projects/test-project/agents/worker/unarchive",
      body: { expected_revision: 11 },
    });
  });
});

describe("registration", () => {
  test("registers with grants naming the new agent, and explains a taken ID", async () => {
    const user = userEvent.setup();
    const api = agentsApi([], {
      register: [
        () =>
          HttpResponse.json(
            {
              ok: false,
              error: { code: "conflict", message: "Agent ID is registered" },
            },
            { status: 409 },
          ),
        null,
      ],
    });
    renderPage();
    expect(
      await screen.findByText("No agents registered."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Register agent" }));
    const drawer = await screen.findByRole("dialog", {
      name: "Register agent",
    });
    await user.type(
      within(drawer).getByRole("textbox", { name: /^ID/ }),
      "planner",
    );
    await user.type(
      within(drawer).getByRole("textbox", { name: /^Name/ }),
      "Planner",
    );
    await user.type(
      within(drawer).getByRole("textbox", { name: /^Binding grants/ }),
      "github:github.com:2{enter}github:github.com:2",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Register agent" }),
    );
    expect(
      await within(drawer).findByText(/already exists with other settings/),
    ).toBeInTheDocument();

    await user.click(
      within(drawer).getByRole("button", { name: "Register agent" }),
    );
    expect(
      await screen.findByText("Registered planner. You are its owner."),
    ).toBeInTheDocument();
    const [first, second] = writes(api.sent);
    expect(first.body).toEqual({
      id: "planner",
      name: "Planner",
      bind_policy: [
        { principal_id: "github:github.com:2", agent_id: "planner" },
      ],
    });
    expect(second.key).not.toBe(first.key);
  });
});
