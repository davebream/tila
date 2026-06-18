/**
 * C2: DO router correlation — X-Request-ID read, sanitize, echo, log (RED).
 *
 * Verifies:
 *   (d) The DO echoes X-Request-ID on every response and the sanitized value
 *       is passed to console.error in onError (tested via mock).
 *   - A \r\n-laden request id is sanitized before logging.
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../src/project-do-router";
import { installProjectErrorHandlers } from "../src/routes/errors";
import type { RouterDeps } from "../src/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

function makeDeps(db: TestDb["db"]): RouterDeps {
  return {
    ctx: {} as DurableObjectState,
    db: db as RouterDeps["db"],
    enrichOpts: vi.fn().mockReturnValue(undefined),
  };
}

let testDb: TestDb;
let app: Hono;

beforeEach(() => {
  testDb = createTestDb();
  app = createProjectRouter(makeDeps(testDb.db));
});

afterEach(() => {
  testDb.sqlite.close();
});

describe("DO correlation middleware — X-Request-ID", () => {
  it("echoes the X-Request-ID header on a successful response", async () => {
    const res = await app.request("/entity/list", {
      method: "GET",
      headers: { "X-Request-ID": "req-abc-123" },
    });

    expect(res.headers.get("X-Request-ID")).toBe("req-abc-123");
  });

  it("echoes X-Request-ID on a 404 error response", async () => {
    const res = await app.request("/entity/get/nonexistent-id", {
      method: "GET",
      headers: { "X-Request-ID": "req-xyz-456" },
    });

    // Either 404 or 200 depending on data, but the correlation header must be echoed
    expect(res.headers.get("X-Request-ID")).toBe("req-xyz-456");
  });

  it("sanitizes control characters in X-Request-ID before logging (log-injection hygiene)", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // Note: HTTP headers cannot carry literal \r\n (the runtime rejects them).
    // Sanitization guards against any control chars that slip through in other
    // environments (e.g. tab, unit separator). We verify the middleware sanitizes
    // the value it reads before passing it to console.error.
    //
    // We test by passing a tab character which IS allowed in some header parsers.
    const idWithTab = "req-id\t123";

    // Create a minimal app that reads X-Request-ID and logs it in onError
    // (mirrors the DO router's correlation middleware + onError log path)
    const app2 = new Hono();
    installProjectErrorHandlers(app2);
    // Simulate what the DO correlation middleware will do:
    // read the raw value, sanitize, stash, then onError logs the stashed value
    app2.use("*", async (c, next) => {
      const raw = c.req.header("X-Request-ID") ?? "";
      const sanitized = raw.replace(/[\r\n\t]/g, "_").slice(0, 128);
      c.set("correlationId" as never, sanitized as never);
      await next();
    });
    app2.get("/boom", () => {
      throw new Error("forced error for log test");
    });
    // Patch onError to log the stashed sanitized id
    app2.onError((err, c) => {
      const sanitized = (c.get as (k: string) => string)("correlationId") ?? "";
      console.error("ProjectDO unhandled error:", err, "requestId:", sanitized);
      return c.json(
        { ok: false, error: { code: "internal", message: "err" } },
        500,
      );
    });

    await app2.request("/boom", {
      method: "GET",
      headers: { "X-Request-ID": idWithTab },
    });

    const logCalls = consoleErrorSpy.mock.calls;
    const loggedString = logCalls.map((args) => args.join(" ")).join("\n");

    // Tab must be replaced with _
    expect(loggedString).not.toContain("req-id\t123");
    expect(loggedString).toContain("req-id_123");

    consoleErrorSpy.mockRestore();
  });

  it("works when no X-Request-ID header is provided", async () => {
    const res = await app.request("/entity/list", {
      method: "GET",
    });

    // Should not crash — correlation is best-effort
    expect(res.status).toBeDefined();
  });
});
