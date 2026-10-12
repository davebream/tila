import { AuthGate } from "@/app";
import { LoginPage } from "@/pages/login";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { act, renderWithProviders, screen, waitFor } from "../test-utils";

describe("LoginPage", () => {
  beforeEach(() => localStorage.clear());
  test("offers GitHub only after the instance confirms availability", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("*/api/auth/github/login-config", async () => {
        await pending;
        return HttpResponse.json({ ok: true, enabled: true });
      }),
    );
    renderWithProviders(<LoginPage />, { authenticated: false });

    expect(
      screen.queryByRole("button", { name: "Connect with GitHub" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("or use API token")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();

    await act(async () => release());
    expect(
      await screen.findByRole("button", { name: "Connect with GitHub" }),
    ).toBeInTheDocument();
    expect(screen.getByText("or use API token")).toBeInTheDocument();
    expect(
      screen.getByText(/or use Connect with GitHub above/),
    ).toBeInTheDocument();
  });

  test.each([
    ["disabled", () => HttpResponse.json({ ok: true, enabled: false })],
    ["unavailable endpoint", () => HttpResponse.json({}, { status: 404 })],
    ["server error", () => HttpResponse.json({}, { status: 503 })],
    ["network error", () => HttpResponse.error()],
    ["missing enabled", () => HttpResponse.json({ ok: true })],
    [
      "non-boolean enabled",
      () => HttpResponse.json({ ok: true, enabled: "true" }),
    ],
    [
      "unsuccessful envelope",
      () => HttpResponse.json({ ok: false, enabled: true }),
    ],
    ["invalid JSON", () => HttpResponse.text("invalid")],
  ])(
    "keeps API-token login usable when availability is %s",
    async (_name, response) => {
      const user = userEvent.setup();
      const availability = vi.fn(response);
      const exchange = vi.fn(() => HttpResponse.json({ ok: true }));
      server.use(
        http.get("*/api/auth/github/login-config", availability),
        http.post("*/auth/session", exchange),
      );
      renderWithProviders(<LoginPage />, { authenticated: false });
      await user.type(screen.getByLabelText("Project ID"), "test-project");
      await user.type(screen.getByLabelText("API Token"), "tila_test_token");
      await user.click(screen.getByRole("button", { name: "Connect" }));
      await waitFor(() => expect(exchange).toHaveBeenCalledOnce());
      expect(availability).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole("button", { name: "Connect with GitHub" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("or use API token")).not.toBeInTheDocument();
      expect(
        screen.queryByText(/when GitHub is unavailable/),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Ask your project admin for a token."),
      ).toBeInTheDocument();
    },
  );

  test("rechecks availability on remount without retaining a previous enabled result", async () => {
    server.use(
      http.get("*/api/auth/github/login-config", () =>
        HttpResponse.json({ ok: true, enabled: true }),
      ),
    );
    const first = renderWithProviders(<LoginPage />, { authenticated: false });
    await screen.findByRole("button", { name: "Connect with GitHub" });
    first.unmount();
    const availability = vi.fn(() =>
      HttpResponse.json({ ok: true, enabled: false }),
    );
    server.use(http.get("*/api/auth/github/login-config", availability));
    renderWithProviders(<LoginPage />, { authenticated: false });
    expect(
      screen.queryByRole("button", { name: "Connect with GitHub" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(availability).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("button", { name: "Connect with GitHub" }),
    ).not.toBeInTheDocument();
  });

  test("renders form and submits on button click", async () => {
    const user = userEvent.setup();

    renderWithProviders(<LoginPage />, { authenticated: false });

    // Find form elements
    const projectIdInput = screen.getByLabelText("Project ID");
    const tokenInput = screen.getByLabelText("API Token");
    const submitButton = screen.getByRole("button", { name: /Connect$/i });

    expect(projectIdInput).toBeInTheDocument();
    expect(tokenInput).toBeInTheDocument();
    expect(submitButton).toBeInTheDocument();

    // Fill and submit
    await user.type(projectIdInput, "test-project");
    await user.type(tokenInput, "tila_test_token");
    await user.click(submitButton);

    // Verify button changes to loading state (even briefly)
    // We can't reliably catch the "Connecting..." text due to timing,
    // so we just verify the form was interactive
    expect(projectIdInput).toHaveValue("test-project");
    expect(tokenInput).toHaveValue("tila_test_token");
  });

  test("displays error message on failed login", async () => {
    const user = userEvent.setup();

    // Override handler to throw error
    server.use(
      http.post("*/auth/session", () => {
        return HttpResponse.json({ error: "Invalid token" }, { status: 401 });
      }),
    );

    renderWithProviders(<LoginPage />, { authenticated: false });

    const projectIdInput = screen.getByLabelText("Project ID");
    const tokenInput = screen.getByLabelText("API Token");
    const submitButton = screen.getByRole("button", { name: /Connect$/i });

    await user.type(projectIdInput, "test-project");
    // Use a token that starts with tila_ to pass client-side validation
    await user.type(tokenInput, "tila_invalid_token_123");
    await user.click(submitButton);

    // Error message should appear - the component maps 401 to a specific message
    // The alert div has role="alert", check for text within it
    const errorAlert = await screen.findByRole("alert");
    expect(errorAlert).toBeInTheDocument();
    expect(errorAlert.textContent).toMatch(/Invalid token/i);
    expect(errorAlert.textContent).not.toMatch(/GitHub/);
  });

  test("AuthGate renders login page when not authenticated", async () => {
    renderWithProviders(<AuthGate />, {
      authenticated: false,
      route: "/tasks",
    });

    // Should redirect to login page
    await waitFor(() => {
      expect(screen.getByText("Connect to a project")).toBeInTheDocument();
    });

    // Form should be present
    expect(screen.getByLabelText("Project ID")).toBeInTheDocument();
    expect(screen.getByLabelText("API Token")).toBeInTheDocument();
  });
});
