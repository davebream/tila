import { Hono } from "hono";
import { emitRequestDatapoint, emitSweepErrorDatapoint } from "./lib/analytics";
import { constantTimeSecretMatch } from "./lib/constant-time-compare";
import { runSweep } from "./lib/sweep";
import { createAuthMiddleware } from "./middleware/auth";
import { createCacheMiddleware } from "./middleware/cache";
import { createCorsMiddleware } from "./middleware/cors";
import { csrfGuard } from "./middleware/csrf";
import { errorHandler } from "./middleware/error";
import { createIdempotencyMiddleware } from "./middleware/idempotency";
import { projectMiddleware } from "./middleware/project";
import { requestIdMiddleware } from "./middleware/request-id";
import { sourceResolution } from "./middleware/source-resolution";
import { tokenEstimateMiddleware } from "./middleware/token-estimate";
import { versionCheckMiddleware } from "./middleware/version-check";
import { admin } from "./routes/admin";
import { adminRoster } from "./routes/admin-roster";
import { artifacts } from "./routes/artifacts";
import { authGithub } from "./routes/auth-github";
import {
  authSessionExchange,
  authSessionProtected,
} from "./routes/auth-session";
import { claims } from "./routes/claims";
import { doctor } from "./routes/doctor";
import { entities } from "./routes/entities";
import { gates } from "./routes/gates";
import { health } from "./routes/health";
import { infra } from "./routes/infra";
import { journal } from "./routes/journal";
import { presence } from "./routes/presence";
import { records } from "./routes/records";
import { repos } from "./routes/repos";
import { schemaRoutes } from "./routes/schema";
import { search } from "./routes/search";
import { signals } from "./routes/signals";
import { summary as summaryRoute } from "./routes/summary";
import { templates } from "./routes/templates";
import { tokens } from "./routes/tokens";
import { whoami } from "./routes/whoami";
import { workspace } from "./routes/workspace";
import type { Env, HonoVariables } from "./types";

export { ProjectDO } from "@tila/backend-do";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const app = new Hono<AppEnv>();

// Request ID: assign or preserve correlation ID for tracing
app.use("*", requestIdMiddleware);

// Analytics: emit request-level datapoints (fire-and-forget)
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  let errorCode = "";
  let retryable = false;
  if (c.res.status >= 400) {
    try {
      const body = await c.res.clone().json();
      errorCode = (body as { error?: { code?: string } })?.error?.code ?? "";
      retryable =
        (body as { error?: { retryable?: boolean } })?.error?.retryable ===
        true;
    } catch {
      // Non-JSON body — tolerated; defaults remain
    }
  }
  emitRequestDatapoint(c.env.ANALYTICS, c.executionCtx, {
    route: c.req.routePath ?? c.req.path,
    method: c.req.method,
    projectId: c.get("projectId") ?? "",
    latencyMs: Date.now() - start,
    statusCode: c.res.status,
    errorCode,
    retryable,
  });
});

app.onError(errorHandler);

// Token estimate: approximate token count header on all JSON responses
app.use("*", tokenEstimateMiddleware());

// CORS: apply to API, project, and auth routes
// /auth/* must be registered before the route handlers below (Hono middleware ordering)
app.use("/api/*", createCorsMiddleware());
app.use("/projects/*", createCorsMiddleware());
app.use("/auth/*", createCorsMiddleware());

// CLI version check: reject outdated CLI clients (pass-through for SDK/curl)
app.use("/api/*", versionCheckMiddleware());

app.route("/api", health);

// GitHub auth exchange -- pre-auth (no auth middleware on this path)
app.route("/api/auth/github", authGithub);

// Browser-friendly OAuth login alias (redirects to /api/auth/github/login)
app.get("/auth/github/login", (c) => c.redirect("/api/auth/github/login", 302));

// Session exchange -- pre-auth (validates token, creates session cookie)
app.route("/auth/session", authSessionExchange);

// NOTE: The bare "/" path is intentionally not handled by the Worker.
// Static Assets (wrangler [assets] binding) serves the SPA index.html for
// unmatched paths. run_worker_first ensures API/auth routes are handled here.
// See packages/schemas/src/deploy-routes.ts for the authoritative prefix list.

