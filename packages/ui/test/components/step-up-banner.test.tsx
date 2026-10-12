import { StepUpBanner } from "@/components/admin/step-up-banner";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useLocation } from "react-router";
import { sessionStatusWith } from "../mocks/admin-fixtures";
import { server } from "../mocks/server";
import { act, renderWithProviders, screen } from "../test-utils";

function CurrentLocation() {
  return <output aria-label="Current route">{useLocation().pathname}</output>;
}

describe("StepUpBanner GitHub availability", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    server.use(sessionStatusWith({ auth_method: "github" }));
  });
  afterEach(() => vi.unstubAllGlobals());

  test.each([
    ["disabled", () => HttpResponse.json({ ok: true, enabled: false })],
    ["failed", () => HttpResponse.error()],
    ["malformed", () => HttpResponse.json({ ok: true, enabled: "true" })],
  ])(
    "offers administrator guidance when GitHub is %s",
    async (_name, response) => {
      const onDismiss = vi.fn();
      server.use(http.get("*/api/auth/github/login-config", response));
      renderWithProviders(<StepUpBanner onDismiss={onDismiss} />);
      expect(
        await screen.findByText(
          /GitHub sign-in is unavailable.*Contact your instance administrator/,
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Sign in again" }),
      ).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem("tila.stepUp")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(onDismiss).toHaveBeenCalledOnce();
    },
  );

  test("waits for availability, then preserves the GitHub redirect and resume target", async () => {
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
    const user = userEvent.setup();
    renderWithProviders(<StepUpBanner onDismiss={() => {}} />, {
      route: "/p/test-project/settings?tab=members#grants",
    });
    expect(
      screen.queryByRole("button", { name: "Sign in again" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/GitHub sign-in is unavailable/),
    ).not.toBeInTheDocument();
    await act(async () => release());
    const button = await screen.findByRole("button", { name: "Sign in again" });

    // jsdom cannot navigate. Replace only the location read for the click.
    const location = { href: "" };
    vi.stubGlobal(
      "window",
      new Proxy(window, {
        get(target, property) {
          return property === "location"
            ? location
            : Reflect.get(target, property, target);
        },
      }),
    );
    await user.click(button);
    expect(location.href).toBe("/api/auth/github/login");
    expect(
      JSON.parse(window.sessionStorage.getItem("tila.stepUp") ?? "null"),
    ).toEqual({
      projectId: "test-project",
      returnTo: "/p/test-project/settings?tab=members#grants",
    });
  });

  test("keeps token reauthentication available when GitHub is off", async () => {
    server.use(sessionStatusWith({ auth_method: "token" }));
    renderWithProviders(
      <>
        <StepUpBanner onDismiss={() => {}} />
        <CurrentLocation />
      </>,
      {
        route: "/p/test-project/settings",
      },
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in again" }),
    );
    expect(screen.getByLabelText("Current route")).toHaveTextContent("/login");
    expect(
      screen.queryByText(/GitHub sign-in is unavailable/),
    ).not.toBeInTheDocument();
    expect(
      JSON.parse(window.sessionStorage.getItem("tila.stepUp") ?? "null"),
    ).toEqual({
      projectId: "test-project",
      returnTo: "/p/test-project/settings",
    });
  });
});
