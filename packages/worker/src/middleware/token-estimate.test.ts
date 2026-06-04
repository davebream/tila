import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { tokenEstimateMiddleware } from "./token-estimate";

const TOKEN_ESTIMATE_HEADER = "X-Tila-Token-Estimate";

function tokenEstimateFor(body: string): string {
  return String(Math.ceil(body.length / 4));
}

describe("tokenEstimateMiddleware", () => {
  it("adds token estimate to c.json responses without cloning", async () => {
    const cloneSpy = vi.spyOn(Response.prototype, "clone");
    const app = new Hono();
    const body = { ok: true };
    const serialized = JSON.stringify(body);

    app.use("*", tokenEstimateMiddleware());
    app.get("/test", (c) => c.json(body));

    const res = await app.request("/test");

    expect(res.headers.get(TOKEN_ESTIMATE_HEADER)).toBe(
      tokenEstimateFor(serialized),
    );
    expect(await res.json()).toEqual(body);
    expect(cloneSpy).not.toHaveBeenCalled();

    cloneSpy.mockRestore();
  });

  it("preserves status and existing headers on c.json responses", async () => {
    const app = new Hono();
    const body = { ok: true };

    app.use("*", tokenEstimateMiddleware());
    app.get("/test", (c) => {
      c.header("X-Prepared", "yes");
      return c.json(body, 201, { "X-Route": "set" });
    });

    const res = await app.request("/test");

    expect(res.status).toBe(201);
    expect(res.headers.get("X-Prepared")).toBe("yes");
    expect(res.headers.get("X-Route")).toBe("set");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get(TOKEN_ESTIMATE_HEADER)).toBe(
      tokenEstimateFor(JSON.stringify(body)),
    );
  });

  it("preserves status and headers from c.json init responses", async () => {
    const app = new Hono();
    const body = { ok: true, overload: "init" };

    app.use("*", tokenEstimateMiddleware());
    app.get("/test", (c) =>
      c.json(body, { status: 202, headers: { "X-Route": "init" } }),
    );

    const res = await app.request("/test");

    expect(res.status).toBe(202);
    expect(res.headers.get("X-Route")).toBe("init");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get(TOKEN_ESTIMATE_HEADER)).toBe(
      tokenEstimateFor(JSON.stringify(body)),
    );
    expect(await res.json()).toEqual(body);
  });

  it("does not add token estimate to non-JSON responses", async () => {
    const app = new Hono();

    app.use("*", tokenEstimateMiddleware());
    app.get("/test", (c) => c.text("ok"));

    const res = await app.request("/test");

    expect(res.headers.get(TOKEN_ESTIMATE_HEADER)).toBeNull();
  });

  it("estimates raw JSON responses from Content-Length", async () => {
    const app = new Hono();
    const body = JSON.stringify({ ok: true, source: "raw" });

    app.use("*", tokenEstimateMiddleware());
    app.get(
      "/test",
      () =>
        new Response(body, {
          headers: {
            "Content-Length": String(body.length),
            "Content-Type": "application/json",
          },
        }),
    );

    const res = await app.request("/test");

    expect(res.headers.get(TOKEN_ESTIMATE_HEADER)).toBe(tokenEstimateFor(body));
    expect(await res.text()).toBe(body);
  });

  it("skips streaming JSON responses without Content-Length", async () => {
    const app = new Hono();
    const encoder = new TextEncoder();

    app.use("*", tokenEstimateMiddleware());
    app.get(
      "/test",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('{"ok":true}'));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );

    const res = await app.request("/test");

    expect(res.headers.get(TOKEN_ESTIMATE_HEADER)).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });
});