// Session-protected auth routes (logout, status)
const authSessionRoutes = new Hono<AppEnv>();
authSessionRoutes.use("/*", createAuthMiddleware());
authSessionRoutes.route("/auth/session", authSessionProtected);
authSessionRoutes.route("/auth", authSessionProtected);
app.route("/", authSessionRoutes);

// Token management routes -- auth-protected but no project middleware needed
// (projectId comes from the bearer token, not from the URL)
const tokenRoutes = new Hono<AppEnv>();
tokenRoutes.use("/*", createAuthMiddleware());
tokenRoutes.use("/*", csrfGuard);
tokenRoutes.route("/api/tokens", tokens);
tokenRoutes.route("/api/repos", repos);
tokenRoutes.route("/api", whoami);

app.route("/", tokenRoutes);

// Workspace routes -- auth-protected, no project middleware (workspace-session scoped)
const workspaceRoutes = new Hono<AppEnv>();
workspaceRoutes.use("/*", createAuthMiddleware());
workspaceRoutes.use("/*", csrfGuard);
workspaceRoutes.route("/", workspace);
app.route("/api/workspace", workspaceRoutes);

// Sweep route — secret-header auth (no bearer token). Uses the shared
// constant-time compare with the "tila-sweep-compare" HMAC key, which MUST stay
// distinct from the infra "tila-secret-compare" key (see lib/constant-time-compare.ts).
const sweepRoutes = new Hono<AppEnv>();
sweepRoutes.post("/sweep", async (c) => {
  const secret = c.env.SWEEP_SECRET;
  if (
    !secret ||
    !(await constantTimeSecretMatch(
      c.req.header("X-Sweep-Secret") ?? undefined,
      secret,
      "tila-sweep-compare",
    ))
  ) {
    return c.json(
      {
        ok: false,
        error: {
          code: "forbidden",
          message: "Invalid sweep secret",
          retryable: false,
        },
      },
      403,
    );
  }
  const summary = await runSweep(c.env);
  return c.json({ ok: true, ...summary });
});
app.route("/_internal", sweepRoutes);

// Infra-owner admin routes (e.g. destroy any project by slug). Authenticated by
// the INFRA_ADMIN_TOKEN secret, NOT a per-project token — mounted outside
// /projects/:projectId so it bypasses projectMiddleware's PROJECT_MISMATCH guard.
app.route("/_internal", infra);

const projectRoutes = new Hono<AppEnv>();
projectRoutes.use("/*", createAuthMiddleware());
projectRoutes.use("/*", csrfGuard);
projectRoutes.use("/*", sourceResolution());
projectRoutes.use("/*", projectMiddleware);
projectRoutes.use("/*", createIdempotencyMiddleware());
projectRoutes.use("/*", createCacheMiddleware());
projectRoutes.route("/tasks", entities); // canonical
// @deprecated -- use /tasks going forward; kept for backward compatibility
projectRoutes.route("/entities", entities); // @deprecated
projectRoutes.route("/work-units", entities); // @deprecated
projectRoutes.route("/claims", claims);
projectRoutes.route("/artifacts", artifacts);
projectRoutes.route("/journal", journal);
projectRoutes.route("/presence", presence);
projectRoutes.route("/signals", signals);
projectRoutes.route("/schema", schemaRoutes);
projectRoutes.route("/summary", summaryRoute);
projectRoutes.route("/gates", gates);
projectRoutes.route("/templates", templates);
projectRoutes.route("/records", records);
projectRoutes.route("/search", search);
projectRoutes.route("/admin", admin);
projectRoutes.route("/admins", adminRoster);
projectRoutes.route("/", doctor);

app.route("/projects/:projectId", projectRoutes);

// Named export of app for test introspection (route-coverage guard).
// Tests import this to walk app.routes without spinning up a real Worker.
export { app };

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Crash-safe wrapper (PR17): runSweep already isolates PER-PROJECT failures,
    // but a throw BEFORE the loop (e.g. the D1 registry read) would otherwise
    // reject this waitUntil promise and abort the whole nightly sweep with no
    // record. Catch it, log it, and emit a sweep-level error datapoint so the
    // pre-loop crash leaves a forensic footprint. Per-project Analytics are
    // emitted inside runSweep.
    ctx.waitUntil(
      runSweep(env).then(
        () => {},
        (err) => {
          console.error("[sweep] run aborted before completion:", err);
          emitSweepErrorDatapoint(env.ANALYTICS, ctx, { phase: "pre-loop" });
        },
      ),
    );
  },
};
