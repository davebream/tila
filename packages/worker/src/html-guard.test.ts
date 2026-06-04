import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @tila/backend-d1 -- must be before any imports that use it
vi.mock("@tila/backend-d1", () => ({
  D1ProjectRegistry: vi.fn(),
  D1SessionStore: vi.fn().mockImplementation(
    class {
      validate = vi.fn();
    } as unknown as () => unknown,
  ),
  D1RateLimitStore: vi.fn().mockImplementation(
    class {
      check = vi.fn().mockResolvedValue(false);
      recordFailure = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  D1TokenStore: vi.fn().mockImplementation(
    class {
      validate = vi.fn().mockResolvedValue(null);
      updateLastUsedAt = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
}));

vi.mock("@tila/backend-r2", () => ({
  R2ArtifactBackend: vi.fn(),
}));

vi.mock("@tila/backend-do", () => ({
  ProjectDO: vi.fn(),
}));

// Suppress session-cache related mocks (no longer needed for root handler)
vi.mock("./lib/session-cache", () => ({
  getSessionFromCache: vi.fn().mockReturnValue(undefined),
  setSessionInCache: vi.fn(),
}));

const mod = await import("./index");

const mockEnv = {
  DB: {} as D1Database,
  PROJECT: {} as DurableObjectNamespace,
  ARTIFACTS: {} as R2Bucket,
  ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
};

const mockCtx = {
  waitUntil: vi.fn((p: Promise<unknown>) => p.catch(() => {})),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET / root handler (Static Assets owns /; Worker no longer handles bare /)", () => {
  it("does NOT return 200 JSON landing response on GET /", async () => {
    // In production, the [assets] binding serves SPA index.html for /.
    // The Worker no longer has app.get("/") — it was removed so Static Assets
    // can own the root path. In unit tests (no static assets), the request falls
    // through to auth-protected root-mounted routers (returns 401) or Hono's 404.
    // Either way, it must NOT be the old 200 JSON landing response.
    const req = new Request("http://localhost/");
    const res = await mod.default.fetch(req, mockEnv, mockCtx);
    // Must not be 200 OK with the old landing JSON body
    expect(res.status).not.toBe(200);
    // In test env (no static assets), should be 401 (auth middleware) or 404
    expect([401, 404]).toContain(res.status);
  });
});
