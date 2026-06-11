import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables, SessionTokenResult } from "../types";

const forwardToDOMock = vi.fn();

vi.mock("../lib/do-forward", () => ({
  forwardToDO: (...args: unknown[]) => forwardToDOMock(...args),
}));

vi.mock("../lib/analytics", () => ({
  analyticsCtxFrom: () => undefined,
}));

const { claims } = await import("./claims");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function makeSessionToken(
  name: string,
  permission: "read" | "write",
): SessionTokenResult {
  return {
    kind: "session",
    projectId: "proj-1",
    name,
    scopes: permission,
    tokenId: `tok-${name}`,
    githubRepoId: 1,
    githubLogin: name,
    permission,
    expiresAt: Date.now() + 3600_000,
  };
}

function createApp(tokenResult: SessionTokenResult): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    c.set("doStub", {} as DurableObjectStub);
    c.set("projectId", "proj-1");
    await next();
  });
  app.route("/", claims);
  return app;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("claims routes", () => {
  beforeEach(() => {
    forwardToDOMock.mockReset();
    forwardToDOMock.mockImplementation(
      (_stub, path: string, _method: string, body?: { actor?: string }) => {
        if (path === "/coord/release" && body?.actor === "other/other") {
          return jsonResponse(
            {
              ok: false,
              error: {
                code: "release-ownership-denied",
                message: "Only the current holder may release claim task:1",
                retryable: false,
              },
            },
            403,
          );
        }

        return jsonResponse({ ok: true, claim: null, claims: [] });
      },
    );
  });

  it("forwards release for the current holder and preserves the 200 response", async () => {
    const app = createApp(makeSessionToken("holder", "write"));

    const res = await app.request("/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: "task:1", fence: 1 }),
    });

    expect(res.status).toBe(200);
    expect(forwardToDOMock).toHaveBeenCalledWith(
      expect.anything(),
      "/coord/release",
      "POST",
      expect.objectContaining({ actor: "holder/holder" }),
      undefined,
      undefined,
    );
  });

  it("preserves a 403 release-ownership-denied response from the DO", async () => {
    const app = createApp(makeSessionToken("other", "write"));

    const res = await app.request("/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: "task:1", fence: 1 }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("release-ownership-denied");
  });

  it("allows a read-permission session on list and state", async () => {
    const app = createApp(makeSessionToken("reader", "read"));

    const listRes = await app.request("/", { method: "GET" });
    const stateRes = await app.request("/state/task:1", { method: "GET" });

    expect(listRes.status).toBe(200);
    expect(stateRes.status).toBe(200);
  });

  it("rejects a read-permission session on renew and release", async () => {
    const app = createApp(makeSessionToken("reader", "read"));

    const renewRes = await app.request("/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: "task:1", fence: 1, ttl_ms: 60_000 }),
    });
    const releaseRes = await app.request("/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: "task:1", fence: 1 }),
    });

    expect(renewRes.status).toBe(403);
    expect(releaseRes.status).toBe(403);
  });
});
