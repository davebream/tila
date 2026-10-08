import {
  ApiError,
  getArtifactBlob,
  getArtifactHistory,
  githubUserLookup,
  listTasks,
  mutate,
  revokeMembership,
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

describe("mutate", () => {
  test("sends JSON with credentials and only a Content-Type header", async () => {
    const seen: { request?: Request } = {};
    server.use(
      http.post("*/projects/test-project/memberships", ({ request }) => {
        seen.request = request;
        return HttpResponse.json({ ok: true }, { status: 201 });
      }),
    );
    await mutate("POST", "/projects/test-project/memberships", {
      role: "viewer",
    });
    expect(seen.request?.headers.get("Content-Type")).toBe("application/json");
    expect(seen.request?.headers.get("X-Tila-Participant-Id")).toMatch(
      /^dashboard-/,
    );
    expect(seen.request?.headers.get("X-Tila-Client-Name")).toBe("dashboard");
    expect(seen.request?.headers.get("Idempotency-Key")).toBeNull();
    expect(await seen.request?.json()).toEqual({ role: "viewer" });
  });

  test("does not attach participant headers to non-project paths", async () => {
    const seen: { request?: Request } = {};
    server.use(
      http.delete("*/api/tokens/old", ({ request }) => {
        seen.request = request;
        return HttpResponse.json({ ok: true, name: "old", revoked_at: 1 });
      }),
    );
    await mutate("DELETE", "/api/tokens/old");
    expect(seen.request?.headers.get("X-Tila-Participant-Id")).toBeNull();
    expect(seen.request?.headers.get("Content-Type")).toBeNull();
  });

  test("maps the error envelope including details", async () => {
    server.use(
      http.delete("*/projects/test-project/memberships/m-1", () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "step-up-required",
              message: "Re-authenticate to continue",
              retryable: false,
              details: { max_age_seconds: 600, authenticated_at: 1 },
            },
          },
          { status: 403 },
        ),
      ),
    );
    const err = await revokeMembership("test-project", "m-1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("step-up-required");
    expect(err.details).toEqual({ max_age_seconds: 600, authenticated_at: 1 });
  });
});

describe("githubUserLookup", () => {
  test("returns the numeric id for a login", async () => {
    server.use(
      http.get("https://api.github.com/users/:login", ({ params }) =>
        HttpResponse.json({ id: 583231, login: params.login }),
      ),
    );
    await expect(githubUserLookup("octocat")).resolves.toEqual({
      id: 583231,
      login: "octocat",
    });
  });

  test("distinguishes unknown users from rate limiting", async () => {
    server.use(
      http.get("https://api.github.com/users/nobody", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
      http.get("https://api.github.com/users/limited", () =>
        HttpResponse.json({ message: "rate limit" }, { status: 403 }),
      ),
    );
    await expect(githubUserLookup("nobody")).rejects.toMatchObject({
      code: "github-user-not-found",
    });
    await expect(githubUserLookup("limited")).rejects.toMatchObject({
      code: "github-rate-limited",
    });
  });
});
