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

// Mock D1TokenStore, D1SessionStore, AdminGrantsStore, and D1ProjectRegistry
// at the boundary — no live D1 needed.
// AdminGrantsStore and D1ProjectRegistry are imported by require-project-admin.ts
// and MUST be present in this factory or `new undefined()` throws at first gate use.
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
  // AdminGrantsStore: stub — isActiveAdmin is not on the admit path for
  // requireD1TokenHttp (no roster lookup), but the export must exist so the
  // import in require-project-admin.ts resolves without throwing.
  AdminGrantsStore: vi.fn().mockImplementation(
    class {
      isActiveAdmin = vi.fn().mockResolvedValue(false);
    } as unknown as () => unknown,
  ),
  // D1ProjectRegistry: getRepoAdminAutoAdmin must resolve to true so that
  // requireProjectAdminHttp admits a flag-on admin session pre-swap — this
  // produces a genuine RED (session is admitted) rather than a deny-by-throw.
  D1ProjectRegistry: vi.fn().mockImplementation(
    class {
      getRepoAdminAutoAdmin = vi.fn().mockResolvedValue(true);
    } as unknown as () => unknown,
  ),
}));

// Import route AFTER mocks are set up.
// requireProjectAdminHttp and requireD1TokenHttp run REAL logic (no gate mock).
const { tokens } = await import("./tokens");
import {
  __clearAdminGrantsCache,
  __clearProjectAutoAdminCache,
} from "../middleware/require-project-admin";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

// Mock env — D1TokenStore is fully mocked so DB value is never actually used.
// DB must be present so the real gate can construct D1ProjectRegistry(c.env.DB).
const mockEnv = { DB: {} } as unknown as Env;

function makeD1Token(scopes: string): D1TokenResult {
  return {
    kind: "d1-token",
    projectId: "proj-123",
    name: "admin-token",
    scopes,
    tokenId: "test-token-id-uuid",
  };
}

function makeSessionToken(permission = "admin"): SessionTokenResult {
  return {
    kind: "session",
    projectId: "proj-123",
    name: "testuser",
    scopes: permission,
    tokenId: "",
    githubRepoId: 99999,
    githubLogin: "testuser",
    permission,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    githubUserId: 4242,
    githubHost: "github.com",
  };
}

function makeCookieSessionToken(
  permission = "admin",
): CookieSessionTokenResult {
  return {
    kind: "cookie-session",
    projectId: "proj-123",
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

function createApp(
  tokenResult:
    | D1TokenResult
    | SessionTokenResult
    | CookieSessionTokenResult
    | WorkspaceSessionTokenResult = {
    kind: "d1-token" as const,
    projectId: "proj-123",
    name: "admin-token",
    scopes: "full",
    tokenId: "test-token-id-uuid",
  },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Simulate auth middleware setting tokenResult
  app.use("*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    await next();
  });

  app.route("/api/tokens", tokens);
  return app;
}

describe("DELETE /api/tokens/:name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevoke.mockResolvedValue({ revoked: true, tokenHash: null });
    mockIssue.mockResolvedValue({ tokenId: "new-tid" });
    mockList.mockResolvedValue([]);
    __clearAdminGrantsCache();
    __clearProjectAutoAdminCache();
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
    expect(body.error.code).toBe("token-not-found");
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

// ============================================================================
// Gate tests on token routes — real gate runs (no mock override)
// These cases drive REAL principals through requireD1TokenHttp (post-swap) and
// verify the correct 403/pass behavior. The D1ProjectRegistry mock resolves
// getRepoAdminAutoAdmin → true so requireProjectAdminHttp (pre-swap) admits
// flag-on admin sessions, giving a genuine RED before the Task 4 swap.
// ============================================================================
describe("token routes — D1 token gate (real gate, cases 10-12b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevoke.mockResolvedValue({ revoked: true, tokenHash: null });
    mockIssue.mockResolvedValue({ tokenId: "new-tid" });
    mockList.mockResolvedValue([]);
    // Clear per-isolate caches so stale entries from other cases do not
    // contaminate the auto-admin flag lookup path.
    __clearAdminGrantsCache();
    __clearProjectAutoAdminCache();
  });

  // d1-token "full" ⇒ pass (happy-path baseline)
  it("case 10b: d1-token full-scope ⇒ pass (GET /api/tokens)", async () => {
    const app = createApp(makeD1Token("full"));
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(200);
  });

  it("case 10b: d1-token full-scope ⇒ pass (POST /api/tokens)", async () => {
    mockIssue.mockResolvedValue({ tokenId: "minted-tid" });
    const app = createApp(makeD1Token("full"));
    const res = await app.request(
      "/api/tokens",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-token" }),
      },
      mockEnv,
    );
    expect(res.status).toBe(201);
  });

  it("case 10b: d1-token full-scope ⇒ pass (DELETE /api/tokens/:name)", async () => {
    const app = createApp(makeD1Token("full"));
    const res = await app.request(
      "/api/tokens/some-token",
      { method: "DELETE" },
      mockEnv,
    );
    expect(res.status).toBe(200);
  });

  // d1-token "read" ⇒ 403
  it("d1-token read-scope ⇒ 403 (GET)", async () => {
    const app = createApp(makeD1Token("read"));
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("d1-token read-scope ⇒ 403 (POST)", async () => {
    const app = createApp(makeD1Token("read"));
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
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("d1-token read-scope ⇒ 403 (DELETE)", async () => {
    const app = createApp(makeD1Token("read"));
    const res = await app.request(
      "/api/tokens/some-token",
      { method: "DELETE" },
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  // d1-token "" (empty scope) ⇒ 403 — pins strict === "full"
  it("d1-token empty-scope ⇒ 403 (GET)", async () => {
    const app = createApp(makeD1Token(""));
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  // flag-on admin session ⇒ 403 (RED before Task 4 swap, GREEN after swap)
  it("case 11: flag-on admin bearer session ⇒ 403 (GET)", async () => {
    const app = createApp(makeSessionToken("admin"));
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("case 11: flag-on admin bearer session ⇒ 403 (POST)", async () => {
    const app = createApp(makeSessionToken("admin"));
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
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("case 11: flag-on admin bearer session ⇒ 403 (DELETE)", async () => {
    const app = createApp(makeSessionToken("admin"));
    const res = await app.request(
      "/api/tokens/some-token",
      { method: "DELETE" },
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  // flag-on admin cookie-session ⇒ 403 (RED before Task 4 swap, GREEN after swap)
  it("case 11b: flag-on admin cookie-session ⇒ 403 (POST)", async () => {
    const app = createApp(makeCookieSessionToken("admin"));
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
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("case 11b: flag-on admin cookie-session ⇒ 403 (GET)", async () => {
    const app = createApp(makeCookieSessionToken("admin"));
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("case 11b: flag-on admin cookie-session ⇒ 403 (DELETE)", async () => {
    const app = createApp(makeCookieSessionToken("admin"));
    const res = await app.request(
      "/api/tokens/some-token",
      { method: "DELETE" },
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  // workspace-session ⇒ 403 (fail-closed)
  it("case 12b: workspace-session ⇒ 403 (GET)", async () => {
    const app = createApp(makeWorkspaceSessionToken());
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });
});
