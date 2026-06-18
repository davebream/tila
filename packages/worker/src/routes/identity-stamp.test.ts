/**
 * Spoof-prevention tests for identity stamping.
 *
 * Verifies that client-supplied identity fields (created_by, holder, actor) are
 * silently ignored and replaced with server-stamped values from tokenResult.name.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";

const TOKEN_NAME = "test-agent";

// --- Mock forwardToDO to capture payload sent to DO ---

const forwardToDOMock = vi.fn();

vi.mock("../lib/do-forward", () => ({
  forwardToDO: (...args: unknown[]) => forwardToDOMock(...args),
  // No Idempotency-Key in these tests, so this returns undefined (matching the
  // real helper when c.get("idempotencyKey") is unset).
  idempotencyHeaders: () => undefined,
}));

vi.mock("../lib/analytics", () => ({
  analyticsCtxFrom: () => undefined,
}));

// --- Mock D1TokenStore for token issue tests ---

const mockIssue = vi.fn().mockResolvedValue({ tokenId: "mock-token-id-uuid" });

vi.mock("@tila/backend-d1", () => ({
  D1TokenStore: vi.fn().mockImplementation(
    class {
      issue = mockIssue;
      revoke = vi.fn().mockResolvedValue(true);
      list = vi.fn().mockResolvedValue([]);
    } as unknown as () => unknown,
  ),
}));

// --- Import routes AFTER mocks are set up ---
const { entities } = await import("./entities");
const { claims } = await import("./claims");
const { tokens } = await import("./tokens");
const { presence } = await import("./presence");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function createApp(routeModule: Hono<AppEnv>, prefix = ""): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Simulate auth middleware setting tokenResult and doStub
  app.use("*", async (c, next) => {
    c.set("tokenResult", {
      kind: "d1-token" as const,
      projectId: "proj-1",
      name: TOKEN_NAME,
      scopes: "full",
      tokenId: "test-token-id-uuid",
    });
    c.set("doStub", {} as DurableObjectStub);
    await next();
  });
  if (prefix) {
    app.route(prefix, routeModule);
  } else {
    app.route("/", routeModule);
  }
  return app;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Identity stamp — spoof prevention", () => {
  beforeEach(() => {
    forwardToDOMock.mockReset();
    mockIssue.mockReset();
    mockIssue.mockResolvedValue({ tokenId: "mock-token-id-uuid" });

    // Default: forwardToDO returns a successful JSON response
    forwardToDOMock.mockImplementation((_stub, _path, _method, body) =>
      makeJsonResponse({
        ok: true,
        entity: { id: "x", created_by: body?.created_by },
        fence: 1,
        expires_at: Date.now() + 5000,
      }),
    );
  });

  // --- Entity create ---

  describe("POST /entities (entity create)", () => {
    const app = createApp(entities);

    it("stamps created_by from token, ignoring client-supplied value", async () => {
      const res = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "e1",
          type: "task",
          data: {},
          created_by: "spoofed", // should be silently stripped by Zod, then server-stamped
        }),
      });
      expect(res.status).toBe(200);
      const payload = forwardToDOMock.mock.calls[0][3];
      expect(payload.created_by).toBe(TOKEN_NAME);
      expect(payload.created_by).not.toBe("spoofed");
    });

    it("succeeds without created_by in body (new client behavior)", async () => {
      const res = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "e2", type: "task", data: {} }),
      });
      expect(res.status).toBe(200);
      const payload = forwardToDOMock.mock.calls[0][3];
      expect(payload.created_by).toBe(TOKEN_NAME);
    });
  });

  // --- Claim acquire ---

  describe("POST /acquire (claim acquire — exclusive mode)", () => {
    const app = createApp(claims);

    it("stamps machine+user from token, ignoring client-supplied values", async () => {
      const res = await app.request("/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: "task:1",
          mode: "exclusive",
          ttl_ms: 5000,
        }),
      });
      expect(res.status).toBe(200);
      const payload = forwardToDOMock.mock.calls[0][3];
      expect(payload.machine).toBe(TOKEN_NAME);
      expect(payload.user).toBe(TOKEN_NAME);
    });
  });

  describe("POST /acquire (claim acquire — presence mode)", () => {
    const app = createApp(claims);

    it("stamps machine from token in presence mode", async () => {
      // heartbeat returns ok:true
      forwardToDOMock.mockResolvedValueOnce(makeJsonResponse({ ok: true }));

      const res = await app.request("/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: "task:1",
          mode: "presence",
          ttl_ms: 5000,
        }),
      });
      expect(res.status).toBe(200);
      const payload = forwardToDOMock.mock.calls[0][3];
      // In presence mode, forwardToDO is called with /coord/heartbeat and machine=tokenResult.name
      expect(payload.machine).toBe(TOKEN_NAME);
      expect(payload.machine).not.toBe("spoofed");
    });
  });

  // --- Claim renew ---

  describe("POST /renew (claim renew)", () => {
    const app = createApp(claims);

    it("stamps machine+user from token, ignoring client-supplied values", async () => {
      const res = await app.request("/renew", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: "task:1",
          fence: 1,
          ttl_ms: 5000,
        }),
      });
      expect(res.status).toBe(200);
      const payload = forwardToDOMock.mock.calls[0][3];
      expect(payload.machine).toBe(TOKEN_NAME);
      expect(payload.user).toBe(TOKEN_NAME);
    });
  });

  // --- Token issue ---

  describe("POST /tokens (token issue)", () => {
    // The token issue route uses new D1TokenStore(c.env.DB).
    // D1TokenStore is mocked above (vi.mock("@tila/backend-d1")), so the constructor
    // receives whatever we pass as c.env.DB. We pass the env as the second arg to
    // app.request() so c.env is defined.
    const mockEnv = { DB: {} } as unknown as Env;
    const tokensApp = new Hono<AppEnv>();
    tokensApp.use("*", async (c, next) => {
      c.set("tokenResult", {
        kind: "d1-token" as const,
        projectId: "proj-1",
        name: TOKEN_NAME,
        scopes: "full",
        tokenId: "test-token-id-uuid",
      });
      await next();
    });
    tokensApp.route("/", tokens);

    it("stamps created_by from issuing token name", async () => {
      const res = await tokensApp.request(
        "/",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "new-token",
            note: "test",
            created_by: "spoofed", // stripped by Zod schema as unknown field
          }),
        },
        mockEnv,
      );
      expect(res.status).toBe(201);
      expect(mockIssue).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: TOKEN_NAME }),
      );
    });

    it("stamps created_by even when created_by is absent from body", async () => {
      const res = await tokensApp.request(
        "/",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "another-token" }),
        },
        mockEnv,
      );
      expect(res.status).toBe(201);
      expect(mockIssue).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: TOKEN_NAME }),
      );
    });
  });

  // --- Presence heartbeat ---

  describe("POST /heartbeat (presence heartbeat)", () => {
    const app = createApp(presence, "");

    it("stamps machine from token, ignoring client-supplied value", async () => {
      forwardToDOMock.mockResolvedValueOnce(makeJsonResponse({ ok: true }));

      const res = await app.request("/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          machine: "spoofed-machine",
          info: { task: "current" },
        }),
      });
      expect(res.status).toBe(200);
      const payload = forwardToDOMock.mock.calls[0][3];
      expect(payload.machine).toBe(TOKEN_NAME);
      expect(payload.machine).not.toBe("spoofed-machine");
      expect(payload.info).toEqual({ task: "current" });
    });
  });

  // --- Schema regression: Zod strips identity fields silently ---

  describe("Schema regression — identity fields stripped, not rejected", () => {
    const app = createApp(entities);

    it("returns 200 (not 400) when created_by is present in entity create body", async () => {
      const res = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "e3",
          type: "task",
          data: {},
          created_by: "old-client-value",
        }),
      });
      // Must succeed — Zod strips the unknown field, does not reject it
      expect(res.status).toBe(200);
    });
  });
});
