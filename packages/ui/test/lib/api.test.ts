import {
  ApiError,
  getArtifactBlob,
  getArtifactHistory,
  getWorkCatalog,
  githubLoginConfig,
  githubUserLookup,
  listJournal,
  listTasks,
  mutate,
  replayJournal,
  revokeMembership,
  searchTasks,
  sessionStatus,
} from "@/lib/api";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";

describe("GitHub browser login capability", () => {
  test("requests fresh public configuration without exposing credentials", async () => {
    let request: Request | undefined;
    server.use(
      http.get("*/api/auth/github/login-config", ({ request: incoming }) => {
        request = incoming;
        return HttpResponse.json({ ok: true, enabled: true });
      }),
    );
    expect(await githubLoginConfig()).toEqual({ ok: true, enabled: true });
    expect(request?.cache).toBe("no-store");
    expect(request?.headers.get("Authorization")).toBeNull();
  });

  test.each([
    { ok: true },
    { ok: true, enabled: "true" },
    { ok: false, enabled: true },
  ])("rejects malformed configuration %j", async (body) => {
    server.use(
      http.get("*/api/auth/github/login-config", () => HttpResponse.json(body)),
    );
    await expect(githubLoginConfig()).rejects.toThrow();
  });
});

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

describe("task catalog and search requests", () => {
  test("listTasks forwards an opaque cursor unchanged", async () => {
    let params: URLSearchParams | null = null;
    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        params = new URL(request.url).searchParams;
        return HttpResponse.json({ ok: true, entities: [] });
      }),
    );
    await listTasks("test-project", { cursor: "a+b/=", sort: "id" });
    const sent = params as URLSearchParams | null;
    expect(sent?.get("cursor")).toBe("a+b/=");
    expect(sent?.get("sort")).toBe("id");
  });

  test("listTasks sends the state filter as one comma list and the state sort", async () => {
    let params: URLSearchParams | null = null;
    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        params = new URL(request.url).searchParams;
        return HttpResponse.json({ ok: true, entities: [] });
      }),
    );
    await listTasks("test-project", {
      state: ["in-review", "done"],
      sort: "state",
      order: "asc",
    });
    let sent = params as URLSearchParams | null;
    expect(sent?.get("state")).toBe("in-review,done");
    expect(sent?.get("sort")).toBe("state");
    await listTasks("test-project", { state: [] });
    sent = params as URLSearchParams | null;
    expect(sent?.has("state")).toBe(false);
  });

  test("getWorkCatalog reads the task type catalog", async () => {
    let path = "";
    server.use(
      http.get("*/projects/*/tasks/~/types", ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({
          ok: true,
          types: [],
          scope: { restricted: false },
        });
      }),
    );
    const response = await getWorkCatalog("test-project");
    expect(path).toBe("/projects/test-project/tasks/~/types");
    expect(response.types).toEqual([]);
  });

  test("searchTasks asks for literal task search", async () => {
    let params: URLSearchParams | null = null;
    server.use(
      http.get("*/projects/*/search", ({ request }) => {
        params = new URL(request.url).searchParams;
        return HttpResponse.json({ ok: true, results: [], total: 0 });
      }),
    );
    await searchTasks("test-project", {
      q: "fix (auth",
      type: ["task", "epic"],
      cursor: "c1",
      limit: 20,
    });
    const sent = params as URLSearchParams | null;
    expect(sent?.get("q")).toBe("fix (auth");
    expect(sent?.get("kind")).toBe("task");
    expect(sent?.get("syntax")).toBe("literal");
    expect(sent?.get("type")).toBe("task,epic");
    expect(sent?.get("cursor")).toBe("c1");
    expect(sent?.get("limit")).toBe("20");
  });
});

describe("journal requests", () => {
  test("sends several resources as repeated params", async () => {
    let params: URLSearchParams | null = null;
    server.use(
      http.get("*/projects/*/journal", ({ request }) => {
        params = new URL(request.url).searchParams;
        return HttpResponse.json({ ok: true, events: [] });
      }),
    );
    await listJournal("test-project", {
      resource: ["job-1", "job:job-1"],
      limit: 20,
    });
    const sent = params as URLSearchParams | null;
    expect(sent?.getAll("resource")).toEqual(["job-1", "job:job-1"]);
    expect(sent?.get("limit")).toBe("20");
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

describe("session migration status", () => {
  test.each([
    [401, "account-migration-required", { migrationRequired: true }],
    [401, "session-expired", null],
    [403, "membership-required", null],
    [503, "auth-unavailable", null],
    [503, "account-migration-required", null],
  ])("handles HTTP %s %s", async (status, code, expected) => {
    server.use(
      http.get("*/auth/session/status", () =>
        HttpResponse.json({ error: { code } }, { status: status as number }),
      ),
    );
    expect(await sessionStatus()).toEqual(expected);
  });
});

describe("replayJournal", () => {
  test("requests an explicit window and carries the participant header", async () => {
    let request: Request | undefined;
    server.use(
      http.get("*/projects/*/journal/replay", ({ request: incoming }) => {
        request = incoming;
        return HttpResponse.json({
          ok: true,
          events: [],
          next_after_seq: 150,
          through_seq: 150,
          has_more: false,
        });
      }),
    );

    const page = await replayJournal("p1", {
      after_seq: 0,
      through_seq: 150,
      limit: 150,
    });

    const url = new URL(request?.url ?? "");
    expect(url.pathname).toBe("/projects/p1/journal/replay");
    // after_seq 0 is a real bound (the first window), not an absent param.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      after_seq: "0",
      through_seq: "150",
      limit: "150",
    });
    expect(request?.headers.get("X-Tila-Participant-Id")).toBeTruthy();
    expect(page.has_more).toBe(false);
  });

  test("sends only the bounds it was given", async () => {
    let params: URLSearchParams | undefined;
    server.use(
      http.get("*/projects/*/journal/replay", ({ request }) => {
        params = new URL(request.url).searchParams;
        return HttpResponse.json({
          ok: true,
          events: [],
          next_after_seq: 7,
          through_seq: 7,
          has_more: false,
        });
      }),
    );
    await replayJournal("p1", { after_seq: 7 });
    expect(Object.fromEntries(params ?? [])).toEqual({ after_seq: "7" });
  });

  test.each([
    {
      status: 503,
      code: "journal-history-unavailable",
      message: "Unable to read complete journal archives",
    },
    {
      status: 400,
      code: "invalid-cursor",
      message: "Replay bounds must satisfy after_seq <= through_seq",
    },
    {
      status: 403,
      code: "permission-denied",
      message: "Credential does not permit this operation or resource",
    },
  ])(
    "surfaces $code ($status) as an ApiError with the server's code",
    async (failure) => {
      server.use(
        http.get("*/projects/*/journal/replay", () =>
          HttpResponse.json(
            {
              ok: false,
              error: {
                code: failure.code,
                message: failure.message,
                retryable: failure.status === 503,
              },
            },
            { status: failure.status },
          ),
        ),
      );
      const error = await replayJournal("p1", { after_seq: 0 }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        code: failure.code,
        status: failure.status,
        message: failure.message,
      });
    },
  );
});
