import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type {
  CookieSessionTokenResult,
  D1TokenResult,
  Env,
  HonoVariables,
  SessionTokenResult,
  WorkspaceSessionTokenResult,
} from "../types";
import { requirePermission } from "./permission";

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

function makeSessionToken(permission: string): SessionTokenResult {
  return {
    kind: "session",
    projectId: "proj-1",
    name: "testuser",
    scopes: permission,
    tokenId: "",
    githubRepoId: 99999,
    githubLogin: "testuser",
    permission,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function makeCookieSessionToken(
  scopes: string,
  permission = "read",
): CookieSessionTokenResult {
  return {
    kind: "cookie-session",
    projectId: "proj-1",
    name: "test-actor",
    scopes,
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

function createTestApp(
  requiredLevel: "read" | "write" | "admin",
  tokenResult:
    | D1TokenResult
    | SessionTokenResult
    | CookieSessionTokenResult
    | WorkspaceSessionTokenResult,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Inject tokenResult before the permission guard
  app.use("/*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    return next();
  });
  app.use("/*", requirePermission(requiredLevel));
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

async function fetch200or403(
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

describe("requirePermission middleware", () => {
  describe("D1 tokens", () => {
    it('allows D1 token with scopes="full" for read-level route', async () => {
      const app = createTestApp("read", makeD1Token("full"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('allows D1 token with scopes="full" for write-level route', async () => {
      const app = createTestApp("write", makeD1Token("full"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it("blocks D1 token with non-full scopes", async () => {
      const app = createTestApp("read", makeD1Token("read"));
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });
  });

  describe("session tokens", () => {
    it('allows session token with permission="read" for read-level route', async () => {
      const app = createTestApp("read", makeSessionToken("read"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('allows session token with permission="write" for read-level route', async () => {
      const app = createTestApp("read", makeSessionToken("write"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('allows session token with permission="write" for write-level route', async () => {
      const app = createTestApp("write", makeSessionToken("write"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('allows session token with permission="admin" for write-level route', async () => {
      const app = createTestApp("write", makeSessionToken("admin"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('blocks session token with permission="read" for write-level route', async () => {
      const app = createTestApp("write", makeSessionToken("read"));
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });
  });

  describe("cookie-session tokens", () => {
    it("allows cookie-session with permission=admin for read-level route", async () => {
      const app = createTestApp(
        "read",
        makeCookieSessionToken("full", "admin"),
      );
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it("allows cookie-session with permission=admin for write-level route", async () => {
      const app = createTestApp(
        "write",
        makeCookieSessionToken("full", "admin"),
      );
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it("allows cookie-session with permission=write for write-level route", async () => {
      const app = createTestApp(
        "write",
        makeCookieSessionToken("full", "write"),
      );
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it("blocks cookie-session with permission=write on admin-level route (AC-2)", async () => {
      // AC-2: a GitHub write user must NOT reach admin-gated routes via cookie
      const app = createTestApp(
        "admin",
        makeCookieSessionToken("full", "write"),
      );
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });

    it("blocks cookie-session with permission=read on write-level route", async () => {
      const app = createTestApp(
        "write",
        makeCookieSessionToken("read", "read"),
      );
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });

    it("parity: cookie write→write guard behaves same as bearer write→write (AC-1)", async () => {
      const cookieApp = createTestApp(
        "write",
        makeCookieSessionToken("full", "write"),
      );
      const bearerApp = createTestApp("write", makeSessionToken("write"));
      const cookieResult = await fetch200or403(cookieApp);
      const bearerResult = await fetch200or403(bearerApp);
      expect(cookieResult.status).toBe(bearerResult.status);
    });

    it("parity: cookie write→admin guard behaves same as bearer write→admin (AC-1, AC-2)", async () => {
      const cookieApp = createTestApp(
        "admin",
        makeCookieSessionToken("full", "write"),
      );
      const bearerApp = createTestApp("admin", makeSessionToken("write"));
      const cookieResult = await fetch200or403(cookieApp);
      const bearerResult = await fetch200or403(bearerApp);
      // Both should be 403 — write does not reach admin
      expect(cookieResult.status).toBe(403);
      expect(bearerResult.status).toBe(403);
      expect(cookieResult.status).toBe(bearerResult.status);
    });

    it("parity: cookie admin→admin guard behaves same as bearer admin→admin (AC-1)", async () => {
      const cookieApp = createTestApp(
        "admin",
        makeCookieSessionToken("full", "admin"),
      );
      const bearerApp = createTestApp("admin", makeSessionToken("admin"));
      const cookieResult = await fetch200or403(cookieApp);
      const bearerResult = await fetch200or403(bearerApp);
      // Both should be 200
      expect(cookieResult.status).toBe(200);
      expect(bearerResult.status).toBe(200);
    });
  });

  describe("workspace-session tokens", () => {
    it("blocks workspace-session on any project route with PROJECT_REQUIRED", async () => {
      const app = createTestApp("read", makeWorkspaceSessionToken());
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "project-required",
      );
    });

    it("blocks workspace-session on write-level route with PROJECT_REQUIRED", async () => {
      const app = createTestApp("write", makeWorkspaceSessionToken());
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "project-required",
      );
    });

    it("blocks workspace-session on admin-level route with PROJECT_REQUIRED", async () => {
      const app = createTestApp("admin", makeWorkspaceSessionToken());
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "project-required",
      );
    });
  });

  describe("admin level", () => {
    it('allows D1 token with scopes="full" for admin-level route', async () => {
      const app = createTestApp("admin", makeD1Token("full"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('allows session token with permission="admin" for admin-level route', async () => {
      const app = createTestApp("admin", makeSessionToken("admin"));
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it('blocks session token with permission="write" on admin-level route', async () => {
      const app = createTestApp("admin", makeSessionToken("write"));
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });

    it('blocks session token with permission="read" on admin-level route', async () => {
      const app = createTestApp("admin", makeSessionToken("read"));
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });

    it("allows cookie-session with permission=admin for admin-level route", async () => {
      const app = createTestApp(
        "admin",
        makeCookieSessionToken("full", "admin"),
      );
      const { status } = await fetch200or403(app);
      expect(status).toBe(200);
    });

    it("blocks cookie-session with permission=read on admin-level route", async () => {
      const app = createTestApp(
        "admin",
        makeCookieSessionToken("read", "read"),
      );
      const { status, body } = await fetch200or403(app);
      expect(status).toBe(403);
      expect((body as { error: { code: string } }).error.code).toBe(
        "permission-denied",
      );
    });
  });
});

describe("project middleware — PROJECT_MISMATCH guard", () => {
  // Import and use projectMiddleware inline to test the mismatch guard
  it("returns 403 PROJECT_MISMATCH when session token projectId differs from route", async () => {
    const { projectMiddleware } = await import("./project");

    const mockProject = {
      idFromName: vi.fn().mockReturnValue("fake-id"),
      get: vi.fn().mockReturnValue({} as DurableObjectStub),
    } as unknown as DurableObjectNamespace;

    const projectEnv = {
      ...mockEnv,
      PROJECT: mockProject,
    } as unknown as Env;

    const tokenResult: SessionTokenResult = {
      kind: "session",
      projectId: "proj-OTHER",
      name: "testuser",
      scopes: "write",
      tokenId: "",
      githubRepoId: 99999,
      githubLogin: "testuser",
      permission: "write",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", tokenResult);
      return next();
    });
    app.use("/projects/:projectId/*", projectMiddleware);
    app.get("/projects/:projectId/entities", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/projects/proj-1/entities"),
      projectEnv,
      mockCtx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("project-mismatch");
  });

  it("passes through when session token projectId matches route", async () => {
    const { projectMiddleware } = await import("./project");

    const mockProject = {
      idFromName: vi.fn().mockReturnValue("fake-id"),
      get: vi.fn().mockReturnValue({} as DurableObjectStub),
    } as unknown as DurableObjectNamespace;

    const projectEnv = {
      ...mockEnv,
      PROJECT: mockProject,
    } as unknown as Env;

    const tokenResult: SessionTokenResult = {
      kind: "session",
      projectId: "proj-1",
      name: "testuser",
      scopes: "write",
      tokenId: "",
      githubRepoId: 99999,
      githubLogin: "testuser",
      permission: "write",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", tokenResult);
      return next();
    });
    app.use("/projects/:projectId/*", projectMiddleware);
    app.get("/projects/:projectId/entities", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/projects/proj-1/entities"),
      projectEnv,
      mockCtx,
    );
    expect(res.status).toBe(200);
  });

  it("returns 403 PROJECT_MISMATCH when D1 token projectId differs from route", async () => {
    const { projectMiddleware } = await import("./project");

    const mockProject = {
      idFromName: vi.fn().mockReturnValue("fake-id"),
      get: vi.fn().mockReturnValue({} as DurableObjectStub),
    } as unknown as DurableObjectNamespace;

    const projectEnv = {
      ...mockEnv,
      PROJECT: mockProject,
    } as unknown as Env;

    const tokenResult: D1TokenResult = {
      kind: "d1-token",
      projectId: "proj-DIFFERENT",
      name: "my-token",
      scopes: "full",
      tokenId: "tok-uuid",
    };

    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", tokenResult);
      return next();
    });
    app.use("/projects/:projectId/*", projectMiddleware);
    app.get("/projects/:projectId/entities", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/projects/proj-1/entities"),
      projectEnv,
      mockCtx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("project-mismatch");
  });
});
