import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { HonoVariables } from "../types";
import type { Env } from "../types";
import { sourceResolution } from "./source-resolution";

function createApp(authKind: "bearer" | "cookie" | "workspace") {
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use("*", (c, next) => {
    c.set("authKind", authKind);
    return next();
  });
  app.use("*", sourceResolution());
  app.get("/test", (c) => {
    return c.json({
      source: c.get("source"),
      sourceVersion: c.get("sourceVersion"),
    });
  });
  return app;
}

describe("sourceResolution", () => {
  it("parses X-Tila-Source header for bearer auth", async () => {
    const app = createApp("bearer");
    const res = await app.request("/test", {
      headers: { "X-Tila-Source": "sdk/1.2.3" },
    });
    const body = (await res.json()) as {
      source: string;
      sourceVersion: string;
    };
    expect(body.source).toBe("sdk");
    expect(body.sourceVersion).toBe("1.2.3");
  });

  it("defaults to unknown for bearer without header", async () => {
    const app = createApp("bearer");
    const res = await app.request("/test");
    const body = (await res.json()) as {
      source: string;
      sourceVersion: string | null;
    };
    expect(body.source).toBe("unknown");
    expect(body.sourceVersion).toBeNull();
  });

  it("forces dashboard for cookie auth regardless of header", async () => {
    const app = createApp("cookie");
    const res = await app.request("/test", {
      headers: { "X-Tila-Source": "cli/2.0.0" },
    });
    const body = (await res.json()) as {
      source: string;
      sourceVersion: string | null;
    };
    expect(body.source).toBe("dashboard");
    expect(body.sourceVersion).toBeNull();
  });

  it("forces dashboard for workspace auth regardless of header", async () => {
    const app = createApp("workspace");
    const res = await app.request("/test", {
      headers: { "X-Tila-Source": "sdk/1.0.0" },
    });
    const body = (await res.json()) as {
      source: string;
      sourceVersion: string | null;
    };
    expect(body.source).toBe("dashboard");
    expect(body.sourceVersion).toBeNull();
  });

  it("handles malformed header gracefully", async () => {
    const app = createApp("bearer");
    const res = await app.request("/test", {
      headers: { "X-Tila-Source": "no-slash" },
    });
    const body = (await res.json()) as {
      source: string;
      sourceVersion: string | null;
    };
    expect(body.source).toBe("unknown");
    expect(body.sourceVersion).toBeNull();
  });
});
