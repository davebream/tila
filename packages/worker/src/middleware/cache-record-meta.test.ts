/**
 * The metadata-only record read (`GET …/records/:type/:key?meta=1`) is never
 * served from or written to the Cache API and is always sent
 * `Cache-Control: private, no-store`.
 *
 * Two topologies are exercised. Mounted under `/projects/:projectId` (the
 * Worker's real mount) the path starts with `projects`, which the tier map
 * does not know, so the cache layer is a pass-through today. Mounted at the
 * root, `/records` is a low-tier route with a 5 s Cache API entry and a 3 s
 * browser max-age, which is what any future classification of project routes
 * would give it; the guard must hold there too, and must not touch anything
 * that is not exactly the metadata read.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCacheMiddleware } from "./cache";

type Vars = { projectId: string; credentialPolicy?: unknown };

function stubCaches() {
  const cache = {
    match: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
  };
  vi.stubGlobal("caches", { default: cache });
  return cache;
}

function routes(policy?: unknown) {
  const sub = new Hono<{ Variables: Vars }>();
  sub.use("/*", async (c, next) => {
    c.set("projectId", "proj1");
    if (policy) c.set("credentialPolicy", policy);
    await next();
  });
  sub.use("/*", createCacheMiddleware());
  sub.get("/records/:type/:key{.+}", (c) => c.json({ ok: true }));
  sub.get("/records/:type/~/history/:key{.+}", (c) => c.json({ ok: true }));
  sub.get("/records/_types", (c) => c.json({ ok: true }));
  sub.get("/tasks/:id", (c) => c.json({ ok: true }));
  return sub;
}

/** The sub-router under the Worker's real `/projects/:projectId` mount. */
function mounted(policy?: unknown) {
  const app = new Hono();
  app.route("/projects/:projectId", routes(policy));
  return app;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("record metadata read cache guard", () => {
  it("sends private, no-store and leaves the Cache API alone under the project mount", async () => {
    const cache = stubCaches();

    const res = await mounted().request(
      "/projects/p1/records/config/a/b?meta=1",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("holds where /records is a low-tier route: no match, no put, no max-age", async () => {
    const cache = stubCaches();
    const app = routes();

    const res = await app.request("/records/config/a/b?meta=1");

    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("is not answered from a cached copy even when one exists", async () => {
    const cache = stubCaches();
    cache.match.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, meta: { revision: 1 } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = routes();

    const res = await app.request("/records/config/k?meta=1");

    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(cache.match).not.toHaveBeenCalled();
  });

  it("gives credential-restricted callers the same header", async () => {
    stubCaches();
    const app = routes({ role: "participant", capabilities: ["records:read"] });

    const res = await app.request("/records/config/k?meta=1");

    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("applies to HEAD as well as GET", async () => {
    const cache = stubCaches();

    const res = await routes().request("/records/config/k?meta=1", {
      method: "HEAD",
    });

    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(cache.match).not.toHaveBeenCalled();
  });

  it("still applies when other parameters accompany meta=1", async () => {
    const cache = stubCaches();

    const res = await routes().request("/records/config/k?x=1&meta=1");

    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(cache.put).not.toHaveBeenCalled();
  });
});

describe("record metadata guard stays exact", () => {
  it("leaves the ordinary record read on its tier, cached and with max-age", async () => {
    const cache = stubCaches();

    const res = await routes().request("/records/config/k");

    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=3, stale-while-revalidate=5",
    );
    expect(cache.match).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it.each([
    "meta=true",
    "meta=0",
    "meta=",
    "meta=01",
    "meta=1&meta=1",
    "meta=1&meta=0",
    "xmeta=1",
    "meta2=1",
  ])("does not treat ?%s as a metadata read", async (query) => {
    const cache = stubCaches();

    const res = await routes().request(`/records/config/k?${query}`);

    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=3, stale-while-revalidate=5",
    );
    expect(cache.match).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["history", "/records/config/~/history/k?meta=1"],
    ["type catalog", "/records/_types?meta=1"],
    ["another resource", "/tasks/t-1?meta=1"],
  ])("does not touch the %s route", async (_label, path) => {
    const cache = stubCaches();

    const res = await routes().request(path);

    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=3, stale-while-revalidate=5",
    );
    expect(cache.match).toHaveBeenCalledTimes(1);
  });

  it("does not touch a non-GET request that names meta=1", async () => {
    const cache = stubCaches();
    const app = new Hono<{ Variables: Vars }>();
    app.use("/*", async (c, next) => {
      c.set("projectId", "proj1");
      await next();
    });
    app.use("/*", createCacheMiddleware());
    app.post("/records/config/k", (c) => c.json({ ok: true }));

    const res = await app.request("/records/config/k?meta=1", {
      method: "POST",
    });

    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(cache.match).not.toHaveBeenCalled();
    // A successful write still invalidates the records list entry.
    expect(cache.delete).toHaveBeenCalledTimes(1);
  });
});
