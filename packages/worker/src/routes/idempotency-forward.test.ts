/**
 * Audit B1 — covered write routes forward the caller-scoped Idempotency-Key and
 * request-body hash to the DO via extraHeaders, so the DO can dedup the
 * fence-mutating write inside its own transaction. Routes that did NOT receive
 * an Idempotency-Key forward no idempotency headers (DO behavior unchanged).
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";

const forwardToDOMock = vi.fn();

// Re-export the real idempotencyHeaders alongside the mocked forwardToDO so the
// routes' header-building logic is exercised for real.
vi.mock("../lib/do-forward", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/do-forward")>(
      "../lib/do-forward",
    );
  return {
    ...actual,
    forwardToDO: (...args: unknown[]) => forwardToDOMock(...args),
  };
});

vi.mock("../lib/analytics", () => ({
  analyticsCtxFrom: () => undefined,
}));

const { entities } = await import("./entities");
const { claims } = await import("./claims");
const { records } = await import("./records");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

// The extraHeaders argument is the 7th positional arg (index 6) to forwardToDO.
const EXTRA_HEADERS_ARG = 6;

function createApp(
  routeModule: Hono<AppEnv>,
  opts: { withIdempotency: boolean },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", {
      kind: "d1-token" as const,
      projectId: "proj-1",
      name: "agent",
      scopes: "full",
      tokenId: "tok-1",
    });
    c.set("doStub", {} as DurableObjectStub);
    // Simulate the idempotency middleware having stashed the scoped key + hash.
    if (opts.withIdempotency) {
      c.set("idempotencyKey", "dp:proj-1:agent:POST:/x:client-key");
      c.set("idempotencyHash", "body-hash-abc");
    }
    await next();
  });
  app.route("/", routeModule);
  return app;
}

describe("audit B1 — idempotency header forwarding", () => {
  beforeEach(() => {
    forwardToDOMock.mockReset();
    forwardToDOMock.mockImplementation(
      () =>
        new Response(JSON.stringify({ ok: true, entity: { id: "x" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  it("entity update forwards Idempotency-Key + hash when present", async () => {
    const app = createApp(entities, { withIdempotency: true });
    await app.request("/e1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { n: 1 }, fence: 1 }),
    });
    const extra = forwardToDOMock.mock.calls[0][EXTRA_HEADERS_ARG] as Record<
      string,
      string
    >;
    expect(extra).toBeDefined();
    expect(extra["Idempotency-Key"]).toBe("dp:proj-1:agent:POST:/x:client-key");
    expect(extra["X-Idempotency-Hash"]).toBe("body-hash-abc");
  });

  it("entity update forwards NO idempotency headers when key absent", async () => {
    const app = createApp(entities, { withIdempotency: false });
    await app.request("/e1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { n: 1 }, fence: 1 }),
    });
    const extra = forwardToDOMock.mock.calls[0][EXTRA_HEADERS_ARG];
    expect(extra).toBeUndefined();
  });

  it("claim acquire forwards Idempotency-Key + hash when present", async () => {
    const app = createApp(claims, { withIdempotency: true });
    await app.request("/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource: "task:e1",
        mode: "exclusive",
        ttl_ms: 60000,
      }),
    });
    const extra = forwardToDOMock.mock.calls[0][EXTRA_HEADERS_ARG] as Record<
      string,
      string
    >;
    expect(extra["Idempotency-Key"]).toBe("dp:proj-1:agent:POST:/x:client-key");
    expect(extra["X-Idempotency-Hash"]).toBe("body-hash-abc");
  });

  it("record archive forwards Idempotency-Key + hash when present", async () => {
    const app = createApp(records, { withIdempotency: true });
    await app.request("/cfg/~/archive/main", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fence: 1 }),
    });
    // The archive route makes exactly one forwardToDO call.
    const extra = forwardToDOMock.mock.calls[0][EXTRA_HEADERS_ARG] as Record<
      string,
      string
    >;
    expect(extra["Idempotency-Key"]).toBe("dp:proj-1:agent:POST:/x:client-key");
    expect(extra["X-Idempotency-Hash"]).toBe("body-hash-abc");
  });
});
