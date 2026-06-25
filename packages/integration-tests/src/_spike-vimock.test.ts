import {
  _resetMiddlewareStateForTest,
  createAuthMiddleware,
} from "@tila/worker/test-support";
/**
 * Cross-package vi.mock feasibility spike.
 *
 * Proves that vi.mock("@tila/backend-d1") declared in an integration-tests
 * file intercepts the @tila/backend-d1 import made by worker source code
 * (createAuthMiddleware) across the pnpm workspace boundary.
 *
 * This spike is intentionally minimal:
 * - NO createAuthTestApp (not built yet — that is Task 3)
 * - Inline Hono app construction
 * - Minimal mock factory
 *
 * If this test PASSES: cross-package mock interception works. Proceed.
 * If it CANNOT pass: HALT and surface for Option B re-plan.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal D1 mock — only the stores that createAuthMiddleware constructs.
// The call to new D1SessionStore / D1RateLimitStore / D1RevokedJtiStore must
// not throw, and validate/isRevoked must return null/false so the middleware
// reaches the "no-auth-header" 401 branch.
vi.mock("@tila/backend-d1", () => ({
  D1SessionStore: vi.fn().mockImplementation(
    class {
      validate = vi.fn().mockResolvedValue(null);
    } as unknown as () => unknown,
  ),
  D1RateLimitStore: vi.fn().mockImplementation(
    class {
      check = vi.fn().mockResolvedValue(false);
      recordFailure = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  D1RevokedJtiStore: vi.fn().mockImplementation(
    class {
      isRevoked = vi.fn().mockResolvedValue(false);
      revoke = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  D1TokenStore: vi.fn().mockImplementation(
    class {
      validate = vi.fn().mockResolvedValue(null);
      updateLastUsedAt = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  D1IdempotencyStore: vi.fn().mockImplementation(
    class {
      check = vi.fn().mockResolvedValue(null);
      store = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  RepoAllowlistStore: vi.fn().mockImplementation(
    class {
      listForProject = vi.fn().mockResolvedValue([]);
      isRegistered = vi.fn().mockResolvedValue(null);
    } as unknown as () => unknown,
  ),
  GitHubAppConfigStore: vi.fn().mockImplementation(
    class {
      setInstallation = vi.fn().mockResolvedValue(undefined);
      getInstallation = vi.fn().mockResolvedValue(null);
    } as unknown as () => unknown,
  ),
}));

// Minimal Env stub — enough to satisfy createAuthMiddleware without crashing.
const mockWaitUntil = vi.fn((p: Promise<unknown>) => p);

const testEnv = {
  DB: {} as D1Database,
  PROJECT: {
    idFromName: vi.fn().mockReturnValue({ toString: () => "stub-id" }),
    get: vi.fn().mockReturnValue({
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        ),
    }),
  } as unknown as DurableObjectNamespace,
  ARTIFACTS: {} as R2Bucket,
  ANALYTICS: {
    writeDataPoint: vi.fn(),
  } as unknown as AnalyticsEngineDataset,
  GITHUB_SESSION_HMAC_KEY: btoa("test-hmac-key-this-is-32-bytes!!")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, ""),
};

function buildSpikeApp() {
  const app = new Hono<{ Bindings: typeof testEnv }>();
  app.use("/*", createAuthMiddleware());
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("cross-package vi.mock spike", () => {
  beforeEach(() => {
    _resetMiddlewareStateForTest();
  });

  it("unauthenticated request is rejected with 401 unauthorized", async () => {
    const app = buildSpikeApp();
    const req = new Request("http://localhost/probe");
    const res = await app.fetch(req, testEnv, {
      waitUntil: mockWaitUntil,
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unauthorized");
  });
});
