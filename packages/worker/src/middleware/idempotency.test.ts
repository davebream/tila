import type { IdempotencyStoreLike } from "@tila/backend-d1";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createIdempotencyMiddleware } from "./idempotency";

// ---------------------------------------------------------------------------
// In-memory fake store implementing IdempotencyStoreLike
// ---------------------------------------------------------------------------

type StoredEntry = {
  statusCode: number;
  body: string;
  requestHash: string | null;
};

class FakeIdempotencyStore implements IdempotencyStoreLike {
  private map = new Map<string, StoredEntry>();

  async check(
    key: string,
    _projectId: string,
  ): Promise<{
    statusCode: number;
    body: string;
    requestHash: string | null;
  } | null> {
    return this.map.get(key) ?? null;
  }

  async store(
    key: string,
    _projectId: string,
    statusCode: number,
    responseJson: string,
    requestHash?: string | null,
  ): Promise<void> {
    // first-write-wins (mimic onConflictDoNothing)
    if (!this.map.has(key)) {
      this.map.set(key, {
        statusCode,
        body: responseJson,
        requestHash: requestHash ?? null,
      });
    }
  }

  async reserve(
    key: string,
    _projectId: string,
    _nowMs: number,
    _staleMs: number,
  ): Promise<
    | { state: "acquired" }
    | { state: "in-flight" }
    | { state: "finalized"; statusCode: number; body: string }
  > {
    const existing = this.map.get(key);
    if (!existing) {
      this.map.set(key, { statusCode: 0, body: "", requestHash: null });
      return { state: "acquired" };
    }
    if (existing.statusCode === 0) return { state: "in-flight" };
    return {
      state: "finalized",
      statusCode: existing.statusCode,
      body: existing.body,
    };
  }

  async finalize(
    key: string,
    _projectId: string,
    statusCode: number,
    responseJson: string,
  ): Promise<boolean> {
    const existing = this.map.get(key);
    if (!existing || existing.statusCode !== 0) return false;
    this.map.set(key, { statusCode, body: responseJson, requestHash: null });
    return true;
  }

  async release(key: string): Promise<void> {
    const existing = this.map.get(key);
    if (existing && existing.statusCode === 0) this.map.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeApp(
  fake: IdempotencyStoreLike,
  opts: { handlerStatus?: number } = {},
) {
  let handlerCount = 0;

  const app = new Hono<{ Variables: { projectId: string } }>();

  // stub middleware: sets projectId (mimics projectMiddleware)
  app.use("/*", async (c, next) => {
    c.set("projectId", "p1");
    await next();
  });

  // the middleware under test
  app.use("/*", createIdempotencyMiddleware({ makeStore: () => fake }));

  // handler: reads the body (proves stream was not consumed), returns a response
  app.post("/", async (c) => {
    handlerCount++;
    await c.req.json(); // must NOT throw
    const status = opts.handlerStatus ?? 200;
    return c.json({ ok: true, id: "x" }, status as 200);
  });

  return { app, getHandlerCount: () => handlerCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createIdempotencyMiddleware", () => {
  it("pass-through when no Idempotency-Key header", async () => {
    const fake = new FakeIdempotencyStore();
    const { app, getHandlerCount } = makeApp(fake);

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });

    expect(getHandlerCount()).toBe(2);
  });

  it("same key + same body: second call replays stored response", async () => {
    const fake = new FakeIdempotencyStore();
    const { app, getHandlerCount } = makeApp(fake);

    const body = JSON.stringify({ a: 1 });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "key-abc",
    };

    const res1 = await app.request("/", { method: "POST", headers, body });
    const body1 = await res1.text();

    const res2 = await app.request("/", { method: "POST", headers, body });
    const body2 = await res2.text();

    expect(res2.status).toBe(200);
    expect(body2).toBe(body1);
    expect(res2.headers.get("Idempotency-Replayed")).toBe("true");
    // handler was only invoked on the first call
    expect(getHandlerCount()).toBe(1);
  });

