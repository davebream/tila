import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env, HonoVariables } from "../types";
import { csrfGuard } from "./csrf";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function createTestApp(
  authKind: "bearer" | "cookie" | "workspace",
  env?: Partial<Env>,
) {
  const app = new Hono<AppEnv>();
  // Simulate auth middleware setting authKind
  app.use("/*", async (c, next) => {
    c.set("authKind", authKind);
    c.set("tokenResult", {
      kind:
        authKind === "cookie"
          ? "cookie-session"
          : authKind === "workspace"
            ? "workspace-session"
            : "d1-token",
      projectId: authKind === "workspace" ? "" : "proj",
      name: "actor",
      scopes: authKind === "workspace" ? "" : "full",
      tokenId: "",
      sessionHash: "hash",
      expiresAt: Date.now() + 3600_000,
      githubLogin: authKind === "workspace" ? "actor" : undefined,
    } as never);
    return next();
  });
  app.use("/*", csrfGuard);
  app.post("/test", (c) => c.json({ ok: true }));
  app.get("/test", (c) => c.json({ ok: true }));
  return { app, env: env as Env | undefined };
}

describe("csrfGuard", () => {
  it("cookie-auth POST with matching Origin passes", async () => {
    const { app } = createTestApp("cookie");
    const res = await app.request("http://localhost/test", {
      method: "POST",
      headers: { Origin: "http://localhost" },
    });
    expect(res.status).toBe(200);
  });

  it("cookie-auth POST with missing Origin returns 403", async () => {
    const { app } = createTestApp("cookie");
    const res = await app.request("http://localhost/test", {
      method: "POST",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("CSRF_MISSING_ORIGIN");
  });

  it("cookie-auth POST with mismatched Origin returns 403", async () => {
    const { app } = createTestApp("cookie");
    const res = await app.request("http://localhost/test", {
      method: "POST",
      headers: { Origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("CSRF_ORIGIN_MISMATCH");
  });

  it("bearer-auth POST without Origin passes (no CSRF needed)", async () => {
    const { app } = createTestApp("bearer");
    const res = await app.request("http://localhost/test", {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  it("cookie-auth GET passes without Origin check", async () => {
    const { app } = createTestApp("cookie");
    const res = await app.request("http://localhost/test", {
      method: "GET",
    });
    expect(res.status).toBe(200);
  });

  it("workspace POST with matching Origin passes CSRF check", async () => {
    const { app } = createTestApp("workspace");
    const res = await app.request("http://localhost/test", {
      method: "POST",
      headers: { Origin: "http://localhost" },
    });
    expect(res.status).toBe(200);
  });

  it("workspace POST with missing Origin returns 403 CSRF_MISSING_ORIGIN", async () => {
    const { app } = createTestApp("workspace");
    const res = await app.request("http://localhost/test", {
      method: "POST",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CSRF_MISSING_ORIGIN");
  });

  it("workspace POST with mismatched Origin returns 403 CSRF_ORIGIN_MISMATCH", async () => {
    const { app } = createTestApp("workspace");
    const res = await app.request("http://localhost/test", {
      method: "POST",
      headers: { Origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CSRF_ORIGIN_MISMATCH");
  });

  it("bearer-auth POST without Origin still passes (regression: not affected by workspace change)", async () => {
    const { app } = createTestApp("bearer");
    const res = await app.request("http://localhost/test", {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  describe("CORS-approved cross-origin requests", () => {
    it("cookie-auth POST from CORS-approved origin passes", async () => {
      const app = new Hono<AppEnv>();
      app.use("/*", async (c, next) => {
        c.set("authKind", "cookie");
        c.set("tokenResult", {
          kind: "cookie-session",
          projectId: "proj",
          name: "actor",
          scopes: "full",
          tokenId: "",
          sessionHash: "hash",
          expiresAt: Date.now() + 3600_000,
        } as never);
        return next();
      });
      app.use("/*", csrfGuard);
      app.post("/test", (c) => c.json({ ok: true }));

      const corsEnv = {
        CORS_ALLOWED_ORIGINS: "https://my-ui.pages.dev",
      } as unknown as Env;

      const res = await app.request(
        "http://api.workers.dev/test",
        {
          method: "POST",
          headers: { Origin: "https://my-ui.pages.dev" },
        },
        corsEnv,
      );
      expect(res.status).toBe(200);
    });

    it("cookie-auth POST from non-approved cross-origin returns 403", async () => {
      const app = new Hono<AppEnv>();
      app.use("/*", async (c, next) => {
        c.set("authKind", "cookie");
        c.set("tokenResult", {
          kind: "cookie-session",
          projectId: "proj",
          name: "actor",
          scopes: "full",
          tokenId: "",
          sessionHash: "hash",
          expiresAt: Date.now() + 3600_000,
        } as never);
        return next();
      });
      app.use("/*", csrfGuard);
      app.post("/test", (c) => c.json({ ok: true }));

      const corsEnv = {
        CORS_ALLOWED_ORIGINS: "https://my-ui.pages.dev",
      } as unknown as Env;

      const res = await app.request(
        "http://api.workers.dev/test",
        {
          method: "POST",
          headers: { Origin: "https://evil.example.com" },
        },
        corsEnv,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CSRF_ORIGIN_MISMATCH");
    });

    it("wildcard in CORS_ALLOWED_ORIGINS is ignored (rejected)", async () => {
      const app = new Hono<AppEnv>();
      app.use("/*", async (c, next) => {
        c.set("authKind", "cookie");
        c.set("tokenResult", {
          kind: "cookie-session",
          projectId: "proj",
          name: "actor",
          scopes: "full",
          tokenId: "",
          sessionHash: "hash",
          expiresAt: Date.now() + 3600_000,
        } as never);
        return next();
      });
      app.use("/*", csrfGuard);
      app.post("/test", (c) => c.json({ ok: true }));

      // Wildcard should be stripped by parseAllowedOrigins
      const corsEnv = {
        CORS_ALLOWED_ORIGINS: "*",
      } as unknown as Env;

      const res = await app.request(
        "http://api.workers.dev/test",
        {
          method: "POST",
          headers: { Origin: "https://evil.example.com" },
        },
        corsEnv,
      );
      expect(res.status).toBe(403);
    });

    it("empty CORS_ALLOWED_ORIGINS allows only same-origin", async () => {
      const app = new Hono<AppEnv>();
      app.use("/*", async (c, next) => {
        c.set("authKind", "cookie");
        c.set("tokenResult", {
          kind: "cookie-session",
          projectId: "proj",
          name: "actor",
          scopes: "full",
          tokenId: "",
          sessionHash: "hash",
          expiresAt: Date.now() + 3600_000,
        } as never);
        return next();
      });
      app.use("/*", csrfGuard);
      app.post("/test", (c) => c.json({ ok: true }));

      const corsEnv = {
        CORS_ALLOWED_ORIGINS: "",
      } as unknown as Env;

      // Same-origin passes
      const sameOriginRes = await app.request(
        "http://localhost/test",
        {
          method: "POST",
          headers: { Origin: "http://localhost" },
        },
        corsEnv,
      );
      expect(sameOriginRes.status).toBe(200);

      // Cross-origin rejected
      const crossOriginRes = await app.request(
        "http://localhost/test",
        {
          method: "POST",
          headers: { Origin: "https://other.example.com" },
        },
        corsEnv,
      );
      expect(crossOriginRes.status).toBe(403);
    });
  });
});
