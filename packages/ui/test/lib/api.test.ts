import {
  ApiError,
  getArtifactBlob,
  getArtifactHistory,
  listTasks,
} from "@/lib/api";
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

describe("artifact history requests", () => {
  test("encodes keys and pagination without altering their values", async () => {
    const key = "versioned/project/report/2/a #?%.txt";
    const cursor = "next+/==";
    const response = {
      ok: true,
      items: [],
      meta: { total: 0, limit: 20, next_cursor: null },
    };
    let captured: Request | undefined;
    server.use(
      http.get("*/projects/test-project/artifacts/*", ({ request }) => {
        captured = request;
        return HttpResponse.json(response);
      }),
    );
    expect(
      await getArtifactHistory("test-project", key, { limit: 20, cursor }),
    ).toEqual(response);
    const url = new URL(captured?.url ?? "");
    expect(url.pathname).toBe(
      `/projects/test-project/artifacts/~/history/${encodeURIComponent(key)}`,
    );
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("cursor")).toBe(cursor);
    expect(captured?.credentials).toBe("include");
    await getArtifactHistory("test-project", key);
    expect(new URL(captured?.url ?? "").search).toBe("");
    await getArtifactBlob("test-project", key);
    expect(new URL(captured?.url ?? "").pathname).toBe(
      "/projects/test-project/artifacts/versioned/project/report/2/a%20%23%3F%25.txt",
    );
  });

  test("preserves API and network errors for retry UI", async () => {
    server.use(
      http.get("*/projects/*/artifacts/*", () =>
        HttpResponse.json(
          {
            error: {
              code: "invalid-cursor",
              message: "Invalid history cursor",
            },
          },
          { status: 400 },
        ),
      ),
    );
    await expect(getArtifactHistory("p", "key")).rejects.toMatchObject({
      code: "invalid-cursor",
      message: "Invalid history cursor",
    });
    server.use(
      http.get("*/projects/*/artifacts/*", () => HttpResponse.error()),
    );
    await expect(getArtifactHistory("p", "key")).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(getArtifactHistory("p", "key")).rejects.toMatchObject({
      code: "network-error",
    });
  });
});
