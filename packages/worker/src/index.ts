import { D1ProjectRegistry, D1SessionStore } from "@tila/backend-d1";
import { R2ArtifactBackend } from "@tila/backend-r2";
import { Hono } from "hono";
import { DRIFT_RECONCILE_THRESHOLD, SWEEP_BATCH_SIZE } from "./config";
import { emitRequestDatapoint } from "./lib/analytics";
import { sweepExpiredKey } from "./lib/sweep-key";
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

interface SweepSummary {
  projectsSwept: number;
  artifactsExpired: number;
  r2DeleteErrors: number;
  driftChecksRun: number;
  driftReconciled: number;
  driftErrors: number;
  expiredSessions: number;
  journalEventsArchived: number;
}

const app = new Hono<AppEnv>();

// Request ID: assign or preserve correlation ID for tracing
app.use("*", requestIdMiddleware);

// Analytics: emit request-level datapoints (fire-and-forget)
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  emitRequestDatapoint(c.env.ANALYTICS, c.executionCtx, {
    route: c.req.routePath ?? c.req.path,
    method: c.req.method,
    projectId: c.get("projectId") ?? "",
    latencyMs: Date.now() - start,
    statusCode: c.res.status,
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

// Sweep route — secret-header auth (no bearer token)
const sweepRoutes = new Hono<AppEnv>();
sweepRoutes.post("/sweep", async (c) => {
  const secret = c.env.SWEEP_SECRET;
  if (!secret || c.req.header("X-Sweep-Secret") !== secret) {
    return c.json(
      {
        ok: false,
        error: {
          code: "FORBIDDEN",
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
projectRoutes.route("/", doctor);

app.route("/projects/:projectId", projectRoutes);

async function runSweep(env: Env): Promise<SweepSummary> {
  console.log("[sweep] daily artifact cleanup started");
  const registry = new D1ProjectRegistry(env.DB);
  const r2 = new R2ArtifactBackend(env.ARTIFACTS);
  const projects = await registry.listAll();
  const summary: SweepSummary = {
    projectsSwept: 0,
    artifactsExpired: 0,
    r2DeleteErrors: 0,
    driftChecksRun: 0,
    driftReconciled: 0,
    driftErrors: 0,
    expiredSessions: 0,
    journalEventsArchived: 0,
  };

  // Session expiry cleanup (global, not per-project)
  try {
    const sessionStore = new D1SessionStore(env.DB);
    const { deleted: expiredSessions } = await sessionStore.deleteExpired();
    console.log(`[sweep] deleted ${expiredSessions} expired sessions`);
    summary.expiredSessions = expiredSessions;
  } catch (err) {
    console.error("[sweep] session cleanup failed:", err);
  }

  for (const { projectId } of projects) {
    const doId = env.PROJECT.idFromName(projectId);
    const doStub = env.PROJECT.get(doId);
    let res: Response;
    try {
      res = await doStub.fetch("http://do/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_size: SWEEP_BATCH_SIZE }),
      });
    } catch (err) {
      console.error(
        `[sweep] failed to reach DO for project ${projectId}:`,
        err,
      );
      continue;
    }

    if (!res.ok) {
      console.error(
        `[sweep] DO /sweep returned ${res.status} for project ${projectId}`,
      );
      continue;
    }

    const data = (await res.json()) as { expiredKeys?: string[] };
    for (const key of data.expiredKeys ?? []) {
      await sweepExpiredKey(key, doStub, (k) => r2.delete(k), summary);
    }
    summary.projectsSwept++;

    // Journal archival: archive old journal events to R2 (non-fatal)
    try {
      const archiveRes = await doStub.fetch("http://do/journal/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (archiveRes.ok) {
        const archiveData = (await archiveRes.json()) as {
          ok: boolean;
          events?: Array<{
            seq: number;
            t: number;
            kind: string;
            resource: string;
            actor: string;
            token_id: string | null;
            fence: number | null;
            data: Record<string, unknown>;
            source: string | null;
            source_version: string | null;
          }>;
          throughSeq?: number;
          count?: number;
        };
        const count = archiveData.count ?? 0;
        if (
          count > 0 &&
          archiveData.events &&
          archiveData.throughSeq !== undefined
        ) {
          // Group events by year/month, write each group to R2 as JSONL
          const groups = new Map<string, typeof archiveData.events>();
          for (const event of archiveData.events) {
            const d = new Date(event.t);
            const year = d.getUTCFullYear();
            const month = String(d.getUTCMonth() + 1).padStart(2, "0");
            const key = `${year}/${month}`;
            const group = groups.get(key);
            if (group) {
              group.push(event);
            } else {
              groups.set(key, [event]);
            }
          }
          let r2WriteOk = true;
          for (const [yearMonth, groupEvents] of groups) {
            const r2Key = `journal-archive/${projectId}/${yearMonth}.jsonl`;
            const jsonl = groupEvents.map((e) => JSON.stringify(e)).join("\n");
            try {
              await env.ARTIFACTS.put(r2Key, jsonl);
            } catch (r2Err) {
              console.error(
                `[sweep] journal R2 write failed for ${r2Key}:`,
                r2Err,
              );
              r2WriteOk = false;
            }
          }
          if (r2WriteOk) {
            // Confirm archival so DO deletes events and advances watermark
            const confirmRes = await doStub.fetch(
              "http://do/journal/archive/confirm",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ throughSeq: archiveData.throughSeq }),
              },
            );
            if (confirmRes.ok) {
              console.log(
                `[sweep] project ${projectId} archived ${count} journal events`,
              );
              summary.journalEventsArchived += count;
            } else {
              console.error(
                `[sweep] journal confirm failed for project ${projectId}: ${confirmRes.status}`,
              );
            }
          }
        }
      } else {
        console.error(
          `[sweep] journal archive request failed for project ${projectId}: ${archiveRes.status}`,
        );
      }
    } catch (archiveErr) {
      console.error(
        `[sweep] journal archival failed for project ${projectId}:`,
        archiveErr,
      );
    }

    // Search drift check + conditional reconciliation (non-fatal)
    try {
      const driftRes = await doStub.fetch("http://do/artifact/search-drift");
      if (driftRes.ok) {
        const drift = (await driftRes.json()) as {
          findings?: Array<{ check: string; count: number; status: string }>;
        };
        const findings = drift.findings ?? [];

        // Always log all 5 drift checks (even when count=0)
        console.log(
          `[sweep] project ${projectId} drift metrics:`,
          JSON.stringify(
            findings.map((f) => ({
              check: f.check,
              count: f.count,
              status: f.status,
            })),
          ),
        );
        summary.driftChecksRun++;

        // Sum fail-check counts and compare to threshold
        const totalFailCount = findings
          .filter((f) => f.status === "fail")
          .reduce((sum, f) => sum + f.count, 0);

        if (totalFailCount >= DRIFT_RECONCILE_THRESHOLD) {
          console.log(
            `[sweep] project ${projectId} drift threshold exceeded (${totalFailCount} >= ${DRIFT_RECONCILE_THRESHOLD}), triggering reconciliation`,
          );
          try {
            // Step 1: Get rebuild candidates
            const scanRes = await doStub.fetch(
              "http://do/artifact/search-rebuild-scan",
            );
            if (!scanRes.ok) {
              throw new Error(`search-rebuild-scan returned ${scanRes.status}`);
            }
            const scanData = (await scanRes.json()) as {
              ok: boolean;
              pointers: Array<unknown>;
            };

            // Step 2: Apply rebuild
            const rebuildRes = await doStub.fetch(
              "http://do/artifact/search-rebuild",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  candidates: scanData.pointers,
                  apply: true,
                  actor: "sweep-cron",
                }),
              },
            );
            if (!rebuildRes.ok) {
              throw new Error(`search-rebuild returned ${rebuildRes.status}`);
            }
            console.log(
              `[sweep] project ${projectId} reconciliation completed successfully`,
            );
            summary.driftReconciled++;
          } catch (reconcileErr) {
            console.error(
              `[sweep] project ${projectId} reconciliation failed:`,
              reconcileErr,
            );
            summary.driftErrors++;
          }
        }
      }
    } catch (driftErr) {
      console.error(
        `[sweep] project ${projectId} drift check failed:`,
        driftErr,
      );
      summary.driftErrors++;
    }
  }

  console.log("[sweep] completed:", JSON.stringify(summary));
  return summary;
}

// Named export of app for test introspection (route-coverage guard).
// Tests import this to walk app.routes without spinning up a real Worker.
export { app };

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runSweep(env));
  },
};
