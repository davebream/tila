import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

// Import after mocks are set up
const { whoami } = await import("./whoami");

function createApp(tokenResult: UnifiedTokenResult): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Inject tokenResult via middleware before routing
  app.use("*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    await next();
  });

  app.route("/", whoami);
  return app;
}

describe("GET /whoami", () => {
  it("returns auth_kind only for d1-token", async () => {
    const tokenResult: UnifiedTokenResult = {
      kind: "d1-token",
      projectId: "test-project",
      name: "test-token",
      scopes: "all",
      tokenId: "token-123",
    };

    const app = createApp(tokenResult);
    const res = await app.request("/whoami");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      project_id: string;
      token_name: string;
      scopes: string;
      auth_kind?: string;
      github_login?: string;
      permission?: string;
      expires_at?: number;
    };

    expect(body.ok).toBe(true);
    expect(body.project_id).toBe("test-project");
    expect(body.token_name).toBe("test-token");
    expect(body.scopes).toBe("all");
    expect(body.auth_kind).toBe("d1-token");
    expect(body.github_login).toBeUndefined();
    expect(body.permission).toBeUndefined();
    expect(body.expires_at).toBeUndefined();
  });

  it("returns all fields for session token", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const tokenResult: UnifiedTokenResult = {
      kind: "session",
      projectId: "test-project",
      name: "github:testuser",
      scopes: "all",
      tokenId: "session-456",
      githubRepoId: 99999,
      githubLogin: "testuser",
      permission: "write",
      expiresAt,
    };

    const app = createApp(tokenResult);
    const res = await app.request("/whoami");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      project_id: string;
      token_name: string;
      scopes: string;
      auth_kind?: string;
      github_login?: string;
      permission?: string;
      expires_at?: number;
    };

    expect(body.ok).toBe(true);
    expect(body.project_id).toBe("test-project");
    expect(body.token_name).toBe("github:testuser");
    expect(body.scopes).toBe("all");
    expect(body.auth_kind).toBe("session");
    expect(body.github_login).toBe("testuser");
    expect(body.permission).toBe("write");
    expect(body.expires_at).toBe(expiresAt);
  });

  it("returns auth_kind and expires_at for cookie-session", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 7200;
    const tokenResult: UnifiedTokenResult = {
      kind: "cookie-session",
      projectId: "test-project",
      name: "cookie:user",
      scopes: "all",
      tokenId: "",
      sessionHash: "hash-789",
      expiresAt,
    };

    const app = createApp(tokenResult);
    const res = await app.request("/whoami");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      project_id: string;
      token_name: string;
      scopes: string;
      auth_kind?: string;
      github_login?: string;
      permission?: string;
      expires_at?: number;
    };

    expect(body.ok).toBe(true);
    expect(body.project_id).toBe("test-project");
    expect(body.token_name).toBe("cookie:user");
    expect(body.scopes).toBe("all");
    expect(body.auth_kind).toBe("cookie-session");
    expect(body.github_login).toBeUndefined();
    expect(body.permission).toBeUndefined();
    expect(body.expires_at).toBe(expiresAt);
  });
});
