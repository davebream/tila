import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CookieSessionTokenResult,
  D1TokenResult,
  Env,
  HonoVariables,
  SessionTokenResult,
  WorkspaceSessionTokenResult,
} from "../types";

// --- Test seam (committed) -------------------------------------------------
// The middleware constructs `new AdminGrantsStore(c.env.DB)` directly, so the
// module boundary is the seam. Every constructed instance shares the same
// stubbable `isActiveAdmin` mock.
const mockIsActiveAdmin = vi.fn();
vi.mock("@tila/backend-d1", () => ({
  AdminGrantsStore: class {
    isActiveAdmin = mockIsActiveAdmin;
  },
}));

import {
  __clearAdminGrantsCache,
  requireProjectAdmin,
} from "./require-project-admin";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const mockEnv = {
  DB: {} as D1Database,
  PROJECT: {} as DurableObjectNamespace,
  ARTIFACTS: {} as R2Bucket,
  ANALYTICS: {} as AnalyticsEngineDataset,
} as unknown as Env;

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function makeD1Token(scopes: string): D1TokenResult {
  return {
    kind: "d1-token",
    projectId: "proj-1",
    name: "test-token",
    scopes,
    tokenId: "tok-uuid",
  };
}

function makeSessionToken(
  opts: {
    projectId?: string;
    githubUserId?: number | undefined;
    githubHost?: string | undefined;
  } = {},
): SessionTokenResult {
  return {
    kind: "session",
    projectId: opts.projectId ?? "proj-1",
    name: "testuser",
    scopes: "admin",
    tokenId: "",
    githubRepoId: 99999,
    githubLogin: "testuser",
    permission: "admin",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    githubUserId: "githubUserId" in opts ? opts.githubUserId : 4242,
    githubHost: "githubHost" in opts ? opts.githubHost : "github.com",
  };
}

function makeCookieSessionToken(
  permission = "admin",
): CookieSessionTokenResult {
  return {
    kind: "cookie-session",
    projectId: "proj-1",
    name: "test-actor",
    scopes: "full",
    tokenId: "",
    sessionHash: "test-hash",
    expiresAt: Date.now() + 3600_000,
    permission,
  };
}

function makeWorkspaceSessionToken(): WorkspaceSessionTokenResult {
  return {
    kind: "workspace-session",
    projectId: "",
    name: "gh-alice",
    scopes: "",
    tokenId: "",
    sessionHash: "ws-hash",
    githubLogin: "gh-alice",
    expiresAt: Date.now() + 3600_000,
  };
}

/**
 * Build an app whose pre-middleware injects the given tokenResult and projectId
 * (mirroring the live auth + project middleware), then mounts requireProjectAdmin.
 */
function createTestApp(
  tokenResult:
    | D1TokenResult
    | SessionTokenResult
    | CookieSessionTokenResult
    | WorkspaceSessionTokenResult
    | undefined,
  projectId: string | undefined = "proj-1",
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    if (tokenResult !== undefined) {
      c.set("tokenResult", tokenResult);
    }
    if (projectId !== undefined) {
      c.set("projectId", projectId);
    }
    return next();
  });
  app.use("/*", requireProjectAdmin);
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

async function fetchStatus(
  app: Hono<AppEnv>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.fetch(
    new Request("http://localhost/test"),
    mockEnv,
    mockCtx,
  );
  const body = await res.json();
  return { status: res.status, body };
}

function expectDenied(result: { status: number; body: unknown }): void {
  expect(result.status).toBe(403);
  expect((result.body as { error: { code: string } }).error.code).toBe(
    "permission-denied",
  );
}

