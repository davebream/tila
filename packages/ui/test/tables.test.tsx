import { TasksPage } from "@/pages/tasks";
import { http, HttpResponse } from "msw";
import { server } from "./mocks/server";
import { renderWithProviders, screen, waitFor } from "./test-utils";

const THREE_ENTITIES = [
  {
    id: "entity-1",
    type: "task",
    schema_version: 1,
    data: {},
    archived: 0,
    created_at: Date.now() - 30000,
    updated_at: Date.now() - 10000,
    created_by: "user-a",
    tags: [],
  },
  {
    id: "entity-2",
    type: "milestone",
    schema_version: 1,
    data: {},
    archived: 0,
    created_at: Date.now() - 20000,
    updated_at: Date.now() - 8000,
    created_by: "user-b",
    tags: [],
  },
  {
    id: "entity-3",
    type: "epic",
    schema_version: 1,
    data: {},
    archived: 0,
    created_at: Date.now() - 10000,
    updated_at: Date.now() - 5000,
    created_by: "user-c",
    tags: [],
  },
];

describe("Tasks table ARIA attributes", () => {
  beforeEach(() => {
    server.use(
      http.get("*/projects/*/tasks", () => {
        return HttpResponse.json({ ok: true, entities: THREE_ENTITIES });
      }),
    );
  });

  test("data table has aria-rowcount equal to the number of entities", async () => {
    renderWithProviders(<TasksPage />);

    await waitFor(() => {
      expect(screen.getByText("entity-1")).toBeInTheDocument();
    });

    const table = screen.getByRole("table", { name: "Tasks" });
    expect(table.getAttribute("aria-rowcount")).toBe("3");
  });

  test("each data row has aria-rowindex starting from 1", async () => {
    renderWithProviders(<TasksPage />);

    await waitFor(() => {
      expect(screen.getByText("entity-1")).toBeInTheDocument();
    });

    // getAllByRole("row") includes the header row; filter to data rows by aria-rowindex
    const allRows = screen.getAllByRole("row");
    const dataRows = allRows.filter(
      (r) => r.getAttribute("aria-rowindex") !== null,
    );
    expect(dataRows).toHaveLength(3);
    expect(dataRows[0].getAttribute("aria-rowindex")).toBe("1");
    expect(dataRows[1].getAttribute("aria-rowindex")).toBe("2");
    expect(dataRows[2].getAttribute("aria-rowindex")).toBe("3");
  });
});
