import { Hono } from "hono";
import { describe, expect, it } from "vitest";

/**
 * Tests for the root GET / route that replaces the SPA middleware.
 * The Worker is now API-only; the UI is served from Cloudflare Pages.
 */

function createTestApp() {
  const app = new Hono();
  app.get("/", (c) =>
    c.json({ ok: true, message: "tila API is running", health: "/api/health" }),
  );
  return app;
}

describe("GET /", () => {
  it("returns 200 with ok, message, and health fields", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      message: string;
      health: string;
    };
    expect(body.ok).toBe(true);
    expect(body.message).toBe("tila API is running");
    expect(body.health).toBe("/api/health");
  });

  it("returns JSON content type", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
