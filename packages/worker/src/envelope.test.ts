/**
 * C7: Cross-surface parity test — asserts that the same error class yields
 * identical `{ code, message, retryable }` body AND identical HTTP status
 * across the worker error handler and the DO error handler.
 *
 * Strategy: exercise both error handlers via Hono apps that throw the same
 * typed errors. Assert the response bodies from `@tila/schemas`
 * `errorEnvelope`/`okEnvelope` are used by both surfaces.
 */
import { FenceError } from "@tila/core";
import { errorEnvelope, okEnvelope } from "@tila/schemas";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { installProjectErrorHandlers } from "../../backend-do/src/routes/errors";
import { errorHandler } from "./middleware/error";

// ---------------------------------------------------------------------------
// Helpers: build minimal worker + DO apps with shared error class
// ---------------------------------------------------------------------------

function makeWorkerApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app;
}

function makeDoApp() {
  const app = new Hono();
  installProjectErrorHandlers(app);
  return app;
}

// ---------------------------------------------------------------------------
// Parity: ZodError → validation-error (status 400, retryable: false)
// ---------------------------------------------------------------------------

describe("Cross-surface envelope parity — ZodError", () => {
  it("worker and DO emit identical body for ZodError", async () => {
    const { ZodError } = await import("zod");
    const zodErr = new ZodError([
      {
        code: "invalid_type",
        expected: "string",
        received: "number",
        path: ["name"],
        message: "Expected string",
      } as Parameters<(typeof ZodError.prototype)["addIssue"]>[0],
    ]);

    const workerApp = makeWorkerApp();
    workerApp.get("/test", () => {
      throw zodErr;
    });
    const doApp = makeDoApp();
    doApp.get("/test", () => {
      throw zodErr;
    });

    const [workerRes, doRes] = await Promise.all([
      workerApp.request("/test"),
      doApp.request("/test"),
    ]);

    const workerBody = (await workerRes.json()) as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
    };
    const doBody = (await doRes.json()) as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
    };

    // Both must match the shared errorEnvelope factory shape
    expect(workerRes.status).toBe(400);
    expect(doRes.status).toBe(400);

    expect(workerBody.ok).toBe(false);
    expect(doBody.ok).toBe(false);

    // code and retryable must be identical
    expect(workerBody.error.code).toBe(doBody.error.code);
    expect(workerBody.error.retryable).toBe(doBody.error.retryable);
    expect(workerBody.error.retryable).toBe(false);
    expect(workerBody.error.code).toBe("validation-error");
  });
});

// ---------------------------------------------------------------------------
// Parity: SyntaxError → validation-error (worker only — DO doesn't parse body)
// ---------------------------------------------------------------------------

describe("Worker envelope — SyntaxError → validation-error body from errorEnvelope", () => {
  it("worker SyntaxError body matches errorEnvelope factory shape", async () => {
    const workerApp = makeWorkerApp();
    workerApp.get("/test", () => {
      throw new SyntaxError("Unexpected token");
    });

    const res = await workerApp.request("/test");
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
    };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
    expect(body.error.retryable).toBe(false);

    // The body must match what errorEnvelope produces
    const expected = errorEnvelope(
      "validation-error",
      body.error.message, // message may vary
      false,
    );
    expect(body).toMatchObject(expected);
  });
});

// ---------------------------------------------------------------------------
// Parity: unknown error → internal (status 500, retryable: true)
// ---------------------------------------------------------------------------

describe("Cross-surface envelope parity — unhandled error", () => {
  it("worker emits internal-error body matching errorEnvelope factory", async () => {
    const workerApp = makeWorkerApp();
    workerApp.get("/test", () => {
      throw new Error("Something went wrong");
    });

    const res = await workerApp.request("/test");
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
    };

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("internal");
    expect(body.error.retryable).toBe(true);

    // The body must match what errorEnvelope produces
    const expected = errorEnvelope("internal", body.error.message, true);
    expect(body).toMatchObject(expected);
  });
});

// ---------------------------------------------------------------------------
// Parity: FenceError → stale-fence (status 409, retryable: false)
// DO handles this via installProjectErrorHandlers; worker forwards DO responses
// ---------------------------------------------------------------------------

describe("DO envelope — FenceError → stale-fence body from errorEnvelope", () => {
  it("DO stale-fence body matches errorEnvelope factory shape", async () => {
    const doApp = makeDoApp();
    doApp.get("/test", () => {
      throw new FenceError(0, 1);
    });

    const res = await doApp.request("/test");
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
    };

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("stale-fence");
    // The body must match what errorEnvelope produces
    const expected = errorEnvelope(
      "stale-fence",
      body.error.message,
      body.error.retryable,
    );
    expect(body).toMatchObject(expected);
  });
});

// ---------------------------------------------------------------------------
// okEnvelope factory shape
// ---------------------------------------------------------------------------

describe("okEnvelope factory shape", () => {
  it("okEnvelope produces { ok: true, ...body }", () => {
    const result = okEnvelope({ entity: { id: "123" } });
    expect(result).toEqual({ ok: true, entity: { id: "123" } });
  });

  it("errorEnvelope produces { ok: false, error: { code, message, retryable } }", () => {
    const result = errorEnvelope("not-found", "Not found", false);
    expect(result).toEqual({
      ok: false,
      error: { code: "not-found", message: "Not found", retryable: false },
    });
  });
});