describe("requireProjectAdmin middleware", () => {
  beforeEach(() => {
    mockIsActiveAdmin.mockReset();
    // Fixtures reuse proj-1/4242; a leaked positive entry would false-green a
    // later deny case before isActiveAdmin is consulted.
    __clearAdminGrantsCache();
  });

  describe("d1-token", () => {
    it("passes full-scope d1-token WITHOUT calling the roster store", async () => {
      const app = createTestApp(makeD1Token("full"));
      const { status } = await fetchStatus(app);
      expect(status).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it('denies non-full-scope d1-token (e.g. "read")', async () => {
      const app = createTestApp(makeD1Token("read"));
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });
  });

  describe("bearer session — roster lookup", () => {
    it("passes a roster member (isActiveAdmin → true)", async () => {
      mockIsActiveAdmin.mockResolvedValueOnce(true);
      const app = createTestApp(makeSessionToken());
      const { status } = await fetchStatus(app);
      expect(status).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledWith(
        "proj-1",
        "github.com",
        4242,
      );
    });

    it("denies a non-member (isActiveAdmin → false)", async () => {
      mockIsActiveAdmin.mockResolvedValueOnce(false);
      const app = createTestApp(makeSessionToken());
      expectDenied(await fetchStatus(app));
    });

    it("denies when githubUserId is null and does NOT call the lookup", async () => {
      const app = createTestApp(makeSessionToken({ githubUserId: undefined }));
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("denies when githubHost is null and does NOT call the lookup", async () => {
      const app = createTestApp(makeSessionToken({ githubHost: undefined }));
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("denies when projectId is missing/empty and does NOT call the lookup", async () => {
      const app = createTestApp(makeSessionToken(), "");
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("fails closed on D1 throw AND does not cache the error (re-queries within TTL)", async () => {
      mockIsActiveAdmin.mockRejectedValueOnce(new Error("D1 down"));
      const app1 = createTestApp(makeSessionToken());
      expectDenied(await fetchStatus(app1));

      // Second call within TTL: if the error were cached, isActiveAdmin would
      // not be invoked again. It MUST be re-invoked → call count == 2.
      mockIsActiveAdmin.mockResolvedValueOnce(true);
      const app2 = createTestApp(makeSessionToken());
      const { status } = await fetchStatus(app2);
      expect(status).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(2);
    });
  });

  describe("non-bearer / unknown kinds", () => {
    it('denies cookie-session even with permission="admin"', async () => {
      const app = createTestApp(makeCookieSessionToken("admin"));
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("denies workspace-session", async () => {
      const app = createTestApp(makeWorkspaceSessionToken());
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("denies an unknown token kind", async () => {
      const app = createTestApp({
        kind: "mystery",
      } as unknown as D1TokenResult);
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });

    it("denies when tokenResult is missing", async () => {
      const app = createTestApp(undefined);
      expectDenied(await fetchStatus(app));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(0);
    });
  });

  describe("cache semantics", () => {
    it("cross-project isolation: a positive entry for projA does NOT satisfy projB", async () => {
      // Prime projA → true (cached positive).
      mockIsActiveAdmin.mockResolvedValueOnce(true);
      const appA = createTestApp(
        makeSessionToken({ projectId: "projA" }),
        "projA",
      );
      expect((await fetchStatus(appA)).status).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(1);

      // projB with the same host/user must NOT hit projA's cache entry.
      mockIsActiveAdmin.mockResolvedValueOnce(false);
      const appB = createTestApp(
        makeSessionToken({ projectId: "projB" }),
        "projB",
      );
      expectDenied(await fetchStatus(appB));
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(2);
      expect(mockIsActiveAdmin).toHaveBeenLastCalledWith(
        "projB",
        "github.com",
        4242,
      );
    });

    it("caches a positive result: a second call within TTL is served from cache", async () => {
      mockIsActiveAdmin.mockResolvedValueOnce(true);
      const app1 = createTestApp(makeSessionToken());
      expect((await fetchStatus(app1)).status).toBe(200);

      // No further mock setup; if the cache works, isActiveAdmin is not called again.
      const app2 = createTestApp(makeSessionToken());
      expect((await fetchStatus(app2)).status).toBe(200);
      expect(mockIsActiveAdmin).toHaveBeenCalledTimes(1);
    });

    it("revocation observed once cached entry expires (distinct triples)", async () => {
      vi.useFakeTimers();
      try {
        const { ADMIN_GRANTS_CACHE_TTL_MS } = await import("../config");

        // Member granted → cached true.
        mockIsActiveAdmin.mockResolvedValueOnce(true);
        const app1 = createTestApp(makeSessionToken());
        expect((await fetchStatus(app1)).status).toBe(200);
        expect(mockIsActiveAdmin).toHaveBeenCalledTimes(1);

        // Advance past TTL → entry expires → re-query.
        vi.advanceTimersByTime(ADMIN_GRANTS_CACHE_TTL_MS + 1);

        mockIsActiveAdmin.mockResolvedValueOnce(false);
        const app2 = createTestApp(makeSessionToken());
        expectDenied(await fetchStatus(app2));
        expect(mockIsActiveAdmin).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
