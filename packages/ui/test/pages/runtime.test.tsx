import { RuntimePage } from "@/pages/runtime";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { act, renderWithProviders, screen, within } from "../test-utils";

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const NOW_S = NOW / 1000;
const RUN = "0a1b2c3d-0000-4000-8000-0000000000a1";
const OLD_RUN = "0b1b2c3d-0000-4000-8000-0000000000b1";
const ENROLLMENT = "00000000-0000-4000-8000-0000000000e1";
const BINDING = "00000000-0000-4000-8000-0000000000c1";

function renderRuntime(route = "/p/test-project/runtime") {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/runtime" element={<RuntimePage />} />
      <Route path="/p/:projectId/runtime/:agentId" element={<RuntimePage />} />
    </Routes>,
    { route },
  );
}

const fullBinding = (over: Record<string, unknown> = {}) => ({
  detail: "full",
  consumer_binding_id: BINDING,
  agent_id: "worker",
  binding_epoch: 2,
  holder: {
    kind: "run",
    run_id: RUN,
    enrollment_id: ENROLLMENT,
    workload_binding_id: null,
  },
  principal_id: "enrollment:host",
  participant_id: "participant-current",
  host_ref: ENROLLMENT,
  harness: "claude-code",
  native_session_ref: {
    host_ref: ENROLLMENT,
    harness: "claude-code",
    profile_id: "work",
    session_id: "session-two",
  },
  profile: {
    profile_id: "work",
    profile_revision: 3,
    account_ref: "a".repeat(64),
    verification: "declared",
  },
  capability_report: {
    protocol: 1,
    adapter_version: "1.2.0",
    capabilities: {
      "io.tila/native-queue": true,
      "io.tila/urgent-steer": false,
    },
  },
  mechanism: "native-queue",
  attended: true,
  allow_idle_start: false,
  state: "active",
  lease_expires_at: NOW_S + 300,
  created_at: NOW - 10_000,
  updated_at: NOW - 5_000,
  ...over,
});

const observation = (over: Record<string, unknown> = {}) => ({
  lifecycle: "attached",
  detail: "full",
  host_liveness: "online",
  liveness_basis: "run-lease",
  reasons: [],
  last_observed_at: NOW - 5_000,
  changes_at: (NOW_S + 300) * 1000,
  ...over,
});

const authority = (lease = NOW_S + 300) => ({
  source: "run",
  run_state: "active",
  lease_expires_at: lease,
  enrollment_revoked: false,
});

const fullOccupant = (over: Record<string, unknown> = {}) => ({
  binding: fullBinding(),
  authority: authority(),
  run: {
    status: "visible",
    run_id: RUN,
    run_role: "acting",
    enrollment_id: ENROLLMENT,
    workload_binding_id: null,
    principal_id: "enrollment:host",
    participant_id: "participant-current",
    state: "active",
    lease_expires_at: NOW_S + 300,
    created_at: NOW_S - 100,
  },
  host: {
    status: "enrollment",
    enrollment_id: ENROLLMENT,
    installation_id: "00000000-0000-4000-8000-0000000000f1",
    name: "studio-mac",
    kind: "personal",
    created_at: NOW_S - 1000,
    revoked_at: null,
  },
  presence: { status: "not-reported" },
  observation: observation(),
  ...over,
});

const commands = (allowed = true, epoch: number | null = 2) => ({
  release: {
    supported: true,
    allowed,
    expected_epoch: epoch,
    consumer_binding_id: epoch === null ? null : BINDING,
    denied_reason: allowed
      ? null
      : epoch === null
        ? "no-active-binding"
        : "permission-denied",
  },
  reconnect: { supported: false, reason: "no-host-adapter-command" },
  stop: { supported: false, reason: "no-host-adapter-command" },
});

const view = (
  rows: unknown[],
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ok: true,
  server_now: NOW,
  sources: {
    agents: "ok",
    runs: "ok",
    enrollments: "ok",
    presence: "ok",
  },
  rows,
  next_cursor: null,
  ...over,
});

const row = (current: unknown, previous: unknown = null, cmd = commands()) => ({
  agent: { id: "worker", name: "Reviewer", binding_epoch: 2 },
  current,
  previous,
  work_attempt: null,
  commands: cmd,
});

