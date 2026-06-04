import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";

// Mock the token-cache module to spy on invalidate.
// Must be declared before importing anything that imports token-cache.
const mockInvalidate = vi.fn();

vi.mock("../lib/token-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/token-cache")>();
  return {
    ...actual,
    invalidate: mockInvalidate,
  };
});

// Mock D1TokenStore and D1SessionStore at the boundary — no live D1 needed.
const mockRevoke = vi.fn();
const mockIssue = vi.fn().mockResolvedValue(undefined);
const mockList = vi.fn().mockResolvedValue([]);
const mockDeleteByTokenHash = vi.fn().mockResolvedValue({ deleted: 0 });

vi.mock("@tila/backend-d1", () => ({
  D1TokenStore: vi.fn().mockImplementation(
    class {
      revoke = mockRevoke;
      issue = mockIssue;
      list = mockList;
    } as unknown as () => unknown,
  ),
  D1SessionStore: vi.fn().mockImplementation(
    class {
      deleteByTokenHash = mockDeleteByTokenHash;
    } as unknown as () => unknown,
  ),
}));

// Import route AFTER mocks are set up.
const { tokens } = await import("./tokens");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

// Mock env — D1TokenStore is fully mocked so DB value is never actually used.
const mockEnv = { DB: {} } as unknown as Env;

function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Simulate auth middleware setting tokenResult
  app.use("*", async (c, next) => {
    c.set("tokenResult", {
      kind: "d1-token" as const,
      projectId: "proj-123",
      name: "admin-token",
      scopes: "full",
      tokenId: "test-token-id-uuid",
    });
    await next();
  });

  app.route("/api/tokens", tokens);
  return app;
}

describe("DELETE /api/tokens/:name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls invalidate(tokenHash) synchronously on successful revoke", async () => {
    mockRevoke.mockResolvedValue({ revoked: true, tokenHash: "abc123hash" });
    const app = createApp();

    const res = await app.request(
      "/api/tokens/my-token",
      { method: "DELETE" },
      mockEnv,
    );

    expect(res.status).toBe(200);
    expect(mockInvalidate).toHaveBeenCalledWith("abc123hash");
    expect(mockInvalidate).toHaveBeenCalledTimes(1);

    const body = (await res.json()) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("my-token");
    // tokenHash must NOT appear in response (contracts.md Invariant 3)
    expect(JSON.stringify(body)).not.toContain("abc123hash");
  });

  it("does NOT call invalidate when tokenHash is null", async () => {
    mockRevoke.mockResolvedValue({ revoked: true, tokenHash: null });
    const app = createApp();

    const res = await app.request(
      "/api/tokens/my-token",
      { method: "DELETE" },
      mockEnv,
    );

    expect(res.status).toBe(200);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("returns 404 when token not found (revoked: false)", async () => {
    mockRevoke.mockResolvedValue({ revoked: false, tokenHash: null });
    const app = createApp();

    const res = await app.request(
      "/api/tokens/unknown-token",
      { method: "DELETE" },
      mockEnv,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("TOKEN_NOT_FOUND");
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("passes revokedBy from tokenResult.name to store.revoke()", async () => {
    mockRevoke.mockResolvedValue({ revoked: true, tokenHash: "somehash" });
    const app = createApp();

    await app.request(
      "/api/tokens/target-token",
      { method: "DELETE" },
      mockEnv,
    );

    expect(mockRevoke).toHaveBeenCalledWith(
      "proj-123",
      "target-token",
      "admin-token",
    );
  });

  it("calls D1SessionStore.deleteByTokenHash on successful revoke", async () => {
    mockRevoke.mockResolvedValue({ revoked: true, tokenHash: "abc123hash" });
    const app = createApp();

    const res = await app.request(
      "/api/tokens/my-token",
      { method: "DELETE" },
      mockEnv,
    );

    expect(res.status).toBe(200);
    expect(mockDeleteByTokenHash).toHaveBeenCalledWith("abc123hash");
    expect(mockDeleteByTokenHash).toHaveBeenCalledTimes(1);
  });

  it("does NOT call deleteByTokenHash when tokenHash is null", async () => {
    mockRevoke.mockResolvedValue({ revoked: true, tokenHash: null });
    const app = createApp();

    const res = await app.request(
      "/api/tokens/my-token",
      { method: "DELETE" },
      mockEnv,
    );

    expect(res.status).toBe(200);
    expect(mockDeleteByTokenHash).not.toHaveBeenCalled();
  });

  it("does NOT call deleteByTokenHash when token not found", async () => {
    mockRevoke.mockResolvedValue({ revoked: false, tokenHash: null });
    const app = createApp();

    const res = await app.request(
      "/api/tokens/unknown-token",
      { method: "DELETE" },
      mockEnv,
    );

    expect(res.status).toBe(404);
    expect(mockDeleteByTokenHash).not.toHaveBeenCalled();
  });
});
