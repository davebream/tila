import { TasksPage } from "@/pages/tasks";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";

describe("TasksPage", () => {
  test("renders table rows from API data", async () => {
    renderWithProviders(<TasksPage />);

    await waitFor(() => {
      expect(screen.getByText("entity-1")).toBeInTheDocument();
    });

    expect(screen.getByText("entity-2")).toBeInTheDocument();
    expect(screen.getByText("entity-3")).toBeInTheDocument();

    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeGreaterThan(3);

    expect(screen.getByText("another-user")).toBeInTheDocument();
  });

  test("shows empty state when no tasks exist", async () => {
    server.use(
      http.get("*/projects/*/tasks", () => {
        return HttpResponse.json({
          ok: true,
          entities: [],
        });
      }),
    );

    renderWithProviders(<TasksPage />);

    await waitFor(() => {
      expect(screen.getByText(/No tasks in this project/)).toBeInTheDocument();
    });
  });

  test("renders type filter button", async () => {
    renderWithProviders(<TasksPage />);

    await waitFor(() => {
      expect(screen.getByText("entity-1")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /Type/ })).toBeInTheDocument();
  });

  test("type filter button is enabled when tasks have types", async () => {
    renderWithProviders(<TasksPage />);

    await waitFor(() => {
      expect(screen.getByText("entity-1")).toBeInTheDocument();
    });

    const typeButton = screen.getByRole("button", { name: /Type/ });
    expect(typeButton).not.toBeDisabled();
  });

  test("filters rows by the ID filter input", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />);

    await waitFor(() => {
      expect(screen.getByText("entity-1")).toBeInTheDocument();
    });
    expect(screen.getByText("entity-2")).toBeInTheDocument();

    const idFilter = screen.getByLabelText("Filter tasks by ID");
    await user.type(idFilter, "entity-1");

    // Debounced client-side filter: only the matching row remains.
    await waitFor(() => {
      expect(screen.queryByText("entity-2")).not.toBeInTheDocument();
    });
    expect(screen.getByText("entity-1")).toBeInTheDocument();
  });

  test("shows showing-first hint when has_more is true", async () => {
    server.use(
      http.get("*/projects/*/tasks", () => {
        return HttpResponse.json({
          ok: true,
          entities: [
            {
              id: "entity-1",
              type: "task",
              schema_version: 1,
              data: { title: "Test Task 1" },
              archived: 0,
              created_at: Date.now() - 10000,
              updated_at: Date.now() - 5000,
              created_by: "another-user",
              tags: [],
            },
          ],
          total: 250,
          limit: 100,
          offset: 0,
          has_more: true,
        });
      }),
    );

    renderWithProviders(<TasksPage />);

    await waitFor(() => {
      expect(screen.getByText("entity-1")).toBeInTheDocument();
    });

    // Hint text should appear
    expect(screen.getByText(/showing first/i)).toBeInTheDocument();
    // Full entity shape is preserved — created_by is visible
    expect(screen.getByText("another-user")).toBeInTheDocument();
  });

  test("does not show hint when has_more is false", async () => {
    server.use(
      http.get("*/projects/*/tasks", () => {
        return HttpResponse.json({
          ok: true,
          entities: [
            {
              id: "entity-1",
              type: "task",
              schema_version: 1,
              data: {},
              archived: 0,
              created_at: Date.now() - 10000,
              updated_at: Date.now() - 5000,
              created_by: "test-user",
              tags: [],
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
          has_more: false,
        });
      }),
    );

    renderWithProviders(<TasksPage />);

    await waitFor(() => {
      expect(screen.getByText("entity-1")).toBeInTheDocument();
    });

    expect(screen.queryByText(/showing first/i)).not.toBeInTheDocument();
  });
});
