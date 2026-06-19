import { CommandPalette } from "@/components/ui/command-palette";
import { http, HttpResponse } from "msw";
import { server } from "./mocks/server";
import { renderWithProviders, screen, waitFor } from "./test-utils";

describe("CommandPalette", () => {
  test("uses useTaskIndex: requests compact=true and limit=200", async () => {
    const capturedRequests: URLSearchParams[] = [];

    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        capturedRequests.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          ok: true,
          entities: [{ id: "palette-task-1", type: "task" }],
        });
      }),
    );

    renderWithProviders(<CommandPalette open onClose={() => {}} />);

    // Wait for the index request to fire
    await waitFor(() => {
      expect(capturedRequests.length).toBeGreaterThan(0);
    });

    // Positive assertion: a request with compact=true and limit=200 must have fired
    const indexRequest = capturedRequests.find(
      (p) => p.get("compact") === "true" && p.get("limit") === "200",
    );
    expect(indexRequest).toBeDefined();

    // The compact entity's id should appear in the rendered palette list
    await waitFor(() => {
      expect(screen.getByText("palette-task-1")).toBeInTheDocument();
    });
  });
});
