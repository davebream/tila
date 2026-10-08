import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STEP_UP_MAX_AGE_SECONDS_DEFAULT } from "../config";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";
import {
  requireFreshAuthentication,
  stepUpGuard,
  stepUpMaxAgeMs,
} from "./protected-operation";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const NOW = 1_700_000_000_000;

function cookieSession(
  overrides: Partial<
    Extract<UnifiedTokenResult, { kind: "cookie-session" }>
  > = {},
): UnifiedTokenResult {
  return {
    kind: "cookie-session",
    projectId: "proj-1",
    name: "octocat",
    scopes: "admin",
    tokenId: "",
    sessionHash: "hash",
    expiresAt: NOW + 3_600_000,
    permission: "admin",
    principalId: "github:github.com:1",
    role: "owner",
    membershipSources: ["explicit"],
    authenticatedAt: NOW - 60_000,
    authMethod: "github",
    ...overrides,
  };
}

function appWith(token: UnifiedTokenResult, env: Partial<Env> = {}) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", token);
    await next();
  });
  app.use("/guarded/*", stepUpGuard);
  app.all("/guarded/op", (c) => c.json({ ok: true }));
  app.post("/inline", (c) => {
    const stale = requireFreshAuthentication(c);
    if (stale) return stale;
    return c.json({ ok: true });
  });
  const call = (method: string, path: string) =>
    app.request(path, { method }, env as Env);
  return { call };
}

describe("step-up reauthentication", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stepUpMaxAgeMs falls back to the default for missing or invalid overrides", () => {
    expect(stepUpMaxAgeMs({})).toBe(STEP_UP_MAX_AGE_SECONDS_DEFAULT * 1000);
    expect(stepUpMaxAgeMs({ STEP_UP_MAX_AGE_SECONDS: "abc" })).toBe(
      STEP_UP_MAX_AGE_SECONDS_DEFAULT * 1000,
    );
    expect(stepUpMaxAgeMs({ STEP_UP_MAX_AGE_SECONDS: "0" })).toBe(
      STEP_UP_MAX_AGE_SECONDS_DEFAULT * 1000,
    );
    expect(stepUpMaxAgeMs({ STEP_UP_MAX_AGE_SECONDS: "120" })).toBe(120_000);
  });

  it("allows a fresh cookie session", async () => {
    const { call } = appWith(cookieSession());
    const res = await call("POST", "/guarded/op");
    expect(res.status).toBe(200);
  });

  it("rejects a stale cookie session with step-up-required and details", async () => {
    const authenticatedAt = NOW - STEP_UP_MAX_AGE_SECONDS_DEFAULT * 1000 - 1;
    const { call } = appWith(cookieSession({ authenticatedAt }));
    const res = await call("DELETE", "/guarded/op");
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: {
        code: string;
        retryable: boolean;
        details: { max_age_seconds: number; authenticated_at: number };
      };
    };
    expect(body.error.code).toBe("step-up-required");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details.max_age_seconds).toBe(
      STEP_UP_MAX_AGE_SECONDS_DEFAULT,
    );
    expect(body.error.details.authenticated_at).toBe(authenticatedAt);
  });

  it("treats a cookie session without authenticatedAt as stale", async () => {
    const { call } = appWith(cookieSession({ authenticatedAt: undefined }));
    const res = await call("POST", "/inline");
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details: { authenticated_at: null } };
    };
    expect(body.error.code).toBe("step-up-required");
    expect(body.error.details.authenticated_at).toBeNull();
  });

  it("honors the STEP_UP_MAX_AGE_SECONDS override", async () => {
    const { call } = appWith(cookieSession({ authenticatedAt: NOW - 90_000 }), {
      STEP_UP_MAX_AGE_SECONDS: "60",
    });
    expect((await call("POST", "/guarded/op")).status).toBe(403);
    const fresh = appWith(cookieSession({ authenticatedAt: NOW - 30_000 }), {
      STEP_UP_MAX_AGE_SECONDS: "60",
    });
    expect((await fresh.call("POST", "/guarded/op")).status).toBe(200);
  });

  it("never gates GET requests", async () => {
    const { call } = appWith(cookieSession({ authenticatedAt: 0 }));
    expect((await call("GET", "/guarded/op")).status).toBe(200);
  });

  it("exempts bearer credentials and scoped cookie sessions", async () => {
    const exempt: UnifiedTokenResult[] = [
      {
        kind: "d1-token",
        projectId: "proj-1",
        name: "bootstrap",
        scopes: "full",
        tokenId: "tok-1",
      },
      {
        kind: "session",
        projectId: "proj-1",
        name: "octocat",
        scopes: "admin",
        tokenId: "",
        githubRepoId: 1,
        githubLogin: "octocat",
        permission: "admin",
        expiresAt: NOW + 60_000,
        jti: "jti-1",
      },
      cookieSession({
        authenticatedAt: 0,
        policy: { role: "owner", capabilities: ["tokens:revoke"] },
        credentialId: "cred-1",
      }),
    ];
    for (const token of exempt) {
      const { call } = appWith(token);
      expect((await call("DELETE", "/guarded/op")).status).toBe(200);
    }
  });
});
