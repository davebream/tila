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

// Mock require-project-admin so we can control requireProjectAdminHttp.
const mockRequireProjectAdminHttp = vi.fn<() => Promise<Response | null>>();

vi.mock("../middleware/require-project-admin", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../middleware/require-project-admin")
    >();
  return {
    ...actual,
    requireProjectAdminHttp: mockRequireProjectAdminHttp,
  };
});

// Import route AFTER mocks are set up.
const { tokens } = await import("./tokens");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

// Mock env — D1TokenStore is fully mocked so DB value is never actually used.
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

const deny403 = () =>
  new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: "token-authz-denied",
        message:
          "Repo/token management requires full scope or an admin session",
        retryable: false,
      },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );

describe("DELETE /api/tokens/:name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes (d1-token full-scope baseline)
    mockRequireProjectAdminHttp.mockResolvedValue(null);
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
// Auto-admin gate on token routes (design Testing-Strategy cases 10-12b)
// ============================================================================
describe("token routes — auto-admin gate (cases 10-12b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevoke.mockResolvedValue({ revoked: true, tokenHash: null });
    mockIssue.mockResolvedValue({ tokenId: "new-tid" });
    mockList.mockResolvedValue([]);
  });

  // Case 10: flag off + admin session ⇒ 403; d1-token full-scope ⇒ allowed (AC-2 baseline)
  it("case 10a: flag off + admin session ⇒ 403 (AC-2)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(deny403());
    const app = createApp(makeSessionToken("admin"));
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("case 10b: d1-token full-scope ⇒ allowed (AC-2 baseline regression)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(null); // gate passes
    const app = createApp(makeD1Token("full"));
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(200);
  });

  // Case 11: flag on + admin BEARER session ⇒ allowed at tokens.ts route
  it("case 11: flag on + admin bearer session ⇒ allowed at GET /api/tokens", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(null); // gate passes (flag on)
    const app = createApp(makeSessionToken("admin"));
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(200);
  });

  // Case 11b: flag on + admin COOKIE-session ⇒ allowed at POST /api/tokens (mint)
  //           flag off + admin cookie-session ⇒ 403 (security-sensitive browser→mint path)
  it("case 11b-allow: flag on + admin cookie-session ⇒ allowed at POST /api/tokens (mint)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(null); // gate passes (flag on)
    mockIssue.mockResolvedValue({ tokenId: "minted-tid" });
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
    // Gate passes → hits route body; issue is mocked → 201
    expect(res.status).toBe(201);
  });

  it("case 11b-deny: flag off + admin cookie-session ⇒ 403 at POST /api/tokens (security gate)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(deny403());
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

  // Case 12: flag on + non-admin session ⇒ 403
  it("case 12: flag on + non-admin session (write permission) ⇒ 403", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(deny403());
    const app = createApp(makeSessionToken("write"));
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  // Case 12b: workspace-session / empty-projectId ⇒ 403 (fail-closed contract)
  it("case 12b: workspace-session ⇒ 403 (fail-closed)", async () => {
    mockRequireProjectAdminHttp.mockResolvedValue(deny403());
    const app = createApp(makeWorkspaceSessionToken());
    const res = await app.request("/api/tokens", { method: "GET" }, mockEnv);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });
});
