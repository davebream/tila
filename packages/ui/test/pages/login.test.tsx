import { AuthGate } from "@/app";
import { LoginPage } from "@/pages/login";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";

describe("account login", () => {
  test("offers email/password without token entry or email delivery", async () => {
    const login = vi.fn(async ({ request }: { request: Request }) => {
      expect(await request.json()).toEqual({
        email: "person@example.com",
        password: "long-test-password",
      });
      return HttpResponse.json({ user: { email: "person@example.com" } });
    });
    server.use(
      http.get("*/api/account/config", () =>
        HttpResponse.json({ github: false, emailDelivery: false }),
      ),
      http.post("*/api/account/auth/sign-in/email", login),
    );
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { authenticated: false });
    expect(screen.queryByLabelText("API Token")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Project ID")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "person@example.com");
    await user.type(screen.getByLabelText("Password"), "long-test-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(login).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("button", { name: "Sign in with GitHub" }),
    ).not.toBeInTheDocument();
  });
  test("offers GitHub only when explicitly configured", async () => {
    server.use(
      http.get("*/api/account/config", () =>
        HttpResponse.json({ github: true }),
      ),
    );
    renderWithProviders(<LoginPage />, { authenticated: false });
    expect(
      await screen.findByRole("button", { name: "Sign in with GitHub" }),
    ).toBeInTheDocument();
  });
  test("shows a sign-in failure without exposing password or tokens", async () => {
    server.use(
      http.get("*/api/account/config", () =>
        HttpResponse.json({ github: false }),
      ),
      http.post("*/api/account/auth/sign-in/email", () =>
        HttpResponse.json(
          { message: "Invalid email or password" },
          { status: 401 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { authenticated: false });
    await user.type(screen.getByLabelText("Email"), "person@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid email or password",
    );
  });
  test("routes unauthenticated visitors to account login", async () => {
    server.use(
      http.get("*/api/account/config", () =>
        HttpResponse.json({ github: false }),
      ),
    );
    renderWithProviders(<AuthGate />, {
      authenticated: false,
      route: "/tasks",
    });
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByLabelText("API Token")).not.toBeInTheDocument();
  });
});

function migrationResponse() {
  return HttpResponse.json(
    {
      ok: false,
      error: { code: "account-migration-required", retryable: false },
    },
    { status: 401 },
  );
}

describe("legacy browser session migration", () => {
  beforeEach(() => {
    server.use(
      http.get("*/api/account/config", () =>
        HttpResponse.json({ github: false, emailDelivery: false }),
      ),
    );
  });

  test("keeps recovery guidance visible when sign-out fails", async () => {
    server.use(
      http.get("*/auth/session/status", migrationResponse),
      http.post("*/auth/logout", () =>
        HttpResponse.json(
          {
            error: {
              code: "auth-unavailable",
              message: "Try signing out again",
            },
          },
          { status: 503 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    await user.click(
      await screen.findByRole("button", { name: "Sign out of old session" }),
    );
    expect(
      await screen.findByText("Try signing out again"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your old API-token browser session/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out of old session" }),
    ).toBeEnabled();
  });

  test("shows actionable recovery without requesting dashboard data and permits logout", async () => {
    const projects = vi.fn(() => HttpResponse.json({ ok: true, tasks: [] }));
    const logout = vi.fn(() => HttpResponse.json({ ok: true }));
    server.use(
      http.get("*/auth/session/status", migrationResponse),
      http.all("*/projects/*", projects),
      http.post("*/auth/logout", logout),
    );
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<AuthGate />, {
      route: "/tasks",
    });
    queryClient.setQueryData(["old-project"], { private: true });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "account with project access",
    );
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByText(/tila auth setup/)).toHaveTextContent(
      "--project <project-id>",
    );
    expect(queryClient.getQueryData(["old-project"])).toBeUndefined();
    expect(projects).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Sign out of old session" }),
    );
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.queryByText(/Your old API-token browser session/),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  test("clears the migration notice after successful account sign-in", async () => {
    let signedIn = false;
    server.use(
      http.get("*/auth/session/status", () =>
        signedIn
          ? HttpResponse.json({ ok: true, projectId: "", capabilities: null })
          : migrationResponse(),
      ),
      http.post("*/api/account/auth/sign-in/email", () => {
        signedIn = true;
        return HttpResponse.json({ user: { email: "owner@example.com" } });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "account with project access",
    );
    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.type(screen.getByLabelText("Password"), "long-test-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/Your old API-token browser session/),
      ).not.toBeInTheDocument(),
    );
    expect(signedIn).toBe(true);
  });
});