  it("same key + different body: returns 422 idempotency-key-conflict", async () => {
    const fake = new FakeIdempotencyStore();
    const { app, getHandlerCount } = makeApp(fake);

    await app.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "key-conflict",
      },
      body: JSON.stringify({ a: 1 }),
    });

    const countAfterFirst = getHandlerCount();

    const res2 = await app.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "key-conflict",
      },
      body: JSON.stringify({ a: 2 }),
    });

    expect(res2.status).toBe(422);
    const json = (await res2.json()) as {
      ok: boolean;
      error: { code: string; retryable: boolean };
    };
    expect(json.error.code).toBe("idempotency-key-conflict");
    // conflict must never be retryable
    expect(json.error.retryable).toBe(false);
    // downstream handler must NOT have been invoked on the conflicting second call
    expect(getHandlerCount()).toBe(countAfterFirst);
  });

  it("legacy null-hash row: replays stored response regardless of body", async () => {
    const fake = new FakeIdempotencyStore();
    const { app, getHandlerCount } = makeApp(fake);

    // Pre-seed a stored entry with requestHash: null (legacy pre-migration row).
    // The key is caller-scoped; the test stub sets no tokenResult, so caller="anon".
    const legacyKey = "dp:p1:anon:POST:/:key-legacy";
    await fake.store(
      legacyKey,
      "p1",
      200,
      JSON.stringify({ ok: true, id: "legacy" }),
      null,
    );

    // Send a request with any body — the null hash should match unconditionally
    const res = await app.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "key-legacy",
      },
      body: JSON.stringify({ completelydifferentbody: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replayed")).toBe("true");
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.id).toBe("legacy");
    // downstream handler must NOT have been invoked (replayed from store)
    expect(getHandlerCount()).toBe(0);
  });

  it("non-JSON Content-Type: pass-through (inactive)", async () => {
    const fake = new FakeIdempotencyStore();
    const { app, getHandlerCount } = makeApp(fake);

    // non-JSON content-type — middleware should not activate
    const app2 = new Hono<{ Variables: { projectId: string } }>();
    let count = 0;
    app2.use("/*", async (c, next) => {
      c.set("projectId", "p1");
      await next();
    });
    app2.use("/*", createIdempotencyMiddleware({ makeStore: () => fake }));
    app2.post("/", async (c) => {
      count++;
      return c.text("ok");
    });

    await app2.request("/", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Idempotency-Key": "key-plain" },
      body: "hello",
    });
    await app2.request("/", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Idempotency-Key": "key-plain" },
      body: "hello",
    });

    expect(count).toBe(2);

    // GET request also passes through
    const appGet = new Hono<{ Variables: { projectId: string } }>();
    let getCount = 0;
    appGet.use("/*", async (c, next) => {
      c.set("projectId", "p1");
      await next();
    });
    appGet.use("/*", createIdempotencyMiddleware({ makeStore: () => fake }));
    appGet.get("/", async () => {
      getCount++;
      return new Response("ok");
    });

    await appGet.request("/", {
      method: "GET",
      headers: { "Idempotency-Key": "key-get" },
    });
    await appGet.request("/", {
      method: "GET",
      headers: { "Idempotency-Key": "key-get" },
    });

    expect(getCount).toBe(2);

    // suppress unused variable warning
    void getHandlerCount;
  });

  it("handler returns 500: not stored, third retry runs handler again", async () => {
    const fake = new FakeIdempotencyStore();
    const { app, getHandlerCount } = makeApp(fake, { handlerStatus: 500 });

    const body = JSON.stringify({ a: 1 });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "key-500",
    };

    await app.request("/", { method: "POST", headers, body });
    const res2 = await app.request("/", { method: "POST", headers, body });

    expect(res2.status).toBe(500);
    // handler should have run twice (5xx not cached)
    expect(getHandlerCount()).toBe(2);
  });

  it("handler reads await c.req.json() even though middleware hashed the body", async () => {
    const fake = new FakeIdempotencyStore();
    const { app } = makeApp(fake);

    // The handler in makeApp calls c.req.json() — if the stream was consumed, it would throw
    const res = await app.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "key-stream",
      },
      body: JSON.stringify({ streaming: true }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("fail-closed: store check throws, returns 503 retryable WITHOUT running the handler", async () => {
    const throwingStore: IdempotencyStoreLike = {
      async check() {
        throw new Error("D1 unavailable");
      },
      async store() {},
      async reserve() {
        throw new Error("D1 unavailable");
      },
      async finalize() {
        return false;
      },
      async release() {},
    };

    const { app, getHandlerCount } = makeApp(throwingStore);

    const res = await app.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "key-fail-closed",
      },
      body: JSON.stringify({ a: 1 }),
    });

    // The client opted into exactly-once on a mutating request; if the store is
    // unreachable we must NOT run the handler (which could double-apply a write).
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("idempotency-unavailable");
    expect(body.error.retryable).toBe(true);
    expect(getHandlerCount()).toBe(0);
  });

  it("store write failure after a 2xx is best-effort: the response still succeeds", async () => {
    const writeThrowingStore: IdempotencyStoreLike = {
      async check() {
        return null;
      },
      async store() {
        throw new Error("D1 write failed");
      },
      async reserve() {
        return { state: "acquired" };
      },
      async finalize() {
        throw new Error("D1 write failed");
      },
      async release() {},
    };

    const { app, getHandlerCount } = makeApp(writeThrowingStore);

    const res = await app.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "key-write-fail",
      },
      body: JSON.stringify({ a: 1 }),
    });

    // The handler ran and committed; failing to persist the idempotency record
    // must not turn a successful write into an error.
    expect(res.status).toBe(200);
    expect(getHandlerCount()).toBe(1);
  });
});
