import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { archiveJournal, revokeSession } from "../lib/admin-ops";
import { destroyProjectResources } from "../lib/destroy-project";
import { forwardToDO } from "../lib/do-forward";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

type AdminEnv = { Bindings: Env; Variables: HonoVariables };

/**
 * Guards destroy/store-counts routes so only full-scope D1 API tokens
 * can reach them. GitHub session tokens (kind "session") with
 * permission==="admin" pass requirePermission("admin") but must not be
 * allowed to trigger destructive infra-owner operations.
 */
export const requireD1Token: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const tokenResult = c.get("tokenResult");
  if (tokenResult.kind !== "d1-token") {
    return c.json(
      {
        ok: false,
        error: {
          code: "D1_TOKEN_REQUIRED",
          message: "This operation requires a full-scope D1 API token",
          retryable: false,
        },
      },
      403,
    );
  }
  return next();
};

export const admin = new Hono<AdminEnv>();
const RevokeSessionRequestSchema = z.object({
  jti: z.string().uuid().max(64),
});

admin.post("/restart", requirePermission("admin"), async (c) => {
  const stub = c.get("doStub");
  return forwardToDO(stub, "/admin/restart", "POST");
});

admin.post(
  "/archive/journal",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
    const stub = c.get("doStub");
    const projectId = c.get("projectId");
    const result = await archiveJournal(c.env, stub, projectId);
    return c.json(result.body, result.status as ContentfulStatusCode);
  },
);

/**
 * GET /admin/store-counts
 * Returns per-table row counts from the project's DO (for destroy read-back
 * verification). Requires a full-scope D1 API token — GitHub session tokens
 * with admin permission are explicitly rejected.
 */
admin.get(
  "/store-counts",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
    const stub = c.get("doStub");
    return forwardToDO(stub, "/admin/store-counts", "GET");
  },
);

/**
 * POST /admin/destroy
 *
 * Per-project entry point to the shared destroy orchestration
 * (see lib/destroy-project.ts). Authenticated by a per-project full-scope D1
 * token. The infra-owner entry point (POST /_internal/admin/projects/:slug/destroy)
 * runs the SAME orchestration under a different auth model.
 */
admin.post(
  "/destroy",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
    const stub = c.get("doStub");
    const projectId = c.get("projectId");
    const result = await destroyProjectResources(c.env, stub, projectId);
    return c.json(result.body, result.status as ContentfulStatusCode);
  },
);

/**
 * POST /admin/sessions/revoke
 *
 * Admin-plane endpoint (C9) to revoke a session JWT by jti.
 * Guarded by requirePermission("admin") per flow-separation.md.
 *
 * Body: { jti: string }
 *
 * Inserts the jti into the D1 _revoked_jti table and immediately
 * invalidates the per-isolate cache entry in the revoking isolate.
 * Cross-isolate staleness: ≤ JTI_REVCHECK_TTL_MS (default 60s).
 */
admin.post(
  "/sessions/revoke",
  requirePermission("admin"),
  requireD1Token,
  async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
            retryable: false,
          },
        },
        400,
      );
    }

    const parsed = RevokeSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              "Body must include a UUID jti no longer than 64 characters",
            retryable: false,
          },
        },
        400,
      );
    }

    const { jti } = parsed.data;
    const projectId = c.get("projectId") ?? "";

    const result = await revokeSession(c.env, jti, projectId);
    return c.json(result);
  },
);
