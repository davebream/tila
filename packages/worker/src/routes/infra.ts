import { D1ProjectRegistry } from "@tila/backend-d1";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { applyAdminGrant } from "../lib/admin-grant";
import { archiveJournal, revokeSession } from "../lib/admin-ops";
import { emitInfraAdminDatapoint } from "../lib/analytics";
import { constantTimeSecretMatch } from "../lib/constant-time-compare";
import { destroyProjectResources } from "../lib/destroy-project";
import { forwardToDO } from "../lib/do-forward";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/** HMAC domain-separation key for the infra admin secret comparison. */
const INFRA_COMPARE_KEY = "tila-secret-compare";

/** Safely read the ExecutionContext — absent in unit tests, present in prod. */
function execCtxOf(c: Context<AppEnv>): ExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * Authenticates the infra-owner principal against the INFRA_ADMIN_TOKEN Worker
 * secret (a shared admin credential, NOT a per-project D1 token).
 *
 * - When the secret is unset, the route is INVISIBLE: returns 404 so the
 *   endpoint's existence is not disclosed.
 * - On a missing/wrong bearer, returns 403 after a constant-time compare and
 *   emits the auth-failure analytics datapoint (the only forensic footprint for
 *   this shared-secret endpoint).
 *
 * Applied as sub-router middleware so the guard is centralized rather than
 * re-implemented inline per route.
 */
export const requireInfraPrincipal: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const secret = c.env.INFRA_ADMIN_TOKEN;

  // Endpoint is invisible unless the infra secret is configured.
  if (!secret) {
    return c.json(
      {
        ok: false,
        error: { code: "not-found", message: "Not found", retryable: false },
      },
      404,
    );
  }

  // Constant-time bearer check against the infra secret.
  const authHeader = c.req.header("Authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : undefined;

  if (!(await constantTimeSecretMatch(provided, secret, INFRA_COMPARE_KEY))) {
    emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
      projectId: c.req.param("projectId") ?? "",
      outcome: "auth-failure",
      statusCode: 403,
    });
    return c.json(
      {
        ok: false,
        error: {
          code: "forbidden",
          message: "Invalid infra admin token",
          retryable: false,
        },
      },
      403,
    );
  }

  await next();
};

/**
 * Existence guard (CI-1) — runs AFTER {@link requireInfraPrincipal}. Confirms the
 * target project EXISTS in the D1 registry BEFORE any Durable Object is contacted.
 *
 * This is load-bearing: tila's `ProjectDO` runs migrations in its constructor on
 * first access, so calling `idFromName`/`get` for a slug that never existed would
 * MATERIALIZE a permanent empty DO (writing to DO SQLite). We must fail closed on
 * a missing registry row before touching the DO namespace at all.
 *
 * - `opts.includeArchived` selects the archived-inclusive lookup
 *   (`getIncludingArchived`) for admin paths that must reach archived projects;
 *   the default lookup (`get`) filters archived projects out.
 * - On a missing row → 404 PROJECT_NOT_FOUND, emit the analytics datapoint, and
 *   return BEFORE any `idFromName`/`get`/DO contact.
 * - On success, stashes the resolved `projectId` and `doStub` for downstream
 *   handlers, then calls `next()`.
 */
export function resolveTargetProject(opts?: {
  includeArchived?: boolean;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = c.req.param("projectId") ?? "";
    const registry = new D1ProjectRegistry(c.env.DB);
    const row = opts?.includeArchived
      ? await registry.getIncludingArchived(id)
      : await registry.get(id);

    // Fail closed before any DO is materialized.
    if (!row) {
      emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
        projectId: id,
        outcome: "project-not-found",
        statusCode: 404,
      });
      return c.json(
        {
          ok: false,
          error: {
            code: "not-found",
            message: "Project not found",
            retryable: false,
          },
        },
        404,
      );
    }

    c.set("projectId", id);
    c.set("doStub", c.env.PROJECT.get(c.env.PROJECT.idFromName(id)));
    await next();
  };
}

/**
 * Infra-owner admin routes — authenticated by the INFRA_ADMIN_TOKEN Worker
 * secret rather than a per-project D1 token. Mounted OUTSIDE /projects/:projectId
 * so it bypasses projectMiddleware's per-project PROJECT_MISMATCH guard, letting
 * an infra owner destroy any project by slug without that project's own token.
 */
export const infra = new Hono<AppEnv>();

infra.use("/*", requireInfraPrincipal);

infra.post(
  "/admin/projects/:projectId/destroy",
  resolveTargetProject({ includeArchived: true }),
  async (c) => {
    const projectId = c.req.param("projectId");

    // Second-factor confirmation: the caller must echo the slug in X-Confirm-Slug.
    // Forces the operator to name the irreversible target twice, defeating a
    // fat-fingered or wrong-loop-variable destroy of the wrong project.
    if (c.req.header("X-Confirm-Slug") !== projectId) {
      emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
        projectId,
        outcome: "confirm-slug-mismatch",
        statusCode: 400,
      });
      return c.json(
        {
          ok: false,
          error: {
            code: "confirm-slug-mismatch",
            message:
              "X-Confirm-Slug header must match the project slug in the URL",
            retryable: false,
          },
        },
        400,
      );
    }

    // The DO stub was resolved by resolveTargetProject after confirming the
    // project exists in the D1 registry, so no idFromName/get happens here.
    const stub = c.get("doStub");
    const result = await destroyProjectResources(c.env, stub, projectId);
    emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
      projectId,
      outcome: result.status === 200 ? "destroyed" : "destroy-failed",
      statusCode: result.status,
    });
    return c.json(result.body, result.status as ContentfulStatusCode);
  },
);

