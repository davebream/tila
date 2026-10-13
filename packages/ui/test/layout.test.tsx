import { AuthGate } from "@/app";
import userEvent from "@testing-library/user-event";
import { CAPABILITIES } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { adminHandlers } from "./mocks/admin-fixtures";
import { server } from "./mocks/server";
import { renderWithProviders, screen, waitFor, within } from "./test-utils";

function restrictedIdentity() {
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        token_name: "bug-bot",
        scopes: "write",
        role: "participant",
        policy: {
          role: "participant",
          capabilities: CAPABILITIES.filter(
            (cap) => !cap.startsWith("project:"),
          ),
          restrictions: { task_types: ["bug"] },
        },
      }),
    ),
  );
}

describe("Layout navigation", () => {
  test("groups pages into primary sections with the active one marked", async () => {
    renderWithProviders(<AuthGate />, { route: "/p/test-project/tasks" });

    const primary = await screen.findByRole("navigation", { name: "Primary" });
    const links = within(primary).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Work",
      "Conversations",
      "Runtime",
      "Settings",
    ]);
    expect(within(primary).getByRole("link", { name: "Work" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(
      within(primary).getByRole("link", { name: "Conversations" }),
    ).toHaveAttribute("href", "/p/test-project/rooms");
    expect(
      within(primary).getByRole("link", { name: "Runtime" }),
    ).not.toHaveAttribute("aria-current");

    const work = screen.getByRole("navigation", { name: "Work" });
    expect(
      within(work)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Tasks", "Queue", "Records", "Artifacts", "Journal"]);
    expect(within(work).getByRole("link", { name: "Tasks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("a drawer deep link keeps its section active", async () => {
    renderWithProviders(<AuthGate />, {
      route: "/p/test-project/tasks/entity-1",
    });
    const work = await screen.findByRole("navigation", { name: "Work" });
    expect(within(work).getByRole("link", { name: "Tasks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("a single-page section is the current page without a sub-navigation", async () => {
    server.use(...adminHandlers());
    renderWithProviders(<AuthGate />, { route: "/p/test-project/settings" });

    const primary = await screen.findByRole("navigation", { name: "Primary" });
    expect(
      within(primary).getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.queryByRole("navigation", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  test("a restricted credential only sees the surfaces it can read", async () => {
    restrictedIdentity();
    renderWithProviders(<AuthGate />, { route: "/p/test-project/tasks" });

    const primary = await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() =>
      expect(
        within(primary)
          .getAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual(["Work", "Settings"]),
    );
    const work = screen.getByRole("navigation", { name: "Work" });
    expect(
      within(work)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Tasks", "Queue", "Records"]);
  });

  test("the skip link comes before the primary navigation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthGate />, { route: "/p/test-project/tasks" });
    await screen.findByRole("navigation", { name: "Primary" });

    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();
  });

  test("the search control opens the command palette at every width", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthGate />, { route: "/p/test-project/tasks" });

    await user.click(
      await screen.findByRole("button", { name: "Search and navigate" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
  });

  test("⌘K toggles the command palette", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthGate />, { route: "/p/test-project/tasks" });
    await screen.findByRole("navigation", { name: "Primary" });

    await user.keyboard("{Meta>}k{/Meta}");
    expect(
      await screen.findByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
  });

  test("the palette hides destinations the credential cannot use", async () => {
    const user = userEvent.setup();
    restrictedIdentity();
    renderWithProviders(<AuthGate />, { route: "/p/test-project/tasks" });
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() =>
      expect(
        within(primary).queryByRole("link", { name: "Runtime" }),
      ).not.toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: "Search and navigate" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    await user.type(within(dialog).getByRole("combobox"), "go to");
    expect(await within(dialog).findByText("Go to Tasks")).toBeInTheDocument();
    expect(within(dialog).queryByText("Go to Runtime")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Go to Rooms")).not.toBeInTheDocument();
  });
});
