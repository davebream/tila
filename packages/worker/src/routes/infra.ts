import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { emitInfraDestroyDatapoint } from "../lib/analytics";
import { constantTimeSecretMatch } from "../lib/constant-time-compare";
import { destroyProjectResources } from "../lib/destroy-project";
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
    emitInfraDestroyDatapoint(c.env.ANALYTICS, execCtxOf(c), {
      projectId: c.req.param("projectId") ?? "",
      outcome: "auth-failure",
      statusCode: 403,
    });
    return c.json(
      {
        ok: false,
        error: {
          code: "FORBIDDEN",
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
 * Infra-owner admin routes — authenticated by the INFRA_ADMIN_TOKEN Worker
 * secret rather than a per-project D1 token. Mounted OUTSIDE /projects/:projectId
 * so it bypasses projectMiddleware's per-project PROJECT_MISMATCH guard, letting
 * an infra owner destroy any project by slug without that project's own token.
 */
export const infra = new Hono<AppEnv>();

infra.use("/*", requireInfraPrincipal);

infra.post("/projects/:projectId/destroy", async (c) => {
  const projectId = c.req.param("projectId");

  // Second-factor confirmation: the caller must echo the slug in X-Confirm-Slug.
  // Forces the operator to name the irreversible target twice, defeating a
  // fat-fingered or wrong-loop-variable destroy of the wrong project.
  if (c.req.header("X-Confirm-Slug") !== projectId) {
    emitInfraDestroyDatapoint(c.env.ANALYTICS, execCtxOf(c), {
      projectId,
      outcome: "confirm-slug-mismatch",
      statusCode: 400,
    });
    return c.json(
      {
        ok: false,
        error: {
          code: "CONFIRM_SLUG_MISMATCH",
          message:
            "X-Confirm-Slug header must match the project slug in the URL",
          retryable: false,
        },
      },
      400,
    );
  }

  const doId = c.env.PROJECT.idFromName(projectId);
  const stub = c.env.PROJECT.get(doId);
  const result = await destroyProjectResources(c.env, stub, projectId);
  emitInfraDestroyDatapoint(c.env.ANALYTICS, execCtxOf(c), {
    projectId,
    outcome: result.status === 200 ? "destroyed" : "destroy-failed",
    statusCode: result.status,
  });
  return c.json(result.body, result.status as ContentfulStatusCode);
});
