import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __clearAdminGrantsCache } from "../middleware/require-project-admin";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Admin gate DIVERGENCE regression — REAL middlewares.
//
// This file intentionally does NOT mock `../middleware/auth` (so requireD1Token
// is the genuine gate) nor `../middleware/require-project-admin` (so the genuine
// roster gate runs). It proves that a single roster bearer caller is ACCEPTED at
// /admin/restart (the one widened route) yet REJECTED at all four irreversible
// routes — which remain requireD1Token-only. A future PR that swaps
// requireProjectAdmin onto an irreversible route would flip those rejections to
// acceptances and fail this test.
// ─────────────────────────────────────────────────────────────────────────────

// Only leaf I/O is mocked.
const forwardToDOMock = vi.fn();
vi.mock("../lib/do-forward", () => ({
  forwardToDO: (...args: unknown[]) => forwardToDOMock(...args),
}));

// The roster lookup default; overridden per test.
const isActiveAdminMock = vi.fn().mockResolvedValue(true);

// CRITICAL: this mock MUST export AdminGrantsStore as a NEW-callable class —
// the real requireProjectAdmin runs `new AdminGrantsStore(c.env.DB)`. vitest's
// vi.fn().mockImplementation(() => ({...})) is not new-callable here, so use a
// class (matching admin.test.ts's pattern). Also export the stores the
// irreversible handlers touch so that, should a handler ever run, construction
// does not throw.
vi.mock("@tila/backend-d1", () => ({
  AdminGrantsStore: class {
    isActiveAdmin = isActiveAdminMock;
  } as unknown as () => unknown,
  D1ProjectRegistry: class {
    listAllIncludingArchived = vi.fn().mockResolvedValue([]);
  } as unknown as () => unknown,
  D1RevokedJtiStore: class {
    revoke = vi.fn().mockResolvedValue(undefined);
    isRevoked = vi.fn().mockResolvedValue(false);
  } as unknown as () => unknown,
}));

// revokeJtiInCache is a side-effect call inside the revoke handler.
vi.mock("../middleware/auth", () => ({
  revokeJtiInCache: vi.fn(),
}));

const { admin } = await import("./admin");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const mockEnv: Partial<Env> = {
  DB: {} as D1Database,
  ARTIFACTS: {} as R2Bucket,
};

/**
 * Build a roster bearer session WITH githubUserId AND githubHost set — without
 * them, requireProjectAdmin's null-identity guard fires first and restart would
 * be denied for the WRONG reason.
 */
function rosterBearer(): UnifiedTokenResult {
  return {
    kind: "session",
    projectId: "proj-target",
    name: "roster-user",
    scopes: "admin",
    tokenId: "tid_session",
    githubRepoId: 1,
    githubLogin: "roster-user",
    permission: "admin",
    expiresAt: Date.now() + 3_600_000,
    githubUserId: 4242,
    githubHost: "github.com",
  };
}

function createApp(tokenResult: UnifiedTokenResult): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("doStub", {} as DurableObjectStub);
    c.set("projectId", "proj-target");
    c.set("tokenResult", tokenResult);
    await next();
  });
  app.route("/admin", admin);
  return app;
}

function req(app: Hono<AppEnv>, path: string, method = "GET") {
  const headers =
    method === "POST" ? { "Content-Type": "application/json" } : undefined;
  const body =
    path === "/admin/sessions/revoke"
      ? JSON.stringify({ jti: "123e4567-e89b-12d3-a456-426614174000" })
      : undefined;
  return app.request(path, { method, headers, body }, mockEnv as Env);
}

describe("admin gate divergence (real middlewares)", () => {
  beforeEach(() => {
    forwardToDOMock.mockReset();
    forwardToDOMock.mockResolvedValue(Response.json({ ok: true }));
    isActiveAdminMock.mockReset();
    isActiveAdminMock.mockResolvedValue(true);
    __clearAdminGrantsCache();
  });

  it("accepts a roster bearer at /admin/restart but rejects it at the four irreversible routes", async () => {
    const app = createApp(rosterBearer());

    // /admin/restart — roster bearer accepted, forwarded to the DO.
    const restart = await req(app, "/admin/restart", "POST");
    expect(restart.status).toBe(200);
    expect(forwardToDOMock).toHaveBeenCalledWith(
      expect.anything(),
      "/admin/restart",
      "POST",
    );

    // The four irreversible routes remain requireD1Token-only → 403.
    const irreversible: Array<{ path: string; method: string }> = [
      { path: "/admin/destroy", method: "POST" },
      { path: "/admin/archive/journal", method: "POST" },
      { path: "/admin/store-counts", method: "GET" },
      { path: "/admin/sessions/revoke", method: "POST" },
    ];

    for (const { path, method } of irreversible) {
      forwardToDOMock.mockClear();
      const res = await req(app, path, method);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("d1-token-required");
      // Rejected before any DO forward.
      expect(forwardToDOMock).not.toHaveBeenCalled();
    }
  });

  it("rejects /admin/restart for a non-roster bearer (isActiveAdmin → false)", async () => {
    isActiveAdminMock.mockResolvedValue(false);
    const app = createApp(rosterBearer());

    const res = await req(app, "/admin/restart", "POST");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("permission-denied");
    expect(forwardToDOMock).not.toHaveBeenCalled();
  });
});
