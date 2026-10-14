import { AuthGate } from "@/app";
import { DefaultRedirect } from "@/components/admin/step-up-resume";
import { peekStepUpResume, stashStepUpResume } from "@/lib/step-up";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { StrictMode, Suspense, useEffect, useLayoutEffect } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { adminHandlers } from "../mocks/admin-fixtures";
import { server } from "../mocks/server";
import {
  act,
  render,
  renderWithProviders,
  screen,
  waitFor,
} from "../test-utils";

function CurrentLocation() {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Current route">{pathname + search + hash}</output>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}

function renderRedirect(strict = false) {
  const ui = (
    <MemoryRouter initialEntries={["/previous", "/"]}>
      <Routes>
        <Route
          path="/"
          element={<DefaultRedirect projectId="test-project" />}
        />
        <Route path="*" element={<CurrentLocation />} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{ui}</StrictMode> : ui);
}

describe("step-up resume", () => {
  const protectedMutation = vi.fn(() => HttpResponse.json({ ok: true }));

  beforeEach(() => {
    window.sessionStorage.clear();
    protectedMutation.mockClear();
    server.use(
      http.post("*/projects/*/memberships", protectedMutation),
      http.delete("*/projects/*/memberships/:id", protectedMutation),
    );
  });

  afterEach(() => {
    expect(protectedMutation).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "returns to the stashed page and consumes it (StrictMode: %s)",
    async (strict) => {
      const returnTo = "/p/test-project/settings?tab=members#grants";
      stashStepUpResume({ projectId: "test-project", returnTo });
      renderRedirect(strict);

      expect(await screen.findByLabelText("Current route")).toHaveTextContent(
        returnTo,
      );
      expect(window.sessionStorage.getItem("tila.stepUp")).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        "/previous",
      );
    },
  );

  test("a discarded render leaves the stash intact", () => {
    stashStepUpResume({
      projectId: "test-project",
      returnTo: "/p/test-project/settings",
    });
    const raw = window.sessionStorage.getItem("tila.stepUp");
    const pending = new Promise<void>(() => {});
    function Suspend(): never {
      throw pending;
    }

    render(
      <StrictMode>
        <MemoryRouter>
          <Suspense fallback={<p>Waiting</p>}>
            <DefaultRedirect projectId="test-project" />
            <Suspend />
          </Suspense>
        </MemoryRouter>
      </StrictMode>,
    );

    expect(screen.getByText("Waiting")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("tila.stepUp")).toBe(raw);
  });

  test("keeps the committed destination on subsequent renders", () => {
    const returnTo = "/p/test-project/settings";
    stashStepUpResume({ projectId: "test-project", returnTo });
    const ui = () => (
      <StrictMode>
        <MemoryRouter>
          <DefaultRedirect projectId="test-project" />
          <CurrentLocation />
        </MemoryRouter>
      </StrictMode>
    );
    const { rerender } = render(ui());
    expect(window.sessionStorage.getItem("tila.stepUp")).toBeNull();

    rerender(ui());

    expect(screen.getByLabelText("Current route")).toHaveTextContent(returnTo);
  });

  test.each([
    {
      name: "different destination",
      returnTo: "/p/test-project/tasks",
      direct: false,
    },
    {
      name: "same destination",
      returnTo: "/p/test-project/settings",
      direct: false,
    },
    {
      name: "direct storage write",
      returnTo: "/p/test-project/tasks",
      direct: true,
    },
  ])(
    "preserves a newer stash written before the navigation effect: $name",
    ({ returnTo: newReturnTo, direct }) => {
      const returnTo = "/p/test-project/settings";
      stashStepUpResume({ projectId: "test-project", returnTo });
      function NewStash() {
        useLayoutEffect(() => {
          const newer = {
            projectId: "test-project",
            returnTo: newReturnTo,
          };
          if (direct) {
            window.sessionStorage.setItem("tila.stepUp", JSON.stringify(newer));
          } else {
            stashStepUpResume(newer);
          }
        }, [newReturnTo, direct]);
        return null;
      }

      render(
        <StrictMode>
          <MemoryRouter>
            <DefaultRedirect projectId="test-project" />
            <NewStash />
            <CurrentLocation />
          </MemoryRouter>
        </StrictMode>,
      );

      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        returnTo,
      );
      expect(peekStepUpResume()).toEqual({
        projectId: "test-project",
        returnTo: newReturnTo,
      });
    },
  );

  test("effect replay preserves a stash written after the first navigation", () => {
    const returnTo = "/p/test-project/settings";
    const newer = {
      projectId: "test-project",
      returnTo: "/p/test-project/tasks",
    };
    stashStepUpResume({ projectId: "test-project", returnTo });
    function NewStashOnReplay() {
      useEffect(() => () => stashStepUpResume(newer), []);
      return null;
    }

    render(
      <StrictMode>
        <MemoryRouter>
          <DefaultRedirect projectId="test-project" />
          <NewStashOnReplay />
          <CurrentLocation />
        </MemoryRouter>
      </StrictMode>,
    );

    expect(screen.getByLabelText("Current route")).toHaveTextContent(returnTo);
    expect(peekStepUpResume()).toEqual(newer);
  });

  test.each([
    ["missing", null],
    ["corrupt JSON", "{"],
    ["null", "null"],
    ["array", "[]"],
    [
      "missing project",
      JSON.stringify({ returnTo: "/p/test-project/settings" }),
    ],
    ["missing destination", JSON.stringify({ projectId: "test-project" })],
    [
      "non-string destination",
      JSON.stringify({ projectId: "test-project", returnTo: 1 }),
    ],
    [
      "another project",
      JSON.stringify({ projectId: "other", returnTo: "/p/other/settings" }),
    ],
    ...[
      "https://example.com/p/test-project/settings",
      "//example.com/p/test-project/settings",
      "settings",
      "/p/other/settings",
      "/p/test-project-other/settings",
      "/p/test-project/../other/settings",
      "/p/test-project/%2e%2e/other/settings",
      "/p/test-project\\..\\other/settings",
      "/p/test-project%2fother/settings",
      "/p/test-project\n/settings",
      "/p/%ZZ/settings",
    ].map((returnTo): [string, string] => [
      returnTo,
      JSON.stringify({ projectId: "test-project", returnTo }),
    ]),
  ])(
    "falls back and clears an invalid or mismatched stash: %s",
    async (_, raw) => {
      if (raw !== null) window.sessionStorage.setItem("tila.stepUp", raw);

      renderRedirect(true);

      expect(await screen.findByLabelText("Current route")).toHaveTextContent(
        "/p/test-project/overview",
      );
      expect(window.sessionStorage.getItem("tila.stepUp")).toBeNull();
    },
  );

  test.each([false, true])(
    "after GitHub sign-in it reselects the project and returns to settings (StrictMode: %s)",
    async (strict) => {
      let selected: string | null = null;
      let selectionCalls = 0;
      server.use(
        ...adminHandlers("explicit"),
        http.get("*/auth/session/status", () =>
          HttpResponse.json({
            ok: true,
            projectId: selected ?? "",
            permission: selected ? "admin" : "none",
            canManageTokens: Boolean(selected),
            capabilities: {
              memberships_manage: Boolean(selected),
              credentials_manage: Boolean(selected),
              membership_available: true,
              step_up_max_age_seconds: 600,
            },
          }),
        ),
        http.get("*/api/workspace/projects", () =>
          HttpResponse.json({ projects: [] }),
        ),
        http.post("*/api/workspace/select", async ({ request }) => {
          selectionCalls += 1;
          selected = ((await request.json()) as { project_id: string })
            .project_id;
          return HttpResponse.json({
            ok: true,
            projectId: selected,
            scopes: "admin",
          });
        }),
      );
      stashStepUpResume({
        projectId: "test-project",
        returnTo: "/p/test-project/settings",
      });

      renderWithProviders(<AuthGate />, {
        route: "/",
        reactStrictMode: strict,
      });

      await waitFor(() => expect(selected).toBe("test-project"));
      expect(
        await screen.findByRole("heading", { name: "Settings" }),
      ).toBeInTheDocument();
      expect(window.sessionStorage.getItem("tila.stepUp")).toBeNull();
      expect(selectionCalls).toBe(1);
    },
  );

  test.each([false, true])(
    "with the project already active it only navigates back (StrictMode: %s)",
    async (strict) => {
      server.use(...adminHandlers("explicit"));
      stashStepUpResume({
        projectId: "test-project",
        returnTo: "/p/test-project/settings",
      });

      renderWithProviders(<AuthGate />, {
        route: "/",
        reactStrictMode: strict,
      });

      expect(
        await screen.findByRole("heading", { name: "Settings" }),
      ).toBeInTheDocument();
      expect(window.sessionStorage.getItem("tila.stepUp")).toBeNull();
    },
  );

  test.each([false, true])(
    "selection failure stays on the workspace and preserves only a newer stash (newer: %s)",
    async (newer) => {
      let finishSelection: (() => void) | undefined;
      const select = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          finishSelection = resolve;
        });
        return HttpResponse.json(
          { error: { code: "forbidden" } },
          { status: 403 },
        );
      });
      server.use(
        http.get("*/auth/session/status", () =>
          HttpResponse.json({ ok: true, projectId: "", permission: "none" }),
        ),
        http.get("*/api/workspace/projects", () =>
          HttpResponse.json({ projects: [] }),
        ),
        http.post("*/api/workspace/select", select),
      );
      stashStepUpResume({
        projectId: "test-project",
        returnTo: "/p/test-project/settings",
      });
      const next = { projectId: "other", returnTo: "/p/other/settings" };
      renderWithProviders(
        <>
          <AuthGate />
          <CurrentLocation />
        </>,
        { route: "/", reactStrictMode: true },
      );
      await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
      if (newer) stashStepUpResume(next);

      await act(async () => finishSelection?.());

      await waitFor(() => expect(select).toHaveResolvedTimes(1));
      await waitFor(() =>
        expect(peekStepUpResume()).toEqual(newer ? next : null),
      );
      expect(
        screen.getByRole("heading", { name: "Select a project" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Current route")).toHaveTextContent(/^\/$/);
      expect(select).toHaveBeenCalledTimes(1);
    },
  );
});
