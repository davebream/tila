import { AuthGate } from "@/app";
import { renderWithProviders, screen } from "./test-utils";

describe("App routing", () => {
  test("/ opens the project overview", async () => {
    renderWithProviders(<AuthGate />, { route: "/" });

    const heading = await screen.findByRole("heading", { name: "Overview" });
    expect(heading).toBeInTheDocument();
  });

  test("an unknown project path opens the overview", async () => {
    renderWithProviders(<AuthGate />, { route: "/p/test-project/nowhere" });

    expect(
      await screen.findByRole("heading", { name: "Overview" }),
    ).toBeInTheDocument();
  });

  test("/tasks shows tasks page", async () => {
    renderWithProviders(<AuthGate />, { route: "/tasks" });

    const heading = await screen.findByRole("heading", { name: /Tasks/i });
    expect(heading).toBeInTheDocument();

    expect(screen.getByRole("button", { name: /Type/ })).toBeInTheDocument();
  });

  test("/entities redirects to /tasks", async () => {
    renderWithProviders(<AuthGate />, { route: "/entities" });

    const heading = await screen.findByRole("heading", { name: /Tasks/i });
    expect(heading).toBeInTheDocument();
  });

  test("/journal shows journal page", async () => {
    renderWithProviders(<AuthGate />, { route: "/journal" });

    const heading = await screen.findByRole("heading", { name: /Journal/i });
    expect(heading).toBeInTheDocument();

    expect(
      screen.getByLabelText("Filter journal by resource"),
    ).toBeInTheDocument();
  });

  test("/presence shows presence page", async () => {
    renderWithProviders(<AuthGate />, { route: "/presence" });

    const heading = await screen.findByRole("heading", { name: /Presence/i });
    expect(heading).toBeInTheDocument();
  });

  test("/artifacts shows artifacts page", async () => {
    renderWithProviders(<AuthGate />, { route: "/artifacts" });

    const heading = await screen.findByRole("heading", { name: /Artifacts/i });
    expect(heading).toBeInTheDocument();

    expect(screen.getByLabelText("Search artifacts")).toBeInTheDocument();
  });

  test("/entities/:id opens that task, not the bare list", async () => {
    renderWithProviders(<AuthGate />, { route: "/entities/entity-1" });

    expect(
      await screen.findByRole("dialog", { name: /Test Task Detail/ }),
    ).toBeInTheDocument();
  });

  test("/p/:project/entities/:id opens that task", async () => {
    renderWithProviders(<AuthGate />, {
      route: "/p/test-project/entities/entity-1",
    });

    expect(
      await screen.findByRole("dialog", { name: /Test Task Detail/ }),
    ).toBeInTheDocument();
  });
});
