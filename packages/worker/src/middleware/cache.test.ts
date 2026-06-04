import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCacheKey,
  classifyRoute,
  createCacheMiddleware,
  invalidateProjectCache,
} from "./cache";

// ---------------------------------------------------------------------------
// Task 1: classifyRoute and buildCacheKey
// ---------------------------------------------------------------------------

describe("classifyRoute", () => {
  it.each([
    // low tier
    ["/tasks", "low"],
    ["/tasks/abc-123", "low"],
    ["/entities", "low"],
    ["/work-units", "low"],
    ["/records", "low"],
    ["/schema", "low"],
    ["/templates", "low"],
    ["/summary", "low"],
    ["/artifacts", "low"],
    ["/search", "low"],
    ["/gates", "low"],
    // medium tier
    ["/claims", "medium"],
    ["/journal", "medium"],
    ["/signals", "medium"],
    // high tier
    ["/presence", "high"],
    // skip tier
    ["/admin", "skip"],
    ["/doctor", "skip"],
    ["/doctor/health", "skip"],
    ["/unknown-segment", "skip"],
    ["/", "skip"],
    ["", "skip"],
  ])("classifyRoute(%s) === %s", (path, expected) => {
    expect(classifyRoute(path)).toBe(expected);
  });
});

describe("buildCacheKey", () => {
  it("produces a synthetic URL with projectId and path", () => {
    const req = buildCacheKey("proj1", "/tasks", "");
    expect(req.url).toMatch(/^https:\/\/cache\.tila\/proj1\/tasks/);
  });

  it("sorts query parameters alphabetically", () => {
    const req = buildCacheKey("proj1", "/tasks", "z=last&a=first&m=middle");
    const url = new URL(req.url);
    const params = [...url.searchParams.keys()];
    expect(params).toEqual(["a", "m", "z"]);
  });

  it("produces the same key regardless of query param order", () => {
    const req1 = buildCacheKey("proj1", "/tasks", "b=2&a=1");
    const req2 = buildCacheKey("proj1", "/tasks", "a=1&b=2");
    expect(req1.url).toBe(req2.url);
  });

  it("omits query string when empty", () => {
    const req = buildCacheKey("proj1", "/tasks", "");
    expect(req.url).not.toContain("?");
  });

  it("returns a Request object", () => {
    const req = buildCacheKey("proj1", "/tasks", "");
    expect(req).toBeInstanceOf(Request);
  });
});

// ---------------------------------------------------------------------------
// Task 2: createCacheMiddleware
// ---------------------------------------------------------------------------

import { Hono } from "hono";

type MockCache = {
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function makeMockCaches(overrides: Partial<MockCache> = {}): {
  default: MockCache;
} {
  return {
    default: {
      match: vi.fn().mockResolvedValue(undefined), // cache miss by default
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
      ...overrides,
    },
  };
}

function makeApp(mockCaches?: { default: MockCache }) {
  if (mockCaches) {
    vi.stubGlobal("caches", mockCaches);
  }
  const app = new Hono<{
    Variables: { projectId: string; doStub: unknown };
  }>();
  // inject projectId into context
  app.use("/*", async (c, next) => {
    c.set("projectId", "proj1");
    await next();
  });
  app.use("/*", createCacheMiddleware());
  return app;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCacheMiddleware - Cache API unavailable (wrangler dev)", () => {
  it("passes through when caches is undefined", async () => {
    // do NOT stub caches — it should be undefined in node env
    const app = new Hono<{ Variables: { projectId: string } }>();
    app.use("/*", async (c, next) => {
      c.set("projectId", "proj1");
      await next();
    });
    app.use("/*", createCacheMiddleware());
    app.get("/tasks", (c) => c.json({ ok: true }));

    const res = await app.request("/tasks");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("still adds Cache-Control header for low tier when caches is unavailable", async () => {
    const app = new Hono<{ Variables: { projectId: string } }>();
    app.use("/*", async (c, next) => {
      c.set("projectId", "proj1");
      await next();
    });
    app.use("/*", createCacheMiddleware());
    app.get("/tasks", (c) => c.json({ ok: true }));

    const res = await app.request("/tasks");
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("Cache-Control")).toContain("max-age=3");
    expect(res.headers.get("Cache-Control")).toContain(
      "stale-while-revalidate=5",
    );
  });
});

describe("createCacheMiddleware - Cache-Control headers per tier", () => {
  it("sets low tier Cache-Control for /tasks", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.get("/tasks", (c) => c.json({ ok: true }));

    const res = await app.request("/tasks");
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=3, stale-while-revalidate=5",
    );
  });

  it("sets medium tier Cache-Control for /claims", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.get("/claims", (c) => c.json({ ok: true }));

    const res = await app.request("/claims");
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=1, stale-while-revalidate=2",
    );
  });

  it("sets high tier Cache-Control for /presence", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.get("/presence", (c) => c.json({ ok: true }));

    const res = await app.request("/presence");
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=1, stale-while-revalidate=1",
    );
  });

  it("does not set Cache-Control for skip tier /admin", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.get("/admin", (c) => c.json({ ok: true }));

    const res = await app.request("/admin");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});

