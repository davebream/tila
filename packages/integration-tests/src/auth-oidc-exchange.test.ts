import {
  _resetMiddlewareStateForTest,
  authFixtures,
  backendD1MockFactory,
  createAuthMiddleware,
  makeAuthEnv,
} from "@tila/worker/test-support";
/**
 * auth-oidc-exchange.test.ts — WI-B2 (#125) integration: the generic OIDC
 * session trust boundary.
 *
 * The security-critical invariant for WI-B2 is that a session minted from a
 * generic OIDC exchange (kind: "oidc-session") can NEVER reach a GitHub-coupled
 * project-admin gate, while still being a usable session at its granted
 * permission tier. This is proven here end-to-end through the real
 * `createAuthMiddleware` + `requireProjectAdmin` / `requireProjectAdminHttp`
 * code paths.
 *
 * Seam: plain Node Vitest (see vitest.config.ts). The `oidc-session` admin-deny
 * path touches NO D1 (requireProjectAdmin branch (4) and requireProjectAdminHttp
 * via autoAdminGrants' kind-filter both deny before any store call), so no D1
 * binding is needed — the structural absence of any AdminGrantsStore call is
 * itself the "no _admin_grants row written" proof.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requirePermission } from "../../worker/src/middleware/permission";
import {
  requireProjectAdmin,
  requireProjectAdminHttp,
} from "../../worker/src/middleware/require-project-admin";
import type { Env, HonoVariables } from "../../worker/src/types";

// Control the deployment instance id the auth middleware "sees".
vi.mock("../../worker/src/lib/deployment-instance", () => ({
  ensureDeploymentInstanceId: () => Promise.resolve("inst-1"),
  __resetInstanceCache: vi.fn(),
}));

// Store behavior comes from the shared mock factory (paired with makeAuthEnv).
vi.mock("@tila/backend-d1", () => backendD1MockFactory());

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const execCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function buildApp() {
  const app = new Hono<AppEnv>();
  app.use("*", createAuthMiddleware());
  // Mimic project middleware: requireProjectAdmin reads c.get("projectId").
  app.use("/projects/:projectId/*", async (c, next) => {
    c.set("projectId", c.req.param("projectId"));
    return next();
  });
  app.use("/projects/:projectId/admin", requireProjectAdmin);
  app.get("/projects/:projectId/admin", (c) => c.json({ ok: true }));

  // requireProjectAdminHttp-gated route (repo/token management style).
  app.post("/manage", async (c, next) => {
    const denied = await requireProjectAdminHttp(c);
    if (denied) return denied;
    return next();
  });
  app.post("/manage", (c) => c.json({ ok: true }));

  // A plain write-gated route to prove the oidc-session is a usable session.
  app.use("/projects/:projectId/write", requirePermission("write"));
  app.get("/projects/:projectId/write", (c) => c.json({ ok: true }));

  return app;
}

async function oidcToken(
  permission: "read" | "write" | "admin",
): Promise<string> {
  // The fixture base is github-shaped; the discriminated-union parse keeps only
  // the oidc fields once sub_type is "oidc". No jti → skips the revocation D1 read.
  return authFixtures.mintSessionToken({
    sub_type: "oidc",
    project_id: "proj-1",
    oidc_issuer: "https://idp.example.com",
    oidc_subject: "workload-1",
    actor_name: "workload-1",
    permission,
  });
}

beforeEach(() => {
  _resetMiddlewareStateForTest();
});

describe("WI-B2 oidc-session trust boundary", () => {
  it("is denied by requireProjectAdmin with permission-denied (no roster touch)", async () => {
    const app = buildApp();
    const token = await oidcToken("admin");
    const res = await app.fetch(
      new Request("http://localhost/projects/proj-1/admin", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeAuthEnv(),
      execCtx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("permission-denied");
  });

  it("is denied by requireProjectAdminHttp with token-authz-denied", async () => {
    const app = buildApp();
    const token = await oidcToken("admin");
    const res = await app.fetch(
      new Request("http://localhost/manage", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeAuthEnv(),
      execCtx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("token-authz-denied");
  });

  it("is a usable session: a write-permission oidc-session passes a write gate", async () => {
    const app = buildApp();
    const token = await oidcToken("write");
    const res = await app.fetch(
      new Request("http://localhost/projects/proj-1/write", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeAuthEnv(),
      execCtx,
    );
    expect(res.status).toBe(200);
  });
});
