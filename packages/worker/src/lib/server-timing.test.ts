import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";
import { forwardToDO } from "./do-forward";
import {
  RequestTiming,
  measurePhase,
  serverTimingMiddleware,
} from "./server-timing";

afterEach(() => vi.restoreAllMocks());

describe("request timing", () => {
  it("attributes failed waits and excludes overlapping time", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timing = new RequestTiming();
    await timing.measure("auth_token", async () => {
      now = 10;
    });
    await expect(
      timing.measure("transfer", async () => {
        now = 30;
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    await timing.measure("do", async () => {
      now = 35;
      await timing.measure("do", async () => {
        now = 40;
      });
      now = 50;
    });
    now = 55;
    expect(timing.header()).toContain("tila_worker;dur=55.000");
    expect(timing.header()).toContain("tila_auth_token;dur=10.000");
    expect(timing.header()).toContain("tila_transfer;dur=20.000");
    expect(timing.header()).toContain("tila_do;dur=20.000");
    expect(timing.header()).toContain("tila_worker_other;dur=5.000");
  });

  it("preserves bodies, status and existing headers across concurrent and error responses", async () => {
    const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
    const contexts = new Set<RequestTiming | undefined>();
    app.use("*", serverTimingMiddleware);
    app.onError((_, c) => c.json({ error: "offline" }, 503));
    app.get("/:kind", async (c) => {
      contexts.add(c.get("requestTiming"));
      await measurePhase(c, "auth_token", async () => {
        if (c.req.param("kind") === "error") throw new Error("offline");
      });
      return c.json({ ok: true }, 201, {
        "Server-Timing": "existing;dur=2",
        "X-Keep": "yes",
      });
    });
    const [ok, error] = await Promise.all([
      app.request("/ok"),
      app.request("/error"),
    ]);
    expect(contexts.size).toBe(2);
    expect(ok.status).toBe(201);
    expect(ok.headers.get("X-Keep")).toBe("yes");
    expect(ok.headers.get("Server-Timing")).toContain("existing;dur=2");
    expect(await ok.json()).toEqual({ ok: true });
    expect(error.status).toBe(503);
    expect(error.headers.get("Server-Timing")).toContain(
      "tila_auth_token;dur=",
    );
    expect(await error.json()).toEqual({ error: "offline" });
  });

  it("separates preflight and operation forwarding without consuming responses", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timing = new RequestTiming();
    const stub = {
      fetch: vi.fn(async () => {
        now += 10;
        return Response.json({ ok: true });
      }),
    };
    const context = {
      timing,
      projectId: "test",
      analytics: undefined,
      ctx: { waitUntil: vi.fn() },
    };
    const status = await forwardToDO(
      stub as unknown as DurableObjectStub,
      "/admin/transfer/status",
      "GET",
      undefined,
      undefined,
      context as never,
    );
    const operation = await forwardToDO(
      stub as unknown as DurableObjectStub,
      "/coord/acquire",
      "POST",
      {},
      undefined,
      context as never,
    );
    expect(await status.json()).toEqual({ ok: true });
    expect(await operation.json()).toEqual({ ok: true });
    expect(timing.header()).toContain("tila_transfer;dur=10.000");
    expect(timing.header()).toContain("tila_do;dur=10.000");
  });
});
