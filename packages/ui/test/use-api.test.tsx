import { useTaskIndex, useTasks } from "@/hooks/use-api";
import { http, HttpResponse } from "msw";
import { server } from "./mocks/server";
import { renderWithProviders, screen, waitFor } from "./test-utils";

describe("useTasks params forwarding", () => {
  let capturedParams: URLSearchParams | null = null;

  beforeEach(() => {
    capturedParams = null;
    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        capturedParams = new URL(request.url).searchParams;
        return HttpResponse.json({ ok: true, entities: [] });
      }),
    );
  });

  test("forwards compact, sort, order, limit params to listTasks", async () => {
    function ProbeComponent() {
      const { data } = useTasks({
        compact: true,
        sort: "updated_at",
        order: "desc",
        limit: 100,
      });
      return <div>{data ? "loaded" : "loading"}</div>;
    }

    renderWithProviders(<ProbeComponent />);

    await waitFor(() => {
      expect(capturedParams?.get("compact")).toBe("true");
    });
    expect(capturedParams?.get("sort")).toBe("updated_at");
    expect(capturedParams?.get("order")).toBe("desc");
    expect(capturedParams?.get("limit")).toBe("100");
  });
});

describe("useTaskIndex", () => {
  let capturedParams: URLSearchParams | null = null;

  beforeEach(() => {
    capturedParams = null;
    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        capturedParams = new URL(request.url).searchParams;
        return HttpResponse.json({
          ok: true,
          entities: [{ id: "task-index-1", type: "task" }],
        });
      }),
    );
  });

  test("requests compact=true&limit=200&sort=updated_at&order=desc", async () => {
    function ProbeComponent() {
      const { data } = useTaskIndex();
      return <div>{data ? "loaded" : "loading"}</div>;
    }

    renderWithProviders(<ProbeComponent />);

    await waitFor(() => {
      expect(capturedParams?.get("compact")).toBe("true");
    });
    expect(capturedParams?.get("limit")).toBe("200");
    expect(capturedParams?.get("sort")).toBe("updated_at");
    expect(capturedParams?.get("order")).toBe("desc");
  });
});
