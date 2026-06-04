/**
 * Route-level tests for the search route.
 *
 * Verifies requirePermission("read") guard on GET /search.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";
import { search } from "./search";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const MOCK_ENV = {
  ANALYTICS: { writeDataPoint: () => {} },
} as unknown as Env;
const MOCK_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function mockStub(response: Response): DurableObjectStub {
  return {
    fetch: vi.fn(async () => response),
  } as unknown as DurableObjectStub;
}

function createApp(
  stub: DurableObjectStub,
  tokenResult: HonoVariables["tokenResult"],
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("doStub", stub);
    c.set("tokenResult", tokenResult);
    c.set("source", "cli");
    c.set("sourceVersion", "test");
    return next();
  });
  app.route("/search", search);
  return app;
}

const ADMIN_TOKEN_RESULT: HonoVariables["tokenResult"] = {
  kind: "d1-token" as const,
  projectId: "proj-1",
  name: "admin-token",
  scopes: "full",
  tokenId: "tok-uuid",
};

describe("search route", () => {
  describe("POST /search/reindex -- empty body hardening (issue #412)", () => {
    it("does not 500 on /search/reindex with empty body", async () => {
      // The stub returns whatever the DO would return; the key assertion is
      // that the Worker itself does not throw/500 before forwarding to DO.
      const doResponse = new Response(
        JSON.stringify({ ok: false, error: { code: "validation-error" } }),
        { status: 400 },
      );
      const stub = mockStub(doResponse);
      const app = createApp(stub, ADMIN_TOKEN_RESULT);
      const res = await app.fetch(
        new Request("http://localhost/search/reindex", { method: "POST" }),
        MOCK_ENV,
        MOCK_CTX,
      );
      expect(res.status).not.toBe(500);
    });
  });

  describe("GET /search permission guard", () => {
    it("rejects a session token with no read permission with 403", async () => {
      const stub = mockStub(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      // workspace-session has no project_id, which yields PROJECT_REQUIRED (a 403)
      const tokenResult = {
        kind: "workspace-session" as const,
        projectId: "",
        name: "gh-alice",
        scopes: "",
        tokenId: "",
        sessionHash: "ws-hash",
        githubLogin: "gh-alice",
        expiresAt: Date.now() + 3600_000,
      };
      const app = createApp(stub, tokenResult);
      const res = await app.fetch(
        new Request("http://localhost/search?q=hello"),
        MOCK_ENV,
        MOCK_CTX,
      );
      expect(res.status).toBe(403);
    });

    it("allows a session token with read permission", async () => {
      const doResponse = new Response(
        JSON.stringify({ results: [], total: 0 }),
        { status: 200 },
      );
      const stub = mockStub(doResponse);
      const tokenResult = {
        kind: "session" as const,
        projectId: "proj-1",
        name: "reader",
        scopes: "read",
        tokenId: "",
        githubRepoId: 999,
        githubLogin: "reader",
        permission: "read",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
      const app = createApp(stub, tokenResult);
      const res = await app.fetch(
        new Request("http://localhost/search?q=hello"),
        MOCK_ENV,
        MOCK_CTX,
      );
      // The DO stub returns 200, so the route should pass through
      expect(res.status).toBe(200);
    });

    it("allows a d1-token with full scopes", async () => {
      const doResponse = new Response(
        JSON.stringify({ results: [], total: 0 }),
        { status: 200 },
      );
      const stub = mockStub(doResponse);
      const tokenResult = {
        kind: "d1-token" as const,
        projectId: "proj-1",
        name: "admin-token",
        scopes: "full",
        tokenId: "tok-uuid",
      };
      const app = createApp(stub, tokenResult);
      const res = await app.fetch(
        new Request("http://localhost/search?q=hello"),
        MOCK_ENV,
        MOCK_CTX,
      );
      expect(res.status).toBe(200);
    });
  });
});
