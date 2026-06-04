import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { installProjectErrorHandlers } from "../src/routes/errors";

describe("installProjectErrorHandlers – ZodError handling", () => {
  it("returns 400 with validation-error code when a route throws ZodError", async () => {
    const app = new Hono();
    installProjectErrorHandlers(app);

    // Route that triggers ZodError via .parse() with invalid data
    app.post("/test-zod", async (c) => {
      const TestSchema = z.object({
        name: z.string(),
        count: z.number().int().positive(),
      });
      const body = await c.req.json();
      const parsed = TestSchema.parse(body);
      return c.json({ ok: true, data: parsed });
    });

    const res = await app.request("/test-zod", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 42, count: -1 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
    expect(body.error.retryable).toBe(false);
    // Message should contain field-level info from Zod issues
    expect(body.error.message).toContain("name");
    expect(body.error.message).toContain("count");
  });

  it("still returns 500 for non-ZodError unhandled errors", async () => {
    const app = new Hono();
    installProjectErrorHandlers(app);

    app.get("/test-generic", () => {
      throw new Error("unexpected failure");
    });

    const res = await app.request("/test-generic");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("internal");
  });
});