describe("createCacheMiddleware - GET cache miss", () => {
  it("calls match with correct cache key and calls put on miss", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.get("/tasks", (c) => c.json({ tasks: [] }));

    const res = await app.request("/tasks");
    expect(res.status).toBe(200);

    // match should have been called
    expect(mockCaches.default.match).toHaveBeenCalledOnce();
    const matchArg = mockCaches.default.match.mock.calls[0][0] as Request;
    expect(matchArg.url).toContain("cache.tila");
    expect(matchArg.url).toContain("proj1");
    expect(matchArg.url).toContain("/tasks");

    // put should have been called (via waitUntil — synchronous in test env)
    expect(mockCaches.default.put).toHaveBeenCalledOnce();
  });

  it("does not call cache for non-GET requests", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.post("/tasks", (c) => c.json({ ok: true }));

    await app.request("/tasks", { method: "POST" });
    expect(mockCaches.default.match).not.toHaveBeenCalled();
    expect(mockCaches.default.put).not.toHaveBeenCalled();
  });

  it("does not cache skip-tier routes", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.get("/admin", (c) => c.json({ ok: true }));

    await app.request("/admin");
    expect(mockCaches.default.match).not.toHaveBeenCalled();
    expect(mockCaches.default.put).not.toHaveBeenCalled();
  });
});

describe("createCacheMiddleware - GET cache hit", () => {
  it("returns cached response directly on cache hit", async () => {
    const cachedResponse = new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const mockCaches = makeMockCaches({
      match: vi.fn().mockResolvedValue(cachedResponse),
    });
    const app = makeApp(mockCaches);
    // handler should NOT be reached
    app.get("/tasks", (c) => c.json({ fresh: true }));

    const res = await app.request("/tasks");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cached: true });
    // put should NOT be called on hit
    expect(mockCaches.default.put).not.toHaveBeenCalled();
  });
});

describe("createCacheMiddleware - Cache API errors", () => {
  it("falls through to handler when match throws", async () => {
    const mockCaches = makeMockCaches({
      match: vi.fn().mockRejectedValue(new Error("Cache API error")),
    });
    const app = makeApp(mockCaches);
    app.get("/tasks", (c) => c.json({ fallback: true }));

    const res = await app.request("/tasks");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fallback: true });
  });
});

// ---------------------------------------------------------------------------
// Task 3: invalidateProjectCache
// ---------------------------------------------------------------------------

describe("invalidateProjectCache", () => {
  it("deletes /tasks, /summary, /search keys for tasks writes", async () => {
    const mockCache = {
      match: vi.fn(),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue(true),
    };
    vi.stubGlobal("caches", { default: mockCache });

    await invalidateProjectCache(
      mockCache as unknown as Cache,
      "proj1",
      "tasks",
    );

    const deletedUrls = (mockCache.delete.mock.calls as [Request][]).map(
      (call) => call[0].url,
    );
    expect(deletedUrls.some((u: string) => u.includes("/tasks"))).toBe(true);
    expect(deletedUrls.some((u: string) => u.includes("/summary"))).toBe(true);
    expect(deletedUrls.some((u: string) => u.includes("/search"))).toBe(true);
  });

  it("deletes /artifacts and /search keys for artifacts writes", async () => {
    const mockCache = {
      match: vi.fn(),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue(true),
    };

    await invalidateProjectCache(
      mockCache as unknown as Cache,
      "proj1",
      "artifacts",
    );

    const deletedUrls = (mockCache.delete.mock.calls as [Request][]).map(
      (call) => call[0].url,
    );
    expect(deletedUrls.some((u: string) => u.includes("/artifacts"))).toBe(
      true,
    );
    expect(deletedUrls.some((u: string) => u.includes("/search"))).toBe(true);
  });

  it("deletes only /claims for claims writes", async () => {
    const mockCache = {
      match: vi.fn(),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue(true),
    };

    await invalidateProjectCache(
      mockCache as unknown as Cache,
      "proj1",
      "claims",
    );

    const deletedUrls = (mockCache.delete.mock.calls as [Request][]).map(
      (call) => call[0].url,
    );
    expect(deletedUrls.some((u: string) => u.includes("/claims"))).toBe(true);
    // should not delete unrelated segments
    expect(deletedUrls.some((u: string) => u.includes("/tasks"))).toBe(false);
  });

  it("logs but does not propagate delete errors", async () => {
    const mockCache = {
      match: vi.fn(),
      put: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error("delete failed")),
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      invalidateProjectCache(mockCache as unknown as Cache, "proj1", "tasks"),
    ).resolves.toBeUndefined();

    warnSpy.mockRestore();
  });
});

describe("createCacheMiddleware - write invalidation", () => {
  it("triggers invalidation after successful POST", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.post("/tasks", (c) => c.json({ ok: true }, 201));

    await app.request("/tasks", { method: "POST" });

    // delete should have been called for the invalidation
    expect(mockCaches.default.delete).toHaveBeenCalled();
    const deletedUrls = (
      mockCaches.default.delete.mock.calls as [Request][]
    ).map((call) => call[0].url);
    expect(deletedUrls.some((u: string) => u.includes("/tasks"))).toBe(true);
  });

  it("does not trigger invalidation after failed POST", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.post("/tasks", (c) => c.json({ error: "bad" }, 422));

    await app.request("/tasks", { method: "POST" });
    expect(mockCaches.default.delete).not.toHaveBeenCalled();
  });

  it("triggers invalidation after successful PATCH", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.patch("/tasks/abc", (c) => c.json({ ok: true }));

    await app.request("/tasks/abc", { method: "PATCH" });
    expect(mockCaches.default.delete).toHaveBeenCalled();
  });

  it("triggers invalidation after successful DELETE", async () => {
    const mockCaches = makeMockCaches();
    const app = makeApp(mockCaches);
    app.delete("/tasks/abc", (c) => c.json({ ok: true }));

    await app.request("/tasks/abc", { method: "DELETE" });
    expect(mockCaches.default.delete).toHaveBeenCalled();
  });
});
