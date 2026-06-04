import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { health } from "./health";

function createTestApp() {
  const app = new Hono();
  app.route("/api", health);
  return app;
}

describe("GET /api/health", () => {
  it("returns 200 with ok, version, apiVersion, minCliVersion", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: string;
      apiVersion: number;
      minCliVersion: string;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.apiVersion).toBe("number");
    expect(Number.isInteger(body.apiVersion)).toBe(true);
    expect(typeof body.minCliVersion).toBe("string");
    expect(body.minCliVersion.length).toBeGreaterThan(0);
  });

  it("does not require Authorization header", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/health");
    // No Authorization header sent — must still succeed
    expect(res.status).toBe(200);
  });
});