/** Zod schema for the cross-project sessions/revoke body, mirroring admin.ts. */
const RevokeSessionRequestSchema = z.object({
  jti: z.string().uuid().max(64),
});

/**
 * POST /admin/projects/:projectId/restart — cross-project mirror of
 * admin.ts `POST /admin/restart`. Reachable by slug under the infra principal.
 * Returns the delegated DO body VERBATIM.
 */
infra.post(
  "/admin/projects/:projectId/restart",
  resolveTargetProject(),
  async (c) => {
    const res = await forwardToDO(c.get("doStub"), "/admin/restart", "POST");
    emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
      projectId: c.get("projectId"),
      outcome: "restarted",
      statusCode: res.status,
    });
    return res;
  },
);

/**
 * GET /admin/projects/:projectId/store-counts — cross-project mirror of
 * admin.ts `GET /admin/store-counts`. Returns the DO body
 * `{ counts: { domain, schemaHistory } }` VERBATIM.
 */
infra.get(
  "/admin/projects/:projectId/store-counts",
  resolveTargetProject(),
  async (c) => {
    const res = await forwardToDO(
      c.get("doStub"),
      "/admin/store-counts",
      "GET",
    );
    emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
      projectId: c.get("projectId"),
      outcome: "store-counts",
      statusCode: res.status,
    });
    return res;
  },
);

/**
 * POST /admin/projects/:projectId/sessions/revoke — cross-project mirror of
 * admin.ts `POST /admin/sessions/revoke`. The URL slug is the caller-asserted
 * provenance recorded against the jti (CI-2: no jti→project derivation).
 */
infra.post(
  "/admin/projects/:projectId/sessions/revoke",
  resolveTargetProject(),
  async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
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
            code: "validation-error",
            message:
              "Body must include a UUID jti no longer than 64 characters",
            retryable: false,
          },
        },
        400,
      );
    }

    const result = await revokeSession(
      c.env,
      parsed.data.jti,
      c.req.param("projectId"),
    );
    emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
      projectId: c.get("projectId"),
      outcome: "session-revoked",
      statusCode: 200,
    });
    return c.json(result);
  },
);

/**
 * POST /admin/projects/:projectId/archive/journal — cross-project mirror of
 * admin.ts `POST /admin/archive/journal`. Runs the shared 4-step archive
 * orchestration and returns its `{ body, status }`.
 */
infra.post(
  "/admin/projects/:projectId/archive/journal",
  resolveTargetProject(),
  async (c) => {
    const result = await archiveJournal(
      c.env,
      c.get("doStub"),
      c.get("projectId"),
    );
    emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
      projectId: c.get("projectId"),
      outcome: "journal-archived",
      statusCode: result.status,
    });
    return c.json(result.body, result.status as ContentfulStatusCode);
  },
);

/**
 * POST /admin/projects/:projectId/admins — break-glass first-admin seeder.
 *
 * Guarded by the inherited `requireInfraPrincipal` (404 when INFRA_ADMIN_TOKEN
 * is unset, 403 on mismatch via constant-time compare) and `resolveTargetProject`
 * (fail-closed on unknown project, 404 PROJECT_NOT_FOUND).
 *
 * Delegates to the shared `applyAdminGrant` helper with `grantedByUserId = null`
 * (infra/owner-seeded grants have no acting GitHub user identity).
 *
 * SECURITY: This handler writes D1 ONLY — it must NEVER call `c.get("doStub").fetch()`.
 * resolveTargetProject sets a lazy doStub on the context, but the seeder must not
 * materialize the DO (a DO request would run migrations against the target's SQLite).
 *
 * Analytics mapping (outcome → emitInfraAdminDatapoint):
 *   success               → "admin-seeded"
 *   validation-error      → "validation-error"
 *   login-unresolved      → "login-unresolved"
 *   github-user-not-found → "github-user-not-found"
 *   github-error          → "github-error"
 *
 * Auth-failure datapoints are NOT re-emitted here — requireInfraPrincipal owns them.
 */
infra.post(
  "/admin/projects/:projectId/admins",
  resolveTargetProject(),
  async (c) => {
    const projectId = c.get("projectId");

    // Parse JSON body.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
        projectId,
        outcome: "validation-error",
        statusCode: 400,
      });
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message: "Invalid JSON body",
            retryable: false,
          },
        },
        400,
      );
    }

    // Delegate to shared helper. grantedByUserId = null → infra-seeded grant.
    const result = await applyAdminGrant(c.env, projectId, body, null);

    // Outcome → analytics label mapping (infra vocabulary).
    const outcomeLabel: Record<string, string> = {
      success: "admin-seeded",
      "validation-error": "validation-error",
      "login-unresolved": "login-unresolved",
      "github-user-not-found": "github-user-not-found",
      "github-error": "github-error",
    };

    if (!result.ok) {
      const label = outcomeLabel[result.outcome] ?? result.outcome;
      emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
        projectId,
        outcome: label,
        statusCode: result.status,
      });
      return c.json(
        {
          ok: false,
          error: {
            code: result.code,
            message: result.message,
            retryable: result.status === 502,
          },
        },
        result.status,
      );
    }

    emitInfraAdminDatapoint(c.env.ANALYTICS, execCtxOf(c), {
      projectId,
      outcome: "admin-seeded",
      statusCode: 200,
    });
    return c.json({
      ok: true,
      github_user_id: result.githubUserId,
      granted: result.granted,
    });
  },
);
