import {
  useRecentTasks,
  useTaskPage,
  useTaskSearch,
  useTasks,
} from "@/hooks/use-api";
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

describe("useTaskPage", () => {
  test("sends type, archived=0, server sort and the cursor", async () => {
    const captured: URLSearchParams[] = [];
    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        captured.push(new URL(request.url).searchParams);
        return HttpResponse.json({ ok: true, entities: [] });
      }),
    );
    function ProbeComponent() {
      const { data } = useTaskPage({
        type: ["task", "epic"],
        archived: false,
        sort: "id",
        order: "asc",
        limit: 100,
        cursor: "abc",
      });
      return <div>{data ? "loaded" : "loading"}</div>;
    }

    renderWithProviders(<ProbeComponent />);

    await screen.findByText("loaded");
    const params = captured[0];
    expect(params.get("type")).toBe("task,epic");
    expect(params.get("archived")).toBe("0");
    expect(params.get("sort")).toBe("id");
    expect(params.get("order")).toBe("asc");
    expect(params.get("cursor")).toBe("abc");
    expect(params.has("compact")).toBe(false);
  });
});

describe("useTaskSearch", () => {
  test("is not sent below the minimum length", async () => {
    let requests = 0;
    server.use(
      http.get("*/projects/*/search", () => {
        requests++;
        return HttpResponse.json({ ok: true, results: [], total: 0 });
      }),
    );
    function ProbeComponent() {
      const { fetchStatus } = useTaskSearch({ q: " a " });
      return <div>{fetchStatus}</div>;
    }

    renderWithProviders(<ProbeComponent />);

    expect(await screen.findByText("idle")).toBeInTheDocument();
    expect(requests).toBe(0);
  });
});

describe("useRecentTasks", () => {
  test("requests the ten most recently updated non-archived tasks", async () => {
    let params: URLSearchParams | null = null;
    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        params = new URL(request.url).searchParams;
        return HttpResponse.json({ ok: true, entities: [] });
      }),
    );
    function ProbeComponent() {
      const { data } = useRecentTasks();
      return <div>{data ? "loaded" : "loading"}</div>;
    }

    renderWithProviders(<ProbeComponent />);

    await screen.findByText("loaded");
    const sent = params as URLSearchParams | null;
    expect(sent?.get("limit")).toBe("10");
    expect(sent?.get("sort")).toBe("updated_at");
    expect(sent?.get("order")).toBe("desc");
    expect(sent?.get("archived")).toBe("0");
    expect(sent?.has("compact")).toBe(false);
  });
});
