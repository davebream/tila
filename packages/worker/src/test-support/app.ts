/**
 * createAuthTestApp — builds a Hono test app with auth middleware + routes.
 *
 * Mirrors the app construction in routes/auth-github.test.ts:135-139 and
 * middleware/auth.test.ts:200-208 — no new abstractions, just a shared factory.
 *
 * When mountProjectRoute is true, also mounts projectMiddleware + a stub probe
 * route at /projects/:projectId/_probe. This is required for project-mismatch
 * tests because the mismatch guard lives in projectMiddleware (project.ts:36),
 * NOT in the auth routes. The probe mirrors the production route prefix
 * /projects/:projectId at index.ts:198 (NOT /api/projects).
 *
 * The generic OIDC exchange route (WI-B1) is not yet on main; it is excluded.
 * When WI-B1 lands, add a guarded import here and mount it conditionally.
 */
import type { RateLimitStoreInterface } from "@tila/backend-d1";
import { Hono } from "hono";
import { createAuthMiddleware } from "../middleware/auth";
import { projectMiddleware } from "../middleware/project";
import { authGithub } from "../routes/auth-github";
import {
  authSessionExchange,
  authSessionProtected,
} from "../routes/auth-session";
import { tokens } from "../routes/tokens";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/**
 * Build a Hono test app with:
 *  - createAuthMiddleware (with optional rateLimitStore override)
 *  - auth route handlers: github exchange, session exchange, session protected, tokens
 *  - optionally: projectMiddleware + a stub GET /projects/:projectId/_probe
 *
 * @param env - The Env for this app (from makeAuthEnv)
 * @param opts.mountProjectRoute - Mount projectMiddleware + a stub probe route for
 *   project-mismatch tests. The probe returns 200 on success, allowing the test
 *   to distinguish 200 (match), 403 project-mismatch, or 401 unauthorized.
 * @param opts.rateLimitStore - Override rate-limit store injected into createAuthMiddleware.
 */
export function createAuthTestApp(
  _env: Env,
  opts?: {
    mountProjectRoute?: boolean;
    rateLimitStore?: RateLimitStoreInterface;
  },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Auth routes that do NOT require prior auth middleware (exchange endpoints)
  app.route("/api/auth/github", authGithub);
  app.route("/auth/session", authSessionExchange);

  // Auth-protected routes: mount middleware then the protected sub-routers
  const protectedRoutes = new Hono<AppEnv>();
  protectedRoutes.use(
    "/*",
    createAuthMiddleware({ rateLimitStore: opts?.rateLimitStore }),
  );
  protectedRoutes.route("/auth/session", authSessionProtected);
  protectedRoutes.route("/api/tokens", tokens);

  // Optional project route for project-mismatch tests
  if (opts?.mountProjectRoute) {
    protectedRoutes.use("/projects/:projectId/*", projectMiddleware);
    protectedRoutes.get("/projects/:projectId/_probe", (c) =>
      c.json({ ok: true, projectId: c.req.param("projectId") }),
    );
  }

  app.route("/", protectedRoutes);

  return app;
}