const handler = (body: () => unknown, status = 200) =>
  http.get("*/projects/test-project/runtime-view", () =>
    HttpResponse.json(body() as Record<string, unknown>, { status }),
  );

describe("runtime view", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval"],
      now: NOW,
    });
  });
  afterEach(() => vi.useRealTimers());

  test("links the mailbox to run, host, session and declared account evidence", async () => {
    server.use(handler(() => view([row(fullOccupant())])));
    renderRuntime();
    const table = await screen.findByRole("table", { name: "Runtime" });
    const cells = within(table);
    expect(cells.getByText("Attached")).toBeInTheDocument();
    expect(cells.getByText(RUN.slice(0, 8))).toBeInTheDocument();
    expect(cells.getByText("studio-mac")).toBeInTheDocument();
    expect(cells.getByText("Run lease valid")).toBeInTheDocument();
    expect(cells.getByText("session-two")).toBeInTheDocument();
    expect(cells.getByText("Declared — not verified")).toBeInTheDocument();
    expect(table.textContent).not.toMatch(/\bverified\b(?<!not verified)/i);
    expect(document.body.textContent).not.toMatch(/\bidle\b|completed/i);
  });

  test("shows permission-redacted rows without identities but with their state", async () => {
    server.use(
      handler(() =>
        view([
          row(
            {
              binding: {
                detail: "redacted",
                consumer_binding_id: BINDING,
                agent_id: "worker",
                binding_epoch: 2,
                state: "active",
                mechanism: "native-queue",
                lease_expires_at: NOW_S + 300,
                updated_at: NOW - 5_000,
              },
              authority: authority(NOW_S - 10),
              run: { status: "redacted" },
              host: { status: "redacted" },
              presence: { status: "redacted" },
              observation: observation({
                lifecycle: "expired",
                detail: "redacted",
                reasons: ["run-lease-lapsed"],
              }),
            },
            null,
            commands(false),
          ),
        ]),
      ),
    );
    renderRuntime();
    const table = await screen.findByRole("table", { name: "Runtime" });
    expect(within(table).getByText("Expired")).toBeInTheDocument();
    expect(within(table).getAllByText("Details hidden").length).toBeGreaterThan(
      1,
    );
    expect(table.textContent).not.toContain(RUN.slice(0, 8));
  });

  test("expires at the lease deadline using the server clock while polling fails", async () => {
    // Server clock runs 30s ahead; the lease ends 60s after server_now.
    server.use(
      handler(() =>
        view(
          [
            row(
              fullOccupant({
                authority: authority((NOW + 30_000) / 1000 + 60),
              }),
            ),
          ],
          { server_now: NOW + 30_000 },
        ),
      ),
    );
    renderRuntime();
    expect(await screen.findByText("Attached")).toBeInTheDocument();
    server.use(
      http.get("*/projects/test-project/runtime-view", () =>
        HttpResponse.error(),
      ),
    );
    // 60s later locally is 90s later on the server: exactly the deadline.
    // Without the skew correction the row would still read "Attached".
    await act(async () => {
      vi.setSystemTime(NOW + 60_000);
      vi.advanceTimersByTime(5_000);
    });
    expect(await screen.findByText("Expired")).toBeInTheDocument();
    expect(screen.getByText("Run lease lapsed")).toBeInTheDocument();
    expect(await screen.findByText(/Refresh failed/)).toBeInTheDocument();
  });

  test("reports unavailable run data as unknown, not attached", async () => {
    server.use(
      handler(() =>
        view(
          [
            row(
              fullOccupant({
                authority: {
                  source: "run-source-unavailable",
                  run_state: "unknown",
                  lease_expires_at: NOW_S + 300,
                  enrollment_revoked: null,
                },
                run: { status: "unknown", reason: "source-unavailable" },
              }),
            ),
          ],
          {
            sources: {
              agents: "ok",
              runs: "unavailable",
              enrollments: "ok",
              presence: "forbidden",
            },
          },
        ),
      ),
    );
    renderRuntime();
    expect(
      await screen.findByText(/Run data unavailable\. Mailbox authority/),
    ).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Runtime" });
    expect(within(table).queryByText("Attached")).not.toBeInTheDocument();
    expect(within(table).getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(screen.getByText(/Presence is not visible/)).toBeInTheDocument();
  });

  test("a failed projection is never shown as no agents", async () => {
    server.use(
      handler(
        () => ({
          ok: false,
          error: { code: "do-unreachable", message: "down", retryable: true },
        }),
        503,
      ),
    );
    renderRuntime();
    expect(
      await screen.findByText("Could not load runtime observations."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No agents registered.")).not.toBeInTheDocument();
  });
});

describe("runtime detail and release outcomes", () => {
  const user = () => userEvent.setup();

  test("shows capability report states and unsupported host commands", async () => {
    server.use(handler(() => view([row(fullOccupant())])));
    renderRuntime("/p/test-project/runtime/worker");
    const dialog = await screen.findByRole("dialog");
    const scope = within(dialog);
    expect(await scope.findByText("Supported (reported)")).toBeInTheDocument();
    expect(scope.getByText("Unsupported (reported)")).toBeInTheDocument();
    expect(scope.getAllByText("Not reported").length).toBeGreaterThan(0);
    expect(scope.getByRole("button", { name: "Reconnect" })).toBeDisabled();
    expect(scope.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(
      scope.getByText(/unsupported — no host adapter command/),
    ).toBeInTheDocument();
    expect(scope.getByText(/Work attempt: none linked/)).toBeInTheDocument();
  });

  test("a stale epoch is reported as rejected, not success", async () => {
    server.use(
      handler(() => view([row(fullOccupant())])),
      http.post("*/projects/test-project/agents/worker/release", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "stale-binding",
              message: "Binding epoch changed",
              retryable: false,
            },
          },
          { status: 409 },
        ),
      ),
    );
    renderRuntime("/p/test-project/runtime/worker");
    const u = user();
    const dialog = await screen.findByRole("dialog");
    await u.click(
      await within(dialog).findByRole("button", { name: "Release mailbox" }),
    );
    await u.click(
      within(dialog).getByRole("button", { name: "Confirm release" }),
    );
    expect(
      await within(dialog).findByText(
        "Rejected: the binding changed since you loaded it.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Observed/)).not.toBeInTheDocument();
  });

  test("an unanswered release stays unknown until a poll observes the change", async () => {
    let released = false;
    let body: { expected_epoch?: number } = {};
    server.use(
      handler(() =>
        released
          ? view([
              row(
                null,
                fullOccupant({
                  binding: fullBinding({ state: "released" }),
                  observation: observation({ lifecycle: "released" }),
                }),
                commands(false, null),
              ),
            ])
          : view([row(fullOccupant())]),
      ),
      http.post(
        "*/projects/test-project/agents/worker/release",
        async ({ request }) => {
          body = (await request.json()) as typeof body;
          released = true;
          return HttpResponse.error();
        },
      ),
    );
    renderRuntime("/p/test-project/runtime/worker");
    const u = user();
    const dialog = await screen.findByRole("dialog");
    await u.click(
      await within(dialog).findByRole("button", { name: "Release mailbox" }),
    );
    await u.click(
      within(dialog).getByRole("button", { name: "Confirm release" }),
    );
    expect(body.expected_epoch).toBe(2);
    expect(
      await within(dialog).findByText("Observed: binding released"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("No current occupant."),
    ).toBeInTheDocument();
  });

  test("keeps a replaced previous occupant distinct from the current session", async () => {
    server.use(
      handler(() =>
        view([
          row(
            fullOccupant(),
            fullOccupant({
              binding: fullBinding({
                consumer_binding_id: "00000000-0000-4000-8000-0000000000c0",
                binding_epoch: 1,
                state: "replaced",
                holder: {
                  kind: "run",
                  run_id: OLD_RUN,
                  enrollment_id: ENROLLMENT,
                  workload_binding_id: null,
                },
                native_session_ref: {
                  host_ref: ENROLLMENT,
                  harness: "claude-code",
                  profile_id: "work",
                  session_id: "session-one",
                },
              }),
              observation: observation({
                lifecycle: "replaced",
                reasons: ["replaced-run-still-active"],
              }),
            }),
          ),
        ]),
      ),
    );
    renderRuntime("/p/test-project/runtime/worker");
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("session-two")).toBeInTheDocument();
    expect(within(dialog).getByText("session-one")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Its run is still active but holds no mailbox authority",
      ),
    ).toBeInTheDocument();
  });
});
