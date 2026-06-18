/**
 * C3: Error envelope retryable parity tests (RED → GREEN)
 *
 * Asserts that:
 *  1. A mapped domain error (e.g. FenceError → `stale-fence`) reports identical
 *     `retryable` from the DO error handler and the `mapProjectError` map —
 *     proving the DO is the single source of truth.
 *  2. Zod validation errors and `notFound` responses still emit `retryable: false`.
 *  3. `jsonError` threads `retryable` when the param is passed (Task 10).
 *
 * Strategy: exercise the DO's `installProjectErrorHandlers` and `jsonError`
 * directly (not the full Worker HTTP layer) since the Worker forwards DO envelopes
 * unchanged. This tests the property described in the design:
 * "Worker↔DO parity is automatic once the DO sources `retryable` from error-map.ts".
 */
import { FenceError } from "@tila/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { installProjectErrorHandlers } from "../../backend-do/src/routes/errors";
import { jsonError } from "../../backend-do/src/routes/responses";
import { mapProjectError } from "../../ops-sqlite/src/error-map";

// ---------------------------------------------------------------------------
// mapProjectError: verify retryable is returned after Task 9
// ---------------------------------------------------------------------------

describe("mapProjectError — retryable field", () => {
  it("returns retryable from the error map for FenceError (stale-fence)", () => {
    const mapped = mapProjectError(new FenceError("stale fence", 0, 1));
    expect(mapped).not.toBeNull();
    expect(mapped?.code).toBe("stale-fence");
    // After Task 9: mapped.retryable is present and is a boolean
    expect(typeof mapped?.retryable).toBe("boolean");
  });

  it("returns null for an unknown error type", () => {
    const mapped = mapProjectError(new Error("unknown"));
    expect(mapped).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DO error handler: FenceError → stale-fence envelope parity
// ---------------------------------------------------------------------------

describe("DO installProjectErrorHandlers — FenceError → stale-fence", () => {
  it("emits stale-fence with retryable sourced from error-map (not hardcoded)", async () => {
    const app = new Hono();
    installProjectErrorHandlers(app);
    app.get("/test", () => {
      throw new FenceError("stale", 0, 1);
    });

    const res = await app.request("/test");
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; retryable: boolean; message: string };
    };

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("stale-fence");
    // retryable MUST match what mapProjectError returns (centralized source of truth)
    const mapped = mapProjectError(new FenceError("stale", 0, 1));
    expect(body.error.retryable).toBe(mapped?.retryable);
  });
});

// ---------------------------------------------------------------------------
// DO error handler: Zod errors → retryable: false
// ---------------------------------------------------------------------------

describe("DO installProjectErrorHandlers — ZodError → retryable: false", () => {
  it("emits validation-error with retryable: false", async () => {
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
    const app = new Hono();
    installProjectErrorHandlers(app);
    app.get("/test", () => {
      throw zodErr;
    });

    const res = await app.request("/test");
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; retryable: boolean };
    };

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
    expect(body.error.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DO error handler: notFound → retryable: false
// ---------------------------------------------------------------------------

describe("DO installProjectErrorHandlers — notFound → retryable: false", () => {
  it("emits not-found with retryable: false for an unknown route", async () => {
    const app = new Hono();
    installProjectErrorHandlers(app);
    // No routes registered — anything hits notFound
    const res = await app.request("/nonexistent");
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; retryable: boolean };
    };

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not-found");
    expect(body.error.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// jsonError: retryable is threaded when passed (Task 10 signature)
// ---------------------------------------------------------------------------

describe("jsonError — retryable parameter", () => {
  it("defaults retryable to false when not provided (current behavior preserved)", async () => {
    const app = new Hono();
    app.get("/test", (c) => jsonError(c, 400, "bad-request", "test error"));
    const res = await app.request("/test");
    const body = (await res.json()) as { error: { retryable: boolean } };
    expect(body.error.retryable).toBe(false);
  });

  it("passes retryable: true when explicitly set (new param, Task 10)", async () => {
    const app = new Hono();
    // After Task 10: jsonError(c, status, code, message, extras?, retryable = false)
    app.get("/test", (c) =>
      jsonError(c, 409, "stale-fence", "stale", undefined, true),
    );
    const res = await app.request("/test");
    const body = (await res.json()) as { error: { retryable: boolean } };
    // This test is RED until Task 10 adds the retryable param to jsonError
    expect(body.error.retryable).toBe(true);
  });
});
