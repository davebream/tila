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
