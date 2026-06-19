import { listTasks } from "@/lib/api";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";

describe("listTasks URL params", () => {
  let capturedParams: URLSearchParams | null = null;

  beforeEach(() => {
    capturedParams = null;
    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        capturedParams = new URL(request.url).searchParams;
        return HttpResponse.json({
          ok: true,
          entities: [],
        });
      }),
    );
  });

  test("serializes compact, sort, order, and limit into query string", async () => {
    await listTasks("test-project", {
      compact: true,
      sort: "updated_at",
      order: "desc",
      limit: 100,
    });

    expect(capturedParams?.get("compact")).toBe("true");
    expect(capturedParams?.get("sort")).toBe("updated_at");
    expect(capturedParams?.get("order")).toBe("desc");
    expect(capturedParams?.get("limit")).toBe("100");
  });

  test("serializes offset when provided", async () => {
    await listTasks("test-project", { offset: 50 });
    expect(capturedParams?.get("offset")).toBe("50");
  });

  test("does not include compact param when not provided", async () => {
    await listTasks("test-project", { sort: "updated_at" });
    expect(capturedParams?.get("compact")).toBeNull();
  });

  test("does not include limit or offset when undefined", async () => {
    await listTasks("test-project", {});
    expect(capturedParams?.get("limit")).toBeNull();
    expect(capturedParams?.get("offset")).toBeNull();
  });
});
