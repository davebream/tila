/**
 * Token management authorization tests.
 *
 * Verifies that the requireTokenAdmin() scope guard:
 * - Allows full-scoped tokens to proceed to business logic
 * - Rejects non-full-scoped tokens with 403 TOKEN_AUTHZ_DENIED
 *
 * See docs/01-DECISIONS.md §20 — Token management authorization: flat-admin in v0.1
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";

// --- Mock D1TokenStore and D1SessionStore ---
vi.mock("@tila/backend-d1", () => ({
  D1TokenStore: vi.fn().mockImplementation(
    class {
      issue = vi.fn().mockResolvedValue({ tokenId: "tid_abc123" });
      revoke = vi
        .fn()
        .mockResolvedValue({ revoked: true, tokenHash: "somehash" });
      list = vi.fn().mockResolvedValue([
        {
          name: "test-token",
          note: null,
          scopes: "full",
          created_at: 1700000000,
          last_used_at: null,
          revoked_at: null,
          created_by: "init",
          revoked_by: null,
          token_id: "tid_abc123",
        },
      ]);
    } as unknown as () => unknown,
  ),
  D1SessionStore: vi.fn().mockImplementation(
    class {
      deleteByTokenHash = vi.fn().mockResolvedValue({ deleted: 0 });
    } as unknown as () => unknown,
  ),
}));

// Mock token-cache invalidate to avoid side effects
vi.mock("../lib/token-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/token-cache")>();
  return { ...actual, invalidate: vi.fn() };
});

// --- Import routes AFTER mocks ---
const { tokens } = await import("./tokens");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

// Mock env — D1TokenStore is fully mocked so DB value is never actually used
const mockEnv = { DB: {} } as unknown as Env;

function createApp(scopes: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", {
      kind: "d1-token" as const,
      projectId: "proj-1",
      name: "test-agent",
      scopes,
      tokenId: "tid_test123",
    });
    await next();
  });
  app.route("/api/tokens", tokens);
  return app;
}

describe("Token authz — requireTokenAdmin guard", () => {
  describe("authorized (scopes = full)", () => {
    const app = createApp("full");

    it("POST /api/tokens proceeds past guard (201 or 400, not 403)", async () => {
      const res = await app.request(
        "/api/tokens",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "new-token" }),
        },
        mockEnv,
      );
      expect(res.status).not.toBe(403);
      // 201 (success) or 400 (validation) — either proves the guard did not block
      expect([201, 400]).toContain(res.status);
    });

    it("GET /api/tokens proceeds past guard (200)", async () => {
      const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("DELETE /api/tokens/:name proceeds past guard (200 or 404, not 403)", async () => {
      const res = await app.request(
        "/api/tokens/some-token",
        { method: "DELETE" },
        mockEnv,
      );
      expect(res.status).not.toBe(403);
      expect([200, 404]).toContain(res.status);
    });
  });

  describe("unauthorized (scopes = read-only)", () => {
    const app = createApp("read-only");

    it("POST /api/tokens returns 403 TOKEN_AUTHZ_DENIED", async () => {
      const res = await app.request(
        "/api/tokens",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "new-token" }),
        },
        mockEnv,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string; message: string; retryable: boolean };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("token-authz-denied");
      expect(body.error.message).toBe(
        "Token management requires a full-scope D1 API token",
      );
      expect(body.error.retryable).toBe(false);
    });

    it("GET /api/tokens returns 403 TOKEN_AUTHZ_DENIED", async () => {
      const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string; retryable: boolean };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("token-authz-denied");
      expect(body.error.retryable).toBe(false);
    });

    it("DELETE /api/tokens/:name returns 403 TOKEN_AUTHZ_DENIED", async () => {
      const res = await app.request(
        "/api/tokens/target",
        { method: "DELETE" },
        mockEnv,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string; retryable: boolean };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("token-authz-denied");
      expect(body.error.retryable).toBe(false);
    });
  });
});
