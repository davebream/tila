import { AuthGate } from "@/app";
import userEvent from "@testing-library/user-event";
import { CAPABILITIES } from "@tila/schemas";
import { http, HttpResponse } from "msw";
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
      "Overview",
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
    ).toEqual([
      "Tasks",
      "Queue",
      "Decisions",
      "Records",
      "Artifacts",
      "Journal",
    ]);
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
    renderWithProviders(<AuthGate />, { route: "/p/test-project/overview" });

    const primary = await screen.findByRole("navigation", { name: "Primary" });
    expect(
      within(primary).getByRole("link", { name: "Overview" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.queryByRole("navigation", { name: "Overview" }),
    ).not.toBeInTheDocument();
  });

  test("a nested settings page marks only itself as current", async () => {
    renderWithProviders(<AuthGate />, {
      route: "/p/test-project/settings/definitions",
    });

    const settings = await screen.findByRole("navigation", {
      name: "Settings",
    });
    expect(
      within(settings).getByRole("link", { name: "Definitions" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(settings).getByRole("link", { name: "Access" }),
    ).not.toHaveAttribute("aria-current");
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
      ).toEqual(["Overview", "Work", "Settings"]),
    );
    const work = screen.getByRole("navigation", { name: "Work" });
    expect(
      within(work)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Tasks", "Queue", "Decisions", "Records"]);
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

  test("⌘K also works with Caps Lock on", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthGate />, { route: "/p/test-project/tasks" });
    await screen.findByRole("navigation", { name: "Primary" });

    await user.keyboard("{Meta>}K{/Meta}");
    expect(
      await screen.findByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
  });

  test("a section narrowed to one page does not mark a hidden page as that page", async () => {
    server.use(
      http.get("*/api/whoami", () =>
        HttpResponse.json({
          ok: true,
          project_id: "test-project",
          token_name: "viewer",
          scopes: "read",
          role: "viewer",
          policy: {
            role: "viewer",
            // Every read except the ones behind the settings sub-pages.
            capabilities: CAPABILITIES.filter(
              (cap) =>
                cap.endsWith(":read") &&
                ![
                  "schema:read",
                  "agents:read",
                  "conversations:read",
                  "signals:read",
                  "summary:read",
                  "tokens:read",
                ].includes(cap),
            ),
          },
        }),
      ),
    );
    renderWithProviders(<AuthGate />, {
      route: "/p/test-project/settings/definitions",
    });

    const primary = await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() =>
      expect(
        screen.queryByRole("navigation", { name: "Settings" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(primary).getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("aria-current", "true");
  });
});
