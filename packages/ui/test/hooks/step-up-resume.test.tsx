import { AuthGate } from "@/app";
import { stashStepUpResume } from "@/lib/step-up";
import { http, HttpResponse } from "msw";
import { adminHandlers } from "../mocks/admin-fixtures";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";

describe("step-up resume", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test("after GitHub sign-in it reselects the project and returns to settings", async () => {
    let selected: string | null = null;
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

    renderWithProviders(<AuthGate />, { route: "/" });

    await waitFor(() => expect(selected).toBe("test-project"));
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(window.sessionStorage.getItem("tila.stepUp")).toBeNull();
  });

  test("with the project already active it only navigates back", async () => {
    server.use(...adminHandlers("explicit"));
    stashStepUpResume({
      projectId: "test-project",
      returnTo: "/p/test-project/settings",
    });

    renderWithProviders(<AuthGate />, { route: "/" });

    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(window.sessionStorage.getItem("tila.stepUp")).toBeNull();
  });
});
