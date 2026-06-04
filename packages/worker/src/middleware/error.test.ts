import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Env, HonoVariables } from "../types";
import { errorHandler } from "./error";

type ErrorBody = {
  ok: boolean;
  error: { code: string; message: string; retryable: boolean };
};

/**
 * Build a minimal Hono app wired with the global error handler. The optional
 * `throwing` route lets a test throw an arbitrary error so we exercise the
 * handler's type branches directly; the default `/parse` route exercises the
 * real `c.req.json()` path that every JSON-body endpoint uses.
 */
function createApp(throwing?: () => unknown) {
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.post("/parse", async (c) => {
    const body = await c.req.json();
    return c.json({ ok: true, body });
  });
  app.get("/throw", () => {
    throw throwing?.();
  });
  app.onError(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("maps a malformed JSON body to 400 validation-error (non-retryable)", async () => {
    const app = createApp();
    const res = await app.request("/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json{",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
    expect(body.error.retryable).toBe(false);
  });

  it("maps an empty JSON body to 400 validation-error (non-retryable)", async () => {
    const app = createApp();
    const res = await app.request("/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
    expect(body.error.retryable).toBe(false);
  });

  it("maps a raw SyntaxError to 400 validation-error (non-retryable)", async () => {
    const app = createApp(() => new SyntaxError("Unexpected token"));
    const res = await app.request("/throw");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("validation-error");
    expect(body.error.retryable).toBe(false);
  });

  it("still returns 400 validation-error for a ZodError (regression)", async () => {
    const schema = z.object({ type: z.string() });
    const app = createApp(() => schema.safeParse({}).error);
    const res = await app.request("/throw");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("validation-error");
    expect(body.error.retryable).toBe(false);
    // error.ts maps each issue to "<path>: <message>" joined with "; ".
    expect(body.error.message).toBe("type: Required");
  });

  it("still returns 500 internal (retryable) for a generic Error (regression)", async () => {
    const app = createApp(() => new Error("boom"));
    const res = await app.request("/throw");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("internal");
    expect(body.error.retryable).toBe(true);
  });

  it("preserves an HTTPException response", async () => {
    const app = createApp(() => new HTTPException(403, { message: "nope" }));
    const res = await app.request("/throw");
    expect(res.status).toBe(403);
  });
});
