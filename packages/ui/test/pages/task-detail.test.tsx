import { formatDateTime } from "@/lib/time";
import {
  TaskDetailPage,
  claimResourceMatchesEntity,
} from "@/pages/task-detail";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

describe("claimResourceMatchesEntity", () => {
  test("canonical task form matches the bare entity id", () => {
    expect(
      claimResourceMatchesEntity(
        "task:task.ingest-worker",
        "task.ingest-worker",
        "task",
      ),
    ).toBe(true);
  });

  test("canonical epic form matches the bare entity id", () => {
    expect(claimResourceMatchesEntity("epic:e1", "e1", "epic")).toBe(true);
  });

  test("bare resource matches the bare entity id", () => {
    expect(
      claimResourceMatchesEntity(
        "task.ingest-worker",
        "task.ingest-worker",
        "task",
      ),
    ).toBe(true);
  });

  test("entity type present with a bare resource matches (OR-4 tolerance)", () => {
    expect(claimResourceMatchesEntity("e1", "e1", "epic")).toBe(true);
  });

  test("a different id does not match", () => {
    expect(
      claimResourceMatchesEntity("task:other", "task.ingest-worker", "task"),
    ).toBe(false);
  });

  test("undefined entity type falls back to bare-only — typed resource does not match", () => {
    expect(claimResourceMatchesEntity("task:x", "x", undefined)).toBe(false);
  });

  test("undefined entity type falls back to bare-only — bare resource matches", () => {
    expect(claimResourceMatchesEntity("x", "x", undefined)).toBe(true);
  });

  test("empty entityId never matches", () => {
    expect(claimResourceMatchesEntity("task:", "", "task")).toBe(false);
  });

  test("empty resource never matches", () => {
    expect(claimResourceMatchesEntity("", "x", "task")).toBe(false);
  });

  test("a record resource sharing the trailing id does not collide", () => {
    expect(
      claimResourceMatchesEntity(
        "record:foo/task.ingest-worker",
        "task.ingest-worker",
        "task",
      ),
    ).toBe(false);
  });
});

// `TaskDetailPage` reads `useParams<{ id }>`, so it must be mounted under a
// matching <Route path>. `renderWithProviders` supplies only <MemoryRouter>, so
// the <Routes>/<Route> wrapper is passed as the `ui` argument.
function renderDrawer(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/tasks/:id" element={<TaskDetailPage />} />
    </Routes>,
    { route },
  );
}

// Mirror packages/ui/test/mocks/handlers.ts entity shape (+ tags), untyped.
// `created_by: "test-user"` is the unambiguous positive post-load signal — it
// renders exactly once in the Fields table, unlike the label "Type".
function entityHandler(id: string, type: string) {
  return http.get("*/projects/*/tasks/:id", () =>
    HttpResponse.json({
      ok: true,
      entity: {
        id,
        type,
        schema_version: 1,
        data: { title: "Test Task" },
        archived: 0,
        created_at: Date.now() - 10_000,
        updated_at: Date.now() - 5_000,
        created_by: "test-user",
        tags: [],
      },
      relationships: [],
    }),
  );
}

function activeClaim(resource: string, expiresAt: number) {
  return {
    resource,
    machine: "agent-sonnet",
    user: "agent-sonnet",
    mode: "exclusive",
    fence: 1,
    acquired_at: Date.now() - 60_000,
    expires_at: expiresAt,
  };
}

function claimsHandler(claims: unknown[]) {
  return http.get("*/projects/*/claims", () =>
    HttpResponse.json({ ok: true, claims }),
  );
}

describe("TaskDetailPage claim state", () => {
  test("displays the claim for a canonical task:<id> resource (AC-1)", async () => {
    const expiresAt = Date.now() + 3_600_000;
    server.use(
      entityHandler("task.ingest-worker", "task"),
      claimsHandler([activeClaim("task:task.ingest-worker", expiresAt)]),
    );

    renderDrawer("/p/test-project/tasks/task.ingest-worker");

    // Positive post-load signal: created_by renders once in the Fields table.
    await waitFor(() =>
      expect(screen.getByText("test-user")).toBeInTheDocument(),
    );

    const claimTable = screen.getByRole("table", { name: "Claim state" });
    // machine + user both "agent-sonnet"
    expect(within(claimTable).getAllByText("agent-sonnet")).toHaveLength(2);
    expect(within(claimTable).getByText("exclusive")).toBeInTheDocument();
    // fence "1" — scoped to the claim table (collides with schema_version: 1)
    expect(within(claimTable).getByText("1")).toBeInTheDocument();
    // expiry cell — formatDateTime computed in-test (timezone-safe)
    expect(
      within(claimTable).getByText(formatDateTime(expiresAt)),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
  });

  test("resolves a claim whose resource is the bare entity id (AC-3)", async () => {
    const expiresAt = Date.now() + 3_600_000;
    server.use(
      entityHandler("task.ingest-worker", "task"),
      claimsHandler([activeClaim("task.ingest-worker", expiresAt)]),
    );

    renderDrawer("/p/test-project/tasks/task.ingest-worker");

    await waitFor(() =>
      expect(screen.getByText("test-user")).toBeInTheDocument(),
    );

    const claimTable = screen.getByRole("table", { name: "Claim state" });
    expect(within(claimTable).getAllByText("agent-sonnet")).toHaveLength(2);
  });

  test("resolves a canonical epic:<id> resource via the shared drawer", async () => {
    const expiresAt = Date.now() + 3_600_000;
    server.use(
      entityHandler("e1", "epic"),
      claimsHandler([activeClaim("epic:e1", expiresAt)]),
    );

    renderDrawer("/p/test-project/tasks/e1");

    await waitFor(() =>
      expect(screen.getByText("test-user")).toBeInTheDocument(),
    );

    const claimTable = screen.getByRole("table", { name: "Claim state" });
    expect(within(claimTable).getAllByText("agent-sonnet")).toHaveLength(2);
  });

  test("shows 'Not claimed.' when there is no active claim (AC-2)", async () => {
    server.use(entityHandler("task.ingest-worker", "task"), claimsHandler([]));

    renderDrawer("/p/test-project/tasks/task.ingest-worker");

    // Gate on the positive signal first — "Not claimed." is also the pre-auth render.
    await waitFor(() =>
      expect(screen.getByText("test-user")).toBeInTheDocument(),
    );

    expect(screen.getByText("Not claimed.")).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "Claim state" }),
    ).not.toBeInTheDocument();
  });
});
