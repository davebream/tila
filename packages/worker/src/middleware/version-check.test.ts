import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { parseSourceHeader, versionCheckMiddleware } from "./version-check";

function createTestApp() {
  const app = new Hono();
  app.use("/api/*", versionCheckMiddleware());
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/other", (c) => c.json({ ok: true }));
  return app;
}

describe("versionCheckMiddleware", () => {
  it("request without X-Tila-CLI-Version header passes through", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other");
    expect(res.status).toBe(200);
  });

  it("request with CLI version at minCliVersion passes through", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other", {
      headers: { "X-Tila-CLI-Version": "0.1.0" },
    });
    expect(res.status).toBe(200);
  });

  it("request with CLI version above minCliVersion passes through", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other", {
      headers: { "X-Tila-CLI-Version": "1.2.3" },
    });
    expect(res.status).toBe(200);
  });

  it("request with CLI version below minCliVersion returns 426", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other", {
      headers: { "X-Tila-CLI-Version": "0.0.1" },
    });
    expect(res.status).toBe(426);
    const body = (await res.json()) as {
      error: string;
      minCliVersion: string;
      upgradeUrl: string;
    };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(typeof body.minCliVersion).toBe("string");
    expect(typeof body.upgradeUrl).toBe("string");
  });

  it("GET /api/health is exempt from version check even with old CLI version", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/health", {
      headers: { "X-Tila-CLI-Version": "0.0.1" },
    });
    expect(res.status).toBe(200);
  });

  it("426 response body contains minCliVersion and upgradeUrl", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other", {
      headers: { "X-Tila-CLI-Version": "0.0.9" },
    });
    expect(res.status).toBe(426);
    const body = (await res.json()) as {
      error: string;
      minCliVersion: string;
      upgradeUrl: string;
    };
    expect(body.minCliVersion).toBe("0.1.0");
    expect(body.upgradeUrl).toMatch(/https:\/\//);
  });

  it("X-Tila-Source: cli/<version> below min returns 426", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other", {
      headers: { "X-Tila-Source": "cli/0.0.1" },
    });
    expect(res.status).toBe(426);
  });

  it("X-Tila-Source: cli/<version> at min passes through", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other", {
      headers: { "X-Tila-Source": "cli/0.1.0" },
    });
    expect(res.status).toBe(200);
  });

  it("X-Tila-Source: sdk/<version> passes through (non-CLI)", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other", {
      headers: { "X-Tila-Source": "sdk/0.1.0" },
    });
    expect(res.status).toBe(200);
  });

  it("X-Tila-Source: mcp-server/<version> passes through (non-CLI)", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other", {
      headers: { "X-Tila-Source": "mcp-server/0.1.0" },
    });
    expect(res.status).toBe(200);
  });

  it("X-Tila-Source takes priority over legacy X-Tila-CLI-Version", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other", {
      headers: {
        "X-Tila-Source": "cli/1.0.0",
        "X-Tila-CLI-Version": "0.0.1",
      },
    });
    expect(res.status).toBe(200);
  });

  it("malformed X-Tila-Source (no slash) falls through to legacy header", async () => {
    const app = createTestApp();
    const res = await app.request("http://localhost/api/other", {
      headers: {
        "X-Tila-Source": "cli-no-version",
        "X-Tila-CLI-Version": "0.0.1",
      },
    });
    expect(res.status).toBe(426);
  });
});

describe("parseSourceHeader", () => {
  it("parses valid source header", () => {
    expect(parseSourceHeader("cli/1.2.3")).toEqual({
      clientId: "cli",
      version: "1.2.3",
    });
  });

  it("parses hyphenated client-id", () => {
    expect(parseSourceHeader("mcp-server/0.1.0")).toEqual({
      clientId: "mcp-server",
      version: "0.1.0",
    });
  });

  it("returns null for no slash", () => {
    expect(parseSourceHeader("cli-no-version")).toBeNull();
  });

  it("returns null for trailing slash", () => {
    expect(parseSourceHeader("cli/")).toBeNull();
  });

  it("returns null for leading slash", () => {
    expect(parseSourceHeader("/1.0.0")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSourceHeader("")).toBeNull();
  });
});
